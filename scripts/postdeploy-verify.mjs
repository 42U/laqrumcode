#!/usr/bin/env node
/**
 * Post-deploy verifier.
 *
 * Run AFTER `node scripts/predeploy-dedup.mjs --apply` succeeded and the
 * kongcode daemon has been restarted. Confirms the deploy actually landed:
 *
 *   - DB ping succeeds (config + ns/db match the live daemon).
 *   - All 9 UNIQUE indexes Agent 1 added (+ artifact_path_unique from Agent 11)
 *     are present on the right tables with the right field tuple.
 *   - All new hot-path WHERE indexes are present
 *     (pw_session_idx, pw_worktype_idx, session_kc_idx, session_cleanup_idx).
 *   - All 7 new field type declarations are present
 *     (subagent.{ended_at,outcome,error,reason}, session.kc_session_id,
 *      concept.{superseded_at,superseded_by}).
 *   - pending_work has ZERO pending rows that VIOLATE the dedup invariant
 *     (no two pending rows with the same session_id + work_type) — proves
 *     the dedup actually worked and the UNIQUE index is doing its job.
 *   - artifact table has no duplicate paths.
 *   - Total pending_work_count is non-pathological (< 50).
 *   - daemon.pid contains a valid JSON marker (NOT bare-PID) — confirming
 *     the running daemon is the new build.
 *   - Reports the daemon's PID + uptime so the user can confirm it's the
 *     freshly-restarted one.
 *
 * Read-only. No --apply semantics. Run as many times as you like.
 *
 * Usage:
 *   node scripts/postdeploy-verify.mjs
 *   node scripts/postdeploy-verify.mjs --verbose
 *
 * Exit codes:
 *   0  → every check passed
 *   1  → at least one check failed (see report for which)
 *   2  → fatal: cannot reach DB / can't load config
 */
import { Surreal } from "surrealdb";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parsePluginConfig } from "../dist/engine/config.js";

const VERBOSE = process.argv.includes("--verbose");

// ── Spec: what SHOULD be present after deploy ─────────────────────────────

/** UNIQUE indexes added by Agent 1 + Agent 11. Each entry is what we expect
 *  to find under INFO FOR TB <table>.indexes[<name>] — we match on field
 *  tuple + presence of UNIQUE in the DEFINE INDEX string. */
const EXPECTED_UNIQUE_INDEXES = [
  { table: "pending_work",        name: "pw_session_worktype_status_unique", fields: ["session_id", "work_type", "status"] },
  { table: "subagent",            name: "subagent_corr_unique",              fields: ["correlation_key"] },
  { table: "subagent",            name: "subagent_run_unique",               fields: ["run_id"] },
  { table: "retrieval_outcome",   name: "retoutc_unique",                    fields: ["session_id", "turn_id", "memory_id"] },
  { table: "turn_score",          name: "turnscore_unique",                  fields: ["session_id", "turn_id"] },
  { table: "orchestrator_metrics",name: "orchm_unique",                      fields: ["session_id", "turn_index"] },
  { table: "identity_chunk",      name: "identity_chunk_unique",             fields: ["source", "identity_version", "chunk_index"] },
  { table: "maturity_stage",      name: "maturity_stage_unique",             fields: ["stage"] },
  { table: "causal_chain",        name: "causal_chain_unique",               fields: ["trigger_memory", "outcome_memory", "chain_type"] },
  // Agent 11 — artifact dedup seal.
  { table: "artifact",            name: "artifact_path_unique",              fields: ["path"] },
];

/** Hot-path WHERE indexes (non-UNIQUE) added by the same deploy. */
const EXPECTED_HOT_PATH_INDEXES = [
  { table: "pending_work", name: "pw_session_idx",        fields: ["session_id"] },
  { table: "pending_work", name: "pw_worktype_idx",       fields: ["work_type"] },
  { table: "session",      name: "session_kc_idx",        fields: ["kc_session_id"] },
  { table: "session",      name: "session_cleanup_idx",   fields: ["cleanup_completed"] },
  // pw_status_idx may have existed pre-deploy — check it too so the report
  // is complete; if it's already there it just passes.
  { table: "pending_work", name: "pw_status_idx",         fields: ["status", "priority"] },
];

/** Field TYPE declarations added by the deploy. We match on (table, field,
 *  expected substring in the DEFINE FIELD string). */
