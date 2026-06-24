/**
 * Causal Memory Graph
 *
 * Activates the dormant caused_by/supports/contradicts edges in the graph.
 * At session end, analyzes the conversation for cause-effect sequences
 * (bug->investigation->fix->outcome) and creates causal chains linking memories.
 * During retrieval, traverses causal edges to pull full chains as context.
 *
 * Ported from laqrumbrain — takes SurrealStore/EmbeddingService as params.
 */
import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore, VectorSearchResult } from "./surreal.js";
export interface CausalChain {
    triggerText: string;
    outcomeText: string;
    chainType: "debug" | "refactor" | "feature" | "fix";
    success: boolean;
    confidence: number;
    description: string;
}
/**
 * Create memory nodes for each end of the chain and link them with
 * caused_by/supports/contradicts edges.
 */
export declare function linkCausalEdges(chains: CausalChain[], sessionId: string, store: SurrealStore, embeddings: EmbeddingService): Promise<void>;
/**
 * Given seed memory IDs from vector search, traverse causal edges
 * (caused_by, supports, contradicts) up to `hops` deep.
 * Computes cosine similarity server-side so results compete fairly in scoring.
 */
export declare function queryCausalContext(seedIds: string[], queryVec: number[], hops?: number, minConfidence?: number, store?: SurrealStore): Promise<VectorSearchResult[]>;
