/**
 * Graph recovery helpers — extracted from introspect.ts migrate handlers
 * (v0.7.26 backfill_project_id, v0.7.32 backfill_derived_from with v0.7.38
 * daemon path + v0.7.39 placeholder synthesis) into a reusable module.
 *
 * Use these when:
 *   - Importing data from another laqrumcode/laqrumbrain instance whose session
 *     metadata didn't fully migrate (X-close pattern, gateway purges).
 *   - After a schema change that renders previously-written rows orphan
 *     (the v0.7.23 derived_from schema mismatch was the canonical case).
 *   - Periodic maintenance — they're idempotent so safe to run on a cron.
 *
 * Each helper is pure + deterministic (no LLM calls, no embedding writes;
 * it only reads existing embeddings and writes RELATE/UPDATE statements).
 * The full-recovery orchestrator runs them in dependency order so a single
 * call brings any orphan-state graph to canonical structure.
 */
import type { SurrealStore } from "./surreal.js";
export interface ProjectIdRecoveryResult {
    tasks: {
        found: number;
        fixed: number;
    };
    sessions: {
        found: number;
        fixed: number;
    };
    concepts: {
        found: number;
        fixed: number;
    };
    memories: {
        found: number;
        fixed: number;
    };
    reflections: {
        found: number;
        fixed: number;
    };
    skills: {
        found: number;
        fixed: number;
    };
    centroidAssigned: number;
    centroidScanned: number;
    globalsTagged: number;
}
export interface DerivedFromRecoveryResult {
    gemOrphans: number;
    gemEdgesCreated: number;
    missingArtifact: number;
    daemonOrphans: number;
    daemonEdgesResolved: number;
    daemonEdgesSynthesized: number;
    synthesizedPlaceholders: number;
    missingTask: number;
    relateFailed: number;
}
export interface FullRecoveryResult {
    projectId: ProjectIdRecoveryResult;
    derivedFrom: DerivedFromRecoveryResult;
}
/** Compute embedding centroid per project from concepts linked via
 *  project_id. Returns a Map keyed by project record id. Skips projects
 *  with zero embedded concepts. */
export declare function computeProjectCentroids(store: SurrealStore): Promise<Map<string, number[]>>;
/** Find the highest-similarity project for a given embedding. Returns
 *  null when no project meets the threshold (caller should fall through
 *  to scope='global' tagging or leave the row unscoped). */
export declare function findBestProjectMatch(embedding: number[], centroids: Map<string, number[]>, threshold?: number): {
    projectId: string;
    similarity: number;
} | null;
/** Look up or create a placeholder task for a pre-substrate session_id.
 *  Used by `recoverDaemonOrphans` when a daemon-source orphan's session
 *  row doesn't exist (data imported from another instance). Idempotent
 *  via deterministic description naming. */
export declare function synthesizePlaceholderTask(store: SurrealStore, kcSessionId: string): Promise<string | null>;
/** Recover project_id metadata across all knowledge tables. Runs the
 *  full backfill cascade: traversal → centroid assignment → scope=global
 *  tagging for unrecoverable rows. Idempotent. */
export declare function recoverProjectIdRows(store: SurrealStore): Promise<ProjectIdRecoveryResult>;
/** Recover derived_from edges on orphaned concepts. Handles:
 *  - gem-source orphans (pre-v0.7.23 schema mismatch): match concept.source
 *    "gem:<X>" to artifact.path "<X>" and RELATE.
 *  - daemon-source orphans (taskId-empty extractions): traverse session
 *    to task, RELATE.
 *  - daemon-source orphans with no resolvable session: synthesize a
 *    placeholder task and RELATE. */
export declare function recoverDaemonOrphans(store: SurrealStore): Promise<DerivedFromRecoveryResult>;
/** Top-level orchestrator: runs both recovery passes in the right order.
 *  Useful for periodic maintenance or post-import cleanup. */
export declare function runFullRecovery(store: SurrealStore): Promise<FullRecoveryResult>;
