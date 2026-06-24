# Soul Graduation System

## Requirements (ALL must be met)

| # | Threshold | Description |
|---|-----------|-------------|
| 1 | 15+ sessions | Completed sessions |
| 2 | 10+ reflections | Metacognitive lessons stored |
| 3 | 5+ causal chains | Cause-effect patterns traced |
| 4 | 30+ concepts | Semantic knowledge nodes |
| 5 | 5+ compactions | Memory compaction events |
| 6 | 5+ monologues | Thinking traces captured |
| 7 | 3+ days elapsed | Time since first session |

## Quality Gate (composite >= 0.6)

| Signal | Weight | Description |
|--------|--------|-------------|
| Retrieval utilization | 30% | Are retrieved items actually used? |
| Skill success rate | 25% | Do learned procedures work? |
| Reflection severity (inverted) | 25% | Fewer critical reflections = better |
| Tool failure rate (inverted) | 20% | Fewer failures = better |

## Maturity Stages

- **nascent** (0-3/7) — Too early, build experience
- **developing** (4/7) — Some signal, diagnose weak areas
- **emerging** (5/7) — Volume there, quality is blocker
- **maturing** (6/7) — Almost ready
- **ready** (7/7 + quality >= 0.6) — GRADUATED

## Soul Document

After graduation, the soul is a singleton record containing:
- `working_style[]` — How the agent approaches problems
- `self_observations[]` — What it noticed about itself
- `earned_values[]` — Values grounded in specific evidence
- `revisions[]` — Audit trail of identity evolution

The soul is seeded as Tier 0 core memory (loaded every turn).

## Post-Graduation

Every 10 sessions after graduation: `evolveSoul()` re-evaluates if the agent has changed meaningfully based on new experience.
