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
export declare function linkToRelevantConcepts(sourceId: string, edgeName: string, text: string, store: SurrealStore, embeddings: EmbeddingService, logTag: string, limit?: number, threshold?: number, precomputedVec?: number[] | null): Promise<void>;
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
export declare function linkConceptHierarchy(conceptId: string, conceptName: string, store: SurrealStore, embeddings: EmbeddingService, logTag: string, precomputedNameVec?: number[] | null): Promise<void>;
