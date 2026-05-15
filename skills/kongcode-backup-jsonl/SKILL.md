---
name: KongCode Backup (JSON Lines)
description: Activate when the user wants to export kongcode for import into a non-SurrealDB system — Postgres + pgvector, Neo4j, OpenSearch, a custom store, or any system that ingests JSON. Triggers on "export kongcode to JSON", "dump kongcode for ingestion", "migrate kongcode off SurrealDB". Use this skill when the destination is not SurrealDB; for SurrealDB-to-SurrealDB use `kongcode-backup-native`.
version: 0.1.0
---

# KongCode Backup — JSON Lines (NDJSON)

Emits one `.jsonl` file per table under a timestamped backup directory. Each line is a self-contained JSON object representing one row, including the record id (`table:thingid`), all scalar fields, embedding arrays, and (for edge tables) `in` / `out` plus any extra fields.

Use this skill when:
- The target system is not SurrealDB.
- You need per-table files for selective import.
- You want a format that grep/jq/Python can process row-by-row.

For full SurrealDB-to-SurrealDB fidelity use `kongcode-backup-native`. For knowledge-only transfer to another agent use `kongcode-backup-semantic`.

## Pre-flight

Same as native: decide between clean (stop daemon) vs live snapshot. Defaults: ns=kong, db=memory, root/root, ws://127.0.0.1:8000/rpc.

## Run

```bash
# Default: dump to ./kongcode-backup-<timestamp>/
node /home/zero/voidorigin/kongcode/scripts/backup-jsonl.mjs

# Custom output directory.
KONGCODE_BACKUP_DIR=/path/to/output node /home/zero/voidorigin/kongcode/scripts/backup-jsonl.mjs

# Custom DB connection (override defaults).
SURREAL_URL=ws://other-host:8000/rpc \
SURREAL_USER=root \
SURREAL_PASS=secret \
SURREAL_NS=kong \
SURREAL_DB=memory \
  node /home/zero/voidorigin/kongcode/scripts/backup-jsonl.mjs
```

## What the script does

1. Connects via the `surrealdb` package shipped at `node_modules/surrealdb/dist/surrealdb.mjs`.
2. Iterates over every node table from kongcode's `ALLOWED_TABLES` list (24 tables: agent, project, task, artifact, concept, turn, identity_chunk, session, memory, core_memory, monologue, skill, reflection, retrieval_outcome, orchestrator_metrics, causal_chain, compaction_checkpoint, subagent, memory_utility_cache, soul, graduation_event, maturity_stage, pending_work, turn_score).
3. For each table: `SELECT * FROM <table>` (paginated by created_at descending if >50k rows).
4. Iterates over every edge (RELATION) table from `schema.surql` (~24 edges): writes `{id, in, out, ...extras}` per row.
5. Writes one JSON object per line to `<table>.jsonl` under the output directory.
6. Emits a `metadata.json` summarizing source DB, timestamp, row counts per table, and the kongcode version that produced the export.

## Verify

```bash
LATEST=$(ls -td kongcode-backup-* | head -1)
echo "Backup: $LATEST"
cat "$LATEST/metadata.json" | jq '.row_counts'
wc -l "$LATEST"/*.jsonl | tail -5
```

Cross-check a sample row's shape:

```bash
head -1 "$LATEST/concept.jsonl" | jq '. | keys'
# Should include: id, content, embedding, stability, confidence, created_at, etc.
```

## Import on the receiving side

Write a target-specific loader that reads `.jsonl` files and maps to the target schema. The metadata.json's `tables` list tells you what to expect.

For pgvector: each concept's `embedding` array maps to a `vector(1024)` column. The edge tables become foreign-key rows in your relations.

For Neo4j: node tables → nodes (label = table name), edge tables → relationships with the in/out as start/end nodes.

## Caveats

- Live writes during a multi-table dump can leave referenced edges pointing at rows not in the snapshot (if a new row was written after its referencing edge but before the row's own table was dumped). Clean snapshot avoids this.
- Vector embeddings are emitted as raw float arrays. The target system must re-index for vector search.
- Record ids are kept in `table:thingid` form; target's loader may need to rewrite or strip prefixes.
