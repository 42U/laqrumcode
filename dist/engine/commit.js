/**
 * commitKnowledge — the single write path.
 *
 * Every graph write (concepts, memories, artifacts, skills, reflections, etc.)
 * should go through this function. It wraps the row insert with the full
 * set of auto-sealing edges, so callers can't accidentally skip linking.
 *
 * Before this existed, write paths did their own linking (the dormant
 * memory-daemon.ts did it thoroughly; newer paths like pending-work.ts:527
 * partially bypassed the linking helpers, leaving concepts unlinked). That
 * was the root cause of the "substrate doesn't auto-seal" problem in 0.3.x.
 *
 * 0.4.0 kicks off with commitKnowledge handling the "concept" kind only.
 * Additional kinds (memory, artifact, skill, reflection, monologue,
 * correction, preference, decision) come online as their writers are
 * migrated off their bespoke paths.
 */
import { linkToRelevantConcepts, linkConceptHierarchy, } from "./concept-links.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";
import { classifyReflection } from "./reflection-filter.js";
// ── Entry point ───────────────────────────────────────────────────────────
export async function commitKnowledge(deps, data) {
    switch (data.kind) {
        case "concept":
            return commitConcept(deps, data);
        case "memory":
            return commitMemory(deps, data);
        case "artifact":
            return commitArtifact(deps, data);
        case "reflection":
            return commitReflection(deps, data);
        default: {
            // Exhaustiveness check — new kinds must add a case here.
            const _exhaustive = data;
            throw new Error(`commitKnowledge: unsupported kind ${String(_exhaustive.kind)}`);
        }
    }
}
// ── Per-kind implementations ──────────────────────────────────────────────
async function commitConcept(deps, data) {
    const { store, embeddings } = deps;
    const logTag = `commit:concept:${data.source ?? "anon"}`;
    // 1. Embed the name (or reuse caller's vec).
    let embedding = data.precomputedVec ?? null;
    if (!embedding && embeddings.isAvailable()) {
        try {
            embedding = await embeddings.embed(data.name);
        }
        catch (e) {
            swallow(`${logTag}:embed`, e);
        }
    }
    // 2. Upsert the concept row (provenance passed through when supplied).
    const conceptId = await store.upsertConcept(data.name, embedding, data.source, data.provenance, data.projectId);
    let edges = 0;
    // 3. Link source → concept via the requested edge, if caller provided one.
    if (data.sourceId && data.edgeName) {
        try {
            await store.relate(data.sourceId, data.edgeName, conceptId);
            edges++;
        }
        catch (e) {
            swallow.warn(`${logTag}:relate`, e);
        }
    }
    // 4. Auto-seal: concept → other concepts (narrower/broader hierarchy).
    if (data.linkHierarchy !== false) {
        const before = edges;
        try {
            await linkConceptHierarchy(conceptId, data.name, store, embeddings, logTag, embedding);
            // linkConceptHierarchy writes edges internally; we don't get a count back,
            // so we approximate by marking "hierarchy attempted" — +1 for observability.
            edges += 1;
        }
        catch (e) {
            swallow(`${logTag}:hierarchy`, e);
            edges = before;
        }
    }
    // 5. Auto-seal: concept → other concepts (related_to by embedding similarity).
    if (data.linkRelated !== false && embedding && embedding.length > 0) {
        const before = edges;
        try {
            await linkToRelevantConcepts(conceptId, "related_to", data.name, store, embeddings, logTag, 5, 0.65, embedding);
            edges += 1;
        }
        catch (e) {
            swallow(`${logTag}:related`, e);
            edges = before;
        }
    }
    return { id: conceptId, edges };
}
async function commitMemory(deps, data) {
    const { store, embeddings } = deps;
    const logTag = `commit:memory:${data.category}`;
    // 1. Embed the text (or reuse caller's vec). When embeddingText is set,
    //    embed that shorter form for better query matching while storing the
    //    full text in the row. Fixes issue #10: category prefixes and rationale
    //    dilute embedding quality for short keyword queries.
    let embedding = data.precomputedVec ?? null;
    if (!embedding && embeddings.isAvailable()) {
        try {
            embedding = await embeddings.embed(data.embeddingText ?? data.text);
        }
        catch (e) {
            swallow(`${logTag}:embed`, e);
        }
    }
    // 2. Insert the memory row. createMemory signature is
    //    (text, embedding, importance, category, sessionId?).
    const memoryId = await store.createMemory(data.text, embedding, data.importance, data.category, data.sessionId, data.projectId);
    let edges = 0;
    // 3. Auto-seal: memory → concepts (about_concept) by semantic similarity.
    //    Previously this linking was only done inside the dormant memory-daemon;
    //    hot paths like causal.ts created memory nodes that never got
    //    concept edges, leaving them as islands in the graph.
    if (memoryId && data.linkConcepts !== false && embedding && embedding.length > 0) {
        const before = edges;
        try {
            await linkToRelevantConcepts(memoryId, "about_concept", data.text, store, embeddings, logTag, 5, 0.65, embedding);
            edges += 1;
        }
        catch (e) {
            swallow(`${logTag}:about_concept`, e);
            edges = before;
        }
    }
    return { id: memoryId, edges };
}
async function commitArtifact(deps, data) {
    const { store, embeddings } = deps;
    const logTag = `commit:artifact:${data.type}`;
    // Embed the description (richer than the path alone for similarity).
    let embedding = data.precomputedVec ?? null;
    if (!embedding && embeddings.isAvailable()) {
        try {
            embedding = await embeddings.embed(`${data.path} ${data.description}`);
        }
        catch (e) {
            swallow(`${logTag}:embed`, e);
        }
    }
    // Insert the artifact row.
    const artifactId = await store.createArtifact(data.path, data.type, data.description, embedding, data.projectId);
    let edges = 0;
    // Auto-seal: artifact → concepts (artifact_mentions) by similarity.
    // Previously only the dormant memory-daemon did this for artifact writes;
    // hot-path artifact creation from post-tool-use.ts left artifacts
    // disconnected from the concept graph.
    if (artifactId && data.linkConcepts !== false && embedding && embedding.length > 0) {
        const before = edges;
        try {
            await linkToRelevantConcepts(artifactId, "artifact_mentions", `${data.path} ${data.description}`, store, embeddings, logTag, 5, 0.65, embedding);
            edges += 1;
        }
        catch (e) {
            swallow(`${logTag}:artifact_mentions`, e);
            edges = before;
        }
    }
    return { id: artifactId, edges };
}
async function commitReflection(deps, data) {
    const { store, embeddings } = deps;
    const logTag = `commit:reflection:${data.category ?? "default"}`;
    // 0. Validate: the architectural anchor making orphan reflects_on writes
    //    impossible at the API boundary. surrealSessionId is required by the
    //    interface (no `?`), TypeScript enforces at compile time. Runtime
    //    check is defense-in-depth for JS callers / type erasure paths.
    if (!data.surrealSessionId) {
        throw new Error("commitReflection: surrealSessionId is required; reflects_on edge cannot be sealed without it");
    }
    // 1. Content filter — v0.7.73 regex set, extracted to reflection-filter.ts.
    let importance = data.importance ?? 7.0;
    let allowEmbedding = true;
    if (data.applyContentFilter !== false) {
        const verdict = classifyReflection(data.text);
        if (verdict === "drop") {
            log.warn(`${logTag}: dropped anti-thoroughness reflection: ${data.text.slice(0, 120)}`);
            return { id: "", edges: 0 };
        }
        if (verdict === "downgrade") {
            log.warn(`${logTag}: downgrading audit-log style reflection: ${data.text.slice(0, 120)}`);
            importance = 3.0;
            allowEmbedding = false;
        }
    }
    // 2. Embed text (or reuse precomputedVec). Downgraded rows skip embedding
    //    so they neither rank in retrieval nor compete in dedup.
    let embedding = data.precomputedVec ?? null;
    if (!embedding && allowEmbedding && embeddings.isAvailable()) {
        try {
            embedding = await embeddings.embed(data.text);
        }
        catch (e) {
            swallow(`${logTag}:embed`, e);
        }
    }
    // 3. Cosine-similarity dedup. undefined → 0.85 (matches pre-v0.7.76).
    //    null → disable.
    const threshold = data.dedupCosineThreshold === undefined ? 0.85 : data.dedupCosineThreshold;
    if (threshold !== null && embedding?.length) {
        const existing = await store.queryFirst(`SELECT vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection WHERE embedding != NONE
       ORDER BY score DESC LIMIT 1`, { vec: embedding });
        if ((existing[0]?.score ?? 0) > threshold) {
            return { id: "", edges: 0 };
        }
    }
    // 4. CREATE the reflection row.
    const record = {
        session_id: data.sessionId,
        text: data.text,
        category: data.category ?? "efficiency",
        severity: data.severity ?? "minor",
        importance,
    };
    if (embedding?.length)
        record.embedding = embedding;
    if (data.projectId)
        record.project_id = data.projectId;
    const rows = await store.queryFirst(`CREATE reflection CONTENT $record RETURN id`, { record });
    const reflectionId = String(rows[0]?.id ?? "");
    if (!reflectionId) {
        swallow.warn(`${logTag}:create`, new Error("CREATE reflection returned no id"));
        return { id: "", edges: 0 };
    }
    // 5. Auto-seal the reflects_on edge. Failure is logged but doesn't bubble;
    //    the row exists with an observable edges=0 orphan canary in the result.
    let edges = 0;
    try {
        await store.relate(reflectionId, "reflects_on", data.surrealSessionId);
        edges = 1;
    }
    catch (e) {
        swallow.warn(`${logTag}:reflects_on`, e);
    }
    // 6. Invalidate the reflection cache used by retrieval injection.
    store.clearReflectionCache();
    return { id: reflectionId, edges };
}
