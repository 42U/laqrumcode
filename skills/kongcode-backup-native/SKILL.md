---
name: KongCode Backup (Native SurrealDB)
description: Activate when the user asks to back up the kongcode database, export the graph, snapshot SurrealDB, or save a copy for restore into another SurrealDB instance. Triggers on "back up kongcode", "export the database", "snapshot memory", "dump kongcode to disk". Use this skill for the **lossless** path when the target is also SurrealDB.
version: 0.1.0
---

# KongCode Backup — Native SurrealDB Export

Produces a `.surql` file containing every `DEFINE TABLE` / `DEFINE FIELD` / `DEFINE INDEX` statement plus `INSERT` for every node row and `RELATE` for every edge. **Lossless within SurrealDB.** Vector embeddings preserved as `array<float>`. Edges preserved with full provenance.

Use this skill when:
- Backing up a kongcode install for disaster recovery.
- Migrating an existing kongcode install to a new host (same or different SurrealDB version).
- Producing a snapshot for archival.

Do NOT use this skill when the target is not SurrealDB. For non-SurrealDB destinations use `kongcode-backup-jsonl`. For sending only the knowledge core to another agent use `kongcode-backup-semantic`.

## Pre-flight

Before running, decide:

1. **Live writes are happening.** The daemon writes turns and retrieval_outcomes continuously. Three choices:
   - **Clean snapshot (recommended).** Stop the daemon, export, restart. ~30s of downtime.
   - **Live snapshot.** Export against a running daemon. You get a moving-target view; some rows may reflect mid-transaction state.
   - **SurrealKV snapshot.** If the underlying SurrealKV supports point-in-time, use it. (Out of scope for this skill.)
2. **Output path.** Default: `./kongcode-backup-$(date +%Y%m%d-%H%M).surql` in the current directory.
3. **Source credentials.** Defaults from kongcode's `src/engine/config.ts`: ns=kong, db=memory, user=root, pass=root, endpoint=ws://127.0.0.1:8000/rpc.

## Run

```bash
# Clean snapshot (recommended): pause daemon first.
DAEMON_PID=$(ps aux | grep -E 'kongcode/dist/daemon/index.js' | grep -v grep | awk '{print $2}' | head -1)
[ -n "$DAEMON_PID" ] && kill -TERM "$DAEMON_PID" && sleep 3

# Export.
/home/zero/.kongcode/cache/surreal-3.0.5/surreal export \
  --endpoint http://127.0.0.1:8000 \
  --namespace kong \
  --database memory \
  --username root \
  --password root \
  "./kongcode-backup-$(date +%Y%m%d-%H%M).surql"

# Daemon will respawn when the next MCP tool call fires.
```

For a live snapshot (no daemon stop), just run the `surreal export` command. Expect 100-300MB depending on row count + embeddings.

## Verify

```bash
# Sanity: row counts in the export match the live DB.
LATEST=$(ls -t kongcode-backup-*.surql | head -1)
echo "Export: $LATEST"
echo "Size: $(du -h "$LATEST" | cut -f1)"
echo "INSERT statements: $(grep -c '^INSERT ' "$LATEST")"
echo "RELATE statements: $(grep -c '^RELATE ' "$LATEST")"

# Compare to live counts via introspect (call the MCP tool, action='status').
```

## Restore

```bash
surreal import \
  --endpoint http://target-host:8000 \
  --namespace kong --database memory \
  --username root --password root \
  ./kongcode-backup-YYYYMMDD-HHMM.surql
```

The schema-baked migrations in `schema.surql` (concept-name rename at lines 60-63, etc.) auto-run on the new install if any legacy rows are present.

## Caveats

- **HNSW vector indexes** are rebuilt on import; expect a delay proportional to embedded-row count.
- **UNIQUE constraints** apply at import time. If the target already has data, expect collision errors. Restore into a fresh DB.
- **Version compatibility.** Source SurrealDB 3.0.5 → target must be 3.x or compatible. The exporter's `.surql` syntax is forward-compatible within the major version.
