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
// ── Entry point ───────────────────────────────────────────────────────────
export async function commitKnowledge(deps, data) {
    switch (data.kind) {
        case "concept":
            return commitConcept(deps, data);
        case "memory":
            return commitMemory(deps, data);
        case "artifact":
            return commitArtifact(deps, data);
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
