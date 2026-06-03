---
name: kongcode-restore-jsonl
description: "Activate when the user wants to restore/import a kongcode JSON-Lines backup (produced by scripts/backup-jsonl.mjs) back into a SurrealDB kongcode graph, or merge one machine's kongcode export into another. Triggers on \"restore kongcode from JSON\", \"import the jsonl backup\", \"merge kongcode graphs\", \"load my kongcode dump\". Counterpart to kongcode-backup-jsonl."
---

Run `node scripts/restore-jsonl.mjs <backup-dir>` against the target SurrealDB (same SURREAL_URL/USER/PASS/NS/DB env + defaults as backup-jsonl.mjs). Nodes import first, then edges. Default is **skip-if-exists** (idempotent, non-destructive). Flags: `--overwrite` (replace by id), `--merge-by-hash` (skip content_hash duplicates), `--dry-run`. Edges with a missing in/out node are skipped + logged. Verify with backup-jsonl.mjs's `metadata.json` table_counts.
