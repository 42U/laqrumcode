#!/usr/bin/env node
/**
 * Pre-deploy duplicate-row cleanup + (optional) schema repair.
 *
 * Agent 1 added UNIQUE indexes to src/engine/schema.surql for several tables
 * (pending_work, subagent, retrieval_outcome, turn_score, orchestrator_metrics,
 * identity_chunk, maturity_stage, causal_chain). Agent 11 added a UNIQUE
 * index on artifact.path. On the next daemon start runSchema() will try to
 * apply them, and SurrealDB REJECTS the DEFINE INDEX if duplicate rows
 * already violate uniqueness — blocking startup.
 *
 * This script enumerates each table's duplicate groups by the UNIQUE keys,
 * keeps the OLDEST row per group, and deletes the rest. Default mode is
 * dry-run.
 *
 * pending_work dedup scope (Agent 22 update):
 *   The original Agent 8 plan filtered to status='pending' only. But the
 *   live UNIQUE index is the compound (session_id, work_type, status) — the
 *   partial-WHERE form was rejected by the deployed Surreal, so Agent 10
 *   redefined it as a compound. That means duplicates in OTHER statuses
 *   (notably 'completed' — the original bug-burst produced both pending
 *   AND completed dupes) also block index creation. This script now dedups
 *   pending_work across ALL statuses, keyed by (session_id, work_type,
 *   status). Idempotent: a second run is a no-op when no dups remain.
 *
 * Schema repair (--repair-schema, one-off):
 *   Agent 1 added `DEFINE FIELD superseded_by ON concept TYPE
 *   option<record<memory>>` to schema.surql. But the live DB has it as
 *   `TYPE none | string` from a pre-existing declaration, and SurrealDB
 *   silently no-ops DEFINE FIELD re-declarations that change the type.
 *   With --repair-schema this script probes the field, and IF zero rows
 *   carry a non-NONE value, REMOVEs + redefines it. If any rows DO carry a
 *   value, it ABORTs the repair (data preservation > convenience). It also
 *   re-attempts the compound UNIQUE index after dedup, in case the daemon's
 *   schema apply happened before this script ran.
 *
 * Usage (from repo root):
 *   node scripts/predeploy-dedup.mjs                       # dry-run, dedup only
 *   node scripts/predeploy-dedup.mjs --apply               # actually delete dupes
 *   node scripts/predeploy-dedup.mjs --table=pending_work --apply
 *   node scripts/predeploy-dedup.mjs --verbose
 *   node scripts/predeploy-dedup.mjs --apply --repair-schema  # + one-off schema repair
 *
 * Status-normalize pass (round-2):
 *   schema.surql line ~520 defines pending_work.status with
 *     ASSERT $value IN ['pending', 'processing', 'completed', 'failed']
 *   Pre-0.7.x installs may carry legacy statuses ("queued", typos, NULL)
 *   that fail that ASSERT when the OVERWRITE DEFINE FIELD lands at daemon
 *   boot — which then refuses to start. This script runs a normalize pass
 *   BEFORE the dedup pass: any pending_work row with status NOT IN the
 *   four-value enum is UPDATEd to status='failed' (the safe terminal
 *   bucket). Clean installs hit zero rows so it's a no-op. With --apply
 *   off, the pass reports what WOULD change and leaves data alone.
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

/**
 * Bootstrap-safe Surreal access.
 *
 * Earlier versions of this script instantiated `SurrealStore` and called
 * `await store.initialize()`. That path invokes `runSchema()`, which applies
 * src/engine/schema.surql — including the NEW UNIQUE indexes that this very
 * script exists to make safe. Result: chicken-and-egg. The schema apply
 * fails on existing duplicates (e.g. pw_session_worktype_status_unique
 * already contains ['<sid>', 'soul_evolve', 'pending']), the script aborts
 * before deduping, and the daemon can never bootstrap.
 *
 * Fix: use the raw `surrealdb` Node client directly. Connect, authenticate,
 * set ns/db at connect-time — never touch schema. The daemon's next start
 * will run schema migration AFTER this dedup pass has cleared duplicates.
 *
 * `qFirst` / `qExec` mirror SurrealStore.queryFirst / .queryExec semantics
 * closely enough for this script's needs:
 *   - the raw client's db.query() returns an array of per-statement results;
 *     with a single statement we take result[0] and filter falsy.
 *   - ns/db is set at connect() time, so we omit the `USE NS … DB …` prefix.
 */
