#!/usr/bin/env node
/**
 * One-shot cleanup: retire the `summarizes` legacy bare RELATION table.
 *
 * Stage 2 audit Q8 + A5 conclusion: `git log -S "summarizes"` shows no writer
 * for this table in repo history. Live DB carries 55 rows shaped
 * {in: memory:..., out: session:...} that originate from a pre-fork
 * ancestor or out-of-tree script. The bare `DEFINE TABLE summarizes TYPE
 * RELATION;` has no IN/OUT type constraints — confirmed via INFO FOR TABLE.
 *
 * Stage 3 user decision: DELETE (option A5-DELETE). This script drops the
 * legacy rows and (with --apply) REMOVEs the table definition from the live
 * DB. The schema.surql edit in Stage 3 removes the DEFINE TABLE so future
 * daemon boots don't re-create it; this script handles the live mutation.
 *
 * Usage (from repo root):
 *   node scripts/cleanup-summarizes-legacy.mjs            # dry-run
 *   node scripts/cleanup-summarizes-legacy.mjs --apply    # actually mutate
 *   node scripts/cleanup-summarizes-legacy.mjs --verbose
 *
 * Idempotent: a second --apply pass finds zero rows and a missing table,
 * and exits cleanly.
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

async function qFirst(db, sql, bindings) {
  const result = await db.query(sql, bindings);
  const rows = Array.isArray(result) ? result[result.length - 1] : result;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[cleanup-summarizes] FATAL: no Surreal URL resolvable from config.");
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
    console.error(`[cleanup-summarizes] FATAL: connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[cleanup-summarizes] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[cleanup-summarizes] surreal ${url}  ns=${ns}  db=${dbName}`);

  // Count rows. If the table doesn't exist yet, SurrealDB returns empty.
  let totalRows = 0;
  try {
    const countRows = await qFirst(db, "SELECT count() AS n FROM summarizes GROUP ALL");
    totalRows = Number(countRows?.[0]?.n ?? 0);
  } catch (e) {
    console.log(`[cleanup-summarizes] count query failed (table likely absent): ${e?.message ?? e}`);
  }
  console.log(`[cleanup-summarizes] summarizes rows: ${totalRows}`);

  if (VERBOSE && totalRows > 0) {
    try {
      const sample = await qFirst(db, "SELECT id, in, out FROM summarizes LIMIT 5");
      for (const r of sample) {
        console.log(`  ${r.id}: in=${r.in} out=${r.out}`);
      }
      if (totalRows > sample.length) console.log(`  …and ${totalRows - sample.length} more`);
    } catch (e) {
      console.log(`  (sample query failed: ${e?.message ?? e})`);
    }
  }

  if (!APPLY) {
    console.log("\n=== SUMMARY (dry-run) ===");
    console.log(`  would DELETE ${totalRows} rows from summarizes`);
    console.log(`  would REMOVE TABLE summarizes`);
    console.log("\n(re-run with --apply to actually mutate)");
    await db.close().catch(() => {});
    process.exit(0);
  }

  let deleted = 0;
  let removed = false;
  let errors = 0;

  if (totalRows > 0) {
    try {
      await db.query("DELETE FROM summarizes");
      console.log(`[cleanup-summarizes] deleted ${totalRows} rows from summarizes`);
      deleted = totalRows;
    } catch (e) {
      console.error(`[cleanup-summarizes] DELETE failed: ${e?.message ?? e}`);
      errors++;
    }
  }

  try {
    await db.query("REMOVE TABLE IF EXISTS summarizes");
    console.log("[cleanup-summarizes] REMOVE TABLE summarizes succeeded");
    removed = true;
  } catch (e) {
    console.error(`[cleanup-summarizes] REMOVE TABLE failed: ${e?.message ?? e}`);
    errors++;
  }

  console.log("\n=== SUMMARY ===");
  console.log(`  deleted: ${deleted} rows`);
  console.log(`  table removed: ${removed ? "yes" : "no"}`);
  if (errors > 0) console.log(`  errors: ${errors}`);

  await db.close().catch(() => {});
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[cleanup-summarizes] FATAL:", e);
  process.exit(1);
});
