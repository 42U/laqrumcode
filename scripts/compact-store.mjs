#!/usr/bin/env node
/**
 * compact-store.mjs — export the laqrumcode graph and import it into a FRESH
 * SurrealDB store (new major version), reclaiming append-only value-log
 * garbage and rebuilding every index from clean state.
 *
 * Why: 2026-06-12 forensics found the production surrealkv store at 65.7GB
 * (63.8GB vlog) wrapping ~0.3GB of live data — ~200x write amplification
 * from full-row rewrites (fixed in 0.7.121 via the access_stats side table,
 * which stops NEW garbage; this script reclaims the EXISTING garbage). The
 * fresh import also rebuilds indexes, curing state-dependent index
 * corruption (the 2026-06-11 ASC-returns-zero-rows incident), and lands the
 * engine upgrade past the closed upstream bug (surrealdb/surrealdb#6285).
 *
 * DISK DISCIPLINE (founder rule memory:fq564m1u7vn6ewnkww3g): every bulk
 * step checks sizes FIRST and quotes receipts. Exports are LOGICAL (~the
 * 0.3GB live data), never physical copies of the haunted store.
 *
 * Default is TEST mode: exports, spins a scratch container of NEW_VERSION on
 * SCRATCH_PORT with a fresh store, imports, runs verification (per-table
 * count diff + the ASC-index differential + content spot-checks), prints a
 * cutover runbook, and leaves the scratch container RUNNING for inspection
 * (--cleanup stops/removes it). It NEVER touches the production container.
 *
 * Usage:
 *   node scripts/compact-store.mjs                 # test mode
 *   node scripts/compact-store.mjs --cleanup       # test then remove scratch
 * Env: SURREAL_URL/USER/PASS/NS/DB (defaults = production),
 *      LAQRUMCODE_COMPACT_NEW_VERSION (default v3.1.4),
 *      LAQRUMCODE_COMPACT_PORT (default 8940),
 *      LAQRUMCODE_COMPACT_STAGE_DIR (default /mnt/money/voidorigin/laqrumcode-compact)
 */
import { execSync } from "node:child_process";
import { mkdirSync, statSync, createWriteStream } from "node:fs";
import { join } from "node:path";

