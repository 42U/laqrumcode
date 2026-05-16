---
name: ground-on-memory
description: "Activate when the user asks about state, history, prior work, codebase knowledge, or anything where injected memory should inform the response. Triggers include \"what do you know about\", \"remember\", \"earlier\", \"last time\", \"we discussed\", \"in this codebase\", \"prior work\", \"previously\", or any direct question about project/session state."
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="ground-on-memory"` to load full instructions.
