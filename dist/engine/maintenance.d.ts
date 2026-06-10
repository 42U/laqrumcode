/**
 * Background maintenance — ONCE per process (0.7.118), canonical caller is
 * the daemon boot (daemon/index.ts, post-embeddings-init); the legacy
 * mcp-server.ts and session-start invocations no-op after the first run.
 * On a degraded boot (store down) the guard is NOT latched: a deduped 5-min
 * self-retry plus any later session-start re-attempts until the store is up.
 *
 * Restores the five jobs that used to live in KongBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. KongCode has no such framework call, so these had been silently
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
export declare function runBootstrapMaintenance(state: GlobalPluginState): void;
/** The full unembedded-row sweep, table by table. Boot Group 3 runs it once
 *  (after consolidateMemories proves BGE-M3 is live) and a 6h interval keeps
 *  it running thereafter. Exported for tests. */
export declare function runEmbeddingBackfills(state: GlobalPluginState): Promise<void>;
/** Seed the `skill` table from the repo-committed JSON snapshot at
 *  `.claude-plugin/skills-seed.json`. This is how fresh kongcode installs
 *  get the curated skills since the SKILL.md files on disk are 5-line
 *  stubs (v0.7.84 moved the skill bodies into the DB as the founder's
 *  no-md-proliferation directive).
 *
 *  Idempotent: per-row dedup by name. Existing skill rows (from prior
 *  migrations or prior boots) are never overwritten. Newly-inserted rows
 *  are tagged `source: "seed"` so the embedding backfill picks them up on
 *  the same boot. */
export declare function seedSkillsFromJson(state: GlobalPluginState): Promise<void>;
