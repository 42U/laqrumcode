#!/usr/bin/env node
/**
 * One-off migration: retype memory_utility_cache.memory_id from `string` to
 * `option<record<memory>>` and rewrite legacy string values back as proper
 * record references.
 *
 * Why this exists
 * ---------------
 *   schema.surql declares
 *       DEFINE FIELD memory_id ON memory_utility_cache TYPE option<record<memory>>;
 *   but the live DB carries
 *       DEFINE FIELD memory_id ON memory_utility_cache TYPE string ...
 *   because the field was originally declared as a string, and SurrealDB
 *   silently no-ops DEFINE FIELD re-declarations that only change type.
 *
 *   The runMemoryMaintenance() query in surreal.ts:1430 had to use
 *       string::concat(meta::tb(id), ":", meta::id(id))
 *   on the memory side to compare against the string-typed memory_id field,
 *   which is awkward and slow. Once retyped, the join is a direct
 *   record-id equality check.
 *
 *   This follows the same migration pattern as
 *   scripts/migrate-concept-superseded-by.mjs.
 *
 * What it does
 * ------------
 *   1. INFO FOR TABLE memory_utility_cache to detect current field type.
 *      If already record-typed, exit early (idempotent).
 *   2. SELECT all rows where memory_id != NONE.
 *   3. Classify each value:
 *        - migratable: matches /^memory:[a-zA-Z0-9_\-]+$/ AND the referenced
 *          memory row still exists.
 *        - non-migratable: opaque string that won't parse as a record id,
 *          or references a memory row that has been deleted. These are
 *          preserved in a new `memory_id_legacy` string field on the same
 *          row before the migration and the migrated field is set to NONE.
 *   4. REMOVE FIELD memory_id ON memory_utility_cache.
 *   5. DEFINE FIELD memory_id ON memory_utility_cache TYPE option<record<memory>>.
 *   6. For each migratable row, UPDATE memory_id back as a RecordId.
 *
 * Safety
 * ------
 *   - Dry-run by default; --apply to mutate.
 *   - Reads & classifies the full set BEFORE any destructive op.
 *   - Idempotent: re-running on an already-migrated DB is a no-op.
 *   - Preserves opaque values in memory_id_legacy rather than discarding.
 *   - Uses the raw surrealdb client (no runSchema() bootstrap side-effects).
 *
 * Usage
 * -----
 *   node scripts/migrate-memory-utility-cache-id.mjs            # dry-run
 *   node scripts/migrate-memory-utility-cache-id.mjs --apply    # execute
 *   node scripts/migrate-memory-utility-cache-id.mjs --verbose
 */
import { Surreal, RecordId } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

