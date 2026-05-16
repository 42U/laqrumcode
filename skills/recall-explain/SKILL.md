---
name: recall-explain
description: Activate when raw recall results need interpretation — user asks a factual/historical question likely to have graph coverage, and you want clustered, contradiction-flagged, actionable output instead of a flat score-sorted list. Also activate when recall returns 5+ results and you need to decide which matter.
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="recall-explain"` to load full instructions.
