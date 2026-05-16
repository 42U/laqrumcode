---
name: kongcode-backup-native
description: "Activate when the user asks to back up the kongcode database, export the graph, snapshot SurrealDB, or save a copy for restore into another SurrealDB instance. Triggers on \"back up kongcode\", \"export the database\", \"snapshot memory\", \"dump kongcode to disk\". Use this skill for the **lossless** path when the target is also SurrealDB."
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="kongcode-backup-native"` to load full instructions.
