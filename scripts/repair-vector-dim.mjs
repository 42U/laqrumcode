#!/usr/bin/env node
/**
 * repair-vector-dim.mjs
 *
 * Repairs rows whose `embedding` column has a non-1024 dimension on any
 * table that participates in HNSW cosine search. Live BGE-M3 is 1024-dim;
 * the dim-mismatch error
 *
 *   surreal:vectorSearch:batch: Incorrect arguments for function
 *   vector::similarity::cosine(). The two vectors must be of the same dimension.
 *
 * fires the moment one indexed row carries a vector whose length differs
 * from the query vector's. The historical 768→1024 migration (early 2026)
 * sometimes left stragglers behind: rows whose embedding column was non-NONE
 * but whose array length was the old 768, or zero (corrupt cache writes),
 * or any other shape.
 *
 * Repair strategy
 * ---------------
 *   1. Scan every indexed table for rows where
 *         embedding != NONE AND array::len(embedding) != 1024
 *      (this includes both "old dim" rows like 768 AND "empty array" rows
 *      with length 0; both poison the cosine call).
 *   2. Also scan embedding_cache for entries whose stored vector is not
 *      1024-dim — the cache feeds query-time `$vec` via l2Get and can be
 *      the source of the mismatch even when every indexed row is clean.
 *   3. For each offending row, NULL out the `embedding` field (set to NONE).
 *      We do NOT re-embed in-script: the daemon's heuristic-drain and the
 *      consolidate-backfill pass (surreal.ts ~L1879) regenerate embeddings
 *      for rows where `embedding IS NONE OR array::len(embedding) = 0` on
 *      the next sweep. This avoids embedding contention with the live
 *      daemon and keeps the script side-effect-minimal.
 *   4. For embedding_cache, DELETE the offending row outright — the cache
 *      is regenerated lazily on next embed() call by l2Put.
 *
 * Why not re-embed in-script?
 *   The daemon owns the only initialized BGE-M3 context. Spinning up a
 *   second LlamaEmbeddingContext in this process would compete for the
 *   GPU/CPU resource pool (see resource-tier.ts) and risk an OOM on
 *   constrained hardware. Backfill via the running daemon is the safe
 *   path, and it's already wired up.
 *
 * Safety
 * ------
 *   - Dry-run by default; --apply to mutate.
 *   - Reads the full classification BEFORE any destructive op so the report
 *     is complete even on dry-run.
 *   - Idempotent: re-running on a clean DB finds zero rows and exits 0.
 *   - Uses raw `surrealdb` client (mirrors probe-surreal-version.mjs and
 *     migrate-concept-superseded-by.mjs) so it does NOT trigger
 *     SurrealStore.initialize() / runSchema().
 *
 * Usage
 * -----
 *   node scripts/repair-vector-dim.mjs            # dry-run
 *   node scripts/repair-vector-dim.mjs --apply    # execute
 *   node scripts/repair-vector-dim.mjs --verbose  # print every offending id
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

const EXPECTED_DIM = 1024;

// Indexed tables whose `embedding` column is consumed by
// vectorSearchBatch (surreal.ts). turn_archive is included because it's
// in the same batch and would also poison the call.
const INDEXED_TABLES = [
  "concept",
  "memory",
  "artifact",
  "turn",
  "turn_archive",
  "monologue",
  "identity_chunk",
  "skill",
  "reflection",
];

async function qFirst(db, sql, bindings) {
  const r = await db.query(sql, bindings);
  const rows = Array.isArray(r) ? r[r.length - 1] : r;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[repair-vector-dim] FATAL: no Surreal URL resolvable from config.");
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
    console.error(`[repair-vector-dim] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[repair-vector-dim] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[repair-vector-dim] surreal ${url}  ns=${ns}  db=${dbName}`);
  console.log(`[repair-vector-dim] expected dim = ${EXPECTED_DIM}`);

  // ── Phase 1: classify ─────────────────────────────────────────────────────
  const offendingByTable = {};       // tb -> [{ id, dim }, ...]
  const offendingCache = [];          // [{ id, text_hash, dim }, ...]
  let totalOffending = 0;

  for (const tb of INDEXED_TABLES) {
    try {
      const rows = await qFirst(
        db,
        `SELECT id, array::len(embedding) AS dim FROM ${tb}
         WHERE embedding != NONE
           AND array::len(embedding) != ${EXPECTED_DIM}`,
      );
      offendingByTable[tb] = rows.map(r => ({ id: String(r.id), dim: Number(r.dim) }));
      totalOffending += rows.length;
      const dimHist = rows.reduce((acc, r) => {
        const k = String(r.dim);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`[${tb}] offending: ${rows.length}  dimHist=${JSON.stringify(dimHist)}`);
      if (VERBOSE && rows.length > 0) {
        for (const r of rows) console.log(`  ${tb} ${r.id} dim=${r.dim}`);
      }
    } catch (e) {
      console.error(`[${tb}] ERROR during scan: ${e?.message ?? e}`);
      offendingByTable[tb] = [];
    }
  }

  try {
    const rows = await qFirst(
      db,
      `SELECT id, text_hash, array::len(embedding) AS dim FROM embedding_cache
       WHERE array::len(embedding) != ${EXPECTED_DIM}`,
    );
    for (const r of rows) {
      offendingCache.push({
        id: String(r.id),
        text_hash: String(r.text_hash ?? ""),
        dim: Number(r.dim),
      });
    }
    console.log(`[embedding_cache] offending: ${rows.length}`);
    if (VERBOSE && rows.length > 0) {
      for (const r of rows) console.log(`  cache ${r.id} dim=${r.dim} hash=${String(r.text_hash).slice(0, 12)}…`);
    }
  } catch (e) {
    console.error(`[embedding_cache] ERROR during scan: ${e?.message ?? e}`);
  }

  // ── Phase 2: dry-run / apply ─────────────────────────────────────────────
  console.log("");
  console.log(`=== SUMMARY (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  console.log(`  indexed-table offending rows: ${totalOffending}`);
  console.log(`  embedding_cache offending rows: ${offendingCache.length}`);

  if (totalOffending === 0 && offendingCache.length === 0) {
    console.log("\n  nothing to repair. exiting clean.");
    await db.close().catch(() => {});
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\n(dry-run — re-run with --apply to mutate. indexed rows will have");
    console.log(" their `embedding` field set to NONE; the daemon's backfill loop");
    console.log(" will regenerate 1024-dim vectors on its next sweep. Cache rows");
    console.log(" will be DELETED; they're regenerated lazily on next embed() call.)");
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  let nulled = 0;
  let nullFail = 0;
  for (const tb of INDEXED_TABLES) {
    const rows = offendingByTable[tb] ?? [];
    for (const r of rows) {
      try {
        // We can't bind a record id like "concept:xyz" via $param without
        // RecordId construction; the SELECT above already returned safe ids.
        // We pass the id as a literal because it came from a trusted SELECT
        // (Same pattern used by migrate-concept-superseded-by.mjs L262.)
        await db.query(`UPDATE ${r.id} SET embedding = NONE`);
        nulled++;
        if (VERBOSE) console.log(`  nulled ${r.id} (was dim=${r.dim})`);
      } catch (e) {
        nullFail++;
        console.error(`  FAILED to null ${r.id}: ${e?.message ?? e}`);
      }
    }
  }

  let cacheDel = 0;
  let cacheDelFail = 0;
  for (const r of offendingCache) {
    try {
      await db.query(`DELETE ${r.id}`);
      cacheDel++;
      if (VERBOSE) console.log(`  deleted ${r.id} (was dim=${r.dim})`);
    } catch (e) {
      cacheDelFail++;
      console.error(`  FAILED to delete ${r.id}: ${e?.message ?? e}`);
    }
  }

  // ── Phase 3: verify ──────────────────────────────────────────────────────
  console.log("\n[repair-vector-dim] verifying…");
  let remaining = 0;
  for (const tb of INDEXED_TABLES) {
    try {
      const rows = await qFirst(
        db,
        `SELECT count() AS c FROM ${tb}
         WHERE embedding != NONE AND array::len(embedding) != ${EXPECTED_DIM}
         GROUP ALL`,
      );
      const c = Number(rows[0]?.c ?? 0);
      remaining += c;
      if (c > 0) console.log(`  [${tb}] STILL OFFENDING: ${c}`);
    } catch (e) {
      console.error(`  [${tb}] verify failed: ${e?.message ?? e}`);
    }
  }
  let cacheRemaining = 0;
  try {
    const rows = await qFirst(
      db,
      `SELECT count() AS c FROM embedding_cache
       WHERE array::len(embedding) != ${EXPECTED_DIM}
       GROUP ALL`,
    );
    cacheRemaining = Number(rows[0]?.c ?? 0);
    if (cacheRemaining > 0) console.log(`  [embedding_cache] STILL OFFENDING: ${cacheRemaining}`);
  } catch (e) {
    console.error(`  [embedding_cache] verify failed: ${e?.message ?? e}`);
  }

  console.log(`\n=== RESULT ===`);
  console.log(`  indexed rows nulled: ${nulled}  (failed: ${nullFail})`);
  console.log(`  cache rows deleted: ${cacheDel}  (failed: ${cacheDelFail})`);
  console.log(`  remaining offending (indexed): ${remaining}`);
  console.log(`  remaining offending (cache):   ${cacheRemaining}`);

  await db.close().catch(() => {});
  const fail = nullFail > 0 || cacheDelFail > 0 || remaining > 0 || cacheRemaining > 0;
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error("[repair-vector-dim] FATAL:", e);
  process.exit(1);
});