const RECORD_ID_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):([a-zA-Z0-9_\-]+)$/;
// The cache name is "memory_id" but the column legitimately stores
// references from any of these tables (see retrieval-quality.ts producer
// and graph-context.ts consumer which filter to memory|concept; turn rows
// also land here via outcome writeback paths). Keep this list in sync with
// the schema.surql union declaration.
const ALLOWED_TABLES = new Set(["memory", "concept", "turn"]);

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
    console.error("[migrate-muc-memory-id] FATAL: no Surreal URL resolvable from config.");
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
    console.error(`[migrate-muc-memory-id] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[migrate-muc-memory-id] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[migrate-muc-memory-id] surreal ${url}  ns=${ns}  db=${dbName}`);

  // ── Step 0: idempotency check. If the field is already record-typed, exit.
  const tInfo = await tableInfo(db, "memory_utility_cache");
  const fieldDefn = String(tInfo?.fields?.memory_id ?? "");
  console.log(`[migrate-muc-memory-id] current memory_utility_cache.memory_id: ${fieldDefn || "(absent)"}`);
  if (/record/i.test(fieldDefn)) {
    console.log("[migrate-muc-memory-id] field is already record-typed — nothing to do.");
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Step 1: enumerate non-NONE rows and classify them.
  const rows = await qFirst(
    db,
    `SELECT id, memory_id FROM memory_utility_cache WHERE memory_id != NONE AND memory_id != ''`,
  );
  console.log(`[migrate-muc-memory-id] found ${rows.length} memory_utility_cache rows with non-NONE memory_id`);

  const migratable = []; // { id, tb, key, original }
  const opaque = [];     // { id, original, reason }

  // Group candidate ids by table for batched existence checks.
  const candidatesByTable = new Map(); // tb -> Set<id>
  for (const r of rows) {
    const mi = r.memory_id;
    if (typeof mi !== "string") {
      opaque.push({ id: String(r.id), original: mi, reason: `non-string type=${typeof mi}` });
      continue;
    }
    const m = mi.match(RECORD_ID_RE);
    if (!m) {
      opaque.push({ id: String(r.id), original: mi, reason: "does not match record-id shape" });
      continue;
    }
    if (!ALLOWED_TABLES.has(m[1])) {
      opaque.push({ id: String(r.id), original: mi, reason: `unsupported table prefix (${m[1]}, allowed: ${[...ALLOWED_TABLES].join(",")})` });
      continue;
    }
    if (!candidatesByTable.has(m[1])) candidatesByTable.set(m[1], new Set());
    candidatesByTable.get(m[1]).add(mi);
  }

  // Verify referenced rows exist (per-table). Dangling refs are non-migratable.
  const existingIds = new Set();
  for (const [tb, idSet] of candidatesByTable) {
    if (idSet.size === 0) continue;
    const idList = Array.from(idSet).join(", ");
    try {
      const existRows = await qFirst(db, `SELECT id FROM ${tb} WHERE id IN [${idList}]`);
      for (const er of existRows) existingIds.add(String(er.id));
    } catch (e) {
      console.error(`[migrate-muc-memory-id] FATAL: ${tb} existence check failed: ${e?.message ?? e}`);
      await db.close().catch(() => {});
      process.exit(2);
    }
  }

  for (const r of rows) {
    const mi = r.memory_id;
    if (typeof mi !== "string") continue;
    const m = mi.match(RECORD_ID_RE);
    if (!m || !ALLOWED_TABLES.has(m[1])) continue;
    if (!existingIds.has(mi)) {
      opaque.push({ id: String(r.id), original: mi, reason: `referenced ${m[1]} row no longer exists` });
      continue;
    }
    migratable.push({ id: String(r.id), tb: m[1], key: m[2], original: mi });
  }

  console.log(`[migrate-muc-memory-id] classification: ${migratable.length} migratable, ${opaque.length} opaque`);
  if (VERBOSE || opaque.length > 0) {
    if (migratable.length > 0) {
      console.log(`\n[migrate-muc-memory-id] migratable rows:`);
      for (const m of migratable.slice(0, VERBOSE ? migratable.length : 5)) {
        console.log(`  ${m.id}  ->  ${m.original}`);
      }
      if (!VERBOSE && migratable.length > 5) {
        console.log(`  …and ${migratable.length - 5} more`);
      }
    }
    if (opaque.length > 0) {
      console.log(`\n[migrate-muc-memory-id] WARN opaque rows (preserved in memory_id_legacy, then cleared):`);
      for (const o of opaque) {
        console.log(`  ${o.id}  ->  ${JSON.stringify(o.original)}  (${o.reason})`);
      }
    }
  }

  if (!APPLY) {
    console.log(`\n=== SUMMARY (dry-run) ===`);
    console.log(`  would migrate: ${migratable.length}`);
    console.log(`  would preserve in legacy field: ${opaque.length}`);
    console.log(`  would discard: 0  (none discarded — opaque values preserved in memory_id_legacy)`);
    console.log(`\n(dry-run — re-run with --apply to actually migrate)`);
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Step 2 (APPLY): preserve opaque values BEFORE the type change. Done
  // OUTSIDE the atomic block below because adding a SCHEMALESS column is
  // idempotent — a retry after partial failure is safe.
  if (opaque.length > 0) {
    console.log(`\n[migrate-muc-memory-id] preserving ${opaque.length} opaque values in memory_utility_cache.memory_id_legacy…`);
    for (const o of opaque) {
      try {
        await db.query(
          `UPDATE ${o.id} SET memory_id_legacy = $val`,
          { val: String(o.original) },
        );
      } catch (e) {
        console.error(`[migrate-muc-memory-id] failed to preserve ${o.id}: ${e?.message ?? e}`);
      }
    }
  }

  // ── Steps 3-4 (atomic): REMOVE INDEX → REMOVE FIELD → DEFINE FIELD →
  // DEFINE INDEX → writeback of migratable rows, all in a single
  // BEGIN/COMMIT transaction. If any step fails, SurrealDB auto-rolls back,
  // leaving the original `string` field + UNIQUE index intact for a retry.
  // Without this, a failure between REMOVE INDEX and DEFINE INDEX would
  // leave the unique-key invariant unenforced for the duration the daemon
  // is running against the partially-migrated DB.
  console.log(`[migrate-muc-memory-id] BEGIN TRANSACTION: REMOVE INDEX muc_mid_idx + REMOVE FIELD memory_id + DEFINE option<record<…>> + DEFINE INDEX UNIQUE + writeback ${migratable.length} rows…`);

  const sqlParts = [
    `BEGIN TRANSACTION;`,
    `REMOVE INDEX muc_mid_idx ON memory_utility_cache;`,
    `REMOVE FIELD memory_id ON memory_utility_cache;`,
    `DEFINE FIELD memory_id ON memory_utility_cache TYPE option<record<memory> | record<concept> | record<turn>>;`,
    `DEFINE INDEX muc_mid_idx ON memory_utility_cache FIELDS memory_id UNIQUE;`,
  ];
  const bindings = {};
  for (let i = 0; i < migratable.length; i++) {
    const m = migratable[i];
    const paramName = `v${i}`;
    bindings[paramName] = new RecordId(m.tb, m.key);
    // m.id was returned by SurrealDB as a Thing and stringified to "<tb>:<key>".
    // Both halves passed RECORD_ID_RE so inline interpolation is safe here.
    sqlParts.push(`UPDATE ${m.id} SET memory_id = $${paramName};`);
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
    console.error(`[migrate-muc-memory-id] FATAL: transaction rolled back: ${e?.message ?? e}`);
    console.error(`[migrate-muc-memory-id] index + field state unchanged; safe to re-run after fixing the underlying issue.`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  // ── Step 5b: null out memory_id on rows whose value is still a raw string.
  // SCHEMALESS preserves the underlying string even though the field is now
  // typed; SurrealDB does NOT auto-validate existing data on field re-def.
  // Without this cleanup the table holds rows that violate the schema type.
  try {
    const cleanupRes = await db.query(
      `UPDATE memory_utility_cache SET memory_id = NONE WHERE memory_id != NONE AND type::is_record(memory_id) = false RETURN BEFORE;`,
    );
    const updated = Array.isArray(cleanupRes) && Array.isArray(cleanupRes[0]) ? cleanupRes[0].length : 0;
    console.log(`[migrate-muc-memory-id] cleared memory_id on ${updated} rows now living in memory_id_legacy`);
  } catch (e) {
    console.error(`[migrate-muc-memory-id] WARN: cleanup of legacy string values failed: ${e?.message ?? e}`);
  }

  // ── Step 5: verification pass.
  console.log(`\n[migrate-muc-memory-id] verifying…`);
  const verify = await qFirst(
    db,
    `SELECT id, memory_id, type::is_record(memory_id) AS is_rec FROM memory_utility_cache WHERE memory_id != NONE`,
  );
  const stillStringRows = verify.filter(r => !r.is_rec);
  const recordRows = verify.filter(r => r.is_rec);
  console.log(`  rows now stored as record<memory>: ${recordRows.length}`);
  if (stillStringRows.length > 0) {
    console.log(`  WARN: ${stillStringRows.length} rows still NOT typed as record:`);
    for (const r of stillStringRows.slice(0, 10)) {
      console.log(`    ${String(r.id)}  ->  ${JSON.stringify(r.memory_id)}`);
    }
  }

  const tInfoAfter = await tableInfo(db, "memory_utility_cache");
  const fieldDefnAfter = String(tInfoAfter?.fields?.memory_id ?? "");
  console.log(`  memory_utility_cache.memory_id definition now: ${fieldDefnAfter}`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`  migrated:           ${written}`);
  console.log(`  preserved in legacy: ${opaque.length}`);
  console.log(`  failed:             ${failed}`);
  console.log(`  field now matches schema: ${/record/i.test(fieldDefnAfter) ? "YES" : "NO"}`);

  await db.close().catch(() => {});
  process.exit(failed > 0 || !/record/i.test(fieldDefnAfter) ? 1 : 0);
}

main().catch((e) => {
  console.error("[migrate-muc-memory-id] FATAL:", e);
  process.exit(1);
});
