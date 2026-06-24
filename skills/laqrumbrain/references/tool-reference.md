# LaqrumCode Tool Reference

## recall

Search the persistent memory graph.

```json
{
  "query": "authentication middleware refactor",
  "scope": "concepts",
  "limit": 5
}
```

**Scopes:**
- `all` — search across all tables (default)
- `memories` — compacted episodic knowledge
- `concepts` — semantic facts and decisions
- `turns` — raw conversation history
- `artifacts` — file paths and outputs
- `skills` — learned procedures

Results include graph expansion (neighbors of top results).

## core_memory

Manage always-loaded directives.

**Add a Tier 0 directive:**
```json
{
  "action": "add",
  "tier": 0,
  "category": "rules",
  "text": "Always run tests after modifying source files",
  "priority": 80
}
```

**List all entries:**
```json
{ "action": "list" }
```

**Deactivate:**
```json
{ "action": "deactivate", "id": "core_memory:abc123" }
```

## introspect

Database diagnostics.

**Health overview:**
```json
{ "action": "status" }
```

**Filtered count:**
```json
{ "action": "count", "table": "concept", "filter": "recent_24h" }
```

**Predefined reports:**
```json
{ "action": "query", "filter": "sessions" }
```

Templates: `recent`, `sessions`, `core_by_category`, `memory_status`, `embedding_coverage`
