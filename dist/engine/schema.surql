-- KongBrain conversation graph schema
-- Run against ns:kong db:memory
-- Aligned with 5-pillar model: Agent, Project, Task, Artifact, Concept

-- ============================================================
-- Access counters (0.7.121) — tiny side-table rows so retrieval
-- bumps stop rewriting full embedded rows into the append-only
-- value log (~200x write amplification, 2026-06-12 forensics).
-- id = target id with ':' -> '_' (access_stats:concept_abc).
-- ============================================================
DEFINE TABLE IF NOT EXISTS access_stats SCHEMALESS;

-- ============================================================
-- PILLAR 1: Agent
-- ============================================================
DEFINE TABLE IF NOT EXISTS agent SCHEMALESS;
DEFINE FIELD IF NOT EXISTS name ON agent TYPE string;
DEFINE FIELD IF NOT EXISTS model ON agent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON agent TYPE datetime DEFAULT time::now();

-- ============================================================
-- PILLAR 2: Project
-- ============================================================
DEFINE TABLE IF NOT EXISTS project SCHEMALESS;
DEFINE FIELD IF NOT EXISTS name ON project TYPE string;
DEFINE FIELD IF NOT EXISTS status ON project TYPE string DEFAULT "active";
DEFINE FIELD IF NOT EXISTS tags ON project TYPE option<array>;
DEFINE FIELD IF NOT EXISTS created_at ON project TYPE datetime DEFAULT time::now();

-- ============================================================
-- PILLAR 3: Task (sessions are tasks)
-- ============================================================
DEFINE TABLE IF NOT EXISTS task SCHEMALESS;
DEFINE FIELD IF NOT EXISTS description ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON task TYPE string DEFAULT "in_progress";
DEFINE FIELD IF NOT EXISTS summary ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS friction ON task TYPE float DEFAULT 0.0;
DEFINE FIELD IF NOT EXISTS created_at ON task TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON task TYPE datetime DEFAULT time::now();

-- ============================================================
-- PILLAR 4: Artifact
-- ============================================================
DEFINE TABLE IF NOT EXISTS artifact SCHEMALESS;
DEFINE FIELD IF NOT EXISTS path ON artifact TYPE string;
DEFINE FIELD IF NOT EXISTS type ON artifact TYPE string;
DEFINE FIELD IF NOT EXISTS description ON artifact TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content_hash ON artifact TYPE option<string>;
DEFINE FIELD IF NOT EXISTS embedding ON artifact TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS tags ON artifact TYPE option<array>;
DEFINE FIELD IF NOT EXISTS created_at ON artifact TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS embedding_target_truncated ON artifact TYPE option<bool>;
DEFINE INDEX IF NOT EXISTS artifact_vec_idx ON artifact FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS artifact_type_idx ON artifact FIELDS type;

-- ============================================================
-- PILLAR 5: Concept (semantic knowledge nodes)
-- ============================================================
DEFINE TABLE IF NOT EXISTS concept SCHEMALESS;
-- Recovery: restore content from name if the rename migration ran before revert.
--
-- This was originally unconditional and ran on every daemon connect, scanning
-- the whole concept table for an empty-result UPDATE even on clean installs
-- that never had a `name` column. Gate it via LET + IF/THEN/END (same idiom
-- used in observability.ts:179 + surreal.ts:1627) so the table-scan UPDATE
-- only fires when legacy rows actually exist. On clean installs the inner
-- count returns 0 and the IF block is skipped entirely; on a legacy install
-- the one-time migration runs once, then no-ops on every subsequent connect.
-- CLOSURE: this LET+IF gate becomes a permanent zero-cost no-op once
-- `SELECT count() FROM concept WHERE name != NONE` returns 0 across production
-- installs for two release cycles; at that point delete the LET+IF and keep
-- only the DEFINE FIELD statements below.
LET $legacy_concept_count = (SELECT count() FROM concept WHERE name != NONE GROUP ALL)[0].count ?? 0;
IF $legacy_concept_count > 0 THEN
  UPDATE concept SET content = name WHERE content = NONE AND name != NONE;
END;
DEFINE FIELD IF NOT EXISTS content ON concept TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON concept TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS stability ON concept TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS confidence ON concept TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS access_count ON concept TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS tags ON concept TYPE option<array>;
DEFINE FIELD IF NOT EXISTS source ON concept TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON concept TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS last_accessed ON concept TYPE option<datetime>;
-- R12/K16 (mirrors K51 for memory): the live daemon embeds a concept as
-- `${content} ${searchTerms.join(". ")}` (memory-daemon.ts) — a richer target
-- than `content` alone — but only `content` was persisted, so when the embedder
-- was DOWN at create time backfillConceptEmbeddings() healed to a content-only
-- vector that DIVERGED from the live form. Persist the divergent embed target
-- (option<string>, only written when it differs from content) so the heal path
-- reproduces it. Plain optional field, no index. IF NOT EXISTS per file convention.
DEFINE FIELD IF NOT EXISTS embedding_target ON concept TYPE option<string>;
DEFINE INDEX IF NOT EXISTS concept_vec_idx ON concept FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
-- tags index (K4): tagBoostedConcepts filters `tags CONTAINSANY $tags` then
-- scores the survivors by cosine. Without this index the CONTAINSANY predicate
-- is a full concept-table scan AND cosine runs over every row the WHERE admits;
-- with it the array-membership filter is index-served so cosine runs only over
-- the bounded tag-matching candidate set. Non-UNIQUE → no predeploy dedup.
DEFINE INDEX IF NOT EXISTS concept_tags_idx ON concept FIELDS tags;

-- ============================================================
-- Conversation turns (the workhorse table)
-- ============================================================
DEFINE TABLE IF NOT EXISTS turn SCHEMALESS;
-- IMPORTANT: turn.session_id is the kc_session_id UUID string, NOT the
-- SurrealDB Thing record id of the `session` row. To join `turn` to its
-- parent `session`, look up via the kc_session_id bridge field:
--   SELECT id FROM session WHERE kc_session_id = $turn.session_id
-- Same convention applies to subagent.parent_session_id,
-- reflection.session_id, and retrieval_outcome.session_id below.
DEFINE FIELD IF NOT EXISTS session_id ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS role ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS text ON turn TYPE string;
-- Migration: ensure embedding is optional (SurrealDB 3.0 HNSW requires this for nullable embeddings)
REMOVE FIELD IF EXISTS embedding ON turn;
DEFINE FIELD IF NOT EXISTS embedding ON turn TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS timestamp ON turn TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_at ON turn TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS token_count ON turn TYPE option<int>;
DEFINE FIELD IF NOT EXISTS tool_name ON turn TYPE option<string>;
DEFINE FIELD IF NOT EXISTS model ON turn TYPE option<string>;
DEFINE FIELD IF NOT EXISTS usage ON turn TYPE option<object>;
DEFINE INDEX IF NOT EXISTS turn_vec_idx ON turn FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS turn_session_idx ON turn FIELDS session_id;
-- turn.timestamp is filtered by archiveOldTurns at src/engine/surreal.ts:~1774
-- (`SELECT id FROM turn WHERE timestamp < time::now() - 7d AND id NOT IN ...`).
-- Without this index the archive scan does a full turn table scan each pass;
-- with `turn` already at thousands of rows and growing this is the only
-- on-write path that justifies an index here.
DEFINE INDEX IF NOT EXISTS turn_timestamp_idx ON turn FIELDS timestamp;

-- Identity chunks (agent persona / identity)
DEFINE TABLE IF NOT EXISTS identity_chunk SCHEMALESS;
DEFINE FIELD IF NOT EXISTS agent_id ON identity_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS source ON identity_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS chunk_index ON identity_chunk TYPE int;
DEFINE FIELD IF NOT EXISTS text ON identity_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON identity_chunk TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS importance ON identity_chunk TYPE float DEFAULT 0.5;
-- v0.7.93 append-only: identity_chunk previously DELETE'd by identity.ts +
-- cognitive-bootstrap.ts on soul-evolve replacement. Now soft-deactivated via
-- active=false + archived_at + archive_reason; the new version inserts as
-- additional rows with chunk_index continuing from prior.
DEFINE FIELD IF NOT EXISTS active ON identity_chunk TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS archived_at ON identity_chunk TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS archive_reason ON identity_chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS embedding_target_truncated ON identity_chunk TYPE option<bool>;
-- identity_version is written by src/engine/identity.ts and named as a key
-- column in the UNIQUE compound (source, identity_version, chunk_index) at
-- schema.surql:identity_chunk_unique. Declared explicitly so INFO FOR TABLE
-- shows it and the UNIQUE index sees a typed column rather than inferring
-- per-row from SCHEMALESS writes.
DEFINE FIELD IF NOT EXISTS identity_version ON identity_chunk TYPE option<string>;
DEFINE INDEX IF NOT EXISTS identity_vec_idx ON identity_chunk FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

