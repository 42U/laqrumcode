/**
 * Concept linking — pure edge-wiring helpers.
 *
 * Extracted from concept-extract.ts in 0.4.0 so that commit.ts can compose
 * these helpers without creating a circular import: commit.ts wants to
 * fire hierarchy + related_to links inside commitKnowledge, while
 * concept-extract.ts's upsertAndLinkConcepts wants to route through
 * commitKnowledge. Shared state-writer helpers living in their own module
 * lets both arrows point inward to this leaf file and nothing points back.
 */

import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import { swallow } from "./errors.js";

/**
 * Embedding-based concept linking.
 *
 * Given a source node (memory, artifact, turn, skill) and its text content,
 * embeds the text and finds the top-N most similar concepts in the graph,
 * then creates edges from source → concept via the specified relation.
 *
 * This ensures linking works even when relevant concepts were created in
 * prior batches or sessions — no batch-timing dependency.
 */
export async function linkToRelevantConcepts(
  sourceId: string,
  edgeName: string,
  text: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  logTag: string,
  limit = 5,
  threshold = 0.65,
  precomputedVec?: number[] | null,
): Promise<void> {
  if (!embeddings.isAvailable() || !text) return;
  try {
    const vec = precomputedVec?.length ? precomputedVec : await embeddings.embed(text);
    if (!vec?.length) return;
    const matches = await store.queryFirst<{ id: string; score: number }>(
      `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM concept
       WHERE embedding != NONE AND array::len(embedding) > 0
         AND superseded_at IS NONE
       ORDER BY score DESC
       LIMIT $lim`,
      { vec, lim: limit },
    );
    for (const m of matches) {
      if (m.score < threshold) break;
      await store.relate(sourceId, edgeName, String(m.id))
        .catch(e => swallow(`${logTag}:relate`, e));
    }
  } catch (e) {
    swallow(`${logTag}:embed`, e);
  }
}

/**
 * Link a newly-upserted concept to existing concepts via narrower/broader
 * edges when one concept's name is a substring of the other (indicating a
 * parent-child hierarchy, e.g. "React" → "React hooks"), plus related_to
 * edges for peer-level semantic associations.
 *
 * Concept selection is KNN-based on the new concept's embedding (top-50 by
 * cosine similarity against the `concept_vec_idx` HNSW index in schema.surql).
 * Pre-0.7.x this used `LIMIT 50` with no ORDER BY, which returned the first
 * 50 concepts in insertion order — so as the graph grew, hierarchy auto-seal
 * only ever saw the oldest 50 nodes and never wired edges into recent topical
 * additions. KNN restores the original intent: candidate hierarchy peers
 * should be the ones actually near this concept in embedding space.
 *
 * When the embedding is unavailable (no embeddings service or zero-vec),
 * we fall back to the old insertion-order scan so degraded environments still
 * produce some edges instead of none.
 */
export async function linkConceptHierarchy(
  conceptId: string,
  conceptName: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
  logTag: string,
  precomputedNameVec?: number[] | null,
): Promise<void> {
  try {
    // Resolve the concept's embedding up-front. Both the hierarchy candidate
    // pre-filter (this function) and the related_to similarity search below
    // need the same vector, so we embed once and reuse.
    let conceptEmb: number[] | null = precomputedNameVec ?? null;
    if (!conceptEmb?.length && embeddings.isAvailable()) {
      try { conceptEmb = await embeddings.embed(conceptName); }
      catch (e) { swallow(`${logTag}:embed`, e); }
    }

    // KNN-based candidate fetch: top-50 nearest concepts by cosine similarity
    // to the new concept's embedding. Backed by `concept_vec_idx` HNSW index
    // (schema.surql:62, DIMENSION 1024 DIST COSINE). When embeddings are
    // unavailable, fall back to a raw LIMIT scan so the substring-hierarchy
    // path still runs on rows that happen to share lexical structure.
    const existing = conceptEmb?.length
      ? await store.queryFirst<{ id: string; content: string }>(
          `SELECT id, content,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM concept
           WHERE id != $cid
             AND embedding != NONE AND array::len(embedding) > 0
             AND superseded_at IS NONE
           ORDER BY score DESC
           LIMIT 50`,
          { vec: conceptEmb, cid: conceptId },
        )
      : await store.queryFirst<{ id: string; content: string }>(
          `SELECT id, content FROM concept WHERE id != $cid LIMIT 50`,
          { cid: conceptId },
        );
    if (existing.length === 0) return;

    const lowerName = conceptName.toLowerCase();

    for (const other of existing) {
      const otherLower = (other.content ?? "").toLowerCase();
      if (!otherLower || otherLower === lowerName) continue;

      const otherId = String(other.id);

      if (lowerName.includes(otherLower) && lowerName !== otherLower) {
        // New concept is more specific (e.g. "React hooks" contains "React")
        await store.relate(conceptId, "narrower", otherId)
          .catch(e => swallow.warn(`${logTag}:narrower`, e));
        await store.relate(otherId, "broader", conceptId)
          .catch(e => swallow.warn(`${logTag}:broader`, e));
      } else if (otherLower.includes(lowerName) && otherLower !== lowerName) {
        // New concept is more general (e.g. "React" contained in "React hooks")
        await store.relate(conceptId, "broader", otherId)
          .catch(e => swallow.warn(`${logTag}:broader`, e));
        await store.relate(otherId, "narrower", conceptId)
          .catch(e => swallow.warn(`${logTag}:narrower`, e));
      }
    }

    // related_to: peer-level semantic association via embedding similarity.
    // Reuses the embedding fetched above so we don't pay for it twice.
    if (embeddings.isAvailable() && conceptEmb?.length) {
      try {
        const similar = await store.queryFirst<{ id: string; score: number }>(
          `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
           FROM concept
           WHERE id != $cid
             AND embedding != NONE AND array::len(embedding) > 0
             AND superseded_at IS NONE
           ORDER BY score DESC
           LIMIT 3`,
          { vec: conceptEmb, cid: conceptId },
        );
        for (const s of similar) {
          if (s.score < 0.75) break;
          const simId = String(s.id);
          await store.relate(conceptId, "related_to", simId)
            .catch(e => swallow.warn(`${logTag}:related_to`, e));
          await store.relate(simId, "related_to", conceptId)
            .catch(e => swallow.warn(`${logTag}:related_to`, e));
        }
      } catch (e) {
        swallow(`${logTag}:related_to_search`, e);
      }
    }
  } catch (e) {
    swallow(`${logTag}:hierarchy`, e);
  }
}
