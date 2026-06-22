#!/usr/bin/env node
/**
 * KongCode JSON Lines restore — reads a `scripts/backup-jsonl.mjs` backup
 * directory (one `<table>.jsonl` per table + a `metadata.json` manifest) back
 * into a kongcode SurrealDB graph.
 *
 * Activated by skills/kongcode-restore-jsonl/SKILL.md. Counterpart to
 * scripts/backup-jsonl.mjs — keep NODE_TABLES + EDGE_TABLES in sync with it.
 *
 * Usage:
 *   node scripts/restore-jsonl.mjs <backup-dir> [--overwrite] [--merge-by-hash] [--dry-run]
 *
 * Merge strategy (per node row, by record id):
 *   default            skip-if-exists — never clobber an existing row (idempotent,
 *                      non-destructive, append-only friendly).
 *   --overwrite        replace an existing row by id (UPDATE … CONTENT).
 *   --merge-by-hash    skip a row if ANY row with the same content_hash already
 *                      exists in the target table (cross-machine dedup). Rows
 *                      without a content_hash fall back to skip-if-exists by id.
 *
 * Edges are RELATE'd preserving in/out/id, skip-if-exists, and are SKIPPED
 * (logged as missing-endpoint) when either endpoint node is absent from the
 * target graph — so a partial restore can never create a dangling edge.
 *
 * Restore never deletes. Exit code is non-zero only on a fatal connection or
 * parse error, never on skips/missing-endpoints.
 *
 * Env-var overrides (match backup-jsonl.mjs; defaults from src/engine/config.ts):
 *   SURREAL_URL   — default ws://127.0.0.1:8000/rpc
 *   SURREAL_USER  — default root
 *   SURREAL_PASS  — default root
 *   SURREAL_NS    — default kong
 *   SURREAL_DB    — default memory
 */

import { Surreal, RecordId, DateTime } from "surrealdb";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "kong";
const DB = process.env.SURREAL_DB || "memory";

/** Node tables — MUST match scripts/backup-jsonl.mjs NODE_TABLES. Imported FIRST. */
const NODE_TABLES = [
  "access_stats",
  "agent", "project", "task", "artifact", "concept",
  "turn", "identity_chunk", "session", "memory", "core_memory",
  "monologue", "skill", "reflection", "retrieval_outcome",
  "orchestrator_metrics", "orchestrator_metrics_daily",
  "causal_chain", "compaction_checkpoint", "subagent",
  "memory_utility_cache", "soul", "graduation_event",
  "maturity_stage", "pending_work", "turn_score",
  "embedding_cache", "maintenance_runs", "turn_archive",
];

/** Edge (RELATION) tables — MUST match scripts/backup-jsonl.mjs EDGE_TABLES.
 *  Imported AFTER nodes so both endpoints exist when an edge is RELATE'd. */
const EDGE_TABLES = [
  // Turn-level
  "responds_to", "tool_result_of", "part_of", "mentions",
  // 5-pillar
  "performed", "owns", "task_part_of", "session_task",
  "produced", "derived_from", "relevant_to", "used_in",
  // Knowledge hierarchy
  "narrower", "broader", "related_to",
  // Memory causality
  "caused_by", "supports", "contradicts", "describes",
  // Evolution
  "supersedes",
  // Cross-pillar
  "about_concept", "artifact_mentions",
  // Skills
  "skill_from_task", "skill_uses_concept",
  // Reflections
  "reflects_on",
  // Subagent
  "spawned", "spawned_from",
  // Other
  "summarizes",
];

/**
 * VALUE (computed) fields that SurrealDB recomputes on every write. They are
 * stripped before re-create — writing them is at best ignored and at worst a
 * coercion error. Only one exists in schema.surql: pending_work.dedup_key.
 */
const COMPUTED_FIELDS = {
  pending_work: ["dedup_key"],
};

/**
 * Per-table datetime fields (TYPE datetime / option<datetime> in schema.surql).
 * The backup serializes SurrealDB datetimes to ISO-8601 strings via JSON; on a
 * SCHEMAFULL/typed field a plain string is REJECTED ("Expected datetime but
 * found '…'"), so each listed field's string value is wrapped in a SurrealDB
 * DateTime (nanosecond-lossless) before write. We do NOT blanket-convert every
 * ISO-looking string: soul.revisions.*.timestamp is TYPE string and rejects a
 * DateTime, so conversion is gated on this explicit per-table allowlist.
 */