-- Sessions (lightweight, links to task for 5-pillar integration)
DEFINE TABLE IF NOT EXISTS session SCHEMALESS;
DEFINE FIELD IF NOT EXISTS agent_id ON session TYPE string DEFAULT "default";
DEFINE FIELD IF NOT EXISTS started_at ON session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS last_active ON session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS turn_count ON session TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS total_input_tokens ON session TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS total_output_tokens ON session TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS ended_at ON session TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cleanup_completed ON session TYPE bool DEFAULT false;
-- F2 (round-2) added a session-level claim token used by the deferred-cleanup
-- worker to coordinate single-claimant cleanup across daemon races. Declared
-- explicitly (not relying on SCHEMALESS) so INFO FOR TABLE session shows it
-- and introspect/audit queries can rely on a typed column.
DEFINE FIELD IF NOT EXISTS cleanup_claim_token ON session TYPE option<string>;

-- Long-term memory (episodic → consolidated)
DEFINE TABLE IF NOT EXISTS memory SCHEMALESS;
DEFINE FIELD IF NOT EXISTS text ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON memory TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS importance ON memory TYPE float DEFAULT 0.5;
DEFINE FIELD IF NOT EXISTS confidence ON memory TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS access_count ON memory TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS category ON memory TYPE string DEFAULT "general";
DEFINE FIELD IF NOT EXISTS source ON memory TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON memory TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS last_accessed ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS status ON memory TYPE option<string> DEFAULT "active";
DEFINE FIELD IF NOT EXISTS resolved_at ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS resolved_by ON memory TYPE option<string>;
-- v0.7.93 append-only: replaces DELETE in garbageCollectMemories +
-- consolidateMemories. Archived rows are soft-deactivated via status='archived'
-- and recorded with archived_at + archive_reason; consolidate-loser rows also
-- carry superseded_by pointing at the keeper.
DEFINE FIELD IF NOT EXISTS archived_at ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS archive_reason ON memory TYPE option<string>;
DEFINE FIELD IF NOT EXISTS superseded_by ON memory TYPE option<record<memory>>;
-- v0.7.95 truncation visibility: when the embedding target was truncated
-- (BGE-M3 8192-token limit, mirrored as 6000-char slice in maintenance
-- backfills + surreal.ts:1892 consolidate-backfill), recall fidelity is
-- partial — the tail of the stored text isn't represented in the vector.
-- Set to true at every site that truncates before embedding so queries can
-- audit which rows have known-partial vectors.
DEFINE FIELD IF NOT EXISTS embedding_target_truncated ON memory TYPE option<bool>;
-- K51: the text actually fed to embed() at create time, when it differs from
-- `text` (commitMemory embeds `embeddingText ?? text` — record-finding.ts passes
-- the bare finding without the [CATEGORY] prefix + Rationale tail). Persisted so
-- backfillMemoryEmbeddings can heal an un-embedded row with the SAME short target
-- the create path would have used, preserving short-query match quality through
-- the heal path. NONE means "embed text" (the common case).
DEFINE FIELD IF NOT EXISTS embedding_target ON memory TYPE option<string>;
DEFINE INDEX IF NOT EXISTS memory_vec_idx ON memory FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS memory_category_idx ON memory FIELDS category;
-- Status is filtered on every vectorSearch (line 417), getSessionRetrievedMemories
-- (1786), getDueMemories (1823), getUnresolvedMemories (1257). Without this
-- index those queries do a full memory scan. Compound (status, category) so
-- the (status, category="handoff") lookup at getLatestHandoff also benefits.
DEFINE INDEX IF NOT EXISTS memory_status_idx ON memory FIELDS status;
-- importance index (K33/K30): the memory GC scan and importance-ordered
-- retrieval/eviction paths sort and filter memory by `importance`. Without it
-- those were unindexed full scans/sorts over a forever-growing table.
DEFINE INDEX IF NOT EXISTS memory_importance_idx ON memory FIELDS importance;
-- retrieval_outcome.memory_table is filtered in archiveOldTurns' NOT IN
-- subquery (surreal.ts:1554, "WHERE memory_table = 'turn'") and in
-- getSessionRetrievedMemories (surreal.ts:1774). Without this, the
-- archive pass does a full retrieval_outcome scan every run.
DEFINE INDEX IF NOT EXISTS ro_memtable_idx ON retrieval_outcome FIELDS memory_table;

-- Maintenance runs — observability for the 4 bootstrap maintenance jobs.
-- One row per (job, run). Used by time-relative threshold gates so new
-- installs get maintenance from session 1 instead of waiting for absolute
-- count floors (count<=2000, count<=200, count<=50) that never fire until
-- weeks in.
DEFINE TABLE IF NOT EXISTS maintenance_runs SCHEMALESS;
DEFINE FIELD IF NOT EXISTS job ON maintenance_runs TYPE string;
DEFINE FIELD IF NOT EXISTS ran_at ON maintenance_runs TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rows_affected ON maintenance_runs TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS duration_ms ON maintenance_runs TYPE int DEFAULT 0;
-- E1 (observability): a job that ALWAYS throws used to be indistinguishable
-- from never-ran/succeeded because recordMaintenanceRun was the last statement
-- in each try block (a throw recorded nothing) and nobody READ this table.
-- `status` ('ok'|'error') + `error` make a failing job visible to memory_health.
-- DEFAULT 'ok' so legacy rows + the historical recordMaintenanceRun success
-- path (which now passes status explicitly) read back as healthy.
DEFINE FIELD IF NOT EXISTS status ON maintenance_runs TYPE string DEFAULT 'ok';
DEFINE FIELD IF NOT EXISTS error ON maintenance_runs TYPE option<string>;
DEFINE INDEX IF NOT EXISTS maintenance_runs_job_idx ON maintenance_runs FIELDS job;
-- E1: memory_health reads newest-per-job (ORDER BY ran_at DESC) and
-- purgeOldMaintenanceRuns trims by ran_at — index it so neither is a full scan
-- as the table grows on a long-lived daemon.
DEFINE INDEX IF NOT EXISTS maintenance_runs_ran_at_idx ON maintenance_runs FIELDS ran_at;

-- ============================================================
-- GRAPH EDGES: Turn-level
-- ============================================================
DEFINE TABLE IF NOT EXISTS responds_to TYPE RELATION IN turn OUT turn;
DEFINE TABLE IF NOT EXISTS part_of TYPE RELATION IN turn OUT session;
DEFINE TABLE IF NOT EXISTS mentions TYPE RELATION IN turn OUT concept;

-- ============================================================
-- GRAPH EDGES: 5-Pillar Relations
-- ============================================================
DEFINE TABLE IF NOT EXISTS performed TYPE RELATION IN agent OUT task;
DEFINE TABLE IF NOT EXISTS owns TYPE RELATION IN agent OUT project;
DEFINE TABLE IF NOT EXISTS task_part_of TYPE RELATION IN task OUT project;
DEFINE TABLE IF NOT EXISTS session_task TYPE RELATION IN session OUT task;
DEFINE TABLE IF NOT EXISTS produced TYPE RELATION IN task OUT artifact;
-- 0.7.23: widened to allow concept|subagent IN and task|artifact OUT.
-- Original: IN concept OUT task. Real callers also need:
--   - concept → artifact (provenance for create_knowledge_gems)
--   - subagent → task    (parent-task linking from pre-tool-use)
-- OVERWRITE so live DBs converge on next daemon start; IF NOT EXISTS would no-op.
-- 0.7.70: extended OUT to allow `session` so background daemon extractions
-- without an attached taskId can still anchor concept provenance to the
-- session row instead of going un-traced. Pre-0.7.70 this fell through to
-- a swallow.warn and left the concept derived_from-less.
-- CLOSURE: safe to demote to IF NOT EXISTS once production installs report
-- zero `derived_from` edges whose OUT row carries the concept-only narrow
-- shape (i.e. no live writers depend on the widened IN/OUT after two
-- consecutive release cycles).
DEFINE TABLE OVERWRITE derived_from TYPE RELATION IN concept|subagent OUT task|artifact|session;
DEFINE TABLE IF NOT EXISTS relevant_to TYPE RELATION IN concept OUT project;
DEFINE TABLE IF NOT EXISTS used_in TYPE RELATION IN artifact OUT project;

