---
description: Run diagnostics on the LaqrumCode memory database
argument-hint: "[status|count|verify|query]"
allowed-tools: ["mcp__plugin_laqrumcode_laqrumcode__introspect"]
---

Run diagnostics on the LaqrumCode memory database.

Parse $ARGUMENTS for the action:
- `status` (default if empty) — health overview with table counts and graduation progress
- `count [table] [filter]` — filtered row counts for a specific table
- `verify [record_id]` — confirm a specific record exists
- `query [template]` — run a predefined report (recent, sessions, core_by_category, memory_status, embedding_coverage)

Call the `introspect` tool with the parsed parameters. Format results in a readable table or summary.
