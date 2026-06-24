# LaqrumCode Graph Schema

## Tables (25)

### 5-Pillar Entities
| Table | Purpose | Key Fields |
|-------|---------|------------|
| `agent` | Who is operating | name, model |
| `project` | What project | name, status, tags |
| `task` | Individual sessions | description, status |
| `session` | Session metadata | agent_id, started_at, ended_at, turn_count |
| `artifact` | Files/outputs tracked | path, description, embedding |

### Knowledge Storage
| Table | Purpose | Key Fields |
|-------|---------|------------|
| `concept` | Semantic knowledge nodes | text, embedding, importance |
| `memory` | Compacted episodic knowledge | text, embedding, status, importance |
| `skill` | Learned procedures | name, steps, preconditions, postconditions, success_count |
| `reflection` | Metacognitive lessons | text, embedding, severity |
| `causal_chain` | Cause-effect patterns | trigger, outcome, success, confidence |
| `identity_chunk` | Agent persona fragments | text, embedding, category |
| `monologue` | Thinking traces | text, embedding |
| `turn` | Every conversation message | text, role, embedding, session_id |
| `core_memory` | Always-loaded directives | text, tier, category, priority, active |

### System
| Table | Purpose |
|-------|---------|
| `soul` | Graduated identity (singleton) |
| `maturity_stage` | Graduation progress |
| `graduation_event` | Soul graduation timestamps |
| `retrieval_outcome` | Query→memory quality signals |
| `orchestrator_metrics` | Intent, complexity, tool budgets |
| `compaction_checkpoint` | Diagnostic trail |
| `memory_utility_cache` | Historical utility lookups |
| `subagent` | Spawned subagent tracking |

## HNSW Vector Indexes (7 tables, 1024-dim cosine)
turn, concept, memory, identity_chunk, artifact, monologue, skill

## Edge Relations (30+)
responds_to, mentions, related_to, narrower, broader, about_concept,
caused_by, supports, contradicts, owns, performed, task_part_of,
session_task, produced, derived_from, used_in, skill_from_task,
skill_uses_concept, supersedes
