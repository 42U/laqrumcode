/**
 * Background maintenance — fired on MCP boot and on every SessionStart.
 *
 * Restores the five jobs that used to live in KongBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. KongCode has no such framework call, so these had been silently
 * not running since the port. See GitHub issue history around 2026-04-21.
 *
 * Each job is internally bounded (count<=200/2000/50 safety floors, LIMIT 50
 * on destructive operations) and idempotent, so it's safe to run on every
 * MCP boot AND on every SessionStart. The ACAN retrain carries its own
 * lockfile from acan.ts preventing concurrent retrains across sibling MCPs.
 *
 * Fire-and-forget — the caller should not await this. Errors go to
 * swallow.warn so they're visible without blocking startup.
 */
import type { GlobalPluginState } from "./state.js";
export declare function runBootstrapMaintenance(state: GlobalPluginState): void;
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
