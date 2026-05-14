/**
 * Supersedes — concept evolution tracking.
 *
 * When the daemon extracts a correction (user correcting the assistant),
 * this module finds the concept(s) that contained the stale knowledge
 * and creates `supersedes` edges from the correction memory to those
 * concepts, decaying their stability so they lose priority in recall.
 *
 * Edge direction: correction_memory -> supersedes -> stale_concept
 *
 * This ensures that:
 * 1. Stale knowledge doesn't win over corrections in retrieval
 * 2. The graph records *why* a concept was deprecated
 * 3. Stability decay is proportional to correction confidence
 */
import { assertRecordId } from "./surreal.js";
import { swallow } from "./errors.js";
/** Minimum cosine similarity to consider a concept as the target of a correction. */
const SUPERSEDE_THRESHOLD = 0.70;
/** How much to decay stability of superseded concepts (multiplicative). */
const STABILITY_DECAY_FACTOR = 0.4;
/** Floor — don't decay below this so the concept remains discoverable. */
const STABILITY_FLOOR = 0.15;
/**
 * Find concepts AND memories that match the "original" (wrong) statement in
 * a correction, create supersedes edges, and decay their priority in retrieval.
 *
 * 0.7.46+: also targets memory rows. record_finding writes memory rows
 * synchronously while concept extraction is daemon-async. Without memory
 * targeting, supersede was a no-op against beliefs the user/agent had
 * just saved in the same session — silently breaking the documented
 * save→contradict→decay flow. Memories are marked status='superseded'
 * which excludes them from vectorSearch (filter: status='active' OR
 * status IS NONE). Concepts continue to use stability decay.
 *
 * @param correctionMemId - The memory:xxx record ID of the correction
 * @param originalText    - The "original" (incorrect) text from the correction
 * @param correctionText  - The "corrected" (right) text from the correction
 * @param store           - SurrealDB store
 * @param embeddings      - Embedding service
 * @param precomputedVec  - Optional pre-computed embedding of the full correction text
 * @returns               - Combined count of superseded concepts + memories
 */
export async function linkSupersedesEdges(correctionMemId, originalText, correctionText, store, embeddings, precomputedVec) {
    if (!embeddings.isAvailable() || !originalText)
        return 0;
    let supersededCount = 0;
    try {
        // Embed the *original* (wrong) text — that's what we're looking for in the graph
        const originalVec = await embeddings.embed(originalText);
        if (!originalVec?.length)
            return 0;
        // Find both concepts and memories matching the wrong statement, in parallel.
        const [conceptCandidates, memoryCandidates] = await Promise.all([
            store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score, stability
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND superseded_at IS NONE
           AND stability > $floor
         ORDER BY score DESC
         LIMIT 5`, { vec: originalVec, floor: STABILITY_FLOOR }),
            store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
         FROM memory
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND (status = 'active' OR status IS NONE)
           AND id != $correctionId
         ORDER BY score DESC
         LIMIT 5`, { vec: originalVec, correctionId: correctionMemId }),
        ]);
        for (const candidate of conceptCandidates) {
            if (candidate.score < SUPERSEDE_THRESHOLD)
                break;
            const conceptId = String(candidate.id);
            await store.relate(correctionMemId, "supersedes", conceptId)
                .catch(e => swallow.warn("supersedes:relate", e));
            const currentStability = candidate.stability ?? 1.0;
            const newStability = Math.max(STABILITY_FLOOR, currentStability * STABILITY_DECAY_FACTOR);
            try {
                assertRecordId(conceptId);
                assertRecordId(correctionMemId);
                // concept.superseded_by is now `option<record<memory>>` (migrated
                // 2026-05-13 via scripts/migrate-concept-superseded-by.mjs). The
                // SurrealDB type coercer rejects bare strings against a record-typed
                // field, so wrap the binding with type::record() — it parses the
                // "memory:xxx" string back into a Thing on the server side. Same
                // mechanism is used in skills.ts for skill.superseded_by.
                await store.queryExec(`UPDATE ${conceptId} SET stability = $newStability, superseded_at = time::now(), superseded_by = type::record($correctionId)`, { newStability, correctionId: correctionMemId });
            }
            catch (e) {
                // Critical write path: if decay fails the stale concept keeps competing
                // in recall and the supersede contract silently breaks. Surface it.
                swallow.warn("supersedes:decay", e);
            }
            supersededCount++;
        }
        // Memories: same threshold, set status='superseded' so vectorSearch
        // excludes them. resolved_at/resolved_by reuse existing schema fields.
        for (const candidate of memoryCandidates) {
            if (candidate.score < SUPERSEDE_THRESHOLD)
                break;
            const memoryId = String(candidate.id);
            await store.relate(correctionMemId, "supersedes", memoryId)
                .catch(e => swallow.warn("supersedes:relate-memory", e));
            try {
                assertRecordId(memoryId);
                await store.queryExec(`UPDATE ${memoryId} SET status = 'superseded', resolved_at = time::now(), resolved_by = $correctionId`, { correctionId: correctionMemId });
            }
            catch (e) {
                // Critical write path: if the status flip fails the stale memory keeps
                // surfacing in vectorSearch (which filters on status='active' OR NONE).
                swallow.warn("supersedes:mark-memory", e);
            }
            supersededCount++;
        }
    }
    catch (e) {
        swallow("supersedes:link", e);
    }
    return supersededCount;
}
