#!/usr/bin/env node
/**
 * LaqrumCode Semantic Knowledge Core backup — exports only the knowledge
 * tables and knowledge edges, dropping transcripts (turns, sessions),
 * retrieval telemetry, orchestrator metrics, and ephemeral runtime caches.
 *
 * Use this when transferring knowledge to another agent or system without
 * the conversation volume. For full snapshot use backup-jsonl.mjs or
 * `surreal export`. See skills/laqrumcode-backup-semantic/SKILL.md.
 *
 * Env-var overrides (all optional):
 *   SURREAL_URL   — default ws://127.0.0.1:8000/rpc
 *   SURREAL_USER  — default root
 *   SURREAL_PASS  — default root
 *   SURREAL_NS    — default laqrum
 *   SURREAL_DB    — default memory
 *   LAQRUMCODE_BACKUP_DIR — default ./laqrumcode-semantic-YYYYMMDD-HHMM/
 */

import { Surreal } from "/home/zero/voidorigin/laqrumcode/node_modules/surrealdb/dist/surrealdb.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "laqrum";
const DB = process.env.SURREAL_DB || "memory";

const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 17);
const OUTDIR = resolve(process.env.LAQRUMCODE_BACKUP_DIR || `./laqrumcode-semantic-${STAMP}`);

/** Knowledge node tables: the 9 that carry retrieval-grounded value. */
const KNOWLEDGE_NODE_TABLES = [
  "concept",
  "memory",
  "skill",
  "reflection",
  "artifact",
  "monologue",
  "causal_chain",
  "soul",
  "identity_chunk",
];