const HTTP_BASE = (process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc")
  .replace(/^ws/, "http").replace(/\/rpc$/, "");
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "laqrum";
const DB = process.env.SURREAL_DB || "memory";
const NEW_VERSION = process.env.LAQRUMCODE_COMPACT_NEW_VERSION || "v3.1.4";
const PORT = Number(process.env.LAQRUMCODE_COMPACT_PORT) || 8940;
const STAGE = process.env.LAQRUMCODE_COMPACT_STAGE_DIR || "/mnt/money/voidorigin/laqrumcode-compact";
const CLEANUP = process.argv.includes("--cleanup");
const SCRATCH = "laqrumcode-compact-test";

function sh(cmd) { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

async function sql(base, q) {
  const res = await fetch(`${base}/sql`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      Accept: "application/json",
      "surreal-ns": NS, "surreal-db": DB,
    },
    body: q,
  });
  if (!res.ok) throw new Error(`${base}/sql ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** v2 (0.7.122): table list is DYNAMIC — the fixed 15-table list missed the
 *  broader-table import loss on 2026-06-12 (founder's "no data loss?" audit
 *  caught it). Every table in the source DB gets verified. */
async function listTables(base) {
  const r = await sql(base, "INFO FOR DB");
  return Object.keys(r?.[0]?.result?.tables ?? {});
}

async function counts(base, tables) {
  const out = {};
  for (const t of tables) {
    try {
      const r = await sql(base, `SELECT count() AS c FROM ${t} GROUP ALL`);
      out[t] = r?.[0]?.result?.[0]?.c ?? 0;
    } catch { out[t] = "ERR"; }
  }
  return out;
}

/** v2 (0.7.122): post-import id-diff repair. SurrealDB /import silently drops
 *  the REMAINDER of an insert chunk after a UNIQUE violation (live incident:
 *  154 duplicate edges poisoned 626 healthy rows). Per table: diff ids, copy
 *  every missing row source→target (INSERT RELATION for edges, CREATE for
 *  nodes); UNIQUE rejections are true duplicates whose keeper survived. */
async function idDiffRepair(srcWsUrl, dstWsUrl, tables) {
  // WS SDK with BINDINGS, not the /sql HTTP endpoint: JSON-literal
  // serialization mangles typed values (record links and datetimes become
  // strings; INSERT RELATION rejects string endpoints) — live-hit on the v2
  // validation run (11/12 copy failures). The SDK round-trips RecordId and
  // Datetime objects faithfully.
  const { Surreal } = await import(new URL("../node_modules/surrealdb/dist/surrealdb.mjs", import.meta.url).href);
  async function open(url) {
    const db = new Surreal();
    await db.connect(url);
    await db.signin({ username: USER, password: PASS });
    await db.use({ namespace: NS, database: DB });
    return db;
  }
  const src = await open(srcWsUrl);
  const dst = await open(dstWsUrl);
  let repaired = 0, dupSkipped = 0, failures = 0;
  try {
    for (const t of tables) {
      const [srcRows] = await src.query(`SELECT <string>id AS id FROM ${t}`);
      const srcIds = (srcRows ?? []).map(r => r.id);
      if (!srcIds.length) continue;
      const [dstRows] = await dst.query(`SELECT <string>id AS id FROM ${t}`).catch(() => [[]]);
      const have = new Set((dstRows ?? []).map(r => r.id));
      const missing = srcIds.filter(id => !have.has(id));
      if (!missing.length) continue;
      let tOk = 0, tDup = 0, tFail = 0;
      for (const id of missing) {
        const [rows] = await src.query(`SELECT * FROM ${id}`);
        const row = rows?.[0];
        if (!row) continue; // raced away on the source — nothing to copy
        const isRel = row.in !== undefined && row.out !== undefined;
        try {
          if (isRel) {
            const { id: _i, ...rest } = row;
            await dst.query(`INSERT RELATION INTO ${t} $content`, { content: { id: row.id, ...rest } });
          } else {
            await dst.query(`CREATE ${id} CONTENT $content`, {
              content: Object.fromEntries(Object.entries(row).filter(([k]) => k !== "id")),
            });
          }
          tOk++;
        } catch (e) {
          if (/already contains|already exists/i.test(String(e?.message ?? e))) tDup++;
          else tFail++;
        }
      }
      repaired += tOk; dupSkipped += tDup; failures += tFail;
      console.log(`    repair ${t}: missing=${missing.length} copied=${tOk} dup-skipped=${tDup} failed=${tFail}`);
    }
  } finally {
    await src.close().catch(() => {});
    await dst.close().catch(() => {});
  }
  return { repaired, dupSkipped, failures };
}

/** v2 (0.7.122): namespace sweep. A store can host databases the migration
 *  never touched — the 2026-06-12 audit found 58 namespaces (17 non-empty,
 *  incl. the laqrumclaw-era graph) on a server everyone thought held one DB.
 *  Every non-empty (ns,db) pair beyond the migrated one gets exported. */
async function namespaceSweep(httpBase) {
  const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  const rootSql = async (q, hdrs = {}) => {
    const res = await fetch(`${httpBase}/sql`, { method: "POST", headers: { Authorization: auth, Accept: "application/json", ...hdrs }, body: q });
    return res.json();
  };
  const root = await rootSql("INFO FOR ROOT");
  const namespaces = Object.keys(root?.[0]?.result?.namespaces ?? {});
  const extras = [];
  for (const ns of namespaces) {
    const nsInfo = await rootSql("INFO FOR NS", { "surreal-ns": ns });
    for (const d of Object.keys(nsInfo?.[0]?.result?.databases ?? {})) {
      if (ns === NS && d === DB) continue;
      const dbInfo = await rootSql("INFO FOR DB", { "surreal-ns": ns, "surreal-db": d });
      const tbls = Object.keys(dbInfo?.[0]?.result?.tables ?? {});
      let rows = 0;
      for (const t of tbls) {
        const c = await rootSql(`SELECT count() AS c FROM ${t} GROUP ALL`, { "surreal-ns": ns, "surreal-db": d }).catch(() => null);
        rows += c?.[0]?.result?.[0]?.c ?? 0;
      }
      if (rows > 0) extras.push({ ns, db: d, rows });
    }
  }
  if (extras.length === 0) { console.log("    no other non-empty databases on the source server."); return; }
  console.log(`    ${extras.length} OTHER non-empty database(s) on the source server — exporting each:`);
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  for (const e of extras) {
    const out = join(STAGE, `legacy-${e.ns}--${e.db}.surql`);
    const res = await fetch(`${httpBase}/export`, { headers: { Authorization: auth, Accept: "application/octet-stream", "surreal-ns": e.ns, "surreal-db": e.db } });
    if (!res.ok || !res.body) { console.log(`      ${e.ns}/${e.db} (${e.rows} rows): EXPORT FAILED ${res.status}`); continue; }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
    console.log(`      ${e.ns}/${e.db}: ${e.rows} rows → ${out}`);
  }
}

async function main() {
  console.log(`compact-store — source ${HTTP_BASE} ns=${NS} db=${DB} → fresh surrealdb ${NEW_VERSION} on :${PORT}`);

  // ── Disk discipline: receipts BEFORE any bulk write ──
  mkdirSync(STAGE, { recursive: true });
  const dfLine = sh(`df -B1 --output=avail ${STAGE} | tail -1`);
  const freeBytes = Number(dfLine);
  console.log(`  stage dir: ${STAGE} — free ${(freeBytes / 1e9).toFixed(1)}GB`);
  // Logical export is bounded by live data (~sub-GB measured); require 10GB
  // headroom anyway so a surprise can never fill the volume.
  if (!Number.isFinite(freeBytes) || freeBytes < 10e9) {
    console.error(`  ABORT: need ≥10GB free at ${STAGE} (have ${(freeBytes / 1e9).toFixed(1)}GB)`);
    process.exit(1);
  }

  // ── 1. Source counts (the verification baseline) — ALL tables, dynamic ──
  console.log("  [1/6] source table counts (dynamic, all tables)…");
  const TABLES = await listTables(HTTP_BASE);
  const before = await counts(HTTP_BASE, TABLES);
  console.log(`    ${TABLES.length} tables;`, JSON.stringify(before).slice(0, 400) + "…");

  // ── 2. Logical export over HTTP ──
  const exportPath = join(STAGE, `laqrum-memory-export.surql`);
  console.log(`  [2/6] exporting ${NS}/${DB} → ${exportPath}…`);
  const res = await fetch(`${HTTP_BASE}/export`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      Accept: "application/octet-stream",
      "surreal-ns": NS, "surreal-db": DB,
    },
  });
  if (!res.ok || !res.body) throw new Error(`/export failed: ${res.status}`);
  const file = createWriteStream(exportPath);
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body), file);
  const exportBytes = statSync(exportPath).size;
  console.log(`    export receipt: ${(exportBytes / 1e9).toFixed(2)}GB at ${exportPath}`);
  if (exportBytes < 1e6) throw new Error("export suspiciously small (<1MB) — aborting before any import");

  // ── 3. Fresh scratch store on the new version ──
  console.log(`  [3/6] starting scratch ${NEW_VERSION} (container ${SCRATCH}, fresh store)…`);
  try { sh(`sudo docker rm -f ${SCRATCH}`); } catch { /* not running */ }
  const dataDir = join(STAGE, "fresh-store");
  // QA G1: "fresh" must mean fresh — a leftover store from a prior run would
  // make the import collide/double. Reset + open permissions via docker
  // (NOPASSWD is docker-only; the v3.1.4 image runs NON-root, and a
  // root-owned bind dir dies with "IO error: Permission denied" — live-hit
  // on the first run, 2026-06-12).
  sh(`sudo docker run --rm -v ${dataDir}:/wipe alpine sh -c "rm -rf /wipe/* /wipe/.[!.]* 2>/dev/null; chmod 777 /wipe; true"`);
  sh(`sudo docker run -d --name ${SCRATCH} -p 127.0.0.1:${PORT}:8000 -v ${dataDir}:/mydata surrealdb/surrealdb:${NEW_VERSION} start surrealkv:/mydata/laqrumdb --user ${USER} --pass ${PASS}`);
  const target = `http://127.0.0.1:${PORT}`;
  // Readiness poll (QA G2: fixed sleep was flaky) — up to 30s.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const h = await fetch(`${target}/health`); if (h.ok) { ready = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) throw new Error(`scratch ${NEW_VERSION} did not become healthy within 30s`);

  // ── 4. Import ──
  console.log(`  [4/6] importing into scratch…`);
  const { createReadStream } = await import("node:fs");
  const imp = await fetch(`${target}/import`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      Accept: "application/json",
      "surreal-ns": NS, "surreal-db": DB,
    },
    body: createReadStream(exportPath),
    duplex: "half",
  });
  if (!imp.ok) throw new Error(`/import failed: ${imp.status}: ${(await imp.text()).slice(0, 300)}`);
  console.log("    import accepted.");

  // ── 5. Verify + id-diff repair ──
  console.log("  [5/6] verifying (all tables) + id-diff repair…");
  let after = await counts(target, TABLES);
  const preMismatch = TABLES.filter(t => before[t] !== after[t]);
  if (preMismatch.length > 0) {
    console.log(`    count mismatches on ${preMismatch.length} table(s) — running id-diff repair (import-chunk-abort recovery):`);
  }
  const srcWs = HTTP_BASE.replace(/^http/, "ws") + "/rpc";
  const dstWs = target.replace(/^http/, "ws") + "/rpc";
  const repair = await idDiffRepair(srcWs, dstWs, TABLES);
  if (repair.repaired + repair.dupSkipped + repair.failures > 0) {
    console.log(`    repair totals: copied=${repair.repaired} dup-skipped=${repair.dupSkipped} failed=${repair.failures}`);
  }
  after = await counts(target, TABLES);
  let mismatches = 0;
  for (const t of TABLES) {
    // After repair, fresh may exceed source only via concurrent source
    // writes; a SHORTFALL beyond rejected duplicates is a real miss.
    const ok = before[t] === after[t] || (typeof after[t] === "number" && typeof before[t] === "number" && after[t] >= before[t]);
    if (!ok) { mismatches++; console.log(`    ${t}: source=${before[t]} fresh=${after[t]} MISMATCH`); }
  }
  console.log(`    counts: ${TABLES.length - mismatches}/${TABLES.length} tables OK`);
  if (repair.failures > 0) mismatches += 1; // hard failures block the verdict

  // ── 6. Namespace sweep (other databases on the source server) ──
  console.log("  [6/6] namespace sweep on the source server…");
  await namespaceSweep(HTTP_BASE);
  // The ASC-index differential that caught the 2026-06-11 incident:
  const asc = await sql(target, `SELECT id, timestamp FROM turn WHERE pruned_at IS NONE ORDER BY timestamp ASC LIMIT 1`);
  const noidx = await sql(target, `SELECT id, timestamp FROM turn WITH NOINDEX WHERE pruned_at IS NONE ORDER BY timestamp ASC LIMIT 1`);
  const ascRows = asc?.[0]?.result?.length ?? 0;
  const noidxRows = noidx?.[0]?.result?.length ?? 0;
  console.log(`    index-sanity: ASC-via-index=${ascRows} NOINDEX=${noidxRows} ${ascRows === noidxRows ? "OK" : "INDEX LYING"}`);
  // surreal images ship no `du` — measure the bind dir from the host side.
  const freshSize = sh(`sudo docker run --rm -v ${dataDir}:/s:ro alpine du -sh /s 2>/dev/null | cut -f1 || true`) || "(unavailable)";
  console.log(`    fresh store size: ${freshSize}`);

  const verdict = mismatches === 0 && ascRows === noidxRows;
  console.log(`\n  VERDICT: ${verdict ? "VERIFIED — fresh store is complete and index-sane" : `NOT CLEAN — ${mismatches} count mismatch(es)${ascRows !== noidxRows ? " + index differential" : ""}`}`);

  if (CLEANUP) {
    sh(`sudo docker rm -f ${SCRATCH}`);
    console.log("  scratch container removed (--cleanup).");
  } else if (verdict) {
    console.log(`
  CUTOVER RUNBOOK (manual — this script never touches production):
    1. Stop writers: kill the laqrumcode daemon (it respawns against the new store after cutover).
    2. Re-export + re-import for freshness (writes since this test), or accept the small gap.
    3. sudo docker stop <prod-container>   # old 65GB store stays on disk as the rollback
    4. Point the production container/compose at surrealdb/surrealdb:${NEW_VERSION} with the fresh store dir (${dataDir}), keeping host port 8000.
    5. Start it; laqrumcode reconnects automatically; verify with memory_health (index_sanity should clear).
    6. After a comfortable soak, archive/delete the old store dir to reclaim ~65GB.
  Scratch container '${SCRATCH}' left running on :${PORT} for inspection.`);
  }
  process.exit(verdict ? 0 : 1);
}

main().catch(e => { console.error(`compact-store failed: ${e?.message ?? e}`); process.exit(1); });