-- ============================================================
-- GRAPH EDGES: Knowledge Relations (from KG research)
-- ============================================================
-- Semantic hierarchy
DEFINE TABLE IF NOT EXISTS narrower TYPE RELATION IN concept OUT concept;
DEFINE TABLE IF NOT EXISTS broader TYPE RELATION IN concept OUT concept;
DEFINE TABLE IF NOT EXISTS related_to TYPE RELATION IN concept OUT concept;

-- Episodic causality & corroboration
DEFINE TABLE IF NOT EXISTS caused_by TYPE RELATION IN memory OUT memory;
DEFINE TABLE IF NOT EXISTS supports TYPE RELATION IN memory OUT memory;
DEFINE TABLE IF NOT EXISTS contradicts TYPE RELATION IN memory OUT memory;
DEFINE TABLE IF NOT EXISTS describes TYPE RELATION IN memory OUT memory;

-- Concept evolution
-- 0.7.x: widened OUT to allow `concept|memory`. supersedes.ts has two relate
-- paths: concept supersedes (line ~97) and memory supersedes (line ~135). The
-- memory path was failing on installs whose live `supersedes` table was created
-- with the older `OUT concept` shape — SurrealDB's coercer rejected
-- `memory:xxx` against a `record<concept>` OUT slot, producing
-- "supersedes:relate-memory: Couldn't coerce value for field `out`..." warns
-- in the daemon log and silently dropping the edge. OVERWRITE so live DBs
-- converge on next daemon start; IF NOT EXISTS would no-op against the
-- already-narrow table.
-- CLOSURE: safe to demote to IF NOT EXISTS once `supersedes WHERE
-- typeof(out) = 'concept'` AND `WHERE typeof(out) = 'memory'` BOTH appear in
-- production installs (proving the live schema reflects the widened shape
-- everywhere it's deployed).
DEFINE TABLE OVERWRITE supersedes TYPE RELATION IN memory OUT concept|memory;

-- Cross-pillar links
DEFINE TABLE IF NOT EXISTS about_concept TYPE RELATION IN memory OUT concept;
DEFINE TABLE IF NOT EXISTS artifact_mentions TYPE RELATION IN artifact OUT concept;

-- ============================================================
-- RETRIEVAL QUALITY TRACKING
-- ============================================================
-- Each record captures one retrieval event and its outcome signals
DEFINE TABLE IF NOT EXISTS retrieval_outcome SCHEMALESS;
-- session_id carries the kc_session_id UUID string, NOT the SurrealDB Thing
-- record id. Same convention as turn.session_id / subagent.parent_session_id.
DEFINE FIELD IF NOT EXISTS session_id ON retrieval_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS turn_id ON retrieval_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS memory_id ON retrieval_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS memory_table ON retrieval_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS retrieval_score ON retrieval_outcome TYPE float;
-- Quality signals
DEFINE FIELD IF NOT EXISTS utilization ON retrieval_outcome TYPE float DEFAULT 0.0;
DEFINE FIELD IF NOT EXISTS tool_success ON retrieval_outcome TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS context_tokens ON retrieval_outcome TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS was_neighbor ON retrieval_outcome TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS query_embedding ON retrieval_outcome TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS llm_relevance ON retrieval_outcome TYPE option<float>;
-- Explicit feedback (GH #16-5): set by record_retrieval_feedback. ACAN training
-- already prefers llm_relevance over utilization; this records the signal source.
DEFINE FIELD IF NOT EXISTS feedback_source ON retrieval_outcome TYPE option<string>;
DEFINE FIELD IF NOT EXISTS llm_relevant ON retrieval_outcome TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS llm_reason ON retrieval_outcome TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON retrieval_outcome TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ro_session_idx ON retrieval_outcome FIELDS session_id;
DEFINE INDEX IF NOT EXISTS ro_memory_idx ON retrieval_outcome FIELDS memory_id;
DEFINE INDEX IF NOT EXISTS ro_turn_idx ON retrieval_outcome FIELDS turn_id;
-- created_at index: the ACAN trainer sorts the most-recent 15K samples by
-- created_at every retrain, and purgeOldRetrievalOutcomes deletes older rows by
-- created_at. Without it both were unindexed full scans/sorts over a
-- forever-growing table.
DEFINE INDEX IF NOT EXISTS ro_created_idx ON retrieval_outcome FIELDS created_at;

-- ============================================================
-- THREE-BUCKET TURN SCORING
-- ============================================================
-- Per-turn composite: 60% rules compliance + 30% context utilization + 10% memory curation.
-- context_util written real-time; rules_compliance and curation backfilled at session end.
DEFINE TABLE IF NOT EXISTS turn_score SCHEMALESS;
DEFINE FIELD IF NOT EXISTS session_id ON turn_score TYPE string;
DEFINE FIELD IF NOT EXISTS turn_id ON turn_score TYPE string;
DEFINE FIELD IF NOT EXISTS context_util ON turn_score TYPE option<float>;
DEFINE FIELD IF NOT EXISTS rules_compliance ON turn_score TYPE option<float>;
DEFINE FIELD IF NOT EXISTS curation ON turn_score TYPE option<float>;
DEFINE FIELD IF NOT EXISTS composite ON turn_score TYPE option<float>;
DEFINE FIELD IF NOT EXISTS created_at ON turn_score TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ts_session_idx ON turn_score FIELDS session_id;
DEFINE INDEX IF NOT EXISTS ts_turn_idx ON turn_score FIELDS turn_id;
-- created_at index: purgeOldTurnScores (maintenance.ts → surreal.ts) sorts by
-- created_at to find the retention cutoff and DELETEs older rows by created_at;
-- observability.ts:139 + soul.ts:218 also range-scan turn_score by created_at.
-- Without it both were unindexed full scans over a forever-growing telemetry
-- table. Mirrors ro_created_idx on retrieval_outcome.
DEFINE INDEX IF NOT EXISTS ts_created_idx ON turn_score FIELDS created_at;

-- ============================================================
-- ISMAR-GENT: Orchestrator Metrics
-- ============================================================
DEFINE TABLE IF NOT EXISTS orchestrator_metrics SCHEMALESS;
DEFINE FIELD IF NOT EXISTS session_id ON orchestrator_metrics TYPE string;
DEFINE FIELD IF NOT EXISTS turn_index ON orchestrator_metrics TYPE int;
DEFINE FIELD IF NOT EXISTS intent ON orchestrator_metrics TYPE string;
DEFINE FIELD IF NOT EXISTS intent_confidence ON orchestrator_metrics TYPE float;
DEFINE FIELD IF NOT EXISTS complexity ON orchestrator_metrics TYPE string;
DEFINE FIELD IF NOT EXISTS thinking_level ON orchestrator_metrics TYPE string;
DEFINE FIELD IF NOT EXISTS tool_limit ON orchestrator_metrics TYPE int;
DEFINE FIELD IF NOT EXISTS token_budget ON orchestrator_metrics TYPE int;
DEFINE FIELD IF NOT EXISTS actual_tool_calls ON orchestrator_metrics TYPE int;
DEFINE FIELD IF NOT EXISTS actual_tokens_in ON orchestrator_metrics TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS actual_tokens_out ON orchestrator_metrics TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS preflight_ms ON orchestrator_metrics TYPE float;
DEFINE FIELD IF NOT EXISTS turn_duration_ms ON orchestrator_metrics TYPE float;
DEFINE FIELD IF NOT EXISTS steering_candidates ON orchestrator_metrics TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS fast_path ON orchestrator_metrics TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at ON orchestrator_metrics TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS om_session_idx ON orchestrator_metrics FIELDS session_id;
-- created_at index: pruneRawMetrics (observability.ts) finds the 30d soft-tag
-- cutoff by created_at and the daily rollup pass range-scans raw rows by
-- created_at. Without it both were unindexed full scans over a long-lived,
-- per-turn-growing telemetry table. Mirrors ro_created_idx on retrieval_outcome.
DEFINE INDEX IF NOT EXISTS om_created_idx ON orchestrator_metrics FIELDS created_at;

-- ============================================================
-- ISMAR-GENT: Daily Rollup of Orchestrator Metrics (0.5.0+)
-- One row per day. Populated by maintenance pass; query for trend reports.
-- Retention: raw orchestrator_metrics rows older than 30d are SOFT-TAGGED via
-- pruned_at + prune_reason and LEFT IN PLACE — NEVER hard-deleted (Tier-0
-- "nothing should be deleted"; pruneRawMetrics in observability.ts, v0.7.96,
-- core_memory:hoj8fvmbt7d14mskciba). The orchestrator_metrics_daily rollups
-- are kept forever. (The pre-v0.7.96 comment here said "pruned after 30d",
-- which read as a hard DELETE and no longer matched the soft-tag writer.)
-- ============================================================
DEFINE TABLE IF NOT EXISTS orchestrator_metrics_daily SCHEMALESS;
DEFINE FIELD IF NOT EXISTS day ON orchestrator_metrics_daily TYPE string; -- YYYY-MM-DD
DEFINE FIELD IF NOT EXISTS turn_count ON orchestrator_metrics_daily TYPE int;
DEFINE FIELD IF NOT EXISTS mean_tool_calls ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS mean_turn_duration_ms ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS mean_tokens_in ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS mean_tokens_out ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS p95_turn_duration_ms ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS p95_tokens_in ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS fast_path_rate ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS mean_retrieval_util ON orchestrator_metrics_daily TYPE float; -- joined from retrieval_outcome
DEFINE FIELD IF NOT EXISTS tool_failure_rate ON orchestrator_metrics_daily TYPE float;
DEFINE FIELD IF NOT EXISTS retrieval_outcome_count ON orchestrator_metrics_daily TYPE int;
DEFINE FIELD IF NOT EXISTS created_at ON orchestrator_metrics_daily TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS omd_day_idx ON orchestrator_metrics_daily FIELDS day UNIQUE;

-- ============================================================
-- MEMORY SUBSTRATE: Compaction Checkpoints
-- ============================================================
DEFINE TABLE IF NOT EXISTS compaction_checkpoint SCHEMALESS;
DEFINE FIELD IF NOT EXISTS session_id ON compaction_checkpoint TYPE string;
DEFINE FIELD IF NOT EXISTS msg_range_start ON compaction_checkpoint TYPE int;
DEFINE FIELD IF NOT EXISTS msg_range_end ON compaction_checkpoint TYPE int;
DEFINE FIELD IF NOT EXISTS status ON compaction_checkpoint TYPE string; -- pending | complete | failed
DEFINE FIELD IF NOT EXISTS memory_id ON compaction_checkpoint TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON compaction_checkpoint TYPE datetime DEFAULT time::now();

-- ============================================================
-- MEMORY SUBSTRATE: Utility Cache (fast historical utility lookups)
-- ============================================================
DEFINE TABLE IF NOT EXISTS memory_utility_cache SCHEMALESS;
-- memory_id is a typed record reference; was previously string. Existing
-- string-typed installs need scripts/migrate-memory-utility-cache-id.mjs to
-- retype before this DEFINE takes effect (SurrealDB no-ops re-declarations
-- that only change type, matching the concept.superseded_by precedent).
--
-- The cache is keyed by ANY retrieved-record id — retrieval-quality writes a
-- utility row for every scored item, which includes memory, concept, turn AND
-- artifact + skill (all are recall scopes). The prior 3-table union
-- (record<memory>|record<concept>|record<turn>) REJECTED artifact:/skill: ids
-- with "Couldn't coerce ... Expected record<...> but found artifact:..." on
-- every such retrieval (live-observed after the 1M campaign restart) — the same
-- schema-narrower-than-code class as K0. option<record> (any record table)
-- matches the documented "keyed by any retrieved-record id" intent and is
-- future-proof. OVERWRITE (not IF NOT EXISTS) because SurrealDB no-ops a
-- re-declaration that only changes type, so existing installs would otherwise
-- keep the narrow union; widening (union → any record) cannot invalidate an
-- existing value, so the OVERWRITE re-validation is safe.
DEFINE FIELD OVERWRITE memory_id ON memory_utility_cache TYPE option<record>;
-- K21: avg_utilization relaxed to option<float>. The race-free writer no longer
-- materializes it (it would require a non-atomic read-compute-write); the mean
-- is computed at read time from util_sum/retrieval_count. Legacy rows that still
-- carry a materialized avg_utilization (and util_sum IS NONE) remain valid and
-- readers fall back to it. OVERWRITE so installs whose field was created as the
-- required `float` relax on daemon restart (a SCHEMALESS row that omits the
-- field would otherwise trip the non-option coercion on a RETURN AFTER write).
DEFINE FIELD OVERWRITE avg_utilization ON memory_utility_cache TYPE option<float>;
DEFINE FIELD IF NOT EXISTS retrieval_count ON memory_utility_cache TYPE int;
-- K21: util_sum is the commutative accumulator behind avg_utilization. The
-- pre-K21 writer did a non-atomic read-compute-write of the running average
-- (`avg_utilization = (avg_utilization * count + $util)/(count+1)`) under a
-- fire-and-forget UPSERT — two concurrent retrieval-quality writebacks for the
-- same row both read the old mean and the second clobbered the first's update.
-- Now the writer only does commutative `util_sum += $util` / `retrieval_count
-- += 1` (order-independent, no lost update) against a DETERMINISTIC record id,
-- and the mean is computed at read time as util_sum/retrieval_count (mirrors
-- bumpAccessCounts' side-table-delta pattern). option<float> so legacy rows
-- written before this field existed coerce cleanly; readers fall back to the
-- materialized avg_utilization when util_sum IS NONE.
DEFINE FIELD IF NOT EXISTS util_sum ON memory_utility_cache TYPE option<float>;
DEFINE FIELD IF NOT EXISTS last_updated ON memory_utility_cache TYPE datetime DEFAULT time::now();
-- R1/K21: REMOVE the muc_mid_idx UNIQUE index. The K21 writer now keys each row
-- on a DETERMINISTIC record id (memory_utility_cache:⟨memory_X⟩ — one row per
-- target, mirroring access_stats which carries NO secondary index), so the
-- record-id PK already guarantees one-row-per-target uniqueness. The retained
-- UNIQUE was actively HARMFUL post-upgrade: a legacy random-ULID row written by
-- the pre-K21 writer occupies the `memory_id = memory:X` slot, so the new
-- deterministic-id UPSERT's `SET memory_id = memory:X` violated the UNIQUE and
-- its write was swallowed by updateUtilityCache's catch — utility writeback for
-- every pre-existing target froze SILENTLY forever after upgrade. Re-keying /
-- removing rows on this telemetry/cache table is permitted (NOT a NEVER-DELETE
-- content table). REMOVE IF EXISTS so installs that already created the index
-- drop it on daemon restart; clean installs no-op. scripts/migrate-memory-
-- utility-cache-id.mjs folds legacy random-id rows into the deterministic id.
REMOVE INDEX IF EXISTS muc_mid_idx ON memory_utility_cache;

-- ============================================================
-- MEMORY SUBSTRATE: Turn Archive (cold storage for old turns)
-- ============================================================
DEFINE TABLE IF NOT EXISTS turn_archive SCHEMALESS;
-- turn_archive is the largest vector table (grows forever as live turns are
-- archived) and is searched every turn. Without this HNSW index the archive
-- search was a full linear cosine scan (~1.2s at ~13K rows). Mirrors turn_vec_idx.
DEFINE INDEX IF NOT EXISTS turn_archive_vec_idx ON turn_archive FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
-- E7 (retention): archiveOldTurns only RELOCATES rows here (INSERT INTO
-- turn_archive + tag source) so this table grew FOREVER. purgeOldTurnArchive
-- (maintenance.ts) keeps the newest ~100k oldest-first via gcHardDelete; the
-- ORDER BY timestamp ASC scan needs this index (rows are copied verbatim from
-- `turn`, which carries `timestamp`). Mirrors turn_timestamp_idx.
DEFINE INDEX IF NOT EXISTS turn_archive_timestamp_idx ON turn_archive FIELDS timestamp;

-- ============================================================
-- COGNITIVE: Causal Chain Metadata
-- ============================================================
DEFINE TABLE IF NOT EXISTS causal_chain SCHEMALESS;
DEFINE FIELD IF NOT EXISTS session_id ON causal_chain TYPE string;
DEFINE FIELD IF NOT EXISTS trigger_memory ON causal_chain TYPE string;
DEFINE FIELD IF NOT EXISTS outcome_memory ON causal_chain TYPE string;
DEFINE FIELD IF NOT EXISTS chain_type ON causal_chain TYPE string DEFAULT "debug"; -- debug | refactor | feature | fix
DEFINE FIELD IF NOT EXISTS success ON causal_chain TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS confidence ON causal_chain TYPE float DEFAULT 0.5;
DEFINE FIELD IF NOT EXISTS description ON causal_chain TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON causal_chain TYPE datetime DEFAULT time::now();
-- v0.8.0: graduation watermark. NONE = not yet synthesized into a skill.
-- The causal_graduate fetch handler filters `graduated_at IS NONE` so each
-- chain is graduated at most once; the commit handler stamps time::now() on
-- the eligible-type chains it consumed. Pre-fix the fetch had no watermark,
-- so every one of N per-session causal_graduate work items re-synthesized the
-- SAME global chain set into duplicate skills (memory:2gp8m8j597c46y6z5lpg).
DEFINE FIELD IF NOT EXISTS graduated_at ON causal_chain TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS cc_session_idx ON causal_chain FIELDS session_id;
DEFINE INDEX IF NOT EXISTS cc_confidence_idx ON causal_chain FIELDS confidence;
DEFINE INDEX IF NOT EXISTS cc_graduated_idx ON causal_chain FIELDS graduated_at;

-- ============================================================
-- COGNITIVE: Skill Library (Procedural Memory)
-- ============================================================
DEFINE TABLE IF NOT EXISTS skill SCHEMALESS;
DEFINE FIELD IF NOT EXISTS name ON skill TYPE string;
DEFINE FIELD IF NOT EXISTS description ON skill TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON skill TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS preconditions ON skill TYPE option<string>;
DEFINE FIELD IF NOT EXISTS steps ON skill TYPE option<array>;
DEFINE FIELD IF NOT EXISTS postconditions ON skill TYPE option<string>;
DEFINE FIELD IF NOT EXISTS success_count ON skill TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS failure_count ON skill TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS avg_duration_ms ON skill TYPE float DEFAULT 0.0;
-- v0.7.96 (2026-05-18): TYPE option<bool> + OVERWRITE. Same lookalike of
-- the pending_work.active deadlock (memory:3k5exi93w1wi5stp0pqn) — 52 of
-- 3446 skill rows had `active IS NONE` from pre-migration writes. Readers
-- already tolerated NONE via `(active = NONE OR active = true)` guards at
-- skills.ts:63, skills.ts:110, soul.ts:190, maintenance.ts:239, so the bomb
-- hadn't gone off — but the moment any caller adds `UPDATE skill ... RETURN
-- AFTER` for a claim race the 52 NONE rows throw the same coerce error
-- pending_work hit. Relaxing to option<bool> aligns the schema with the
-- long-standing reader semantics. OVERWRITE so existing installs pick it
-- up on daemon restart. Healed via UPDATE SET active=true WHERE active IS
-- NONE before this DEFINE landed.
DEFINE FIELD OVERWRITE active ON skill TYPE option<bool> DEFAULT true;
DEFINE FIELD IF NOT EXISTS superseded_by ON skill TYPE option<record<skill>>;
DEFINE FIELD IF NOT EXISTS last_used ON skill TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON skill TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS skill_vec_idx ON skill FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS skill_active_idx ON skill FIELDS active;

DEFINE TABLE IF NOT EXISTS skill_from_task TYPE RELATION IN skill OUT task;
DEFINE TABLE IF NOT EXISTS skill_uses_concept TYPE RELATION IN skill OUT concept;

-- ============================================================
-- COGNITIVE: Metacognitive Reflection
-- ============================================================
DEFINE TABLE IF NOT EXISTS reflection SCHEMALESS;
-- session_id carries the kc_session_id UUID string, NOT the SurrealDB Thing
-- record id. Join via `session WHERE kc_session_id = $reflection.session_id`.
-- The `reflects_on` edge holds the typed link to the session record id.
DEFINE FIELD IF NOT EXISTS session_id ON reflection TYPE string;
DEFINE FIELD IF NOT EXISTS text ON reflection TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON reflection TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS category ON reflection TYPE string DEFAULT "efficiency"; -- failure_pattern | efficiency | approach_strategy
DEFINE FIELD IF NOT EXISTS severity ON reflection TYPE string DEFAULT "minor"; -- minor | moderate | critical
DEFINE FIELD IF NOT EXISTS importance ON reflection TYPE float DEFAULT 7.0;
DEFINE FIELD IF NOT EXISTS access_count ON reflection TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at ON reflection TYPE datetime DEFAULT time::now();
-- v0.7.93 append-only: consolidateMemories Pass 3 previously DELETE'd
-- reflection-dedup losers; now soft-deactivates via active=false + archived_at
-- + archive_reason. The winner's id is captured in superseded_by so the audit
-- chain is recoverable.
DEFINE FIELD IF NOT EXISTS active ON reflection TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS archived_at ON reflection TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS archive_reason ON reflection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS superseded_by ON reflection TYPE option<record<reflection>>;
DEFINE FIELD IF NOT EXISTS embedding_target_truncated ON reflection TYPE option<bool>;
DEFINE INDEX IF NOT EXISTS reflection_vec_idx ON reflection FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
-- session_id index: K18 targeted-membership and the soul/evolve "reflections
-- since soul.updated_at" range scans filter reflection by session_id. Without
-- it those were full table scans over a forever-growing table. session_id
-- carries the kc_session_id UUID string (see the field comment above).
DEFINE INDEX IF NOT EXISTS reflection_session_idx ON reflection FIELDS session_id;

DEFINE TABLE IF NOT EXISTS reflects_on TYPE RELATION IN reflection OUT session;

-- ============================================================
-- SUBAGENT: Tracking spawned subagents
-- ============================================================
DEFINE TABLE IF NOT EXISTS subagent SCHEMALESS;
-- parent_session_id carries the kc_session_id UUID string of the spawning
-- session, NOT the SurrealDB Thing record id of the `session` row. Join via
-- `session WHERE kc_session_id = $subagent.parent_session_id`. Same UUID-
-- vs-Thing convention as turn.session_id above.
DEFINE FIELD IF NOT EXISTS parent_session_id ON subagent TYPE string;
DEFINE FIELD IF NOT EXISTS child_session_id ON subagent TYPE option<string>;
-- 0.7.23: relaxed from required string. Hook handlers (pre-tool-use, subagent-stop)
-- create rows before they know the mode; OVERWRITE converges live DBs.
DEFINE FIELD OVERWRITE mode ON subagent TYPE option<string>; -- full | incognito | unset
-- 0.7.33: same treatment for `task` — pre-tool-use creates subagent rows
-- before the task description is known. Daemon log was flooding with
-- "Couldn't coerce value for field `task`: Expected `string` but found `NONE`"
-- per subagent spawn. Same shape as the 0.7.23 mode fix.
DEFINE FIELD OVERWRITE task ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON subagent TYPE string DEFAULT "running"; -- running | completed | error
DEFINE FIELD IF NOT EXISTS incognito_id ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS summary ON subagent TYPE option<string>;
-- correlation_key and run_id are the natural keys hook-handlers upsert on.
-- The UNIQUE indexes below (subagent_corr_unique, subagent_run_unique) need
-- these field declarations so SurrealDB stores them with a typed column
-- rather than inferring per-row. Without the DEFINE FIELDs the indexes
-- still work but the daemon log fills with coercion warnings on every
-- subagent row that lacks one of the two fields.
DEFINE FIELD IF NOT EXISTS correlation_key ON subagent TYPE option<string>;
-- run_id is a UNIQUE-indexed natural key (see subagent_run_unique below). Multiple
-- rows with run_id=NONE collide on that UNIQUE in SurrealDB, so callers MUST
-- always set a value — even a synthetic placeholder. PreToolUse handlers that
-- don't yet know the real run_id set run_id = correlation_key as a placeholder
-- (round-2 hook-handler contract). The ASSERT below rejects empty strings up
-- front so a malformed write fails close to the call site rather than blowing
-- up the index apply at boot. NONE is still acceptable at the type level for
-- legacy/intermediate states but the UNIQUE will reject duplicate NONEs.
DEFINE FIELD IF NOT EXISTS run_id ON subagent TYPE option<string>
  ASSERT $value = NONE OR $value != "";
DEFINE FIELD IF NOT EXISTS created_at ON subagent TYPE datetime DEFAULT time::now();
-- Fields written by src/hook-handlers/pre-tool-use.ts (Q3, audit Bundle D-D2).
-- The table is SCHEMALESS so SurrealDB accepts these writes without DEFINE FIELDs,
-- but declaring them as option<*> normalizes storage type and lets INFO FOR TABLE
-- document the real shape. result_summary and duration_ms are omitted because
-- their only writer (src/engine/hooks/subagent-lifecycle.ts) was retired in v0.7.74.
DEFINE FIELD IF NOT EXISTS agent_type ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS prompt_preview ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS parent_session_key ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS child_session_key ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS label ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS prompt_length ON subagent TYPE option<int>;
DEFINE FIELD IF NOT EXISTS tool_call_count ON subagent TYPE option<int>;
DEFINE INDEX IF NOT EXISTS sub_parent_idx ON subagent FIELDS parent_session_id;

DEFINE TABLE IF NOT EXISTS spawned TYPE RELATION IN session OUT subagent;
-- 0.7.23: subagent → parent-session provenance, written from pre-tool-use.
DEFINE TABLE IF NOT EXISTS spawned_from TYPE RELATION IN subagent OUT session;

-- ============================================================
-- CONSTITUTIVE MEMORY: Monologue Trace
-- ============================================================
-- ============================================================
-- TIERED MEMORY: Core Memory (Tier 0 + Tier 1)
-- ============================================================
-- Tier 0: Always loaded every turn, never scored or evicted.
-- Tier 1: Session-pinned, loaded at session start, stays until session ends.
-- No vector index — these are loaded in full via SELECT, not similarity search.
DEFINE TABLE IF NOT EXISTS core_memory SCHEMALESS;
DEFINE FIELD IF NOT EXISTS text ON core_memory TYPE string;
DEFINE FIELD IF NOT EXISTS category ON core_memory TYPE string DEFAULT "general";
DEFINE FIELD IF NOT EXISTS priority ON core_memory TYPE int DEFAULT 50;
DEFINE FIELD IF NOT EXISTS tier ON core_memory TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS active ON core_memory TYPE bool DEFAULT true;
-- v0.7.93 append-only: replaces DELETE in soul.ts, profile.ts,
-- cognitive-bootstrap.ts. Soft-deactivation now sets active=false +
-- archived_at + archive_reason rather than dropping the row.
DEFINE FIELD IF NOT EXISTS archived_at ON core_memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS archive_reason ON core_memory TYPE option<string>;
DEFINE FIELD IF NOT EXISTS session_id ON core_memory TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON core_memory TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON core_memory TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS cm_tier_idx ON core_memory FIELDS tier;
DEFINE INDEX IF NOT EXISTS cm_category_idx ON core_memory FIELDS category;

DEFINE TABLE IF NOT EXISTS monologue SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS session_id ON monologue TYPE string;
DEFINE FIELD IF NOT EXISTS category ON monologue TYPE string;
DEFINE FIELD IF NOT EXISTS content ON monologue TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON monologue TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS timestamp ON monologue TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS embedding_target_truncated ON monologue TYPE option<bool>;
-- 0.7.122: SurrealDB 3.1.4 enforces SCHEMAFULL strictly — an access-counter
-- sync UPDATE against monologue threw "no such field" in production (3.0.1
-- silently persisted undeclared fields). Current-src bump callers filter to
-- concept/memory, but monologue rows are retrievable and historical paths
-- reached them; declare the counter fields so no writer can ever throw here.
DEFINE FIELD IF NOT EXISTS access_count ON monologue TYPE option<int>;
DEFINE FIELD IF NOT EXISTS synced_hits ON monologue TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_accessed ON monologue TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS monologue_session ON monologue FIELDS session_id;
DEFINE INDEX IF NOT EXISTS monologue_category ON monologue FIELDS category;
DEFINE INDEX IF NOT EXISTS monologue_vec_idx ON monologue FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
-- timestamp index (K33): the soul_generate/soul_evolve fetch paths and the
-- hasNewSoulExperience probe (pending-work.ts) sort/filter monologue by
-- `timestamp` (ORDER BY timestamp DESC, WHERE timestamp > $since). Without it
-- those were unindexed full scans/sorts over a forever-growing table.
DEFINE INDEX IF NOT EXISTS monologue_timestamp_idx ON monologue FIELDS timestamp;

-- Fibonacci resurfacing: proactive memory that fades over time
-- Memories flagged as surfaceable get a next_surface_at timestamp.
-- Each time they're surfaced and ignored, fib_index increments (longer gaps).
-- If user engages, fib_index resets to 0 (memory is alive again).
DEFINE FIELD IF NOT EXISTS surfaceable ON memory TYPE option<bool> DEFAULT false;
DEFINE FIELD IF NOT EXISTS next_surface_at ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fib_index ON memory TYPE option<int> DEFAULT 0;
DEFINE FIELD IF NOT EXISTS surface_count ON memory TYPE option<int> DEFAULT 0;
DEFINE FIELD IF NOT EXISTS last_surfaced ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_engaged ON memory TYPE option<datetime>;
-- Index for efficient due-memory queries
DEFINE INDEX IF NOT EXISTS memory_surface_idx ON memory FIELDS surfaceable, next_surface_at;
DEFINE FIELD IF NOT EXISTS surface_outcome ON memory TYPE option<string>;

-- Soul: graduated identity document (singleton soul:kongbrain)
DEFINE TABLE IF NOT EXISTS soul SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS agent_id ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS working_style ON soul TYPE array<string>;
DEFINE FIELD IF NOT EXISTS emotional_dimensions ON soul TYPE array<object>;
DEFINE FIELD IF NOT EXISTS emotional_dimensions.*.dimension ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS emotional_dimensions.*.description ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS emotional_dimensions.*.adopted_at ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS self_observations ON soul TYPE array<string>;
DEFINE FIELD IF NOT EXISTS earned_values ON soul TYPE array<object>;
DEFINE FIELD IF NOT EXISTS earned_values.*.value ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS earned_values.*.grounded_in ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS revisions ON soul TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS revisions.*.timestamp ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS revisions.*.section ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS revisions.*.change ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS revisions.*.rationale ON soul TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON soul TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON soul TYPE datetime DEFAULT time::now();

-- Maturity stage: tracks stage transitions for progress notifications
DEFINE TABLE IF NOT EXISTS maturity_stage SCHEMALESS;
DEFINE FIELD IF NOT EXISTS stage ON maturity_stage TYPE string;
DEFINE FIELD IF NOT EXISTS volume_score ON maturity_stage TYPE float;
DEFINE FIELD IF NOT EXISTS quality_score ON maturity_stage TYPE float;
DEFINE FIELD IF NOT EXISTS met_count ON maturity_stage TYPE int;
DEFINE FIELD IF NOT EXISTS created_at ON maturity_stage TYPE datetime DEFAULT time::now();

-- Graduation events: tracks when soul graduation occurred for user notification
DEFINE TABLE IF NOT EXISTS graduation_event SCHEMALESS;
DEFINE FIELD IF NOT EXISTS session_id ON graduation_event TYPE string;
DEFINE FIELD IF NOT EXISTS acknowledged ON graduation_event TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS acknowledged_at ON graduation_event TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS acknowledged_session ON graduation_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS quality_score ON graduation_event TYPE float;
DEFINE FIELD IF NOT EXISTS volume_score ON graduation_event TYPE float;
DEFINE FIELD IF NOT EXISTS stage ON graduation_event TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON graduation_event TYPE datetime DEFAULT time::now();

-- ============================================================
-- PENDING WORK QUEUE: Deferred cognitive tasks for subagent processing
-- ============================================================
-- Session-end queues work items (extraction, reflection, skill, soul).
-- Next session's subagent (Opus) fetches and processes them via MCP tools.
DEFINE TABLE IF NOT EXISTS pending_work SCHEMALESS;
DEFINE FIELD IF NOT EXISTS work_type ON pending_work TYPE string;
DEFINE FIELD IF NOT EXISTS session_id ON pending_work TYPE string;
DEFINE FIELD IF NOT EXISTS surreal_session_id ON pending_work TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task_id ON pending_work TYPE option<string>;
DEFINE FIELD IF NOT EXISTS project_id ON pending_work TYPE option<string>;
DEFINE FIELD IF NOT EXISTS payload ON pending_work TYPE option<object>;
-- OVERWRITE so the ASSERT lands on existing installs whose field was created
-- before the enum guard. Without the ASSERT, a typo'd status ("pendng",
-- "processsing") gets stored silently and the work item never gets picked
-- up by fetch_pending_work — the queue grows zombies. The four-value set
-- mirrors the lifecycle the daemon actually drives: pending → processing
-- → (completed | failed). If new statuses get added in code, update both
-- sides; the ASSERT will reject a CREATE/UPDATE with an unknown value.
--
-- UPGRADE CONTRACT: applying this OVERWRITE on a live DB runs the ASSERT
-- against every existing pending_work row. Pre-0.7.x installs may carry
-- legacy statuses ("queued", typos, NULL) that fail the ASSERT and prevent
-- the schema apply — which then prevents the daemon from booting. Operators
-- upgrading from <0.7.70 MUST run `node scripts/predeploy-dedup.mjs --apply`
-- first; that script normalizes any out-of-enum status to 'failed' before
-- this DEFINE FIELD touches the data. Clean installs have no rows so the
-- ASSERT is a no-op.
-- CLOSURE: safe to demote to IF NOT EXISTS once `predeploy-dedup.mjs --apply`
-- has been run on every install for two consecutive release cycles, at which
-- point the legacy status-normalize pass becomes redundant.
DEFINE FIELD OVERWRITE status ON pending_work TYPE string
  ASSERT $value IN ['pending', 'processing', 'committing', 'completed', 'failed']
  DEFAULT 'pending';
DEFINE FIELD IF NOT EXISTS priority ON pending_work TYPE int DEFAULT 5;
DEFINE FIELD IF NOT EXISTS created_at ON pending_work TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS completed_at ON pending_work TYPE option<datetime>;
-- K15: processing_started_at is stamped when a row is CLAIMED (status flips to
-- "processing") and RE-STAMPED at the commit CAS (→ "committing") so the
-- 10-minute stale-recovery window restarts when commit work begins — a long
-- commit must not let stale-recovery revert a row another path is actively
-- writing. SCHEMALESS already accepted this field at runtime; declared here so
-- INFO FOR TABLE documents it and the (processing_started_at ?? created_at)
-- stale predicate reads a typed column.
DEFINE FIELD IF NOT EXISTS processing_started_at ON pending_work TYPE option<datetime>;
-- K41: committing_token makes the processing→committing CAS in
-- commit_work_results idempotent across a single withRetry re-fire. The CAS
-- stamps a caller-generated token; a retry that lands the SAME token (its own
-- CAS succeeded server-side but the response was lost) is treated as a WIN, not
-- a discard, while a row carrying a DIFFERENT token (genuinely reclaimed by
-- another drainer — the C1 case) is correctly discarded. option<string> so
-- pre-K41 rows (token IS NONE) coerce cleanly under RETURN AFTER.
DEFINE FIELD IF NOT EXISTS committing_token ON pending_work TYPE option<string>;
-- v0.7.95 append-only: pending_work formerly DELETE'd dupes + 7d-stale rows;
-- now soft-archived via active=false + archived_at + archive_reason. Readers
-- (fetch_pending_work, status_breakdown) filter `(active = true OR active IS NONE)`.
-- v0.7.96 (2026-05-18): TYPE option<bool> + OVERWRITE. The original `TYPE bool
-- DEFAULT true` with IF NOT EXISTS shipped without a backfill — 468 pre-existing
-- rows had `active IS NONE`, which the SELECT guard tolerated but the claim
-- UPDATE+RETURN AFTER at pending-work.ts:211-212 did NOT (SCHEMAFULL re-coerces
-- on write-returns, throws `Couldn't coerce ... Expected bool but found NONE`).
-- Result: queue was deadlocked on the highest-priority NONE row until 2026-05-18.
-- option<bool> aligns the schema with reader semantics (NONE legitimate),
-- OVERWRITE ensures existing installs pick up the relaxation on daemon restart.
-- See finding memory:3k5exi93w1wi5stp0pqn for the full root cause trace.
DEFINE FIELD OVERWRITE active ON pending_work TYPE option<bool> DEFAULT true;
DEFINE FIELD IF NOT EXISTS archived_at ON pending_work TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS archive_reason ON pending_work TYPE option<string>;
-- v0.7.102: dedup_key — computed UNIQUE key that REPLACES the
-- (session_id, work_type, status, active) compound index below. Active rows
-- key on the (session|work_type|status) triple → at most one active item per
-- triple (the invariant we actually care about). Archived rows (active=false)
-- key on their own record id, which is globally unique, so UNLIMITED
-- soft-archived rows per (session, work_type) coexist. VALUE recomputes on
-- every write, so the existing archive logic (set active=false) is unchanged.
--
-- Why: v0.7.95's soft-archive set active=false but LEFT status='processing'.
-- The v0.7.99 fix added `active` to the index so ONE (processing,false) row
-- could coexist with the active one — but a SECOND archived row in the same
-- (status) slot still collided ("index already contains [...,'processing',
-- true]"), which broke BOTH fetch_pending_work (stale-recovery) AND
-- commit_work_results (markTerminal) and wedged the whole drain (2026-05-31).
-- Keying archived rows on their id removes the collision entirely.
DEFINE FIELD OVERWRITE dedup_key ON pending_work VALUE
  IF active = true
  THEN string::concat(session_id, '|', work_type, '|', status)
  ELSE <string>id
  END;
DEFINE INDEX IF NOT EXISTS pw_status_idx ON pending_work FIELDS status, priority;
DEFINE INDEX IF NOT EXISTS pw_active_idx ON pending_work FIELDS active;

-- ============================================================
-- EMBEDDING CACHE: Persistent L2 cache surviving daemon restarts
-- ============================================================
DEFINE TABLE IF NOT EXISTS embedding_cache SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text_hash ON embedding_cache TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON embedding_cache TYPE array;
DEFINE FIELD IF NOT EXISTS model_version ON embedding_cache TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON embedding_cache TYPE datetime DEFAULT time::now();
-- v0.7.96 tag-don't-delete (core_memory:hoj8fvmbt7d14mskciba): retention paths
-- mark rows pruned via pruned_at + prune_reason and leave them in place rather
-- than DELETE. Readers (l2Get at embeddings.ts) filter `pruned_at IS NONE`.
DEFINE FIELD IF NOT EXISTS pruned_at ON embedding_cache TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS prune_reason ON embedding_cache TYPE option<string>;
DEFINE INDEX IF NOT EXISTS idx_ec_text_hash ON embedding_cache FIELDS text_hash UNIQUE;

-- ============================================================
-- DUPLICATE-ROW SEAL: DB-level UNIQUE constraints (Agent 1 of 6)
-- ============================================================
-- These UNIQUE indexes are the canonical defense against the duplicate-row
-- bug class (the original symptom: 620 duplicate `causal_graduate` rows in
-- pending_work). They enforce idempotency at the DB layer regardless of
-- what calling code does. If a re-apply fails on UNIQUE creation, existing
-- duplicate rows are blocking it: dedupe in the live DB first, then re-run.
--
-- Idempotency: DEFINE INDEX without IF NOT EXISTS overwrites by default in
-- SurrealDB, matching the style of the OVERWRITE field declarations above
-- (lines 154, 354, 359). IF NOT EXISTS is used where pre-existing single-
-- field indexes use it for consistency.

-- pending_work: compound UNIQUE on (session_id, work_type, status).
-- Stops duplicate enqueues like the 620 causal_graduate rows.
--
-- Tradeoff vs the originally-intended partial UNIQUE (... WHERE status = 'pending'):
-- the deployed SurrealDB rejects `DEFINE INDEX ... UNIQUE WHERE ...` with a parser
-- error (probed 2026-05-13 via scripts/probe-surreal-version.mjs:
-- "Parse error: Unexpected token `WHERE`, expected Eof"). Partial-WHERE indexes
-- are a SurrealDB 2.x+ feature; the responder on ws://127.0.0.1:8000/rpc does
-- not accept that syntax, so runSchema() would fail and the daemon wouldn't start.
--
-- A compound UNIQUE on (session_id, work_type, status) preserves the dedup
-- invariant we actually care about: "no two simultaneously-pending duplicates"
-- still holds because two pending rows would share status='pending' and thus
-- collide on the compound key. Status transitions (pending → processing →
-- completed/failed) are UPDATEs, not CREATEs, so they don't violate the index.
-- The only CREATE paths (deferred-cleanup.ts:71, session-end.ts:74/94/106)
-- never set status explicitly — they all rely on the DEFAULT "pending" from
-- line 466, so accidental CREATE-with-status='completed' is not a code path.
--
-- One row per (session_id, work_type, completed) is allowed; if a session
-- re-runs the same work after completion, that re-run still has status='pending'
-- on insert, which is again unique vs the completed row. Net result: same
-- protection against the 620-duplicate-causal_graduate class of bug, without
-- the partial-WHERE-index syntax dependency.
-- v0.7.99 (2026-05-20): added `active` to the unique columns. Pre-fix the
-- index was on (session_id, work_type, status), but v0.7.95's soft-archive
-- conversion sets `active=false` + archive_reason WITHOUT transitioning
-- `status` out of 'processing'. A stuck soft-archived 'processing' row
-- still occupied the unique slot, blocking fresh claims for the same
-- (session, work_type) — drained 0 of 209 items on first retry. Adding
-- `active` makes the index strictly more permissive: (s, w, 'processing',
-- true) and (s, w, 'processing', false) can coexist. Readers don't see
-- the false row (fetch_pending_work filters `(active=true OR IS NONE)`).
-- OVERWRITE forces existing installs to drop+rebuild on daemon restart.
-- v0.7.102: the index now keys on the computed dedup_key (defined above) so
-- multiple soft-archived rows per (session, work_type) no longer collide.
-- Backfill first — VALUE fields don't compute retroactively on DEFINE, and
-- runSchema() runs this whole file, so this touch populates legacy rows at
-- bootstrap; the WHERE makes it a no-op once every row has a key (verified
-- 2026-05-31: WHERE matches absent-field rows; 832 active triples all distinct).
UPDATE pending_work SET priority = priority WHERE dedup_key = NONE;
DEFINE INDEX OVERWRITE pw_session_worktype_status_unique ON pending_work
  FIELDS dedup_key UNIQUE;
DEFINE INDEX IF NOT EXISTS pw_session_idx ON pending_work FIELDS session_id;
DEFINE INDEX IF NOT EXISTS pw_worktype_idx ON pending_work FIELDS work_type;

-- subagent: correlation_key and run_id must be globally unique. These are
-- the natural keys hook-handlers should be upserting on.
--
-- CALLER CONTRACT (round-2): every CREATE on subagent MUST set both
-- correlation_key AND run_id, even synthetic ones. SurrealDB collapses
-- multiple NONE values into a single UNIQUE-violation bucket, so a second
-- PreToolUse CREATE that leaves run_id unset would collide with the first.
-- The pre-tool-use handler sets run_id = correlation_key as a placeholder
-- and SubagentStop overwrites it with the real run_id. If you add a new
-- caller that creates subagent rows, follow the same pattern.
DEFINE INDEX IF NOT EXISTS subagent_corr_unique ON subagent FIELDS correlation_key UNIQUE;
DEFINE INDEX IF NOT EXISTS subagent_run_unique ON subagent FIELDS run_id UNIQUE;

-- retrieval_outcome: one row per (session, turn, memory) retrieval event.
DEFINE INDEX IF NOT EXISTS retoutc_unique ON retrieval_outcome
  FIELDS session_id, turn_id, memory_id UNIQUE;

-- turn_score: one composite score per (session, turn).
DEFINE INDEX IF NOT EXISTS turnscore_unique ON turn_score
  FIELDS session_id, turn_id UNIQUE;

-- orchestrator_metrics: one row per (session, turn_index).
DEFINE INDEX IF NOT EXISTS orchm_unique ON orchestrator_metrics
  FIELDS session_id, turn_index UNIQUE;

-- identity_chunk: one chunk per (source, version, index).
DEFINE INDEX IF NOT EXISTS identity_chunk_unique ON identity_chunk
  FIELDS source, identity_version, chunk_index UNIQUE;

-- maturity_stage: one row per stage name (transitions are tracked, not
-- duplicated).
DEFINE INDEX IF NOT EXISTS maturity_stage_unique ON maturity_stage FIELDS stage UNIQUE;

-- causal_chain: one chain per (trigger, outcome, type) triple.
DEFINE INDEX IF NOT EXISTS causal_chain_unique ON causal_chain
  FIELDS trigger_memory, outcome_memory, chain_type UNIQUE;

-- session: hot-path WHERE indexes for kc_session_id lookups and the
-- cleanup_completed scan run by session-end maintenance.
DEFINE INDEX IF NOT EXISTS session_kc_idx ON session FIELDS kc_session_id;
DEFINE INDEX IF NOT EXISTS session_cleanup_idx ON session FIELDS cleanup_completed;

-- ============================================================
-- MISSING FIELD TYPE DECLARATIONS (SCHEMALESS → typed option<>)
-- ============================================================
-- These fields were being written by daemon code but had no DEFINE FIELD,
-- so SurrealDB stored them with mixed/inferred types. Declaring them as
-- option<datetime>/option<string> normalizes storage and lets queries use
-- typed predicates.
DEFINE FIELD IF NOT EXISTS ended_at ON subagent TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS outcome ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reason ON subagent TYPE option<string>;
DEFINE FIELD IF NOT EXISTS kc_session_id ON session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS superseded_at ON concept TYPE option<datetime>;
-- superseded_by accepts ANY record: a concept is superseded EITHER by a
-- correction memory (the supersede tool: memory→concept) OR by a newer concept
-- (extraction dedup — commit.ts concept-supersede path, target.kind="concept",
-- cid = the new concept id). The prior record<memory> REJECTED the concept-id
-- case ("Couldn't coerce ... Expected record<memory> but found concept:...",
-- swallowed at commit.ts :decay) so that back-pointer silently never set — the
-- same schema-narrower-than-code class as K0 and the memory_id fix, found by the
-- post-campaign schema-record-type sweep. OVERWRITE because IF NOT EXISTS no-ops
-- a type change; widening can't invalidate an existing value. (The supersedes
-- EDGE still enforces graph IN/OUT types, so integrity isn't lost.)
DEFINE FIELD OVERWRITE superseded_by ON concept TYPE option<record>;
-- v0.7.93 append-only: replaces DELETE in garbageCollectConcepts. Concepts
-- already use superseded_at IS NONE as the active filter (vectorSearch line
-- 441); archive_reason annotates why a concept was marked inactive.
DEFINE FIELD IF NOT EXISTS archive_reason ON concept TYPE option<string>;
DEFINE FIELD IF NOT EXISTS embedding_target_truncated ON concept TYPE option<bool>;

-- ============================================================
-- ARTIFACT DEDUP SEAL (defense in depth)
-- ============================================================
-- PostToolUse re-fires (duplicate-row bug class) could produce duplicate
-- artifact rows for the same canonical file path. Code-side dedup in
-- store.createArtifact() is the primary defense; this UNIQUE index is
-- the DB-level seal. WARNING: if duplicate artifact rows already exist
-- in a live DB, this index creation will be REJECTED on daemon restart.
-- Manually dedupe existing artifacts (or add an entry to the predeploy
-- dedup script) BEFORE relying on this index for new deployments.
DEFINE INDEX IF NOT EXISTS artifact_path_unique ON artifact FIELDS path UNIQUE;

-- ============================================================
-- MIGRATIONS (must run after table definitions)
-- ============================================================
-- 768d → 1024d migration completed; REMOVE INDEX / UPDATE stale
-- embeddings removed to avoid destroying live HNSW indexes on
-- every startup.
