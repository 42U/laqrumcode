/**
 * Predictive Context Prefetching — Phase 7d
 *
 * After preflight classifies intent, predict 2-4 follow-up queries and fire
 * vector searches in the background. Results are cached in an LRU with 5-min TTL.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */
import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore, VectorSearchResult } from "./surreal.js";
import { type Skill } from "./skills.js";
import { type Reflection } from "./reflection.js";
import type { IntentCategory } from "./intent.js";
export declare function recordPrefetchHit(): void;
export declare function recordPrefetchMiss(): void;
export declare function getPrefetchHitRate(): {
    hits: number;
    misses: number;
    attempts: number;
    hitRate: number;
};
export declare function predictQueries(input: string, intent: IntentCategory): string[];
export declare function prefetchContext(queries: string[], sessionId: string, embeddings: EmbeddingService, store: SurrealStore, projectId?: string): Promise<void>;
export interface CachedContext {
    results: VectorSearchResult[];
    skills: Skill[];
    reflections: Reflection[];
}
export declare function getCachedContext(queryVec: number[]): CachedContext | null;
export declare function setCachedContext(queryVec: number[], results: VectorSearchResult[], skills: Skill[], reflections: Reflection[]): void;
export declare function getPrefetchStats(): {
    entries: number;
    maxSize: number;
};
export declare function clearPrefetchCache(): void;
