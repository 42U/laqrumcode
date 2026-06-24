---
name: laqrumcode-backup-semantic
description: "Activate when the user wants to send the laqrumcode knowledge core (concepts, memories, skills, reflections, artifacts, soul) to another agent or system WITHOUT the transcript volume (turns, retrieval_outcomes, metrics). Triggers on \"transfer knowledge to ilaqrum\", \"share laqrumcode brain\", \"extract just the concepts\", \"give my graph to another agent\". For full snapshot use `laqrumcode-backup-native`; for non-SurrealDB targets use `laqrumcode-backup-jsonl`."
---

Body in laqrumcode DB. Call `mcp__plugin_laqrumcode_laqrumcode__get_skill_body` with `name="laqrumcode-backup-semantic"` to load full instructions.
