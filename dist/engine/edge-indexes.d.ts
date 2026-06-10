import type { SurrealStore } from "./surreal.js";
/** Edge tables with confirmed duplicate-write paths (QA waterfall, 2026-06-10).
 *  Naturally-fresh edges (part_of, responds_to, performed, … — endpoints are
 *  per-turn/per-session rows that never repeat a pair) are deliberately not
 *  indexed: lower migration surface, nothing to protect. */
export declare const GUARDED_EDGE_TABLES: readonly ["related_to", "broader", "narrower", "derived_from", "relevant_to", "used_in", "about_concept", "artifact_mentions", "owns", "supersedes"];
export declare function pendingFlagPath(cacheDir: string): string;
export declare function ensureEdgeIndexes(store: SurrealStore, cacheDir: string): Promise<{
    defined: string[];
    skipped: string[];
}>;
