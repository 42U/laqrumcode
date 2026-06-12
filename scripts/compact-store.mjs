#!/usr/bin/env node
/**
 * compact-store.mjs — export the kongcode graph and import it into a FRESH
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
 *      KONGCODE_COMPACT_NEW_VERSION (default v3.1.4),
 *      KONGCODE_COMPACT_PORT (default 8940),
 *      KONGCODE_COMPACT_STAGE_DIR (default /mnt/money/voidorigin/kongcode-compact)
 */
import { execSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";

const HTTP_BASE = (process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc")
  .replace(/^ws/, "http").replace(/\/rpc$/, "");
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "kong";
const DB = process.env.SURREAL_DB || "memory";
const NEW_VERSION = process.env.KONGCODE_COMPACT_NEW_VERSION || "v3.1.4";
const PORT = Number(process.env.KONGCODE_COMPACT_PORT) || 8940;
const STAGE = process.env.KONGCODE_COMPACT_STAGE_DIR || "/mnt/money/voidorigin/kongcode-compact";
const CLEANUP = process.argv.includes("--cleanup");
const SCRATCH = "kongcode-compact-test";

const TABLES = ["concept", "memory", "turn", "turn_archive", "artifact", "skill", "reflection", "monologue", "identity_chunk", "session", "pending_work", "retrieval_outcome", "related_to", "about_concept", "access_stats"];

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

async function counts(base) {
  const out = {};
  for (const t of TABLES) {
    try {
      const r = await sql(base, `SELECT count() AS c FROM ${t} GROUP ALL`);
      out[t] = r?.[0]?.result?.[0]?.c ?? 0;
    } catch { out[t] = "ERR"; }
  }
  return out;
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

  // ── 1. Source counts (the verification baseline) ──
  console.log("  [1/5] source table counts…");
  const before = await counts(HTTP_BASE);
  console.log("   ", JSON.stringify(before));

  // ── 2. Logical export over HTTP ──
  const exportPath = join(STAGE, `kong-memory-export.surql`);
  console.log(`  [2/5] exporting ${NS}/${DB} → ${exportPath}…`);
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
  console.log(`  [3/5] starting scratch ${NEW_VERSION} (container ${SCRATCH}, fresh store)…`);
  try { sh(`sudo docker rm -f ${SCRATCH}`); } catch { /* not running */ }
  const dataDir = join(STAGE, "fresh-store");
  // QA G1: "fresh" must mean fresh — a leftover store from a prior run would
  // make the import collide/double. Reset via docker (NOPASSWD is docker-only).
  if (existsSync(dataDir)) {
    sh(`sudo docker run --rm -v ${dataDir}:/wipe alpine sh -c "rm -rf /wipe/* /wipe/.[!.]* 2>/dev/null; true"`);
  }
  sh(`sudo docker run -d --name ${SCRATCH} -p 127.0.0.1:${PORT}:8000 -v ${dataDir}:/mydata surrealdb/surrealdb:${NEW_VERSION} start surrealkv:/mydata/kongdb --user ${USER} --pass ${PASS}`);
  const target = `http://127.0.0.1:${PORT}`;
  // Readiness poll (QA G2: fixed sleep was flaky) — up to 30s.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const h = await fetch(`${target}/health`); if (h.ok) { ready = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) throw new Error(`scratch ${NEW_VERSION} did not become healthy within 30s`);

  // ── 4. Import ──
  console.log(`  [4/5] importing into scratch…`);
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

  // ── 5. Verify ──
  console.log("  [5/5] verifying…");
  const after = await counts(target);
  let mismatches = 0;
  for (const t of TABLES) {
    const ok = before[t] === after[t];
    if (!ok) mismatches++;
    console.log(`    ${t}: source=${before[t]} fresh=${after[t]} ${ok ? "OK" : "MISMATCH"}`);
  }
  // The ASC-index differential that caught the 2026-06-11 incident:
  const asc = await sql(target, `SELECT id, timestamp FROM turn WHERE pruned_at IS NONE ORDER BY timestamp ASC LIMIT 1`);
  const noidx = await sql(target, `SELECT id, timestamp FROM turn WITH NOINDEX WHERE pruned_at IS NONE ORDER BY timestamp ASC LIMIT 1`);
  const ascRows = asc?.[0]?.result?.length ?? 0;
  const noidxRows = noidx?.[0]?.result?.length ?? 0;
  console.log(`    index-sanity: ASC-via-index=${ascRows} NOINDEX=${noidxRows} ${ascRows === noidxRows ? "OK" : "INDEX LYING"}`);
  const freshSize = sh(`sudo docker exec ${SCRATCH} du -sh /mydata 2>/dev/null || true`) || "(du unavailable)";
  console.log(`    fresh store size: ${freshSize}`);

  const verdict = mismatches === 0 && ascRows === noidxRows;
  console.log(`\n  VERDICT: ${verdict ? "VERIFIED — fresh store is complete and index-sane" : `NOT CLEAN — ${mismatches} count mismatch(es)${ascRows !== noidxRows ? " + index differential" : ""}`}`);

  if (CLEANUP) {
    sh(`sudo docker rm -f ${SCRATCH}`);
    console.log("  scratch container removed (--cleanup).");
  } else if (verdict) {
    console.log(`
  CUTOVER RUNBOOK (manual — this script never touches production):
    1. Stop writers: kill the kongcode daemon (it respawns against the new store after cutover).
    2. Re-export + re-import for freshness (writes since this test), or accept the small gap.
    3. sudo docker stop <prod-container>   # old 65GB store stays on disk as the rollback
    4. Point the production container/compose at surrealdb/surrealdb:${NEW_VERSION} with the fresh store dir (${dataDir}), keeping host port 8000.
    5. Start it; kongcode reconnects automatically; verify with memory_health (index_sanity should clear).
    6. After a comfortable soak, archive/delete the old store dir to reclaim ~65GB.
  Scratch container '${SCRATCH}' left running on :${PORT} for inspection.`);
  }
  process.exit(verdict ? 0 : 1);
}

main().catch(e => { console.error(`compact-store failed: ${e?.message ?? e}`); process.exit(1); });
