---
name: laqrumcode-backup-jsonl
description: "Activate when the user wants to export laqrumcode for import into a non-SurrealDB system — Postgres + pgvector, Neo4j, OpenSearch, a custom store, or any system that ingests JSON. Triggers on \"export laqrumcode to JSON\", \"dump laqrumcode for ingestion\", \"migrate laqrumcode off SurrealDB\". Use this skill when the destination is not SurrealDB; for SurrealDB-to-SurrealDB use `laqrumcode-backup-native`."
---

Body in laqrumcode DB. Call `mcp__plugin_laqrumcode_laqrumcode__get_skill_body` with `name="laqrumcode-backup-jsonl"` to load full instructions.
