/**
 * Background maintenance — ONCE per process (0.7.118), canonical caller is
 * the daemon boot (daemon/index.ts, post-embeddings-init); the legacy
 * mcp-server.ts and session-start invocations no-op after the first run.
 * On a degraded boot (store down) the guard is NOT latched: a deduped 5-min
 * self-retry plus any later session-start re-attempts until the store is up.
 *
 * Restores the five jobs that used to live in LaqrumBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. LaqrumCode has no such framework call, so these had been silently
 * not running since the port. See GitHub issue history around 2026-04-21 —
 * and the 2026-06-10 recurrence: on the daemon-split architecture the only
 * wired callers were the legacy monolith and the session-start hook, so with
 * hooks degraded NOTHING ran maintenance at all.
 *
 * Each job is internally bounded (count<=200/2000/50 safety floors, LIMIT 50
 * on destructive operations) and idempotent. The ACAN retrain carries its own
 * lockfile from acan.ts preventing concurrent retrains across sibling MCPs.
 * Recurring needs (embedding backfills) are covered by the 6h interval armed
 * in Group 3.
 *
 * Fire-and-forget — the caller should not await this. Errors go to
 * swallow.warn so they're visible without blocking startup.
 */
import type { GlobalPluginState } from "./state.js";
/** Test-only: clear the once-per-process guard so suites can invoke
 *  runBootstrapMaintenance repeatedly with fresh fake states. */
export declare function __resetBootstrapMaintenanceForTests(): void;
/**
 * E1 (observability) — run a maintenance job and ALWAYS record a
 * maintenance_runs row in a finally, so a job that throws is distinguishable
 * from one that never ran or succeeded.
 *
 * Before this, the orchestration jobs in this file (purgeStaleEmbedCache,
 * the backfills, seedSkillsFromJson, the sweep, consolidate, etc.) recorded
 * NOTHING — only the surreal.ts in-class jobs wrote a maintenance_runs row,
 * and they wrote it as the LAST statement in their try block, so any throw
 * recorded nothing at all. memory_health never read the table, so a job that
 * always-throws (the purgeStaleEmbedCache class) was invisible and health
 * stayed green.
 *
 * Contract:
 *   - SUCCESS: writes {job, status:'ok', rows_affected, duration_ms}.
 *     rows_affected = the fn's numeric return (0 if it returns void).
 *   - THROW:   writes {job, status:'error', error: msg.slice(0,300),
 *     duration_ms}, then SWALLOWS the error so the maintenance cycle
 *     continues (matches the fire-and-forget, never-block-startup contract).
 *
 * Store-guarded: if the store is unavailable we cannot record a row, so we run
 * the fn best-effort (it self-guards on store too) and skip the audit write —
 * recording is pointless when the store is down and a degraded boot already
 * leaves the once-guard unlatched for a retry.
 */
export declare function runJob(state: GlobalPluginState, name: string, fn: () => Promise<number | void> | number | void): Promise<void>;
export declare function runBootstrapMaintenance(state: GlobalPluginState): void;
/** The full unembedded-row sweep, table by table. Boot Group 3 runs it once
 *  (after consolidateMemories proves BGE-M3 is live) and a 6h interval keeps
 *  it running thereafter. Exported for tests. */
export declare function runEmbeddingBackfills(state: GlobalPluginState): Promise<void>;
/** Seed the `skill` table from the repo-committed JSON snapshot at
 *  `.claude-plugin/skills-seed.json`. This is how fresh laqrumcode installs
 *  get the curated skills since the SKILL.md files on disk are 5-line
 *  stubs (v0.7.84 moved the skill bodies into the DB as the founder's
 *  no-md-proliferation directive).
 *
 *  Idempotent: per-row dedup by name. Existing skill rows (from prior
 *  migrations or prior boots) are never overwritten. Newly-inserted rows
 *  are tagged `source: "seed"` so the embedding backfill picks them up on
 *  the same boot. */
export declare function seedSkillsFromJson(state: GlobalPluginState): Promise<void>;