/** Knowledge edge tables: 12 edges that thread the nodes together. */
const KNOWLEDGE_EDGE_TABLES = [
  // Cross-pillar concept links
  "mentions",
  "about_concept",
  "artifact_mentions",
  // Concept hierarchy + semantic neighbors
  "broader",
  "narrower",
  "related_to",
  // Provenance
  "derived_from",
  // Project scope
  "relevant_to",
  "used_in",
  // Evolution
  "supersedes",
  // Skills
  "skill_from_task",
  "skill_uses_concept",
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

async function collectProjectRefs(db) {
  try {
    const rows = await db.query(`SELECT DISTINCT out FROM relevant_to UNION SELECT DISTINCT out FROM used_in`);
    const out = Array.isArray(rows[0]) ? rows[0] : [];
    return out.map(r => {
      const v = r.out;
      if (v && typeof v === "object" && v.tb) return `${v.tb}:${v.id}`;
      return String(v);
    }).filter(Boolean);
  } catch { return []; }
}

const IMPORT_DOC = `# LaqrumCode Semantic Knowledge Core — Import Guide

This directory contains a portable export of a laqrumcode knowledge graph.
Conversation transcripts, retrieval telemetry, and ephemeral runtime
caches were intentionally excluded.

## Files

- \`metadata.json\` — source DB, timestamp, per-table row counts, schema info.
- \`<table>.jsonl\` — one JSON object per line, one file per included table.

## Included node tables

- concept, memory, skill, reflection, artifact, monologue, causal_chain,
  soul, identity_chunk.

## Included edge tables

- mentions, about_concept, artifact_mentions (cross-pillar concept links)
- broader, narrower, related_to (concept hierarchy)
- derived_from (provenance: concept → task | artifact | session)
- relevant_to, used_in (project scope)
- supersedes (correction → stale-concept evolution)
- skill_from_task, skill_uses_concept (skill provenance)

## Import order

1. Reconstitute project rows (or map source project ids to destination project ids — see \`project_ids\` in metadata.json).
2. Import node tables in this order: identity_chunk, soul, concept, artifact, memory, skill, reflection, monologue, causal_chain.
3. Import edge tables in this order: derived_from, relevant_to, used_in (provenance + scope first), then broader/narrower/related_to (hierarchy), then mentions/about_concept/artifact_mentions/skill_*, then supersedes.
4. Re-index embeddings if the target uses a different embedding model than BGE-M3 (1024-dim). The text fields are present so re-embedding is possible.

## Embedding compatibility

Embeddings are BGE-M3 1024-dimensional. If the target uses a different model:
- The raw float arrays will not be semantically useful — drop the \`embedding\` field on import.
- Re-embed each row's \`text\` / \`content\` / \`description\` field with the target's embedding model.

## Notes

- Record ids are preserved in \`table:thingid\` form. The target's loader can keep these or rewrite them; edges reference these ids directly.
- The \`soul\` row carries the graduated identity. Importing it bootstraps the receiving agent with the source's persona; remove \`soul.jsonl\` before import for a fresh-identity start.
- \`core_memory\` is intentionally excluded — those are session-pinned directives that should be re-established on the receiving install.
`;

async function main() {
  console.log(`LaqrumCode Semantic Knowledge Core backup`);
  console.log(`  Source:  ${URL} ns=${NS} db=${DB}`);
  console.log(`  Output:  ${OUTDIR}`);

  await mkdir(OUTDIR, { recursive: true });

  const db = new Surreal();
  await db.connect(URL);
  await db.signin({ username: USER, password: PASS });
  await db.use({ namespace: NS, database: DB });

  const results = { nodes: [], edges: [] };
  for (const t of KNOWLEDGE_NODE_TABLES) {
    const r = await dumpTable(db, t);
    results.nodes.push(r);
    if (r.count > 0) console.log(`  node ${t.padEnd(20)} ${String(r.count).padStart(8)} rows`);
    else if (r.error) console.log(`  node ${t.padEnd(20)} ERROR ${r.error}`);
  }
  for (const t of KNOWLEDGE_EDGE_TABLES) {
    const r = await dumpTable(db, t);
    results.edges.push(r);
    if (r.count > 0) console.log(`  edge ${t.padEnd(20)} ${String(r.count).padStart(8)} rows`);
    else if (r.error) console.log(`  edge ${t.padEnd(20)} ERROR ${r.error}`);
  }

  const projectRefs = await collectProjectRefs(db);

  const metadata = {
    source: { endpoint: URL, namespace: NS, database: DB },
    exported_at: new Date().toISOString(),
    laqrumcode_export_format: "semantic-v1",
    embedding_model: "BGE-M3",
    embedding_dimension: 1024,
    included: { nodes: KNOWLEDGE_NODE_TABLES, edges: KNOWLEDGE_EDGE_TABLES },
    row_counts: {
      nodes: Object.fromEntries(results.nodes.map(r => [r.table, r.count])),
      edges: Object.fromEntries(results.edges.map(r => [r.table, r.count])),
    },
    totals: {
      node_tables: results.nodes.length,
      edge_tables: results.edges.length,
      total_rows: [...results.nodes, ...results.edges].reduce((a, r) => a + r.count, 0),
    },
    project_ids: projectRefs,
    errors: [...results.nodes, ...results.edges].filter(r => r.error).map(r => ({ table: r.table, error: r.error })),
    excluded: {
      reason: "Transcripts, telemetry, and ephemeral runtime caches are not part of the semantic knowledge core",
      tables: ["turn", "session", "retrieval_outcome", "orchestrator_metrics", "orchestrator_metrics_daily", "pending_work", "subagent", "compaction_checkpoint", "memory_utility_cache", "turn_score", "graduation_event", "maturity_stage", "core_memory", "embedding_cache", "maintenance_runs", "turn_archive"],
    },
  };
  await writeFile(join(OUTDIR, "metadata.json"), JSON.stringify(metadata, null, 2));
  await writeFile(join(OUTDIR, "IMPORT.md"), IMPORT_DOC);

  console.log(`\nWrote ${metadata.totals.total_rows} knowledge rows to ${OUTDIR}`);
  console.log(`Project ids referenced (need mapping on target): ${projectRefs.length}`);
  await db.close();
}

main().catch(e => { console.error("backup-semantic failed:", e); process.exit(1); });
