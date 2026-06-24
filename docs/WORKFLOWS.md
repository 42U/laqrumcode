# LaqrumCode Workflows

How to use the laqrumcode skill suite in practice. This document describes what the skills actually encode, not what we hoped they would. Reflects the state after the phase 0-5 production upgrade.

## The core insight

Laqrumcode's value is determined by a single metric: **retrieval_utilization**. Context injection has always worked — the problem was that Claude ignored ~90% of what got injected. The whole upgrade stack is organized around changing that, not around adding more retrieval infrastructure.

## The skill suite (in dependency order)

### Tier 1 — foundation

- **`laqrumcode-health`** — pre-flight check before any significant graph write. Runs `introspect`, samples `recall`, calls `fetch_pending_work`, reports GREEN/YELLOW/RED.
- **`ground-on-memory`** — behavioral enforcement. Scans injected context, cites relevant items, explicitly notes "no relevant memory" when true.

### Tier 2 — intelligence

- **`recall-explain`** — wraps recall with clustering, contradiction detection, narrative output
- **`capture-insight`** — mid-session foreground knowledge capture (no waiting for batch daemon)

### Tier 3 — write-time quality

- **`supersede-stale`** — realtime supersession of outdated concepts
- **`extract-knowledge`** — source-agnostic extraction (supersedes extract-pdf-gems)

### Tier 4 — compound value

- **`synthesize-sources`** — multi-source meta-concept generation with cross-links
- **`knowledge-gap-scan`** — topic coverage analysis
- **`audit-drift`** — periodic stale-knowledge sweep

## Standard workflows

### Ingesting a new source

```
/laqrumcode-health                              # verify pipeline
/extract-knowledge <path-or-url>              # extract gems
(automatic: gap-scan vs existing coverage)
(automatic: cross-source links to prior concepts)
```

### Answering a factual question

```
(automatic: laqrumcode hook injects context)
/ground-on-memory                             # enforce grounding discipline
(if injected context insufficient): /recall-explain <topic>
(optional): /knowledge-gap-scan <topic>       # understand coverage first
```

### Detecting and correcting drift

```
/audit-drift                                  # periodic sweep
(for each confirmed stale concept): /supersede-stale <concept_id>
(for each correction-worthy insight): /capture-insight <claim>
```

### Cross-source reasoning

```
/knowledge-gap-scan <topic>                   # what do we have?
/synthesize-sources <source1> <source2>       # produce meta-concepts
/recall-explain <topic>                       # verify synthesis is visible
```

## Gem quality rules (canonical, from extract-knowledge)

- Self-contained (no "as shown above")
- Numerical where possible (coefficients, p-values, counts)
- Source-attributed inline
- ≤350 characters of signal (≤400 for synthesis meta-concepts)
- No academic hedging
- Options/trading implications tagged with `OPTIONS IMPLICATION:`
- Short snake_case `name` field (unique within gems list)
- One claim per gem

## Canonical edge vocabulary

Source of truth: `src/engine/edge-vocabulary.ts`. Five categories:

- **Structural**: `decomposes_into`, `elaborates`, `contextualizes`, `enables`, `extends`
- **Mechanism**: `mechanism_for`, `explained_by`, `prerequisite_for`, `identification_for`, `supported_by`, `necessitates`
- **Tension**: `contrasts_with`, `tempered_by`, `fails_when`, `complemented_by`, `corrects`
- **Implication**: `implies`, `amplifies`, `applies_to_options`, `applies_to_equities`, `applies_to_code`
- **Provenance**: `derived_from`, `cites`, `supersedes`

Extending the vocabulary: add to `edge-vocabulary.ts`, update this doc, update extract-knowledge SKILL.md.

## File conventions

- **Backup markdown** path: `${CLAUDE_PROJECT_DIR}/.claude/memory/<slug>-gems.md`
- **Index file**: `${CLAUDE_PROJECT_DIR}/.claude/memory/MEMORY.md` — one-line entries, <150 chars
- **Backup structure**: frontmatter (`name`, `description`, `type: reference`, `source`, `source_doi?`) + narrative section + JSON payload block for replay

## Known architecture quirks

- **Context injection is framed as `<system-reminder>`** (phase 1 upgrade). Claude attends to it as authoritative.
- **Recall returns a `GRAPH NEIGHBORS` section** alongside primary hits (phase 2 upgrade). Read both.
- **Context starts with a `RETRIEVAL RATIONALE` preamble** (phase 2 upgrade) showing which keywords drove retrieval.
- **Concept writes accept optional `provenance`** (phase 3 upgrade): `{session_id, turn_id, skill_name, source_kind}`.
- **Canonical edge vocabulary lives in code** at `src/engine/edge-vocabulary.ts`. Drift from this list warns only (not enforced in `relate()` yet).

## The `UPDATE $id` bug class

SurrealDB rejects `UPDATE $id SET ...` when `$id` is a plain string param. Fix: `assertRecordId(id)` + direct interpolation. Regression test at `test/pending-work-update-id.test.ts` catches any future occurrence via static scan. Do not re-introduce.

## Metrics tracked in plan.json

- `retrieval_utilization` — THE metric. Baseline 10%, phase 1 target 25%, final target 40%+, stretch 85%
- `total_concepts` — growth over time
- `total_edges_cross_source` — compound value indicator
- `pending_work_parse_errors` — regression indicator
- `concepts_embedded_ratio` — embedding pipeline health
- `mid_session_writes_ratio` — capture-insight adoption

## When the system is working

- Phase 1 success looks like: retrieval_utilization moves from 10% to 25%+ over 5 sessions
- Phase 2 success looks like: recall-explain invocations surface contradictions that get flagged
- Phase 3 success looks like: supersede-stale fires on old concepts before the daemon catches them
- Phase 4 success looks like: synthesize-sources produces cross-source edges that outrank single-source hits in recall
- Phase 5 success looks like: this document accurately describes the system (re-read after each phase)
