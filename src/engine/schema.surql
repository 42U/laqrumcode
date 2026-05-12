-- KongBrain conversation graph schema
-- Run against ns:kong db:memory
-- Aligned with 5-pillar model: Agent, Project, Task, Artifact, Concept

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
DEFINE INDEX IF NOT EXISTS artifact_vec_idx ON artifact FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS artifact_type_idx ON artifact FIELDS type;

-- ============================================================
-- PILLAR 5: Concept (semantic knowledge nodes)
-- ============================================================
DEFINE TABLE IF NOT EXISTS concept SCHEMALESS;
-- Recovery: restore content from name if the rename migration ran before revert
UPDATE concept SET content = name WHERE content = NONE AND name != NONE;
DEFINE FIELD IF NOT EXISTS content ON concept TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON concept TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS stability ON concept TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS confidence ON concept TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS access_count ON concept TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS tags ON concept TYPE option<array>;
DEFINE FIELD IF NOT EXISTS source ON concept TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON concept TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS last_accessed ON concept TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS concept_vec_idx ON concept FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

-- ============================================================
-- Conversation turns (the workhorse table)
-- ============================================================
DEFINE TABLE IF NOT EXISTS turn SCHEMALESS;
DEFINE FIELD IF NOT EXISTS session_id ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS role ON turn TYPE string;
DEFINE FIELD IF NOT EXISTS text ON turn TYPE string;
-- Migration: ensure embedding is optional (SurrealDB 3.0 HNSW requires this for nullable embeddings)
REMOVE FIELD IF EXISTS embedding ON turn;
DEFINE FIELD embedding ON turn TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS timestamp ON turn TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_at ON turn TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS token_count ON turn TYPE option<int>;
DEFINE FIELD IF NOT EXISTS tool_name ON turn TYPE option<string>;
DEFINE FIELD IF NOT EXISTS model ON turn TYPE option<string>;
DEFINE FIELD IF NOT EXISTS usage ON turn TYPE option<object>;
DEFINE INDEX IF NOT EXISTS turn_vec_idx ON turn FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS turn_session_idx ON turn FIELDS session_id;
DEFINE INDEX IF NOT EXISTS turn_tool_name_idx ON turn FIELDS tool_name;

-- Identity chunks (agent persona / identity)
DEFINE TABLE IF NOT EXISTS identity_chunk SCHEMALESS;
DEFINE FIELD IF NOT EXISTS agent_id ON identity_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS source ON identity_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS chunk_index ON identity_chunk TYPE int;
DEFINE FIELD IF NOT EXISTS text ON identity_chunk TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON identity_chunk TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS importance ON identity_chunk TYPE float DEFAULT 0.5;
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
DEFINE INDEX IF NOT EXISTS memory_vec_idx ON memory FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;
DEFINE INDEX IF NOT EXISTS memory_category_idx ON memory FIELDS category;

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
DEFINE INDEX IF NOT EXISTS maintenance_runs_job_idx ON maintenance_runs FIELDS job;

-- ============================================================
-- GRAPH EDGES: Turn-level
-- ============================================================
DEFINE TABLE IF NOT EXISTS responds_to TYPE RELATION IN turn OUT turn;
DEFINE TABLE IF NOT EXISTS tool_result_of TYPE RELATION IN turn OUT turn;
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
DEFINE TABLE OVERWRITE derived_from TYPE RELATION IN concept|subagent OUT task|artifact;
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
DEFINE TABLE IF NOT EXISTS supersedes TYPE RELATION IN memory OUT concept|memory;

-- Cross-pillar links
DEFINE TABLE IF NOT EXISTS about_concept TYPE RELATION IN memory OUT concept;
DEFINE TABLE IF NOT EXISTS artifact_mentions TYPE RELATION IN artifact OUT concept;

-- ============================================================
-- RETRIEVAL QUALITY TRACKING
-- ============================================================
-- Each record captures one retrieval event and its outcome signals
DEFINE TABLE IF NOT EXISTS retrieval_outcome SCHEMALESS;
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
DEFINE FIELD IF NOT EXISTS llm_relevant ON retrieval_outcome TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS llm_reason ON retrieval_outcome TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON retrieval_outcome TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS ro_session_idx ON retrieval_outcome FIELDS session_id;
DEFINE INDEX IF NOT EXISTS ro_memory_idx ON retrieval_outcome FIELDS memory_id;
DEFINE INDEX IF NOT EXISTS ro_turn_idx ON retrieval_outcome FIELDS turn_id;

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