async function qFirst(db, sql, bindings) {
  const result = await db.query(sql, bindings);
  const rows = Array.isArray(result) ? result[result.length - 1] : result;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function qExec(db, sql, bindings) {
  await db.query(sql, bindings);
}

/**
 * Pull the raw INFO FOR TABLE <name> shape (object with .fields, .indexes,
 * etc.). Different SurrealDB client/server versions wrap the result one
 * level differently; this coerces both shapes.
 */
async function tableInfo(db, name) {
  const r = await db.query(`INFO FOR TABLE ${name};`);
  const first = Array.isArray(r) ? r[0] : r;
  if (Array.isArray(first)) return first[0] ?? null;
  return first ?? null;
}

/**
 * One-off repair pass. Gated behind --repair-schema. Two steps:
 *
 *   1. concept.superseded_by retype. schema.surql declares
 *      `option<record<memory>>`. The live DB still carries the legacy
 *      `none | string`. SurrealDB silently no-ops DEFINE FIELD when only
 *      the type changes, so the only way out is REMOVE + redefine. That
 *      destroys any existing values, so we ONLY do it when ZERO concept
 *      rows carry a non-NONE value. If any row carries a value, ABORT
 *      with a warning and leave the field alone — the user must decide.
 *
 *   2. pending_work compound UNIQUE re-attempt. The dedup pass above
 *      should have cleared violators; redeclaring the index is a no-op
 *      if it's already correctly defined.
 *
 * Idempotent: if the field type already contains "record", skip step 1.
 * If the index already exists with the right shape, step 2 is a no-op.
 *
 * Honors APPLY: if --repair-schema is given without --apply, prints the
 * decision and what WOULD happen, but does not mutate.
 */
async function repairSchema(db) {
  console.log("\n=== SCHEMA REPAIR ===");

  // ── Step 1: concept.superseded_by ──
  let cInfo;
  try {
    cInfo = await tableInfo(db, "concept");
  } catch (e) {
    console.log(`[repair] cannot read INFO FOR TABLE concept: ${e?.message ?? e}`);
    return { fieldRepair: "error", indexRepair: "skipped" };
  }
  const fieldDefn = String(cInfo?.fields?.superseded_by ?? "");
  let fieldOutcome;
  if (!fieldDefn) {
    console.log("[repair] concept.superseded_by: field absent — DEFINE FIELD with record type");
    if (APPLY) {
      await db.query(
        "DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>;",
      );
      fieldOutcome = "defined";
    } else {
      fieldOutcome = "would_define";
    }
  } else if (/record/i.test(fieldDefn)) {
    console.log(`[repair] concept.superseded_by: already record-typed — skip`);
    console.log(`  current: ${fieldDefn.slice(0, 100)}`);
    fieldOutcome = "skipped_already_correct";
  } else {
    // Field exists but isn't record-typed. Check if any rows carry a value.
    const rows = await qFirst(
      db,
      "SELECT count() AS n FROM concept WHERE superseded_by IS NOT NONE GROUP ALL;",
    );
    const n = Number(rows?.[0]?.n ?? 0);
    if (n > 0) {
      console.log(`[repair] concept.superseded_by: ${n} rows carry a non-NONE value — ABORT`);
      console.log(`  current type: ${fieldDefn.slice(0, 100)}`);
      console.log(`  reason: REMOVE FIELD would destroy data. Repair requires user decision`);
      console.log(`         (e.g. migrate values to a typed column or accept legacy type).`);
      fieldOutcome = "aborted_has_data";
    } else {
      console.log(`[repair] concept.superseded_by: 0 rows in use — safe to REMOVE + redefine`);
      console.log(`  current: ${fieldDefn.slice(0, 100)}`);
      if (APPLY) {
        await db.query("REMOVE FIELD superseded_by ON concept;");
        await db.query(
          "DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>;",
        );
        fieldOutcome = "repaired";
      } else {
        fieldOutcome = "would_repair";
      }
    }
  }

  // ── Step 2: pending_work compound UNIQUE re-attempt ──
  let pwInfo;
  try {
    pwInfo = await tableInfo(db, "pending_work");
  } catch (e) {
    console.log(`[repair] cannot read INFO FOR TABLE pending_work: ${e?.message ?? e}`);
    return { fieldRepair: fieldOutcome, indexRepair: "error" };
  }
  const idxDefn = String(pwInfo?.indexes?.pw_session_worktype_status_unique ?? "");
  let indexOutcome;
  if (idxDefn && /UNIQUE/i.test(idxDefn)
      && /session_id/.test(idxDefn) && /work_type/.test(idxDefn) && /status/.test(idxDefn)) {
    console.log("[repair] pw_session_worktype_status_unique: already present and correct — skip");
    indexOutcome = "skipped_already_correct";
  } else {
    console.log("[repair] pw_session_worktype_status_unique: absent or wrong shape — define");
    if (idxDefn) console.log(`  current: ${idxDefn.slice(0, 100)}`);
    if (APPLY) {
      try {
        await db.query(
          "DEFINE INDEX pw_session_worktype_status_unique ON pending_work FIELDS session_id, work_type, status UNIQUE;",
        );
        indexOutcome = "defined";
        console.log("[repair] UNIQUE index defined.");
      } catch (e) {
        indexOutcome = "failed";
        console.log(`[repair] UNIQUE index DEFINE failed: ${e?.message ?? e}`);
        console.log("[repair] this typically means dupes still exist — check pending_work dedup output above.");
      }
    } else {
      indexOutcome = "would_define";
    }
  }

  return { fieldRepair: fieldOutcome, indexRepair: indexOutcome };
}

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const REPAIR_SCHEMA = process.argv.includes("--repair-schema");
const TABLE_ARG = (process.argv.find(a => a.startsWith("--table=")) || "").slice("--table=".length) || null;

/**
 * Per-table plans. Each entry says:
 *   - name: table name
 *   - keys: the columns that form the UNIQUE tuple (used for GROUP BY + log)
 *   - filter: optional SurrealQL WHERE fragment scoping which rows the
 *     UNIQUE constraint applies to (matches the index's WHERE clause; for
 *     subagent it also drops NONE-keyed rows which aren't deduplicable)
 *   - totalLabel: optional extra "total" count for the report
 *
 * The plan is intentionally declarative — the engine below treats them
 * uniformly.
 */
const PLANS = [
  {
    // Dedup across ALL statuses — matches the compound UNIQUE
    // (session_id, work_type, status) that the live schema enforces. The
    // original bug burst produced dupes in both 'pending' AND 'completed';
    // filtering to status='pending' (the previous Agent 8 plan) left the
    // completed-status dupes in place and blocked schema apply. Including
    // 'status' in the key here makes dedup idempotent against the index.
    name: "pending_work",
    keys: ["session_id", "work_type", "status"],
  },
  {
    name: "subagent",
    keys: ["correlation_key"],
    // correlation_key NONE → not deduplicable (UNIQUE in SurrealDB does not
    // collide on NONE the same way other DBs do, but the user's spec asks
    // us to skip them to avoid touching legacy rows that never had a key).
    filter: "correlation_key IS NOT NONE",
    label: "subagent.correlation_key",
  },
  {
    name: "subagent",
    keys: ["run_id"],
    filter: "run_id IS NOT NONE",
    label: "subagent.run_id",
  },
  {
    name: "retrieval_outcome",
    keys: ["session_id", "turn_id", "memory_id"],
  },
  {
    name: "turn_score",
    keys: ["session_id", "turn_id"],
  },
  {
    name: "orchestrator_metrics",
    keys: ["session_id", "turn_index"],
  },
  {
    name: "identity_chunk",
    keys: ["source", "identity_version", "chunk_index"],
  },
  {
    name: "maturity_stage",
    keys: ["stage"],
  },
  {
    name: "causal_chain",
    keys: ["trigger_memory", "outcome_memory", "chain_type"],
  },
  {
    // Agent 11 added `DEFINE INDEX artifact_path_unique ON artifact FIELDS path
    // UNIQUE` (schema.surql line 584). artifact.path is TYPE string (not
    // option), but PostToolUse re-fires historically produced duplicate rows
    // and a few legacy rows may have path = NONE; skip those just like
    // subagent.correlation_key does, since they're not deduplicable on a
    // single-column UNIQUE.
    name: "artifact",
    keys: ["path"],
    filter: "path IS NOT NONE",
  },
];

function fmtKeys(keys) {
  return keys.length === 1 ? keys[0] : `(${keys.join(", ")})`;
}

function planLabel(p) {
  return p.label ?? p.name;
}

async function tableCount(db, name, filter) {
  const where = filter ? `WHERE ${filter}` : "";
  const rows = await qFirst(
    db,
    `SELECT count() AS n FROM ${name} ${where} GROUP ALL`,
  );
  return Number(rows?.[0]?.n ?? 0);
}

/**
 * Returns an array of { key: <tuple>, ids: [...sorted oldest-first by created_at then id] }.
 * Uses a single SELECT … GROUP BY pass; SurrealDB GROUP BY returns the grouped
 * columns plus aggregates, but to get the per-group id list we pull all rows
 * sorted, then bucket in JS. For our tables this is at most low-tens-of-
 * thousands rows, fine to hold in memory.
 */
async function fetchGroups(db, plan) {
  const where = plan.filter ? `WHERE ${plan.filter}` : "";
  const selectCols = [
    "id",
    "created_at",
    ...plan.keys,
  ].join(", ");
  const rows = await qFirst(
    db,
    `SELECT ${selectCols} FROM ${plan.name} ${where} ORDER BY created_at ASC`,
  );

  const groups = new Map();
  for (const r of rows) {
    // Skip rows that have NULL/NONE for any key column — they cannot
    // collide on a UNIQUE composite, so they're not "duplicate groups".
    if (plan.keys.some(k => r[k] === null || r[k] === undefined)) continue;
    const key = plan.keys.map(k => JSON.stringify(r[k])).join("|");
    let g = groups.get(key);
    if (!g) {
      g = { keyVals: plan.keys.map(k => r[k]), ids: [] };
      groups.set(key, g);
    }
    g.ids.push({ id: r.id, created_at: r.created_at });
  }
  return groups;
}

/**
 * Normalize pre-existing pending_work rows whose status is not in the new
 * four-value enum ['pending','processing','completed','failed']. Without
 * this, the OVERWRITE DEFINE FIELD in schema.surql runs its ASSERT against
 * every row at daemon boot and rejects the apply if any row violates —
 * which prevents startup. We rewrite violators to 'failed' (safe terminal
 * bucket) so the schema apply lands cleanly.
 *
 * Idempotent: a second run finds zero violators and is a no-op.
 * Honors APPLY: dry-run reports the count, does not write.
 */
async function normalizePendingWorkStatus(db) {
  const allowed = "['pending', 'processing', 'completed', 'failed']";
  let badRows;
  try {
    badRows = await qFirst(
      db,
      `SELECT id, status FROM pending_work WHERE status NOT IN ${allowed} OR status IS NONE`,
    );
  } catch (e) {
    console.log(`[pending_work.status] cannot enumerate violators: ${e?.message ?? e}`);
    return { violators: 0, updated: 0, error: String(e?.message ?? e) };
  }
  if (!Array.isArray(badRows) || badRows.length === 0) {
    console.log("[pending_work.status] 0 rows with out-of-enum status — skip");
    return { violators: 0, updated: 0 };
  }
  // Bucket by the offending status value for a useful summary line.
  const byStatus = new Map();
  for (const r of badRows) {
    const k = r?.status === undefined || r?.status === null ? "NONE" : String(r.status);
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  const summary = [...byStatus.entries()].map(([k, n]) => `${k}=${n}`).join(", ");
  console.log(`[pending_work.status] ${badRows.length} rows violate enum (${summary}) — ${APPLY ? "rewriting to 'failed'" : "would rewrite to 'failed'"}`);
  if (!APPLY) return { violators: badRows.length, updated: 0 };

  const ids = badRows.map(r => r.id);
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      await qExec(
        db,
        `BEGIN TRANSACTION;
         UPDATE pending_work SET status = 'failed' WHERE id IN $ids;
         COMMIT TRANSACTION;`,
        { ids: chunk },
      );
      updated += chunk.length;
    } catch (e) {
      // Record which id batch failed so the operator can isolate the offender
      // without a debug re-run. Stringify the ids defensively — they're Thing
      // objects from the surrealdb client and JSON.stringify handles their
      // toJSON. The full list is logged, not truncated, so a follow-up
      // SELECT ... WHERE id IN [...] reproduces the failure exactly.
      const idDump = JSON.stringify(chunk.map(x => String(x)));
      console.error(`[pending_work.status] chunk ${i}-${i + chunk.length} FAILED, rolled back: ${e?.message ?? e}`);
      console.error(`[pending_work.status] failed chunk ids: ${idDump}`);
      throw e;
    }
  }
  console.log(`[pending_work.status] updated ${updated} rows to status='failed'`);
  return { violators: badRows.length, updated };
}

