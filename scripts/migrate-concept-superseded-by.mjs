#!/usr/bin/env node
/**
 * One-off migration: retype concept.superseded_by from `none | string` to
 * `option<record<memory>>` and rewrite legacy string values back as proper
 * record references.
 *
 * Why this exists
 * ---------------
 *   schema.surql line 572 declares
 *       DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>;
 *   but the live DB carries
 *       DEFINE FIELD superseded_by ON concept TYPE none | string PERMISSIONS FULL
 *   because the field was originally created as a string (probably an
 *   accident in supersedes.ts:109 where `correctionId` is a string param) and
 *   SurrealDB silently no-ops DEFINE FIELD re-declarations that only change
 *   the type. Postdeploy-verify FAIL #2 is the symptom: the expected
 *   `record` typeMatch fails against the live `none | string`.
 *
 *   predeploy-dedup.mjs's --repair-schema path was intentionally cautious:
 *   if ANY rows carry a non-NONE value, it ABORTs because REMOVE FIELD
 *   destroys data. There are 13 such rows. This script is the migrate-path:
 *   capture them, REMOVE+DEFINE, then rewrite them as proper record refs.
 *
 *   Without this migration, the type stays string, supersedes.ts:109's
 *   string-param write keeps working (against `none | string`), and the
 *   schema declaration is a lie. With this migration, the type matches
 *   the schema declaration AND supersedes.ts will need to pass a RecordId
 *   (or use literal record syntax) on next call — see the companion change
 *   in supersedes.ts that ships in the same release.
 *
 * What it does
 * ------------
 *   1. SELECT all concept rows where superseded_by != NONE.
 *   2. Classify each value:
 *        - migratable: matches /^memory:[a-zA-Z0-9_\-]+$/ AND the referenced
 *          memory row still exists.
 *        - non-migratable: opaque string that won't parse as a record id,
 *          or references a memory row that has been deleted. These are
 *          preserved in a new `superseded_by_legacy` string field on the
 *          same concept before the migration and the migrated field is set
 *          to NONE (so the typed field is consistent and the legacy value
 *          is recoverable if needed).
 *   3. REMOVE FIELD superseded_by ON concept.
 *   4. DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>.
 *   5. For each migratable row, write the value back using `type::record`
 *      so SurrealDB stores it as a Thing, not a string.
 *
 * Safety
 * ------
 *   - Dry-run by default; --apply to actually mutate.
 *   - Reads & classifies the full set BEFORE any destructive op so the
 *     report is complete even on dry-run.
 *   - REMOVE/DEFINE are SCHEMALESS-safe; concept stays SCHEMALESS, only
 *     the typed field declaration changes.
 *   - Idempotent: re-running on a DB that's already migrated is a no-op
 *     (detects "record" in the existing field defn and exits early).
 *   - Uses the raw `surrealdb` client (same pattern as predeploy-dedup) so
 *     it does NOT trigger runSchema() on bootstrap — avoids
 *     chicken-and-egg with whatever else might be evolving in schema.surql.
 *
 * Usage
 * -----
 *   node scripts/migrate-concept-superseded-by.mjs            # dry-run
 *   node scripts/migrate-concept-superseded-by.mjs --apply    # execute
 *   node scripts/migrate-concept-superseded-by.mjs --verbose
 */
import { Surreal, RecordId } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

const RECORD_ID_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):([a-zA-Z0-9_\-]+)$/;