-- ============================================================
-- ISMAR-GENT: Daily Rollup of Orchestrator Metrics (0.5.0+)
-- One row per day. Populated by maintenance pass; query for trend reports.
-- Retention: orchestrator_metrics raw rows pruned after 30d; daily kept forever.
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
DEFINE FIELD IF NOT EXISTS memory_id ON memory_utility_cache TYPE string;
DEFINE FIELD IF NOT EXISTS avg_utilization ON memory_utility_cache TYPE float;
DEFINE FIELD IF NOT EXISTS retrieval_count ON memory_utility_cache TYPE int;
DEFINE FIELD IF NOT EXISTS last_updated ON memory_utility_cache TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS muc_mid_idx ON memory_utility_cache FIELDS memory_id UNIQUE;

-- ============================================================
-- MEMORY SUBSTRATE: Turn Archive (cold storage for old turns)
-- ============================================================
DEFINE TABLE IF NOT EXISTS turn_archive SCHEMALESS;

-- Summarizes edge
DEFINE TABLE IF NOT EXISTS summarizes TYPE RELATION;

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
DEFINE INDEX IF NOT EXISTS cc_session_idx ON causal_chain FIELDS session_id;
DEFINE INDEX IF NOT EXISTS cc_confidence_idx ON causal_chain FIELDS confidence;

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
DEFINE FIELD IF NOT EXISTS active ON skill TYPE bool DEFAULT true;
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
DEFINE FIELD IF NOT EXISTS session_id ON reflection TYPE string;
DEFINE FIELD IF NOT EXISTS text ON reflection TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON reflection TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS category ON reflection TYPE string DEFAULT "efficiency"; -- failure_pattern | efficiency | approach_strategy
DEFINE FIELD IF NOT EXISTS severity ON reflection TYPE string DEFAULT "minor"; -- minor | moderate | critical
DEFINE FIELD IF NOT EXISTS importance ON reflection TYPE float DEFAULT 7.0;
DEFINE FIELD IF NOT EXISTS access_count ON reflection TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at ON reflection TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS reflection_vec_idx ON reflection FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

DEFINE TABLE IF NOT EXISTS reflects_on TYPE RELATION IN reflection OUT session;

-- ============================================================
-- SUBAGENT: Tracking spawned subagents
-- ============================================================
DEFINE TABLE IF NOT EXISTS subagent SCHEMALESS;
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
DEFINE FIELD IF NOT EXISTS created_at ON subagent TYPE datetime DEFAULT time::now();
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
DEFINE INDEX IF NOT EXISTS monologue_session ON monologue FIELDS session_id;
DEFINE INDEX IF NOT EXISTS monologue_category ON monologue FIELDS category;
DEFINE INDEX IF NOT EXISTS monologue_vec_idx ON monologue FIELDS embedding HNSW DIMENSION 1024 DIST COSINE;

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
DEFINE FIELD IF NOT EXISTS status ON pending_work TYPE string DEFAULT "pending";
DEFINE FIELD IF NOT EXISTS priority ON pending_work TYPE int DEFAULT 5;
DEFINE FIELD IF NOT EXISTS created_at ON pending_work TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS completed_at ON pending_work TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS pw_status_idx ON pending_work FIELDS status, priority;

-- ============================================================
-- EMBEDDING CACHE: Persistent L2 cache surviving daemon restarts
-- ============================================================
DEFINE TABLE IF NOT EXISTS embedding_cache SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS text_hash ON embedding_cache TYPE string;
DEFINE FIELD IF NOT EXISTS embedding ON embedding_cache TYPE array;
DEFINE FIELD IF NOT EXISTS model_version ON embedding_cache TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON embedding_cache TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS idx_ec_text_hash ON embedding_cache FIELDS text_hash UNIQUE;

-- ============================================================
-- MIGRATIONS (must run after table definitions)
-- ============================================================
-- 768d → 1024d migration completed; REMOVE INDEX / UPDATE stale
-- embeddings removed to avoid destroying live HNSW indexes on
-- every startup.