const DATETIME_FIELDS = {
  access_stats: ["last_accessed"],
  agent: ["created_at"],
  project: ["created_at"],
  task: ["created_at", "updated_at"],
  artifact: ["created_at"],
  concept: ["created_at", "last_accessed", "superseded_at"],
  turn: ["timestamp", "created_at"],
  identity_chunk: ["archived_at"],
  session: ["started_at", "last_active", "ended_at"],
  memory: [
    "created_at", "last_accessed", "resolved_at", "archived_at",
    "next_surface_at", "last_surfaced", "last_engaged",
  ],
  core_memory: ["created_at", "updated_at", "archived_at"],
  monologue: ["timestamp"],
  skill: ["created_at", "last_used"],
  reflection: ["created_at", "archived_at"],
  retrieval_outcome: ["created_at"],
  orchestrator_metrics: ["created_at"],
  orchestrator_metrics_daily: ["created_at"],
  causal_chain: ["created_at", "graduated_at"],
  compaction_checkpoint: ["created_at"],
  subagent: ["created_at", "ended_at"],
  memory_utility_cache: ["last_updated"],
  soul: ["created_at", "updated_at"],
  graduation_event: ["created_at", "acknowledged_at"],
  maturity_stage: ["created_at"],
  pending_work: ["created_at", "completed_at", "archived_at"],
  turn_score: ["created_at"],
  embedding_cache: ["created_at", "pruned_at"],
  maintenance_runs: ["ran_at"],
  // turn_archive is SCHEMALESS with no declared fields — nothing to coerce.
};

/**
 * Per-table record<...> reference fields. The backup serializes a RecordId to a
 * plain "table:id" string; a typed record<X> field REJECTS that string
 * ("Expected record<memory> but found 'memory:…'"), so each listed field's
 * string value is converted back to a RecordId before write.
 */
const RECORD_FIELDS = {
  // access_stats.target is a record link to the counted node (concept|memory|…),
  // serialized to a "table:id" string by the backup. Convert it back so the
  // restored counter row carries a real record link, matching how surreal.ts
  // writes it (UPSERT … SET target = <recordid>). access_stats is SCHEMALESS so
  // a bare string would not be rejected, but restoring it as a link keeps the
  // round-trip faithful (and <string>target casts in fetchAccessDeltas stay valid).
  access_stats: ["target"],
  memory: ["superseded_by"],
  concept: ["superseded_by"],
  reflection: ["superseded_by"],
  skill: ["superseded_by"],
  memory_utility_cache: ["memory_id"],
};

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RECORD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*:.+$/;

/** Parse a "table:key" string into a RecordId. The colon split is on the FIRST
 *  colon so keys containing ':' survive. Throws on a malformed id. */
function toRecordId(id) {
  if (typeof id !== "string" || !RECORD_ID_RE.test(id)) {
    throw new Error(`Invalid record id: ${String(id).slice(0, 60)}`);
  }
  const colon = id.indexOf(":");
  return new RecordId(id.slice(0, colon), id.slice(colon + 1));
}

/** Build the CONTENT object for a node row: drop id (set via the $thing target),
 *  strip computed fields, coerce datetime + record fields. Returns { content }. */
function nodeContent(table, row) {
  const { id: _id, ...rest } = row;
  for (const f of COMPUTED_FIELDS[table] ?? []) delete rest[f];
  for (const f of DATETIME_FIELDS[table] ?? []) {
    const v = rest[f];
    if (typeof v === "string" && ISO_DATETIME_RE.test(v)) rest[f] = new DateTime(v);
  }
  for (const f of RECORD_FIELDS[table] ?? []) {
    const v = rest[f];
    if (typeof v === "string" && RECORD_ID_RE.test(v)) rest[f] = toRecordId(v);
  }
  return rest;
}

function parseArgs(argv) {
  const flags = { overwrite: false, mergeByHash: false, dryRun: false };
  const positional = [];
  for (const a of argv) {
    if (a === "--overwrite") flags.overwrite = true;
    else if (a === "--merge-by-hash") flags.mergeByHash = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  return { flags, backupDir: positional[0] };
}

/** Read a <table>.jsonl into an array of parsed rows. Returns [] if the file is
 *  absent (a table with zero rows is simply not written by the backup). A parse
 *  error on a present file is FATAL (throws) — a corrupt backup must not be
 *  silently half-restored. */
async function readTableRows(backupDir, table) {
  const file = join(backupDir, `${table}.jsonl`);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`Parse error in ${table}.jsonl line ${i + 1}: ${e.message}`);
    }
  }
  return rows;
}

async function rowExists(db, thing) {
  const r = await db.query(`SELECT id FROM $thing`, { thing });
  return Array.isArray(r[0]) && r[0].length > 0;
}

