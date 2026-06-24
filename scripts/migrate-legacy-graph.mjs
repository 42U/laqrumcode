#!/usr/bin/env node
/**
 * Legacy graph migrator — copy a previous-brand SurrealDB memory graph into the
 * `laqrum` namespace that laqrumcode expects. Use this ONLY when moving an
 * existing graph from a pre-rebrand install; fresh installs need nothing.
 *
 * CONTENT-SAFE BY DESIGN. Every content table (memory, concept, skill, turn,
 * reflection, artifact, monologue, the 30+ edge tables, …) is copied VERBATIM:
 * ids, embeddings, edges (in/out), timestamps, and ALL text are preserved
 * exactly. A memory whose `text` happens to mention the old brand is left
 * byte-for-byte unchanged. There is NO blanket text rewrite.
 *
 * Only the small, enumerable set of structural BRAND-KEYED IDENTIFIERS is
 * rewritten, derived from LEGACY_BRAND → NEW_BRAND:
 *   - record id   soul:<legacy>brain  → soul:<new>brain   (the singleton soul doc)
 *   - field       agent.name = "<legacy>code" → "<new>code"  (and *brain / *claw)
 *   - field       <any>.agent_id = "<legacy-token>" → "<new-token>"  (owner-sentinel
 *                 literals only; real agent_id values are record ids like
 *                 "agent:…" or "default", which never equal a brand token)
 * Nodes are inserted before edges so relation endpoints always exist first, and
 * the soul singleton is renamed in an explicit post-copy step.
 *
 * Assumes SRC and DST share the same schema version (a rebrand, not a schema
 * change). Env-driven:
 *   LEGACY_BRAND=<old prefix>   # REQUIRED — the brand prefix you renamed FROM
 *   NEW_BRAND=laqrum            # default: laqrum
 *   SRC_URL=ws://127.0.0.1:8000/rpc  SRC_NS=<LEGACY_BRAND>
 *   DST_URL=ws://127.0.0.1:8000/rpc  DST_NS=<NEW_BRAND>
 *   SURREAL_DB=memory  SURREAL_USER=root  SURREAL_PASS=root  [DRY_RUN=1]
 *   node scripts/migrate-legacy-graph.mjs
 *
 * SRC and DST may be the same server (two namespaces) or two different servers
 * (e.g. an old pre-rebrand daemon → a fresh laqrumcode daemon).
 */
import { Surreal } from "surrealdb";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEGACY = process.env.LEGACY_BRAND;
const NEW = process.env.NEW_BRAND || "laqrum";
if (!LEGACY) {
  console.error(
    "LEGACY_BRAND is required — the brand prefix you renamed FROM (the source " +
    "namespace + identity tokens). Example: LEGACY_BRAND=<old> node scripts/migrate-legacy-graph.mjs",
  );
  process.exit(2);
}

const CFG = {
  srcUrl: process.env.SRC_URL || "ws://127.0.0.1:8000/rpc",
  srcNs: process.env.SRC_NS || LEGACY,
  dstUrl: process.env.DST_URL || process.env.SRC_URL || "ws://127.0.0.1:8000/rpc",
  dstNs: process.env.DST_NS || NEW,
  db: process.env.SURREAL_DB || "memory",
  user: process.env.SURREAL_USER || "root",
  pass: process.env.SURREAL_PASS || "root",
  dryRun: process.env.DRY_RUN === "1",
};

// Compound identity tokens that appear as record-id suffixes or as name/agent_id
// VALUES, derived from the LEGACY/NEW prefixes. (The bare namespace rename is
// realised by writing into DST_NS, not by string rewriting.)
const BRAND = [
  [`${LEGACY}code`, `${NEW}code`],
  [`${LEGACY}brain`, `${NEW}brain`],
  [`${LEGACY}claw`, `${NEW}claw`],
];
const tokenMap = new Map(BRAND);
const mapToken = (v) => (typeof v === "string" && tokenMap.has(v) ? tokenMap.get(v) : v);

/** Verbatim copy + surgical field rebrand. NO id rewriting here — record ids
 *  (content-table hashes and edge in/out alike) are preserved exactly. The one
 *  brand-keyed id (the soul singleton) is renamed in an explicit post-copy step
 *  below, which also avoids any client-side RecordId reconstruction. */