async function processPlan(db, plan) {
  const label = planLabel(plan);
  const total = await tableCount(db, plan.name, null);
  const filtered = plan.filter ? await tableCount(db, plan.name, plan.filter) : total;

  const groups = await fetchGroups(db, plan);
  const dupGroups = [];
  let toDelete = [];
  for (const [, g] of groups) {
    if (g.ids.length < 2) continue;
    // ids are already sorted by created_at ASC (oldest first) from the SELECT.
    // Belt-and-suspenders: also tiebreak on id string so the keeper is
    // deterministic if created_at collides.
    g.ids.sort((a, b) => {
      const ta = String(a.created_at);
      const tb = String(b.created_at);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    const keep = g.ids[0];
    const drop = g.ids.slice(1);
    dupGroups.push({ keyVals: g.keyVals, keep, drop });
    for (const d of drop) toDelete.push(d.id);
  }

  // Header line: total / filtered / duplicate-group count
  const totalParts = [`${total} total`];
  if (plan.filter) totalParts.push(`${filtered} ${plan.totalLabel ?? "matching"}`);
  totalParts.push(`${dupGroups.length} duplicate groups`);
  console.log(`[${label}] ${totalParts.join(" / ")}`);
  console.log(
    `[${label}] keeping oldest per ${fmtKeys(plan.keys)}, ` +
    `${APPLY ? "deleting" : "would delete"} ${toDelete.length} rows`,
  );

  if (VERBOSE) {
    const sample = dupGroups.slice(0, 5);
    for (const g of sample) {
      const keyStr = plan.keys.map((k, i) => `${k}=${JSON.stringify(g.keyVals[i])}`).join(" ");
      console.log(`  group ${keyStr}`);
      console.log(`    keep:  ${g.keep.id}  created_at=${g.keep.created_at}`);
      for (const d of g.drop.slice(0, 3)) {
        console.log(`    drop:  ${d.id}  created_at=${d.created_at}`);
      }
      if (g.drop.length > 3) console.log(`    drop:  …and ${g.drop.length - 3} more`);
    }
    if (dupGroups.length > sample.length) {
      console.log(`  …and ${dupGroups.length - sample.length} more groups`);
    }
  }

  if (APPLY && toDelete.length > 0) {
    // SurrealDB accepts record-id arrays in WHERE IN as $param when the
    // array contains real Thing values. The rows we pulled have r.id as
    // an object/Thing from the surrealdb client, which round-trips fine.
    // Chunk to keep query size sane.
    //
    // Each chunk runs in its own BEGIN/COMMIT TRANSACTION so a partial
    // failure (e.g. an FK trigger throwing on row 247 of a 500-row chunk)
    // rolls the whole chunk back cleanly. Without this, prior chunks have
    // already committed and a mid-chunk failure leaves the table in a state
    // that's neither fully-deduped nor in the original pre-run shape — and
    // the next re-run can't tell which chunk it died on. The transactional
    // form means the script can be re-run idempotently from any point.
    const CHUNK = 500;
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const chunk = toDelete.slice(i, i + CHUNK);
      try {
        await qExec(
          db,
          `BEGIN TRANSACTION;
           DELETE ${plan.name} WHERE id IN $ids;
           COMMIT TRANSACTION;`,
          { ids: chunk },
        );
        deleted += chunk.length;
      } catch (e) {
        // Capture the failing chunk's ids so the operator can identify the
        // bad row(s) directly — round-2 ask. Without this, an FK trigger
        // or constraint that aborts on row N of the chunk leaves no trail;
        // the operator has to re-run with --verbose and hope the order is
        // deterministic. Dump the full id list (Things stringify cleanly)
        // and emit to stderr so it survives stdout truncation.
        const idDump = JSON.stringify(chunk.map(x => String(x)));
        console.error(`[${label}] chunk ${i}-${i + chunk.length} FAILED, rolled back: ${e?.message ?? e}`);
        console.error(`[${label}] failed chunk ids: ${idDump}`);
        // Re-throw so the outer error path runs — partial deletes are still
        // committed from prior successful chunks but the script bails before
        // continuing past a failure it can't reason about.
        throw e;
      }
    }
    console.log(`[${label}] deleted ${deleted} rows`);
  }

  return { label, total, filtered, dupGroups: dupGroups.length, toDelete: toDelete.length };
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[predeploy-dedup] FATAL: no Surreal URL resolvable from config — refusing to run.");
    process.exit(2);
  }
  const { url, ns, db: dbName, user, pass } = config.surreal;

  // Raw client — does NOT run schema migration. See top-of-file note.
  const db = new Surreal();
  await db.connect(url, {
    namespace: ns,
    database: dbName,
    authentication: { username: user, password: pass },
  });

  // Pre-flight: prove the connection works before any destructive op.
  // The raw client has no ping(); a trivial RETURN 1 round-trip is the
  // equivalent — surfaces auth / ns-db / network failures up front.
  try {
    await db.query("RETURN 1;");
  } catch (e) {
    console.error(`[predeploy-dedup] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[predeploy-dedup] APPLY=${APPLY}  VERBOSE=${VERBOSE}  REPAIR_SCHEMA=${REPAIR_SCHEMA}  TABLE=${TABLE_ARG ?? "(all)"}`);
  console.log(`[predeploy-dedup] surreal ${url}  ns=${ns}  db=${dbName}`);

  const plans = TABLE_ARG
    ? PLANS.filter(p => p.name === TABLE_ARG)
    : PLANS;
  if (plans.length === 0) {
    console.error(`[predeploy-dedup] no plan matched --table=${TABLE_ARG}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  // Pre-flight: total row counts per touched table (de-duplicated by name).
  const seen = new Set();
  for (const p of plans) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const n = await tableCount(db, p.name, null);
    console.log(`[predeploy-dedup] ${p.name}: ${n} total rows`);
  }
  console.log("");

  // ── Normalize pending_work.status BEFORE dedup ──
  // The pending_work plan groups by (session_id, work_type, status) — if we
  // dedup first and a violator row survives, the schema OVERWRITE on status
  // will still reject the apply at daemon boot. Normalizing first means
  // every surviving row is enum-legal by the time dedup runs, and the dedup
  // grouping correctly sees normalized rows as same-bucket where applicable.
  // Skipped when --table is set to anything other than 'pending_work'.
  let normalizeResult = null;
  if (!TABLE_ARG || TABLE_ARG === "pending_work") {
    try {
      normalizeResult = await normalizePendingWorkStatus(db);
    } catch (e) {
      console.error(`[pending_work.status] FATAL: ${e?.message ?? e}`);
      normalizeResult = { violators: -1, updated: -1, error: String(e?.message ?? e) };
    }
    console.log("");
  }

  const results = [];
  for (const plan of plans) {
    try {
      const r = await processPlan(db, plan);
      results.push(r);
    } catch (e) {
      console.error(`[${planLabel(plan)}] ERROR: ${e?.message ?? e}`);
      results.push({ label: planLabel(plan), error: String(e?.message ?? e) });
    }
  }

  let repair = null;
  if (REPAIR_SCHEMA) {
    try {
      repair = await repairSchema(db);
    } catch (e) {
      console.error(`[repair] FATAL: ${e?.message ?? e}`);
      repair = { fieldRepair: "fatal", indexRepair: "fatal" };
    }
  }

  console.log("\n=== SUMMARY ===");
  if (normalizeResult) {
    if (normalizeResult.error) {
      console.log(`  pending_work.status: ERROR ${normalizeResult.error}`);
    } else {
      console.log(
        `  pending_work.status: ${normalizeResult.violators} violators, ` +
        `${normalizeResult.updated} rows ${APPLY ? "rewritten to 'failed'" : "would be rewritten to 'failed'"}`,
      );
    }
  }
  let grandDelete = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.label}: ERROR ${r.error}`);
      continue;
    }
    console.log(
      `  ${r.label}: ${r.dupGroups} dup groups, ${r.toDelete} rows ${APPLY ? "deleted" : "would be deleted"}`,
    );
    grandDelete += r.toDelete;
  }
  console.log(`  TOTAL: ${grandDelete} rows ${APPLY ? "deleted" : "would be deleted"}`);
  if (repair) {
    console.log(`  REPAIR: concept.superseded_by=${repair.fieldRepair}  pw_session_worktype_status_unique=${repair.indexRepair}`);
  }
  if (!APPLY) {
    console.log("\n(dry-run — re-run with --apply to actually delete)");
  }

  await db.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error("[predeploy-dedup] FATAL:", e);
  process.exit(1);
});
