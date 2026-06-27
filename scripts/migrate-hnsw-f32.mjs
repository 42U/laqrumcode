#!/usr/bin/env node
/**
 * Rebuild all *_vec_idx HNSW indexes as TYPE F32 (SurrealDB's HNSW default is
 * F64). The embeddings are F32-precision (llama.cpp / BGE-M3 emit float32), so
 * storing the index as F64 keeps 8KB/vector of precision the data never had —
 * pure RAM waste in an in-memory index. F32 is LOSSLESS here and ~halves the
 * per-vector index footprint.
 *
 * `DEFINE INDEX OVERWRITE` drops + rebuilds the index (re-inserts every vector).
 * During the rebuild the index is unavailable and reads fall back to a linear
 * scan (see surreal.ts), so run this in a maintenance window. Large tables
 * (concept/turn/memory) take the longest. Idempotent — re-running once the
 * index is already F32 is a cheap no-op rebuild.
 *
 * Env: SRC_URL=ws://127.0.0.1:8000/rpc  SURREAL_NS=laqrum  SURREAL_DB=memory
 *      SURREAL_USER=root  SURREAL_PASS=root  [DRY_RUN=1]
 *   node scripts/migrate-hnsw-f32.mjs
 */
import { Surreal } from "surrealdb";

const CFG = {
  url: process.env.SRC_URL || "ws://127.0.0.1:8000/rpc",
  ns: process.env.SURREAL_NS || "laqrum",
  db: process.env.SURREAL_DB || "memory",
  user: process.env.SURREAL_USER || "root",
  pass: process.env.SURREAL_PASS || "root",
  dryRun: process.env.DRY_RUN === "1",
};

// (index, table) for all 9 vector indexes — keep in sync with schema.surql.
const INDEXES = [
  ["artifact_vec_idx", "artifact"],
  ["concept_vec_idx", "concept"],
  ["turn_vec_idx", "turn"],
  ["identity_vec_idx", "identity_chunk"],
  ["memory_vec_idx", "memory"],
  ["turn_archive_vec_idx", "turn_archive"],
  ["skill_vec_idx", "skill"],
  ["reflection_vec_idx", "reflection"],
  ["monologue_vec_idx", "monologue"],
];

const s = new Surreal();
await s.connect(CFG.url);
await s.signin({ username: CFG.user, password: CFG.pass });
await s.use({ namespace: CFG.ns, database: CFG.db });
console.error(`[hnsw-f32] ${CFG.url} ns=${CFG.ns} db=${CFG.db}${CFG.dryRun ? " (DRY RUN)" : ""}`);

const report = [];
for (const [idx, table] of INDEXES) {
  const ddl = `DEFINE INDEX OVERWRITE ${idx} ON ${table} FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16`;
  if (CFG.dryRun) { console.log(`DRY: ${ddl}`); report.push({ idx, table, ms: 0, ok: true, dry: true }); continue; }
  const t0 = Date.now();
  try { await s.query(ddl); const ms = Date.now() - t0; console.log(`rebuilt ${idx} (${table}) in ${ms}ms`); report.push({ idx, table, ms, ok: true }); }
  catch (e) { console.log(`FAILED ${idx} (${table}): ${String(e?.message || e).slice(0, 160)}`); report.push({ idx, table, ok: false }); }
}

const failed = report.filter((r) => r.ok === false);
console.log(JSON.stringify({ ns: CFG.ns, db: CFG.db, dryRun: CFG.dryRun, rebuilt: report.filter((r) => r.ok && !r.dry).length, failed: failed.length }, null, 2));
await s.close();
process.exit(failed.length ? 1 : 0);
