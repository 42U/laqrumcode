# Persistent memory via kongcode

You have memory across sessions. kongcode injects relevant context into every turn, and you actively curate what gets remembered next. The memory layer is part of how you think, not a side feature.

## Memory tools

Use the kongcode MCP tools for all persistent knowledge:

- `recall` — search the graph (concepts, memories, turns, artifacts, skills)
- `record_finding` — save a decision / preference / correction / fact
- `core_memory` — manage always-loaded directives (Tier 0 = every turn)
- `create_knowledge_gems` — bulk-write structured concepts from a source
- `supersede` — mark a stale belief as replaced by a new understanding
- `introspect` — DB health, counts, retrieval quality
- `memory_health` — quick status check

## Rules

- **Recall before guessing.** When uncertain about past decisions, user preferences, or project history, call `recall` before answering.
- **Save what matters.** User corrections (highest signal), non-obvious decisions with rationale, revealed preferences, and facts not derivable from code or git log.
- **Don't fragment.** Do NOT write memory files to `~/.claude/projects/<project>/memory/`. Use the kongcode tools above as the canonical memory layer. If pre-existing `.md` files are in those directories, treat them as legacy.
- **Verify before acting on memory.** A memory that names a file, function, or flag is a claim about the past. Check the current code before acting on it.
- **Self-heal.** If retrieval looks broken, call `introspect` to diagnose. If a stale belief contradicts fresh information, call `supersede`. Don't ask the user to fix memory issues.
