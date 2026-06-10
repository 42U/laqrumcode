/**
 * link_hierarchy MCP tool — explicit parent→child concept edges.
 *
 * Users/bots can assert "X is a kind of Y" and the substrate writes the
 * broader/narrower edges directly. This is the substrate-does-the-work
 * counterpart to relying entirely on embedding-similarity hierarchy
 * detection in linkConceptHierarchy, which misses hierarchical relations
 * that aren't phrased with substring overlap.
 *
 * Arguments:
 *   parent: concept content (the broader term)
 *   child:  concept content (the narrower term)
 *   source: optional provenance tag for both upserts
 *
 * Both concepts go through commitKnowledge so hierarchy + related_to
 * auto-seal as usual. The explicit broader/narrower edges are written
 * on top — that's the point of the tool, to make the relation explicit
 * where the substrate's pattern-match wouldn't have found it.
 */
import { commitKnowledge } from "../engine/commit.js";
import { swallow } from "../engine/errors.js";
/** Reuse-similarity threshold.
 *  2026-06-09 recalibration (the "link_hierarchy NEVER reuses" incident,
 *  memory:ety7rj662y98liipw70c): the old 0.7 bar was unreachable in practice —
 *  BGE-M3 cosine for a short anchor vs a long stored concept body lands
 *  0.55–0.68 for LEGITIMATE matches, while measured noise pairs on the live
 *  graph top out at ~0.37. 0.60 sits above the noise ceiling with a wide
 *  margin and below the legit-match band, so reuse actually fires.
 *  Note the hard limit either way: a pure kebab-slug anchor vs prose content
 *  measures ~0.25–0.30 (noise) — embeddings cannot bridge that. That case is
 *  handled by the exact-content tier, and (follow-up) by persisting gem names
 *  on concept rows so slug anchors can hit them. */
const REUSE_THRESHOLD = 0.6;
/** Find an existing concept for `name`, in three tiers:
 *    T1 exact content match (case/whitespace-insensitive) — handles re-linking
 *       a concept by its precise content, incl. previously-created stubs;
 *    T2 embedding similarity ≥ REUSE_THRESHOLD — handles content-similar
 *       phrase anchors against prose concepts;
 *    T3 create via commitKnowledge (which itself exact-content-upserts).
 *  Returns the id, whether it was reused, and — when freshly created — the
 *  best near-miss candidate + score so callers can see WHY reuse didn't fire
 *  (the 2026-06-09 incident was invisible precisely because this was opaque). */
async function findOrCreateConcept(store, embeddings, name, source) {
    // T1: exact content match, case-insensitive, trimmed.
    try {
        const exact = await store.queryFirst(`SELECT id FROM concept
       WHERE string::lowercase(string::trim(content)) = $norm
         AND superseded_at IS NONE
       LIMIT 1`, { norm: name.trim().toLowerCase() });
        if (exact.length > 0) {
            return { id: String(exact[0].id), reused: true };
        }
    }
    catch (e) {
        swallow("linkHierarchy:exactMatch", e);
    }
    // T2: embedding similarity.
    if (embeddings.isAvailable()) {
        try {
            const vec = await embeddings.embed(name);
            if (vec?.length) {
                // COSINE_GUARD_OK: read-only reuse-similarity search — the only
                // follow-on is reuse-or-create (edge writes), never a destructive op.
                const candidates = await store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
           FROM concept
           WHERE embedding != NONE AND array::len(embedding) > 0
             AND superseded_at IS NONE
           ORDER BY score DESC
           LIMIT 1`, { vec });
                const top = candidates[0];
                if (top && (top.score ?? 0) >= REUSE_THRESHOLD) {
                    return { id: String(top.id), reused: true };
                }
                // T3: create — pass the precomputed vec, and surface the near-miss.
                const { id } = await commitKnowledge({ store, embeddings }, { kind: "concept", name, source, precomputedVec: vec });
                return {
                    id: id || "",
                    reused: false,
                    nearMiss: top ? { id: String(top.id), score: Number((top.score ?? 0).toFixed(3)) } : undefined,
                };
            }
        }
        catch (e) {
            swallow("linkHierarchy:findOrCreate", e);
        }
    }
    const { id } = await commitKnowledge({ store, embeddings }, { kind: "concept", name, source });
    return { id: id || "", reused: false };
}
export async function handleLinkHierarchy(state, _session, args) {
    const parent = String(args.parent ?? "").trim();
    const child = String(args.child ?? "").trim();
    const source = String(args.source ?? "link_hierarchy");
    if (!parent || !child) {
        return { content: [{ type: "text", text: "Error: both `parent` and `child` are required." }] };
    }
    if (parent.toLowerCase() === child.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: parent and child must differ." }] };
    }
    const { store, embeddings } = state;
    // Resolve both concepts: prefer reusing high-similarity existing rows over
    // upserting bare-name stubs that orphan the originals.
    const [parentRes, childRes] = await Promise.all([
        findOrCreateConcept(store, embeddings, parent, source),
        findOrCreateConcept(store, embeddings, child, source),
    ]);
    const parentId = parentRes.id;
    const childId = childRes.id;
    if (!parentId || !childId) {
        return { content: [{ type: "text", text: "Error: concept upsert failed for one or both terms." }] };
    }
    if (parentId === childId) {
        return { content: [{ type: "text", text: "Error: parent and child resolved to the same concept (similarity match collapse). Pick more distinctive names." }] };
    }
    // Explicit hierarchy edges. broader goes parent→child; narrower goes child→parent.
    // Same direction convention linkConceptHierarchy uses internally.
    let edgesWritten = 0;
    try {
        await store.relate(parentId, "broader", childId);
        edgesWritten++;
    }
    catch (e) {
        swallow("linkHierarchy:broader", e);
    }
    try {
        await store.relate(childId, "narrower", parentId);
        edgesWritten++;
    }
    catch (e) {
        swallow("linkHierarchy:narrower", e);
    }
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    ok: edgesWritten > 0,
                    parent_id: parentId,
                    parent_reused: parentRes.reused,
                    ...(parentRes.nearMiss ? { parent_near_miss: parentRes.nearMiss } : {}),
                    child_id: childId,
                    child_reused: childRes.reused,
                    ...(childRes.nearMiss ? { child_near_miss: childRes.nearMiss } : {}),
                    edges_written: edgesWritten,
                }, null, 2),
            }],
    };
}
