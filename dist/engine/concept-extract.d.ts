/**
 * Shared concept-extraction helpers.
 *
 * Regex-based extraction of concept names from text, plus helpers to
 * upsert extracted concepts and link them via arbitrary edge types.
 */
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
export { linkToRelevantConcepts, linkConceptHierarchy } from "./concept-links.js";
export declare const CONCEPT_RE: RegExp;
/** Default upper bound on concepts returned per text. Override per call. */
export declare const DEFAULT_CONCEPT_CAP = 20;
/** Extract concept name strings from free text using regex heuristics. */
export declare function extractConceptNames(text: string, max?: number): string[];
/**
 * Upsert concepts from text and link them to a source node via the given edge.
 *
 * Used for:
 *  - turn  → "mentions"          → concept  (existing behaviour)
 *  - memory → "about_concept"    → concept  (Fix 1)
 *  - artifact → "artifact_mentions" → concept (Fix 2)
 */
export declare function upsertAndLinkConcepts(sourceId: string, edgeName: string, text: string, store: SurrealStore, embeddings: EmbeddingService, logTag: string, opts?: {
    taskId?: string;
    projectId?: string;
}): Promise<void>;
