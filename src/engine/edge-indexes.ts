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

/** Per-DEFINE/INFO budget. T5 (2026-06-10): the first two post-migration boots
 *  never logged ANY edge-indexes outcome — a DEFINE round-trip on the
 *  busy just-booted connection stalled indefinitely while the same statement
 *  on an idle connection no-ops in milliseconds. A hung await inside this
 *  fire-and-forget function is invisible; the timeout converts it into a
 *  visible, verifiable failure. */
const EDGE_INDEX_OP_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** True when `${table}_inout_unique` exists on the server — used as a
 *  fallback verification when DEFINE errors or times out. INFO FOR INDEX
 *  returns a `{ building: {...} }` object for an existing index and throws
 *  for an unknown one. */
async function indexExists(store: SurrealStore, table: string): Promise<boolean> {
  const info = await withTimeout(
    store.queryMulti<Record<string, unknown>>(
      `INFO FOR INDEX ${table}_inout_unique ON ${table}`,
    ),
    EDGE_INDEX_OP_TIMEOUT_MS,
    `INFO FOR INDEX ${table}`,
  );
  return info != null && typeof info === "object";
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

  // Entry marker — without it, a stall between here and the outcome log is
  // indistinguishable from "never ran" (exactly the 2026-06-10 silent-boot
  // diagnosis trap).
  const preSkipped = GUARDED_EDGE_TABLES.filter((t) => pending[t]);
  log.info(
    `[edge-indexes] verifying UNIQUE (in,out) on ${GUARDED_EDGE_TABLES.length} edge table(s)` +
    (preSkipped.length > 0 ? ` (${preSkipped.length} flagged-pending, skipped)` : ""),
  );

  const defined: string[] = [];
  const skipped: string[] = [];
  for (const table of GUARDED_EDGE_TABLES) {
    if (pending[table]) {
      skipped.push(table);
      continue;
    }
    try {
      await withTimeout(
        store.queryExec(
          `DEFINE INDEX IF NOT EXISTS ${table}_inout_unique ON ${table} FIELDS in, out UNIQUE`,
        ),
        EDGE_INDEX_OP_TIMEOUT_MS,
        `DEFINE INDEX ${table}`,
      );
      defined.push(table);
    } catch (e) {
      // A failed/hung DEFINE does NOT necessarily mean the table is dirty —
      // post-migration the index already exists and enforces, and the DEFINE
      // can still error or stall. Verify existence before flagging: an
      // existing index IS the goal state, so count it as armed.
      let exists = false;
      try { exists = await indexExists(store, table); } catch { exists = false; }
      if (exists) {
        defined.push(table);
        continue;
      }
      // Flag the table so subsequent boots skip the (potentially seconds-long)
      // failed attempt; the dedup migration resets the flag file to re-arm.
      // QA 0.7.117 item 2: record the CAUSE in the flag value — a timeout-
      // flagged clean table and a duplicate-blocked dirty one need different
      // operator responses, and asserting "duplicates" for both sent people
      // chasing dedup-edges on tables with zero duplicates.
      pending[table] = `${new Date().toISOString()} | ${
        e instanceof Error ? e.message.slice(0, 140) : String(e).slice(0, 140)
      }`;
      skipped.push(table);
      swallow.warn(`edgeIndexes:${table}`, e);
    }
  }

  if (skipped.length > 0) {
    try { writeFileSync(flagPath, JSON.stringify(pending, null, 2)); } catch { /* best-effort */ }
    log.warn(
      `[edge-indexes] ${skipped.length} edge table(s) blocked from UNIQUE (in,out): ` +
      `${skipped.join(", ")} — per-table cause recorded in ${flagPath}. ` +
      `Duplicate-blocked tables need scripts/dedup-edges.mjs (it resets the flag; the next boot arms them); ` +
      `timeout-flagged tables re-arm after deleting their flag entry.`,
    );
  } else if (defined.length > 0) {
    // NOTE (T5): the default LAQRUMCODE_LOG_LEVEL is "warn", so log.info lines
    // never reach daemon.log — exactly why post-migration boots looked
    // "silent" (2026-06-10 diagnosis). The flagged→armed RECOVERY transition
    // is the receipt the dedup-edges runbook points operators at, so it must
    // be visible at the default level; steady-state re-verification stays info.
    if (existsSync(flagPath)) {
      try { unlinkSync(flagPath); } catch { /* best-effort */ }
      log.warn(
        `[edge-indexes] recovered: all ${defined.length} edge table(s) now UNIQUE-armed; ` +
        `pending flag cleared (${flagPath})`,
      );
    } else {
      log.info(`[edge-indexes] UNIQUE (in,out) armed on ${defined.length} edge table(s)`);
    }
  }
  return { defined, skipped };
}
