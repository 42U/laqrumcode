---
description: Show overall LaqrumCode system health and memory statistics
allowed-tools: ["mcp__plugin_laqrumcode_laqrumcode__introspect"]
---

Show the overall health and statistics of the LaqrumCode memory system.

1. Call `introspect` with action `status` to get the health overview
2. Present a clear dashboard showing:
   - Database connection status
   - Table counts (concepts, memories, skills, reflections, etc.)
   - Embedding coverage
   - Soul graduation progress (if available)
   - Session history summary
3. If the database is unavailable, explain how to set up SurrealDB