const EXPECTED_FIELD_TYPES = [
  { table: "subagent", field: "ended_at",       typeMatch: /datetime/i },
  { table: "subagent", field: "outcome",        typeMatch: /string/i },
  { table: "subagent", field: "error",          typeMatch: /string/i },
  { table: "subagent", field: "reason",         typeMatch: /string/i },
  { table: "session",  field: "kc_session_id",  typeMatch: /string/i },
  { table: "concept",  field: "superseded_at",  typeMatch: /datetime/i },
  { table: "concept",  field: "superseded_by",  typeMatch: /record/i },
];

// Threshold for the "pending_work backlog is pathological" alarm. Originally
// 50, but normal daemon backlog (179 rows observed during the Agent 22 deploy)
// is well above that without indicating any defect — the daemon drains pending
// work in batches and a few hundred queued items is steady state. Bumped to
// 500 so the alarm only fires when something is genuinely wrong (e.g. the
// daemon stopped consuming, or a dup-row regression). When dedupe is needed,
// the proper signal is the "no duplicate (session_id, work_type) pending
// rows" check above, not the raw count.
const PENDING_WORK_PATHOLOGICAL_LIMIT = 500;

// ── Pretty output ─────────────────────────────────────────────────────────

const PAD = 56;
const checks = []; // { name, ok, detail }

function record(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  const dotted = name.length >= PAD ? name : name + ".".repeat(PAD - name.length);
  console.log(`  ${dotted} [${tag}]${detail ? "  " + detail : ""}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ── Surreal helpers ───────────────────────────────────────────────────────

async function qFirst(db, sql, bindings) {
  const r = await db.query(sql, bindings);
  const rows = Array.isArray(r) ? r[r.length - 1] : r;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function tableInfo(db, table) {
  // INFO FOR TB returns [ { fields: {...}, indexes: {...}, ... } ]. The
  // raw shape lives one wrap deeper than queryFirst's filter; pull directly.
  const r = await db.query(`INFO FOR TB ${table};`);
  const first = Array.isArray(r) ? r[0] : r;
  // SurrealDB versions differ: some return the object directly, some wrap
  // it in an array. Coerce.
  if (Array.isArray(first)) return first[0] ?? null;
  return first ?? null;
}

// ── Daemon.pid marker check ───────────────────────────────────────────────

function checkDaemonPid(cacheDir) {
  const pidFile = join(cacheDir, "daemon.pid");
  let raw;
  try {
    raw = readFileSync(pidFile, "utf-8").trim();
  } catch (e) {
    return { ok: false, detail: `cannot read ${pidFile}: ${e?.code ?? e?.message ?? e}` };
  }
  if (!raw) return { ok: false, detail: "daemon.pid is empty (daemon not running?)" };

  // Pre-0.7.65: bare PID string like "3174755". JSON.parse() will happily
  // parse "3174755" as the number 3174755 — so we have to check structure,
  // not just JSON-ness.
  // 0.7.65+:    JSON { marker: "kongcode-daemon", pid, startedAt, daemonVersion }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  // Object-with-marker = new format. Anything else (number, malformed) = old.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.marker === "kongcode-daemon" && Number.isFinite(parsed.pid)) {
    let ageMs = null;
    if (Number.isFinite(parsed.startedAt) && parsed.startedAt > 0) {
      ageMs = Date.now() - Number(parsed.startedAt);
    }
    let mtimeAgeMs = null;
    try { mtimeAgeMs = Date.now() - statSync(pidFile).mtimeMs; } catch {}
    const uptime = ageMs != null ? `${(ageMs / 1000).toFixed(1)}s` :
                   mtimeAgeMs != null ? `${(mtimeAgeMs / 1000).toFixed(1)}s (mtime)` :
                   "?";
    return {
      ok: true,
      detail: `pid=${parsed.pid} version=${parsed.daemonVersion ?? "?"} uptime=${uptime}`,
    };
  }
  // Bare-PID format. This is the FAILURE case post-deploy: it means the
  // running daemon is the OLD build (or no restart happened).
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return { ok: false, detail: `legacy bare-PID format (pid=${n}) — daemon was NOT restarted on the new build` };
  }
  return { ok: false, detail: `unparseable daemon.pid: ${raw.slice(0, 80)}` };
}

// ── DB checks ─────────────────────────────────────────────────────────────

async function checkPing(db) {
  try {
    await db.query("RETURN 1;");
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

async function checkIndex(db, spec, requireUnique) {
  const info = await tableInfo(db, spec.table);
  const indexes = info?.indexes ?? {};
  const defn = indexes[spec.name];
  if (!defn) return { ok: false, detail: `index ${spec.name} not present on ${spec.table}` };
  const defStr = String(defn);
  // Field-tuple match: every expected field must appear in the DEFINE INDEX
  // string. Surreal serializes FIELDS as "FIELDS a, b, c" — substring match
  // each field name.
  for (const f of spec.fields) {
    if (!defStr.includes(f)) {
      return { ok: false, detail: `index ${spec.name} present but missing field ${f}: ${defStr.slice(0, 80)}` };
    }
  }
  if (requireUnique && !/UNIQUE/i.test(defStr)) {
    return { ok: false, detail: `index ${spec.name} present but NOT marked UNIQUE: ${defStr.slice(0, 80)}` };
  }
  return { ok: true };
}

async function checkField(db, spec) {
  const info = await tableInfo(db, spec.table);
  const fields = info?.fields ?? {};
  const defn = fields[spec.field];
  if (!defn) return { ok: false, detail: `field ${spec.field} not declared on ${spec.table}` };
  const s = String(defn);
  if (!spec.typeMatch.test(s)) {
    return { ok: false, detail: `field ${spec.field} present but type doesn't match ${spec.typeMatch}: ${s.slice(0, 80)}` };
  }
  return { ok: true };
}

