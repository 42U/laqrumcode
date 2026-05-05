/**
 * Retrieval Quality Tracker
 *
 * Measures whether retrieved context was actually useful, not just relevant.
 * Tracks 6 signals from research:
 * 1. Referenced in response (text overlap)
 * 2. Task success (tool executions)
 * 3. Retrieval stability
 * 4. Access patterns
 * 5. Context waste
 * 6. Contradiction detection
 *
 * Ported from kongbrain — uses SurrealStore instead of module-level DB.
 */
import type { SurrealStore, VectorSearchResult } from "./surreal.js";
export type RetrievedItem = VectorSearchResult & {
    finalScore?: number;
    fromNeighbor?: boolean;
};
interface QualitySignals {
    utilization: number;
    toolSuccess: boolean | null;
    contextTokens: number;
    wasNeighbor: boolean;
    recency: number;
}
export declare function getStagedItems(): RetrievedItem[];
export declare function stageRetrieval(sessionId: string, items: RetrievedItem[], queryEmbedding?: number[], indexMap?: Map<number, string>): void;
export declare function recordToolOutcome(success: boolean): void;
/**
 * Evaluate retrieval quality after assistant response.
 */
export declare function evaluateRetrieval(responseTurnId: string, responseText: string, store: SurrealStore): Promise<void>;
/** 0.7.27: count how many high-salience items the assistant ignored last
 *  turn. Used by cognitive-check to inject a Reflexion-style nudge. */
export declare function getLastTurnGroundingTrace(sessionId: string, store: SurrealStore): Promise<{
    injected: number;
    cited: number;
    ignored_high_salience: string[];
} | null>;
export declare function computeSignals(item: RetrievedItem, responseLower: string, toolSuccess: boolean | null, cited?: boolean, ceScore?: number | null): QualitySignals;
export declare function getHistoricalUtilityBatch(ids: string[], store?: SurrealStore): Promise<Map<string, number>>;
export declare function getRecentUtilizationAvg(sessionId: string, windowSize?: number, store?: SurrealStore): Promise<number | null>;
export {};
