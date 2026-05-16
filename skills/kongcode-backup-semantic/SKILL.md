---
name: kongcode-backup-semantic
description: "Activate when the user wants to send the kongcode knowledge core (concepts, memories, skills, reflections, artifacts, soul) to another agent or system WITHOUT the transcript volume (turns, retrieval_outcomes, metrics). Triggers on \"transfer knowledge to ikong\", \"share kongcode brain\", \"extract just the concepts\", \"give my graph to another agent\". For full snapshot use `kongcode-backup-native`; for non-SurrealDB targets use `kongcode-backup-jsonl`."
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="kongcode-backup-semantic"` to load full instructions.