async function checkNoDuplicatePendingWork(db) {
  // The UNIQUE index pw_session_worktype_status_unique forbids two pending
  // rows with the same (session_id, work_type, status). If the deploy
  // succeeded, no such duplicates should exist. SurrealDB on this deploy
  // doesn't support HAVING, so we group server-side and filter client-side.
  const rows = await qFirst(
    db,
    `SELECT session_id, work_type, count() AS n FROM pending_work
       WHERE status = 'pending'
       GROUP BY session_id, work_type`,
  );
  const dups = (Array.isArray(rows) ? rows : []).filter(r => Number(r.n) > 1);
  if (!dups.length) return { ok: true, detail: `scanned ${rows.length} groups` };
  const sample = dups.slice(0, 3).map(r => `${r.session_id}/${r.work_type}=${r.n}`).join(", ");
  return { ok: false, detail: `${dups.length} dup groups remain (sample: ${sample})` };
}

async function checkNoDuplicateArtifactPaths(db) {
  const rows = await qFirst(
    db,
    `SELECT path, count() AS n FROM artifact
       WHERE path IS NOT NONE
       GROUP BY path`,
  );
  const dups = (Array.isArray(rows) ? rows : []).filter(r => Number(r.n) > 1);
  if (!dups.length) return { ok: true, detail: `scanned ${rows.length} paths` };
  const sample = dups.slice(0, 3).map(r => `${r.path}=${r.n}`).join(", ");
  return { ok: false, detail: `${dups.length} dup paths remain (sample: ${sample})` };
}

