---
name: KongCode Backup (Semantic Knowledge Core)
description: Activate when the user wants to send the kongcode knowledge core (concepts, memories, skills, reflections, artifacts, soul) to another agent or system WITHOUT the transcript volume (turns, retrieval_outcomes, metrics). Triggers on "transfer knowledge to ikong", "share kongcode brain", "extract just the concepts", "give my graph to another agent". For full snapshot use `kongcode-backup-native`; for non-SurrealDB targets use `kongcode-backup-jsonl`.
version: 0.1.0
---

# KongCode Backup — Semantic Knowledge Core

Exports only the **knowledge tables** and **knowledge edges** — the rows that matter for retrieval-grounded reasoning. Drops conversation transcripts, retrieval telemetry, orchestrator metrics, and ephemeral session state. The result is portable across agent instances and dramatically smaller than the full graph (typically 25% of the byte size).

Use this skill when:
- Bootstrapping a new agent install with the brain of an existing one.
- Transferring knowledge to a different agent system (iKong, another kongcode instance, a custom agent).
- Sharing a sanitized knowledge core that excludes ephemeral conversation data.

For full snapshot use `kongcode-backup-native`. For non-SurrealDB destinations use `kongcode-backup-jsonl`.

## What is included

**Node tables (9):**
- `concept` — the semantic knowledge graph (the core of kongcode's value)
- `memory` — corrections, decisions, preferences, facts
- `skill` — reusable procedures
- `reflection` — metacognitive notes per session
- `artifact` — files / URLs / docs the agent has worked with
- `monologue` — internal reasoning snippets worth preserving
- `causal_chain` — debug / refactor / feature outcome chains
- `soul` — graduated identity document
- `identity_chunk` — agent persona chunks

**Edge tables (12):**
- `mentions`, `about_concept`, `artifact_mentions` — cross-pillar concept links
- `broader`, `narrower`, `related_to` — concept hierarchy + semantic neighbors
- `derived_from` — provenance (concept → task | artifact | session)
- `relevant_to`, `used_in` — project scope edges
- `supersedes` — correction → stale-concept evolution
- `skill_from_task`, `skill_uses_concept` — skill provenance

## What is excluded

- `turn` (conversation transcripts) — ~2k+ rows of raw dialogue
- `session` — ephemeral per-conversation rows
- `retrieval_outcome` — ~38k rows of recall-success telemetry
- `orchestrator_metrics`, `orchestrator_metrics_daily` — performance counters
- `pending_work` — queued cognitive tasks
- `subagent` — spawned subagent rows
- `compaction_checkpoint`, `memory_utility_cache`, `turn_score` — runtime caches
- `graduation_event`, `maturity_stage` — soul-graduation history (the `soul` row itself IS included)
- `core_memory` — session-pinned directives (re-establish on the target)

## Run

```bash
node /home/zero/voidorigin/kongcode/scripts/backup-semantic.mjs

# Custom output directory.
KONGCODE_BACKUP_DIR=/path/to/knowledge-core node /home/zero/voidorigin/kongcode/scripts/backup-semantic.mjs
```

Same env-var overrides as the JSONL skill: SURREAL_URL, SURREAL_USER, SURREAL_PASS, SURREAL_NS, SURREAL_DB.

## What the script does

1. Connects to SurrealDB (same defaults as the other backup skills).
2. For each of the 9 node tables: `SELECT * FROM <table>` and writes `<table>.jsonl`.
3. For each of the 12 edge tables: writes `<edge>.jsonl` with `{id, in, out, ...}`.
4. Writes a `metadata.json` summarizing the export shape, source DB, timestamp, and per-table row counts.
5. Writes an `IMPORT.md` describing the expected destination schema (5-pillar relations + knowledge edges) so the receiving agent knows what to expect.

## Import on the receiving side

The receiving system needs to reconstitute:
1. Each node table from the corresponding `.jsonl`.
2. Each edge table as relations between the node tables' rows.
3. Optional: re-embed if the target uses a different embedding model than BGE-M3 (1024-dim).

If the target is another kongcode install, use the JSONL-to-SurrealDB loader at `scripts/restore-semantic.mjs` (not yet written; will be added when first needed).

## Caveats

- **Embedding model assumption.** Embeddings in the export are BGE-M3 1024-dim. If the target uses a different model, the embeddings are useless and the target must re-embed each row's text. The text fields are always exported so re-embedding is possible.
- **Edge integrity.** Edges reference node ids. The target's loader must preserve these ids (or maintain an id-rewrite map) for edges to resolve. The simplest approach: import nodes first with their existing ids, then import edges.
- **Project scope.** `relevant_to` and `used_in` edges point at `project` rows. The project table is NOT in the included node list because projects are usually a destination-side concept; the import path either maps source project ids to destination project ids or drops the edges. The `metadata.json` includes the project id set for the receiving system to map.
- **Soul graduation.** The `soul` row carries the graduated identity. Importing it gives the receiving agent the source's graduated persona. If that's not desired (e.g. for a fresh-identity bootstrap), exclude `soul.jsonl` manually after export.
