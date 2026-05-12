/**
 * Metacognitive Reflection
 *
 * At session end, reviews own performance: tool failures, runaway detections,
 * low retrieval utilization, wasted tokens. If problems exceeded thresholds,
 * generates a structured reflection via the configured LLM, stored as high-importance memory.
 * Retrieved when similar situations arise in future sessions.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */
import type { SurrealStore } from "./surreal.js";
export interface Reflection {
    id: string;
    text: string;
    category: string;
    severity: string;
    importance: number;
    score?: number;
}
/**
 * Vector search on the reflection table.
 *
 * 0.7.26: optional projectId scopes reflections to those originating from
 * sessions in the same project (or marked scope='global'). Reflections are
 * session-keyed and sessions are project-keyed via task_part_of, so we filter
 * by traversing reflection.session_id → session.project_id. Soft filter:
 * reflections without a resolvable project still surface (back-compat).
 */
export declare function retrieveReflections(queryVec: number[], limit?: number, store?: SurrealStore, projectId?: string): Promise<Reflection[]>;
/**
 * Format reflections as a context block for the LLM.
 */
export declare function formatReflectionContext(reflections: Reflection[]): string;
/**
 * Get reflection count (for /stats display).
 */
export declare function getReflectionCount(store: SurrealStore): Promise<number>;
