/**
 * UNIQUE (in, out) edge indexes — W2-05, the keystone of the 2026-06-10
 * edge-integrity wave.
 *
 * Background: zero edge tables had uniqueness constraints, so every duplicate
 * RELATE — hook re-fires, RPC-timeout retries, per-turn re-link scans — landed
 * as a new live edge row. Measured production damage: ~595,782 of 645,798 edge
 * rows (92%) were exact (in,out) duplicates or self-loops, with single pairs
 * reaching ×4,541 copies. Application-side pre-checks proved bypassable (the
 * linkToProject guard was a silent no-op for its entire life); these indexes
 * convert dedup from app discipline into a DB invariant, exactly as the
 * duplicate-row seal did for node tables.
 *
 * Boot strategy: DEFINE INDEX IF NOT EXISTS per table. A table that still
 * contains duplicate (in,out) pairs fails the build — it gets flagged in
 * <cacheDir>/edge-indexes-pending.json and skipped on later boots (one warn,
 * no per-boot rebuild cost) until scripts/dedup-edges.mjs cleans the table and
 * removes the flag file; the next boot then arms it. Fresh installs (no
 * duplicates) arm everything on first boot.
 *
 * store.relate() treats the resulting unique violations as idempotent
 * success-without-write (W2-06), so writers need no awareness of the indexes.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SurrealStore } from "./surreal.js";
import { log } from "./log.js";
import { swallow } from "./errors.js";

/** Edge tables with confirmed duplicate-write paths (QA waterfall, 2026-06-10).
 *  Naturally-fresh edges (part_of, responds_to, performed, … — endpoints are
 *  per-turn/per-session rows that never repeat a pair) are deliberately not
 *  indexed: lower migration surface, nothing to protect. */
export const GUARDED_EDGE_TABLES = [
  "related_to",
  "broader",
  "narrower",
  "derived_from",
  "relevant_to",
  "used_in",
  "about_concept",
  "artifact_mentions",
  "owns",
  "supersedes",
] as const;

export function pendingFlagPath(cacheDir: string): string {
  return join(cacheDir, "edge-indexes-pending.json");
}

export async function ensureEdgeIndexes(
  store: SurrealStore,
  cacheDir: string,
): Promise<{ defined: string[]; skipped: string[] }> {
  const flagPath = pendingFlagPath(cacheDir);
  let pending: Record<string, string> = {};
  try {
    if (existsSync(flagPath)) pending = JSON.parse(readFileSync(flagPath, "utf8"));
  } catch {
    pending = {};
  }

  const defined: string[] = [];
  const skipped: string[] = [];
  for (const table of GUARDED_EDGE_TABLES) {
    if (pending[table]) {
      skipped.push(table);
      continue;
    }
    try {
      await store.queryExec(
        `DEFINE INDEX IF NOT EXISTS ${table}_inout_unique ON ${table} FIELDS in, out UNIQUE`,
      );
      defined.push(table);
    } catch (e) {
      // Existing duplicate (in,out) rows block the UNIQUE build. Flag the
      // table so subsequent boots skip the (potentially seconds-long) failed
      // attempt; the dedup migration deletes the flag file to re-arm.
      pending[table] = new Date().toISOString();
      skipped.push(table);
      swallow.warn(`edgeIndexes:${table}`, e);
    }
  }

  if (skipped.length > 0) {
    try { writeFileSync(flagPath, JSON.stringify(pending, null, 2)); } catch { /* best-effort */ }
    log.warn(
      `[edge-indexes] ${skipped.length} edge table(s) blocked from UNIQUE (in,out) by existing duplicates: ` +
      `${skipped.join(", ")} — run scripts/dedup-edges.mjs (it clears ${flagPath}; the next daemon boot arms them).`,
    );
  } else if (defined.length > 0) {
    try { if (existsSync(flagPath)) unlinkSync(flagPath); } catch { /* best-effort */ }
    log.info(`[edge-indexes] UNIQUE (in,out) armed on ${defined.length} edge table(s)`);
  }
  return { defined, skipped };
}
