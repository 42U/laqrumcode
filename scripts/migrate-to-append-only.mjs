#!/usr/bin/env node
/**
 * migrate-to-append-only.mjs
 *
 * v0.7.93 migration: laqrumcode is moving from a destructive-consolidate
 * memory model (DELETE on stale/duplicate rows in garbageCollectMemories,
 * consolidateMemories, soul reset, identity-chunk replacement, etc.) to a
 * strictly append-only model where every row persists and is soft-deactivated
 * via `active = false` + `archived_at` + `archive_reason` + (for dedup-losers)
 * `superseded_by`.
 *
 * Founder rule (2026-05-17, core_memory:c7hcrruuezcmehmd30yd, Tier 0):
 *   "Nothing should be getting deleted."
 *
 * The schema additions (DEFINE FIELDs with IF NOT EXISTS) are applied
 * automatically on daemon startup via runSchema(). This script's job is the
 * one-time data backfill: existing rows in content-bearing tables that lack
 * the new fields need explicit values so readers' `(active = true OR active IS NONE)`
 * filters surface them correctly.
 *
 * Tables touched
 * --------------
 *   identity_chunk — added `active`, `archived_at`, `archive_reason`. Existing
 *                    rows get `active = true` (so they keep showing up in
 *                    recall and version checks).
 *   reflection     — added `active`, `archived_at`, `archive_reason`,
 *                    `superseded_by`. Existing rows get `active = true`.
 *   memory         — added `archived_at`, `archive_reason`, `superseded_by`.
 *                    NO backfill needed: memory already uses `status` field
 *                    (default "active"), and readers filter
 *                    `(status = 'active' OR status IS NONE)`. New fields stay
 *                    NONE on existing rows; they only get set by the new
 *                    soft-deactivate paths going forward.
 *   concept        — added `archive_reason`. NO backfill needed: concept uses
 *                    `superseded_at IS NONE` as the active filter.
 *   core_memory    — added `archived_at`, `archive_reason`. NO backfill: the
 *                    existing `active` field already defaults to true.
 *
 * Idempotency
 * -----------
 *   Re-running on an already-migrated DB is a no-op: it counts rows where
 *   `active IS NONE` on identity_chunk / reflection and, if zero, exits clean.
 *
 * Safety
 * ------
 *   - Dry-run by default; --apply to mutate.
 *   - Reads counts BEFORE mutating so the report is complete even on dry-run.
 *   - Uses raw surrealdb client (same pattern as repair-vector-dim.mjs and
 *     migrate-concept-superseded-by.mjs) so it does NOT trigger runSchema().
 *   - Verifies post-apply that the counts drop to 0.
 *
 * Usage
 * -----
 *   node scripts/migrate-to-append-only.mjs            # dry-run
 *   node scripts/migrate-to-append-only.mjs --apply    # execute
 *   node scripts/migrate-to-append-only.mjs --verbose
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

const BACKFILL_TABLES = ["identity_chunk", "reflection"];

async function qFirst(db, sql, bindings) {
  const r = await db.query(sql, bindings);
  const rows = Array.isArray(r) ? r[r.length - 1] : r;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[migrate-append-only] FATAL: no Surreal URL resolvable from config.");
    process.exit(2);
  }
  const { url, ns, db: dbName, user, pass } = config.surreal;

  const db = new Surreal();
  await db.connect(url, {
    namespace: ns,
    database: dbName,
    authentication: { username: user, password: pass },
  });

  try {
    await db.query("RETURN 1;");
  } catch (e) {
    console.error(`[migrate-append-only] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[migrate-append-only] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[migrate-append-only] surreal ${url}  ns=${ns}  db=${dbName}`);

  // ── Phase 1: classify ──────────────────────────────────────────────────
  console.log("\n=== Pre-migration counts ===");
  const pre = {};
  for (const tb of BACKFILL_TABLES) {
    try {
      const total = await qFirst(db, `SELECT count() AS c FROM ${tb} GROUP ALL`);
      const noneActive = await qFirst(db, `SELECT count() AS c FROM ${tb} WHERE active IS NONE GROUP ALL`);
      const totalCount = Number(total[0]?.c ?? 0);
      const noneCount = Number(noneActive[0]?.c ?? 0);
      pre[tb] = { total: totalCount, none: noneCount };
      console.log(`  ${tb.padEnd(15)} total=${String(totalCount).padStart(5)}  active IS NONE=${String(noneCount).padStart(5)}`);
    } catch (e) {
      console.error(`  [${tb}] ERROR during scan: ${e?.message ?? e}`);
      pre[tb] = { total: 0, none: 0, error: true };
    }
  }

  const totalToBackfill = Object.values(pre).reduce((acc, x) => acc + (x.error ? 0 : x.none), 0);

  if (totalToBackfill === 0) {
    console.log("\n  All rows already have explicit `active` set — nothing to backfill. Exiting clean.");
    await db.close().catch(() => {});
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\n(dry-run — ${totalToBackfill} row(s) would be backfilled with active=true.`);
    console.log(" Re-run with --apply to execute.)");
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Phase 2: apply ─────────────────────────────────────────────────────
  console.log("\n=== Applying backfill ===");
  const results = {};
  for (const tb of BACKFILL_TABLES) {
    if (pre[tb].error || pre[tb].none === 0) {
      results[tb] = { updated: 0, skipped: pre[tb].none };
      continue;
    }
    try {
      const updateSql = `UPDATE ${tb} SET active = true WHERE active IS NONE`;
      if (VERBOSE) console.log(`  [${tb}] ${updateSql}`);
      await db.query(updateSql);
      results[tb] = { updated: pre[tb].none, skipped: 0 };
      console.log(`  [${tb}] backfilled ${pre[tb].none} rows with active = true`);
    } catch (e) {
      results[tb] = { updated: 0, failed: true, error: e?.message ?? String(e) };
      console.error(`  [${tb}] FAILED: ${e?.message ?? e}`);
    }
  }

  // ── Phase 3: verify ────────────────────────────────────────────────────
  console.log("\n=== Verifying post-migration state ===");
  let stillMissing = 0;
  for (const tb of BACKFILL_TABLES) {
    try {
      const remain = await qFirst(db, `SELECT count() AS c FROM ${tb} WHERE active IS NONE GROUP ALL`);
      const c = Number(remain[0]?.c ?? 0);
      stillMissing += c;
      if (c > 0) {
        console.log(`  [${tb}] STILL MISSING active: ${c}`);
      } else {
        console.log(`  [${tb}] OK — 0 rows missing active`);
      }
    } catch (e) {
      console.error(`  [${tb}] verify failed: ${e?.message ?? e}`);
      stillMissing += 1;
    }
  }

  console.log("\n=== RESULT ===");
  for (const tb of BACKFILL_TABLES) {
    const r = results[tb];
    if (r.failed) {
      console.log(`  ${tb.padEnd(15)} FAILED: ${r.error}`);
    } else {
      console.log(`  ${tb.padEnd(15)} backfilled ${r.updated} rows`);
    }
  }
  console.log(`  remaining missing active across all tables: ${stillMissing}`);

  await db.close().catch(() => {});
  process.exit(stillMissing > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[migrate-append-only] FATAL:", e);
  process.exit(1);
});
