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
 * SCALES to 100K+ rows. Each table is STREAMED with keyset pagination
 * (WHERE id > $last ORDER BY id LIMIT BATCH) rather than loaded whole, and rows
 * are written in bulk batches: nodes via `INSERT INTO`, edges via
 * `INSERT RELATION INTO` (preserves in/out/id; ~100x faster than per-record
 * RELATE). A bulk batch that fails falls back to per-record inserts and SKIPS +
 * LOGS only the offending rows instead of aborting the whole run — so a single
 * legacy-corrupt row (e.g. an option<record> field stored as NULL or as a
 * self-referential string, which the current schema rejects) cannot sink a
 * 300K-row migration. Every skip is reported with its id + reason; the process
 * exits non-zero if any per-table count gap is NOT explained by a logged skip.
 *
 * The DESTINATION must be empty for the per-table count check to pass (this is a
 * migration, not a merge). If the laqrum daemon is live against DST, stop it
 * first — otherwise it re-seeds the destination as you copy.
 *
 * Assumes SRC and DST share the same schema version (a rebrand, not a schema
 * change). Env-driven:
 *   LEGACY_BRAND=<old prefix>   # REQUIRED — the brand prefix you renamed FROM
 *   NEW_BRAND=laqrum            # default: laqrum
 *   SRC_URL=ws://127.0.0.1:8000/rpc  SRC_NS=<LEGACY_BRAND>
 *   DST_URL=ws://127.0.0.1:8000/rpc  DST_NS=<NEW_BRAND>
 *   SURREAL_DB=memory  SURREAL_USER=root  SURREAL_PASS=root  [BATCH=500] [DRY_RUN=1]
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
  batch: Math.max(1, Number(process.env.BATCH || 500)),
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
console.error(`[migrate] ${CFG.srcUrl} ns=${CFG.srcNs} → ${CFG.dstUrl} ns=${CFG.dstNs} db=${CFG.db} batch=${CFG.batch}${CFG.dryRun ? " (DRY RUN)" : ""}`);

// Ensure the destination schema exists (idempotent). Prefer the compiled copy.
let schema = "";
for (const p of ["../dist/engine/schema.surql", "../src/engine/schema.surql"]) {
  try { schema = readFileSync(resolve(__dirname, p), "utf8"); break; } catch { /* try next */ }
}
if (schema && !CFG.dryRun) await dst.query(schema);

// Discover tables from the source DB itself — schema-agnostic. For each non-empty
// table grab its row count and classify node vs edge from a one-row sample
// (edges carry in+out). This is cheap and avoids loading any table into memory.
const info = await src.query("INFO FOR DB");
const tables = Object.keys(info?.[0]?.tables ?? {});
const meta = [];
for (const t of tables) {
  const cr = await src.query("SELECT count() FROM type::table($t) GROUP ALL", { t });
  const count = cr?.[0]?.[0]?.count ?? 0;
  if (!count) continue;
  const sr = await src.query("SELECT * FROM type::table($t) LIMIT 1", { t });
  const sample = sr?.[0]?.[0];
  meta.push({ t, count, edge: !!(sample && sample.in && sample.out) });
}
const ordered = [...meta.filter((x) => !x.edge), ...meta.filter((x) => x.edge)];
console.error(`[migrate] ${ordered.length} non-empty tables, ${ordered.reduce((a, m) => a + m.count, 0)} rows`);

// Per-table record of rows the destination rejected (verbatim copy still hit the
// current schema — e.g. a legacy option<record> field stored as NULL/self-string).
const skipDetail = {};

/** Bulk insert preserving record ids. Nodes via INSERT INTO; edges (RELATION
 *  tables) via INSERT RELATION INTO, which keeps in/out/id and is ~100x faster
 *  than per-record RELATE. A failed bulk batch retries row-by-row so good rows
 *  still land and only the offending rows are SKIPPED + LOGGED (never aborts). */
async function insertRecords(t, recs, isEdge) {
  const stmt = (isEdge ? "INSERT RELATION INTO `" : "INSERT INTO `") + t + "` $data";
  try {
    await dst.query(stmt, { data: recs });
    return { ins: recs.length, skip: 0 };
  } catch {
    let ins = 0, skip = 0;
    for (const r of recs) {
      try { await dst.query(stmt, { data: [r] }); ins++; }
      catch (e) {
        skip++;
        (skipDetail[t] ||= []).push({ id: String(r.id), err: String(e?.message || e).slice(0, 140) });
      }
    }
    return { ins, skip };
  }
}

// Stream-copy each table with keyset pagination, transforming + inserting in
// BATCH-sized chunks. Wall-clock and memory stay flat regardless of table size.
const report = [];
let total = 0;
for (const { t, count, edge } of ordered) {
  let last = null, ins = 0, skip = 0;
  for (;;) {
    const q = last === null
      ? "SELECT * FROM type::table($t) ORDER BY id LIMIT $lim"
      : "SELECT * FROM type::table($t) WHERE id > $last ORDER BY id LIMIT $lim";
    const res = await src.query(q, last === null ? { t, lim: CFG.batch } : { t, lim: CFG.batch, last });
    const recs = Array.isArray(res?.[0]) ? res[0] : [];
    if (!recs.length) break;
    last = recs[recs.length - 1].id;
    if (CFG.dryRun) { ins += recs.length; }
    else { const r = await insertRecords(t, recs.map(transform), edge); ins += r.ins; skip += r.skip; }
    if (recs.length < CFG.batch) break;
  }
  report.push({ table: t, count, ins, skip });
  total += ins;
  console.error(`[migrate] ${t}: ins=${ins} skip=${skip} / ${count}${skip ? "  <-- SKIPS" : ""}`);
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

// Verify per-table counts on the destination. A table is OK when every source row
// was either inserted or accounted for by a logged skip (dst + skip === src).
const verify = [];
let allOk = true;
for (const { table, count, skip } of report) {
  if (CFG.dryRun) { verify.push({ table, src: count, read: count, dst: "(dry)", ok: true }); continue; }
  const res = await dst.query("SELECT count() FROM type::table($t) GROUP ALL", { t: table });
  const got = res?.[0]?.[0]?.count ?? 0;
  const ok = got + skip === count;
  if (!ok) allOk = false;
  verify.push({ table, src: count, dst: got, skip, ok });
}

console.log(JSON.stringify({
  srcNs: CFG.srcNs, dstNs: CFG.dstNs, db: CFG.db, dryRun: CFG.dryRun,
  totalInserted: total, tables: report.length, countsOk: allOk,
  skippedTables: verify.filter((v) => v.skip > 0),
  problems: verify.filter((v) => !v.ok),
  skipDetail,
}, null, 2));

await src.close();
await dst.close();
process.exit(allOk ? 0 : 1);
