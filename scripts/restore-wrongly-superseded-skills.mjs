#!/usr/bin/env node
/**
 * restore-wrongly-superseded-skills.mjs
 *
 * Heal skills that were wrongly deactivated by supersedeOldSkills (pre-fix
 * to src/engine/skills.ts, 2026-05-17). The old function lacked a
 * name-equality guard, so unrelated skills with long-enough bodies cleared
 * the 0.82 cosine threshold and nuked each other via `active = false,
 * superseded_by = ${newId}`.
 *
 * This script:
 *   1. SELECTs inactive skills with non-empty body whose superseder has a
 *      DIFFERENT name — strong evidence of collateral deactivation.
 *   2. For each, UPDATEs SET active = true, superseded_by = NONE.
 *   3. Verifies post-apply that the count drops to 0.
 *
 * Safety
 * ------
 *   - Dry-run by default; --apply to mutate.
 *   - Reads the full classification BEFORE any destructive op so the report
 *     is complete even on dry-run.
 *   - Idempotent: re-running on a clean DB finds zero rows and exits 0.
 *   - Uses raw `surrealdb` client (mirrors probe-stuck.mjs and
 *     repair-vector-dim.mjs) so it does NOT trigger
 *     SurrealStore.initialize() / runSchema().
 *
 * Usage
 * -----
 *   node scripts/restore-wrongly-superseded-skills.mjs            # dry-run
 *   node scripts/restore-wrongly-superseded-skills.mjs --apply    # execute
 *   node scripts/restore-wrongly-superseded-skills.mjs --verbose  # print every offending id
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

async function qFirst(db, sql, bindings) {
  const r = await db.query(sql, bindings);
  const rows = Array.isArray(r) ? r[r.length - 1] : r;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[restore-superseded] FATAL: no Surreal URL resolvable from config.");
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
    console.error(`[restore-superseded] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[restore-superseded] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[restore-superseded] surreal ${url}  ns=${ns}  db=${dbName}`);

  // ── Phase 1: classify ──────────────────────────────────────────────────
  // SurrealDB supports record traversal: `superseded_by.name` fetches the
  // referenced row's name field. Filter in JS so we can also report the
  // pair (victim name, superseder name) for transparency.
  // Don't use string::len(body) in WHERE — SurrealDB errors on string::len(NONE)
  // when body is missing on some rows. Filter in JS instead.
  const candidates = await qFirst(
    db,
    `SELECT id, name, body, superseded_by AS new_id, superseded_by.name AS new_name, created_at
     FROM skill
     WHERE active = false
       AND superseded_by != NONE`,
  );

  const wrongly = candidates.filter(r =>
    r.name && r.new_name && r.name !== r.new_name &&
    typeof r.body === "string" && r.body.length > 0
  ).map(r => ({ ...r, body_len: r.body.length }));

  console.log(`[restore-superseded] inactive-with-body candidates: ${candidates.length}`);
  console.log(`[restore-superseded] wrongly-superseded (name mismatch): ${wrongly.length}`);
  if (VERBOSE || wrongly.length > 0) {
    for (const r of wrongly) {
      console.log(`  ${r.id}  name=${r.name}  body_len=${r.body_len}  superseded_by=${r.new_id}  (which is name=${r.new_name})`);
    }
  }

  if (wrongly.length === 0) {
    console.log("\n  nothing to restore. exiting clean.");
    await db.close().catch(() => {});
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\n(dry-run — re-run with --apply to restore these rows.");
    console.log(" Each row will be UPDATE'd: active=true, superseded_by=NONE.)");
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Phase 2: apply ─────────────────────────────────────────────────────
  let restored = 0;
  let failed = 0;
  for (const r of wrongly) {
    try {
      // Trusted id from SELECT; same pattern as repair-vector-dim.mjs L198.
      await db.query(`UPDATE ${r.id} SET active = true, superseded_by = NONE`);
      restored++;
      if (VERBOSE) console.log(`  restored ${r.id} (was wrongly superseded by ${r.new_id})`);
    } catch (e) {
      failed++;
      console.error(`  FAILED to restore ${r.id}: ${e?.message ?? e}`);
    }
  }

  // ── Phase 3: verify ────────────────────────────────────────────────────
  console.log("\n[restore-superseded] verifying…");
  const after = await qFirst(
    db,
    `SELECT id, name, body, superseded_by.name AS new_name FROM skill
     WHERE active = false
       AND superseded_by != NONE`,
  );
  const remainingWrongly = after.filter(r =>
    r.name && r.new_name && r.name !== r.new_name &&
    typeof r.body === "string" && r.body.length > 0
  );

  console.log(`\n=== RESULT ===`);
  console.log(`  rows restored: ${restored}  (failed: ${failed})`);
  console.log(`  remaining wrongly-superseded: ${remainingWrongly.length}`);
  if (remainingWrongly.length > 0) {
    for (const r of remainingWrongly) console.log(`  STILL WRONG: ${r.id}  name=${r.name}  → ${r.new_name}`);
  }

  await db.close().catch(() => {});
  process.exit(failed > 0 || remainingWrongly.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("[restore-superseded] FATAL:", e);
  process.exit(1);
});
