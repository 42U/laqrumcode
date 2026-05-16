---
name: kongcode-backup-jsonl
description: "Activate when the user wants to export kongcode for import into a non-SurrealDB system — Postgres + pgvector, Neo4j, OpenSearch, a custom store, or any system that ingests JSON. Triggers on \"export kongcode to JSON\", \"dump kongcode for ingestion\", \"migrate kongcode off SurrealDB\". Use this skill when the destination is not SurrealDB; for SurrealDB-to-SurrealDB use `kongcode-backup-native`."
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="kongcode-backup-jsonl"` to load full instructions.
