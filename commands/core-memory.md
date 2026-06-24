---
description: Manage always-loaded memory directives
argument-hint: "[list|add|update|deactivate] [args]"
allowed-tools: ["mcp__plugin_laqrumcode_laqrumcode__core_memory", "AskUserQuestion"]
---

Manage LaqrumCode core memory directives — persistent entries loaded into every turn.

Parse $ARGUMENTS for the action:
- `list` (default) — show all core memory entries with tier, category, and priority
- `add [text]` — add a new directive. If text is missing, ask the user for: text, category (identity/rules/tools/operations/general), tier (0=always, 1=session), and priority (0-100)
- `update [id] [text]` — update an existing directive by ID
- `deactivate [id]` — deactivate a directive by ID

For `add` without full arguments, use AskUserQuestion to gather the required information. Tier 0 entries appear every turn — warn the user to use them sparingly.