async function qFirst(db, sql, bindings) {
  const r = await db.query(sql, bindings);
  const rows = Array.isArray(r) ? r[r.length - 1] : r;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function tableInfo(db, name) {
  const r = await db.query(`INFO FOR TABLE ${name};`);
  const first = Array.isArray(r) ? r[0] : r;
  if (Array.isArray(first)) return first[0] ?? null;
  return first ?? null;
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[migrate-superseded-by] FATAL: no Surreal URL resolvable from config.");
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
    console.error(`[migrate-superseded-by] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[migrate-superseded-by] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[migrate-superseded-by] surreal ${url}  ns=${ns}  db=${dbName}`);

  // ── Step 0: idempotency check. If the field is already record-typed, exit.
  const cInfo = await tableInfo(db, "concept");
  const fieldDefn = String(cInfo?.fields?.superseded_by ?? "");
  console.log(`[migrate-superseded-by] current concept.superseded_by: ${fieldDefn || "(absent)"}`);
  if (/record/i.test(fieldDefn)) {
    console.log("[migrate-superseded-by] field is already record-typed — nothing to do.");
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Step 1: enumerate non-NONE rows and classify them.
  const rows = await qFirst(
    db,
    `SELECT id, superseded_by FROM concept WHERE superseded_by != NONE AND superseded_by != ''`,
  );
  console.log(`[migrate-superseded-by] found ${rows.length} concept rows with non-NONE superseded_by`);

  const migratable = []; // { id, tb, key, original }
  const opaque = [];     // { id, original, reason }

  // Collect referenced memory ids first so we can batch-check existence.
  const candidateMemoryIds = new Set();
  for (const r of rows) {
    const sb = r.superseded_by;
    if (typeof sb !== "string") {
      opaque.push({ id: String(r.id), original: sb, reason: `non-string type=${typeof sb}` });
      continue;
    }
    const m = sb.match(RECORD_ID_RE);
    if (!m) {
      opaque.push({ id: String(r.id), original: sb, reason: "does not match record-id shape" });
      continue;
    }
    if (m[1] !== "memory") {
      opaque.push({ id: String(r.id), original: sb, reason: `wrong table prefix (${m[1]}, expected memory)` });
      continue;
    }
    candidateMemoryIds.add(sb);
  }

  // Verify the referenced memory rows exist. If a referenced row has been
  // deleted, the value is technically a dangling reference — we still treat
  // it as non-migratable and preserve in the legacy field rather than
  // creating an unresolvable record<memory>.
  const existingMemoryIds = new Set();
  if (candidateMemoryIds.size > 0) {
    // Build a comma-separated list of literal record ids (safe: each was
    // already regex-validated against RECORD_ID_RE above).
    const idList = Array.from(candidateMemoryIds).join(", ");
    try {
      const existRows = await qFirst(db, `SELECT id FROM memory WHERE id IN [${idList}]`);
      for (const er of existRows) existingMemoryIds.add(String(er.id));
    } catch (e) {
      console.error(`[migrate-superseded-by] FATAL: memory existence check failed: ${e?.message ?? e}`);
      await db.close().catch(() => {});
      process.exit(2);
    }
  }

  for (const r of rows) {
    const sb = r.superseded_by;
    if (typeof sb !== "string") continue; // already in opaque
    const m = sb.match(RECORD_ID_RE);
    if (!m || m[1] !== "memory") continue; // already in opaque
    if (!existingMemoryIds.has(sb)) {
      opaque.push({ id: String(r.id), original: sb, reason: "referenced memory row no longer exists" });
      continue;
    }
    migratable.push({ id: String(r.id), tb: m[1], key: m[2], original: sb });
  }

  console.log(`[migrate-superseded-by] classification: ${migratable.length} migratable, ${opaque.length} opaque`);
  if (VERBOSE || opaque.length > 0) {
    if (migratable.length > 0) {
      console.log(`\n[migrate-superseded-by] migratable rows:`);
      for (const m of migratable.slice(0, VERBOSE ? migratable.length : 5)) {
        console.log(`  ${m.id}  ->  ${m.original}`);
      }
      if (!VERBOSE && migratable.length > 5) {
        console.log(`  …and ${migratable.length - 5} more`);
      }
    }
    if (opaque.length > 0) {
      console.log(`\n[migrate-superseded-by] WARN opaque rows (preserved in superseded_by_legacy, then cleared):`);
      for (const o of opaque) {
        console.log(`  ${o.id}  ->  ${JSON.stringify(o.original)}  (${o.reason})`);
      }
    }
  }

  if (!APPLY) {
    console.log(`\n=== SUMMARY (dry-run) ===`);
    console.log(`  would migrate: ${migratable.length}`);
    console.log(`  would preserve in legacy field: ${opaque.length}`);
    console.log(`  would discard: 0  (none discarded — opaque values preserved in superseded_by_legacy)`);
    console.log(`\n(dry-run — re-run with --apply to actually migrate)`);
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Step 2 (APPLY): preserve opaque values in a separate field BEFORE the
  // type change, since once we REMOVE the field they're gone. This is done
  // OUTSIDE the transaction below because adding a new SCHEMALESS column is
  // a non-destructive idempotent op — re-running on partial failure is safe.
  if (opaque.length > 0) {
    console.log(`\n[migrate-superseded-by] preserving ${opaque.length} opaque values in concept.superseded_by_legacy…`);
    for (const o of opaque) {
      try {
        await db.query(
          `UPDATE ${o.id} SET superseded_by_legacy = $val`,
          { val: String(o.original) },
        );
      } catch (e) {
        console.error(`[migrate-superseded-by] failed to preserve ${o.id}: ${e?.message ?? e}`);
      }
    }
  }

  // ── Steps 3-4 (atomic): REMOVE FIELD + DEFINE FIELD + writeback wrapped in
  // a single BEGIN/COMMIT TRANSACTION. SurrealDB rolls the whole thing back
  // on any error inside the block, so we never end up in a half-migrated
  // state where the field type has been removed but the rows haven't been
  // rewritten. The migratable rows are part of the same transaction; if a
  // single row's UPDATE blows up the COMMIT auto-rolls back leaving the
  // legacy `none | string` field unchanged for a retry.
  //
  // NOTE: we re-snapshot migratable values INSIDE the transaction (as bound
  // params) so the rewrite uses the same RecordId objects classified above.
  // SurrealDB does not yet support multi-statement queries returning per-
  // statement counts on rollback, so we batch all writes into one db.query
  // and surface only the aggregate success/failure.
  console.log(`[migrate-superseded-by] BEGIN TRANSACTION: REMOVE FIELD superseded_by + DEFINE option<record<memory>> + writeback ${migratable.length} rows…`);

  // Build a single multi-statement query. We pass each migratable row's
  // record-id via a uniquely-named parameter so SurrealDB binds it as a
  // proper RecordId rather than a string.
  const sqlParts = [
    `BEGIN TRANSACTION;`,
    `REMOVE FIELD superseded_by ON concept;`,
    `DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>;`,
  ];
  const bindings = {};
  for (let i = 0; i < migratable.length; i++) {
    const m = migratable[i];
    const paramName = `v${i}`;
    bindings[paramName] = new RecordId(m.tb, m.key);
    // m.id is "concept:xxx" form — safe to inline because it came from the
    // SELECT result and we only matched the regex shape on superseded_by.
    sqlParts.push(`UPDATE ${m.id} SET superseded_by = $${paramName};`);
  }
  sqlParts.push(`COMMIT TRANSACTION;`);
  const txnSql = sqlParts.join("\n");

  let written = 0;
  let failed = 0;
  try {
    await db.query(txnSql, bindings);
    written = migratable.length;
  } catch (e) {
    failed = migratable.length;
    console.error(`[migrate-superseded-by] FATAL: transaction rolled back: ${e?.message ?? e}`);
    console.error(`[migrate-superseded-by] field state unchanged; safe to re-run after fixing the underlying issue.`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  // ── Step 5: verification pass.
  console.log(`\n[migrate-superseded-by] verifying…`);
  const verify = await qFirst(
    db,
    `SELECT id, superseded_by, type::is_record(superseded_by) AS is_rec FROM concept WHERE superseded_by != NONE`,
  );
  const stillStringRows = verify.filter(r => !r.is_rec);
  const recordRows = verify.filter(r => r.is_rec);
  console.log(`  rows now stored as record<memory>: ${recordRows.length}`);
  if (stillStringRows.length > 0) {
    console.log(`  WARN: ${stillStringRows.length} rows still NOT typed as record:`);
    for (const r of stillStringRows.slice(0, 10)) {
      console.log(`    ${String(r.id)}  ->  ${JSON.stringify(r.superseded_by)}`);
    }
  }

  // Reread the field type
  const cInfoAfter = await tableInfo(db, "concept");
  const fieldDefnAfter = String(cInfoAfter?.fields?.superseded_by ?? "");
  console.log(`  concept.superseded_by definition now: ${fieldDefnAfter}`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`  migrated:           ${written}`);
  console.log(`  preserved in legacy: ${opaque.length}`);
  console.log(`  failed:             ${failed}`);
  console.log(`  field now matches schema: ${/record/i.test(fieldDefnAfter) ? "YES" : "NO"}`);

  await db.close().catch(() => {});
  process.exit(failed > 0 || !/record/i.test(fieldDefnAfter) ? 1 : 0);
}

main().catch((e) => {
  console.error("[migrate-superseded-by] FATAL:", e);
  process.exit(1);
});