function transform(rec) {
  const out = { ...rec };
  if (typeof out.name === "string") out.name = mapToken(out.name);
  if (typeof out.agent_id === "string") out.agent_id = mapToken(out.agent_id);
  return out;
}

async function connect(url, ns) {
  const db = new Surreal();
  await db.connect(url);
  await db.signin({ username: CFG.user, password: CFG.pass });
  await db.use({ namespace: ns, database: CFG.db });
  return db;
}

const src = await connect(CFG.srcUrl, CFG.srcNs);
const dst = await connect(CFG.dstUrl, CFG.dstNs);
console.error(`[migrate] ${CFG.srcUrl} ns=${CFG.srcNs} → ${CFG.dstUrl} ns=${CFG.dstNs} db=${CFG.db}${CFG.dryRun ? " (DRY RUN)" : ""}`);

// Ensure the destination schema exists (idempotent). Prefer the compiled copy.
let schema = "";
for (const p of ["../dist/engine/schema.surql", "../src/engine/schema.surql"]) {
  try { schema = readFileSync(resolve(__dirname, p), "utf8"); break; } catch { /* try next */ }
}
if (schema && !CFG.dryRun) await dst.query(schema);

// Discover tables from the source DB itself — schema-agnostic.
const info = await src.query("INFO FOR DB");
const tables = Object.keys(info?.[0]?.tables ?? {});

// Pull every table; classify node vs edge (edges carry in+out).
const pulled = [];
for (const t of tables) {
  const res = await src.query("SELECT * FROM type::table($t)", { t });
  const recs = Array.isArray(res?.[0]) ? res[0] : [];
  if (recs.length) pulled.push({ t, recs, edge: !!(recs[0] && recs[0].in && recs[0].out) });
}
const ordered = [...pulled.filter((x) => !x.edge), ...pulled.filter((x) => x.edge)];

/** Bulk INSERT preserving record ids. Table names come from INFO FOR DB, so
 *  they are valid identifiers; backtick-quote them defensively. Edge (RELATION)
 *  tables that reject a plain INSERT fall back to RELATE, which recreates the
 *  in→out link (edge id regenerated, but edge identity is the endpoints). */
async function insertRecords(t, recs, isEdge) {
  try {
    await dst.query("INSERT INTO `" + t + "` $data", { data: recs });
  } catch (e) {
    if (!isEdge) throw e;
    for (const r of recs) {
      const { in: i, out: o, id, ...content } = r;
      await dst.query("RELATE $i->`" + t + "`->$o CONTENT $c", { i, o, c: content });
    }
  }
}

const report = [];
let total = 0;
for (const { t, recs, edge } of ordered) {
  const transformed = recs.map(transform);
  if (!CFG.dryRun) await insertRecords(t, transformed, edge);
  report.push({ table: t, count: recs.length });
  total += recs.length;
}

// Structural fixup: rename the singleton soul record (soul:<legacy> → soul:<new>).
// Its agent_id field was already rebranded during the verbatim copy, and the soul
// is never an edge endpoint in the schema, so no in/out repointing is needed.
if (!CFG.dryRun) {
  for (const [legacyTok, newTok] of BRAND) {
    const res = await dst.query(`SELECT * FROM soul:${legacyTok}`);
    const rec = res?.[0]?.[0];
    if (!rec) continue;
    const { id, ...content } = rec;
    await dst.query(`CREATE soul:${newTok} CONTENT $c`, { c: content });
    await dst.query(`DELETE soul:${legacyTok}`);
    console.error(`[migrate] renamed soul:${legacyTok} → soul:${newTok}`);
  }
}

// Verify per-table counts on the destination.
const verify = [];
let allOk = true;
for (const { table, count } of report) {
  if (CFG.dryRun) { verify.push({ table, src: count, dst: "(dry)", ok: true }); continue; }
  const res = await dst.query("SELECT count() FROM type::table($t) GROUP ALL", { t: table });
  const got = res?.[0]?.[0]?.count ?? 0;
  if (got !== count) allOk = false;
  verify.push({ table, src: count, dst: got, ok: got === count });
}

console.log(JSON.stringify({
  srcNs: CFG.srcNs, dstNs: CFG.dstNs, db: CFG.db, dryRun: CFG.dryRun,
  totalRecords: total, tables: report.length, countsOk: allOk, verify,
}, null, 2));

await src.close();
await dst.close();
process.exit(allOk ? 0 : 1);