async function restoreNodeTable(db, backupDir, table, flags) {
  const rows = await readTableRows(backupDir, table);
  const stat = { table, total: rows.length, created: 0, skipped: 0, errors: 0 };
  if (rows.length === 0) return stat;

  // For --merge-by-hash, preload the set of content_hash values already present
  // in the target table so we can skip cross-machine duplicates in one pass.
  let existingHashes = null;
  if (flags.mergeByHash) {
    existingHashes = new Set();
    try {
      const hr = await db.query(
        `SELECT content_hash FROM ${table} WHERE content_hash != NONE`,
      );
      for (const r of hr[0] ?? []) {
        if (r.content_hash) existingHashes.add(r.content_hash);
      }
    } catch {
      // Table may not carry content_hash; fall through to id-based skip.
      existingHashes = new Set();
    }
  }

  for (const row of rows) {
    let thing;
    try {
      thing = toRecordId(row.id);
    } catch (e) {
      console.warn(`    ! ${table}: skipping row with bad id (${e.message})`);
      stat.errors++;
      continue;
    }

    try {
      // --merge-by-hash: skip if this content_hash already exists anywhere.
      if (flags.mergeByHash && existingHashes && row.content_hash) {
        if (existingHashes.has(row.content_hash)) { stat.skipped++; continue; }
      }

      const exists = await rowExists(db, thing);
      if (exists && !flags.overwrite) { stat.skipped++; continue; }

      const content = nodeContent(table, row);
      if (flags.dryRun) { stat.created++; continue; }

      if (exists && flags.overwrite) {
        await db.query(`UPDATE $thing CONTENT $c`, { thing, c: content });
      } else {
        await db.query(`CREATE $thing CONTENT $c`, { thing, c: content });
      }
      stat.created++;
      if (existingHashes && row.content_hash) existingHashes.add(row.content_hash);
    } catch (e) {
      console.warn(`    ! ${table}: ${String(e?.message ?? e).slice(0, 160)}`);
      stat.errors++;
    }
  }
  return stat;
}

async function restoreEdgeTable(db, backupDir, table, flags) {
  const rows = await readTableRows(backupDir, table);
  const stat = { table, total: rows.length, created: 0, skipped: 0, missing: 0, errors: 0 };
  if (rows.length === 0) return stat;

  for (const row of rows) {
    let inRid, outRid, edgeRid;
    try {
      inRid = toRecordId(row.in);
      outRid = toRecordId(row.out);
      edgeRid = row.id ? toRecordId(row.id) : null;
    } catch (e) {
      console.warn(`    ! ${table}: skipping edge with bad in/out/id (${e.message})`);
      stat.errors++;
      continue;
    }

    try {
      // Endpoint guard: skip + log if either node is absent so a partial
      // restore can never create a dangling edge.
      const [inOk, outOk] = await Promise.all([rowExists(db, inRid), rowExists(db, outRid)]);
      if (!inOk || !outOk) {
        const which = !inOk && !outOk ? "in+out" : !inOk ? "in" : "out";
        console.warn(`    ~ ${table}: missing ${which} endpoint (${row.in} -> ${row.out}), skipping`);
        stat.missing++;
        continue;
      }

      // Skip-if-exists: by edge id when present, else by the (in,out) pair.
      let already = false;
      if (edgeRid) {
        already = await rowExists(db, edgeRid);
      } else {
        const ex = await db.query(
          `SELECT id FROM ${table} WHERE in = $i AND out = $o LIMIT 1`,
          { i: inRid, o: outRid },
        );
        already = Array.isArray(ex[0]) && ex[0].length > 0;
      }
      if (already) { stat.skipped++; continue; }

      // Dry-run: count what WOULD be created but write nothing (mirrors
      // restoreNodeTable). Endpoints exist and the edge isn't present, so a real
      // run would RELATE here.
      if (flags.dryRun) { stat.created++; continue; }

      if (edgeRid) {
        await db.query(`RELATE $i->${table}->$o SET id = $eid`, { i: inRid, o: outRid, eid: edgeRid });
      } else {
        await db.query(`RELATE $i->${table}->$o`, { i: inRid, o: outRid });
      }
      stat.created++;
    } catch (e) {
      console.warn(`    ! ${table}: ${String(e?.message ?? e).slice(0, 160)}`);
      stat.errors++;
    }
  }
  return stat;
}

