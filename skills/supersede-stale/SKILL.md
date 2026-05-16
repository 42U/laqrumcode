---
name: supersede-stale
description: Activate when a recalled or injected concept is contradicted by current code, a newer source, or a user correction. Use this to demote stale knowledge in realtime rather than letting the batch daemon eventually catch it — stale concepts compete with fresh ones in recall and poison grounding.
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="supersede-stale"` to load full instructions.
