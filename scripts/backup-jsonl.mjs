#!/usr/bin/env node
/**
 * KongCode JSON Lines backup — exports every table in the kongcode graph
 * to one `.jsonl` file per table under a timestamped output directory.
 *
 * Activated by skills/kongcode-backup-jsonl/SKILL.md.
 *
 * Env-var overrides (all optional, sensible defaults from src/engine/config.ts):
 *   SURREAL_URL   — default ws://127.0.0.1:8000/rpc
 *   SURREAL_USER  — default root
 *   SURREAL_PASS  — default root
 *   SURREAL_NS    — default kong
 *   SURREAL_DB    — default memory
 *   KONGCODE_BACKUP_DIR — default ./kongcode-backup-YYYYMMDD-HHMM/
 */

import { Surreal } from "/home/zero/voidorigin/kongcode/node_modules/surrealdb/dist/surrealdb.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "kong";
const DB = process.env.SURREAL_DB || "memory";

const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 17);
const OUTDIR = resolve(process.env.KONGCODE_BACKUP_DIR || `./kongcode-backup-${STAMP}`);

/** Node tables — keep in sync with src/engine/tools/introspect.ts ALLOWED_TABLES. */
const NODE_TABLES = [
  "agent", "project", "task", "artifact", "concept",
  "turn", "identity_chunk", "session", "memory", "core_memory",
  "monologue", "skill", "reflection", "retrieval_outcome",
  "orchestrator_metrics", "orchestrator_metrics_daily",
  "causal_chain", "compaction_checkpoint", "subagent",
  "memory_utility_cache", "soul", "graduation_event",
  "maturity_stage", "pending_work", "turn_score",
  "embedding_cache", "maintenance_runs", "turn_archive",
];

/** Edge tables (RELATION tables in schema.surql). */
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

function rowToJsonLine(row) {
  const norm = { ...row };
  if (norm.id && typeof norm.id === "object" && norm.id.tb && norm.id.id !== undefined) {
    norm.id = `${norm.id.tb}:${norm.id.id}`;
  }
  if (norm.in && typeof norm.in === "object" && norm.in.tb) {
    norm.in = `${norm.in.tb}:${norm.in.id}`;
  }
  if (norm.out && typeof norm.out === "object" && norm.out.tb) {
    norm.out = `${norm.out.tb}:${norm.out.id}`;
  }
  return JSON.stringify(norm);
}

async function dumpTable(db, table) {
  try {
    const rows = await db.query(`SELECT * FROM ${table}`);
    const rs = Array.isArray(rows[0]) ? rows[0] : [];
    if (rs.length === 0) return { table, count: 0, file: null };
    const lines = rs.map(rowToJsonLine).join("\n") + "\n";
    const file = join(OUTDIR, `${table}.jsonl`);
    await writeFile(file, lines, "utf8");
    return { table, count: rs.length, file };
  } catch (e) {
    return { table, count: 0, file: null, error: String(e?.message ?? e) };
  }
}

async function main() {
  console.log(`KongCode JSON-Lines backup`);
  console.log(`  Source:  ${URL} ns=${NS} db=${DB}`);
  console.log(`  Output:  ${OUTDIR}`);

  await mkdir(OUTDIR, { recursive: true });

  const db = new Surreal();
  await db.connect(URL);
  await db.signin({ username: USER, password: PASS });
  await db.use({ namespace: NS, database: DB });

  const results = { nodes: [], edges: [] };
  for (const t of NODE_TABLES) {
    const r = await dumpTable(db, t);
    results.nodes.push(r);
    if (r.count > 0) console.log(`  node ${t.padEnd(28)} ${String(r.count).padStart(8)} rows`);
    else if (r.error) console.log(`  node ${t.padEnd(28)} ERROR ${r.error}`);
  }
  for (const t of EDGE_TABLES) {
    const r = await dumpTable(db, t);
    results.edges.push(r);
    if (r.count > 0) console.log(`  edge ${t.padEnd(28)} ${String(r.count).padStart(8)} rows`);
    else if (r.error) console.log(`  edge ${t.padEnd(28)} ERROR ${r.error}`);
  }

  const metadata = {
    source: { endpoint: URL, namespace: NS, database: DB },
    exported_at: new Date().toISOString(),
    kongcode_export_format: "jsonl-v1",
    row_counts: {
      nodes: Object.fromEntries(results.nodes.map(r => [r.table, r.count])),
      edges: Object.fromEntries(results.edges.map(r => [r.table, r.count])),
    },
    totals: {
      node_tables: results.nodes.length,
      edge_tables: results.edges.length,
      total_rows: [...results.nodes, ...results.edges].reduce((a, r) => a + r.count, 0),
    },
    errors: [...results.nodes, ...results.edges].filter(r => r.error).map(r => ({ table: r.table, error: r.error })),
  };
  await writeFile(join(OUTDIR, "metadata.json"), JSON.stringify(metadata, null, 2));

  console.log(`\nWrote ${metadata.totals.total_rows} total rows to ${OUTDIR}`);
  await db.close();
}

main().catch(e => { console.error("backup-jsonl failed:", e); process.exit(1); });