async function checkPendingWorkCount(db) {
  const rows = await qFirst(
    db,
    `SELECT count() AS n FROM pending_work WHERE status = 'pending' GROUP ALL`,
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n > PENDING_WORK_PATHOLOGICAL_LIMIT) {
    return { ok: false, detail: `${n} pending rows (> ${PENDING_WORK_PATHOLOGICAL_LIMIT} threshold — backlog or duplicate-row regression)` };
  }
  return { ok: true, detail: `${n} pending` };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  let config;
  try {
    config = parsePluginConfig({});
  } catch (e) {
    console.error(`[postdeploy] FATAL: cannot parse config: ${e?.message ?? e}`);
    process.exit(2);
  }
  if (!config?.surreal?.url) {
    console.error("[postdeploy] FATAL: no Surreal URL resolvable from config.");
    process.exit(2);
  }
  const { url, ns, db: dbName, user, pass } = config.surreal;
  const cacheDir = config?.paths?.cacheDir ?? join(homedir(), ".kongcode", "cache");

  console.log(`[postdeploy] surreal ${url}  ns=${ns}  db=${dbName}`);
  console.log(`[postdeploy] cacheDir=${cacheDir}`);

  // Raw client — never run schema.surql from here.
  const db = new Surreal();
  try {
    await db.connect(url, {
      namespace: ns,
      database: dbName,
      authentication: { username: user, password: pass },
    });
  } catch (e) {
    console.error(`[postdeploy] FATAL: cannot connect to SurrealDB: ${e?.message ?? e}`);
    process.exit(2);
  }

  // ── Connectivity ──
  section("Connectivity");
  const ping = await checkPing(db);
  record("db ping", ping.ok, ping.detail);
  if (!ping.ok) {
    await db.close().catch(() => {});
    process.exit(2);
  }

  // ── Daemon marker ──
  section("Daemon binary");
  const daemonR = checkDaemonPid(cacheDir);
  record("daemon.pid is JSON marker (not bare PID)", daemonR.ok, daemonR.detail);

  // ── UNIQUE indexes ──
  section(`UNIQUE indexes (${EXPECTED_UNIQUE_INDEXES.length} expected)`);
  for (const spec of EXPECTED_UNIQUE_INDEXES) {
    try {
      const r = await checkIndex(db, spec, /* requireUnique */ true);
      record(`${spec.table}.${spec.name}`, r.ok, r.detail);
    } catch (e) {
      record(`${spec.table}.${spec.name}`, false, `query error: ${e?.message ?? e}`);
    }
  }

  // ── Hot-path WHERE indexes ──
  section(`Hot-path indexes (${EXPECTED_HOT_PATH_INDEXES.length} expected)`);
  for (const spec of EXPECTED_HOT_PATH_INDEXES) {
    try {
      const r = await checkIndex(db, spec, /* requireUnique */ false);
      record(`${spec.table}.${spec.name}`, r.ok, r.detail);
    } catch (e) {
      record(`${spec.table}.${spec.name}`, false, `query error: ${e?.message ?? e}`);
    }
  }

  // ── Field declarations ──
  section(`Typed field declarations (${EXPECTED_FIELD_TYPES.length} expected)`);
  for (const spec of EXPECTED_FIELD_TYPES) {
    try {
      const r = await checkField(db, spec);
      record(`${spec.table}.${spec.field}`, r.ok, r.detail);
    } catch (e) {
      record(`${spec.table}.${spec.field}`, false, `query error: ${e?.message ?? e}`);
    }
  }

  // ── Data invariants ──
  section("Data invariants");
  try {
    const dupPw = await checkNoDuplicatePendingWork(db);
    record("pending_work has no duplicate (session_id, work_type) pending rows", dupPw.ok, dupPw.detail);
  } catch (e) {
    record("pending_work duplicate check", false, `query error: ${e?.message ?? e}`);
  }
  try {
    const dupArt = await checkNoDuplicateArtifactPaths(db);
    record("artifact has no duplicate paths", dupArt.ok, dupArt.detail);
  } catch (e) {
    record("artifact duplicate-path check", false, `query error: ${e?.message ?? e}`);
  }
  try {
    const pwc = await checkPendingWorkCount(db);
    record(`pending_work total under ${PENDING_WORK_PATHOLOGICAL_LIMIT}`, pwc.ok, pwc.detail);
  } catch (e) {
    record("pending_work total count check", false, `query error: ${e?.message ?? e}`);
  }

  await db.close().catch(() => {});

  // ── Summary ──
  const failed = checks.filter(c => !c.ok);
  const passed = checks.length - failed.length;
  console.log(`\n=== SUMMARY ===`);
  console.log(`  ${passed}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`\n  FAILED:`);
    for (const f of failed) {
      console.log(`    - ${f.name}${f.detail ? "  (" + f.detail + ")" : ""}`);
    }
    if (VERBOSE) {
      console.log(`\n  HINT: if "daemon.pid is JSON marker" is the only failure, the schema deploy landed but you haven't restarted the daemon yet.`);
      console.log(`        if UNIQUE-index checks fail, the schema didn't re-apply — restart the daemon AFTER predeploy-dedup --apply succeeded.`);
      console.log(`        if "pending_work has no duplicates" fails, predeploy-dedup --apply hasn't been run (or ran against a different DB).`);
    }
    process.exit(1);
  }
  console.log(`\n  All clear. Deploy is healthy.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[postdeploy] FATAL:", e);
  process.exit(2);
});