async function readManifest(backupDir) {
  try {
    const raw = await readFile(join(backupDir, "metadata.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Compare backup schema_version to this checkout's package.json version.
 *  WARNS on a major/minor mismatch; never hard-fails (patch diffs are noise). */
async function verifySchemaVersion(manifest) {
  if (!manifest) {
    console.warn("  ! no metadata.json in backup dir — cannot verify schema version (continuing).");
    return;
  }
  const backupVer = manifest.schema_version ?? "unknown";
  let localVer = "unknown";
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
    localVer = String(pkg.version ?? "unknown");
  } catch { /* keep unknown */ }

  const majMin = (v) => String(v).split(".").slice(0, 2).join(".");
  if (backupVer === "unknown") {
    console.warn(`  ! backup has no schema_version; local is ${localVer} (continuing).`);
  } else if (majMin(backupVer) !== majMin(localVer)) {
    console.warn(
      `  ! schema_version mismatch: backup ${backupVer} vs local ${localVer} ` +
      `(continuing — restore is field-tolerant, but verify after).`,
    );
  } else {
    console.log(`  schema_version: backup ${backupVer}, local ${localVer} (match).`);
  }
}

async function main() {
  const { flags, backupDir: rawDir } = parseArgs(process.argv.slice(2));
  if (!rawDir) {
    console.error("Usage: node scripts/restore-jsonl.mjs <backup-dir> [--overwrite] [--merge-by-hash] [--dry-run]");
    process.exit(2);
  }
  const backupDir = resolve(rawDir);

  // Fatal if the dir is unreadable / not a backup dir.
  let entries;
  try {
    entries = await readdir(backupDir);
  } catch (e) {
    console.error(`restore-jsonl: cannot read backup dir ${backupDir}: ${e.message}`);
    process.exit(1);
  }
  if (!entries.some(f => f.endsWith(".jsonl") || f === "metadata.json")) {
    console.error(`restore-jsonl: ${backupDir} contains no .jsonl files or metadata.json — not a kongcode backup dir.`);
    process.exit(1);
  }

  const strategy = flags.overwrite ? "overwrite" : flags.mergeByHash ? "merge-by-hash" : "skip-if-exists";
  console.log(`KongCode JSON-Lines restore`);
  console.log(`  Source:   ${backupDir}`);
  console.log(`  Target:   ${URL} ns=${NS} db=${DB}`);
  console.log(`  Strategy: ${strategy}${flags.dryRun ? " (dry-run, no writes)" : ""}`);

  const manifest = await readManifest(backupDir);
  await verifySchemaVersion(manifest);

  const db = new Surreal();
  try {
    await db.connect(URL);
    await db.signin({ username: USER, password: PASS });
    await db.use({ namespace: NS, database: DB });
  } catch (e) {
    console.error(`restore-jsonl: connection failed: ${e.message}`);
    process.exit(1);
  }

  const nodeStats = [];
  const edgeStats = [];
  try {
    for (const t of NODE_TABLES) {
      const s = await restoreNodeTable(db, backupDir, t, flags);
      nodeStats.push(s);
      if (s.total > 0) {
        console.log(`  node ${t.padEnd(26)} created ${String(s.created).padStart(7)}  skipped ${String(s.skipped).padStart(7)}${s.errors ? `  errors ${s.errors}` : ""}`);
      }
    }
    for (const t of EDGE_TABLES) {
      const s = await restoreEdgeTable(db, backupDir, t, flags);
      edgeStats.push(s);
      if (s.total > 0) {
        console.log(`  edge ${t.padEnd(26)} created ${String(s.created).padStart(7)}  skipped ${String(s.skipped).padStart(7)}  missing-endpoint ${String(s.missing).padStart(5)}${s.errors ? `  errors ${s.errors}` : ""}`);
      }
    }
  } catch (e) {
    // A thrown error here is a parse/fatal error (readTableRows throws on
    // corrupt jsonl). Per-row write failures are caught inside and counted.
    console.error(`\nrestore-jsonl: FATAL: ${e.message}`);
    try { await db.close(); } catch { /* ok */ }
    process.exit(1);
  }

  const all = [...nodeStats, ...edgeStats];
  const totals = all.reduce(
    (a, s) => ({
      created: a.created + s.created,
      skipped: a.skipped + s.skipped,
      missing: a.missing + (s.missing ?? 0),
      errors: a.errors + s.errors,
    }),
    { created: 0, skipped: 0, missing: 0, errors: 0 },
  );

  console.log(
    `\nRestore complete: ${totals.created} created, ${totals.skipped} skipped, ` +
    `${totals.missing} missing-endpoint, ${totals.errors} row-errors` +
    `${flags.dryRun ? " (dry-run)" : ""}.`,
  );

  await db.close();
}

main().catch(e => { console.error("restore-jsonl failed:", e); process.exit(1); });
