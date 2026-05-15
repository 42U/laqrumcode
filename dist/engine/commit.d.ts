/**
 * commitKnowledge — the single write path.
 *
 * Every graph write (concepts, memories, artifacts, skills, reflections, etc.)
 * should go through this function. It wraps the row insert with the full
 * set of auto-sealing edges, so callers can't accidentally skip linking.
 *
 * Before this existed, write paths did their own linking (the dormant
 * memory-daemon.ts did it thoroughly; newer paths like pending-work.ts:527
 * partially bypassed the linking helpers, leaving concepts unlinked). That
 * was the root cause of the "substrate doesn't auto-seal" problem in 0.3.x.
 *
 * 0.4.0 kicks off with commitKnowledge handling the "concept" kind only.
 * Additional kinds (memory, artifact, skill, reflection, monologue,
 * correction, preference, decision) come online as their writers are
 * migrated off their bespoke paths.
 */
import type { SurrealStore, ConceptProvenance } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
/**
 * Minimal dependency shape commitKnowledge needs. GlobalPluginState satisfies
 * this structurally, but leaf modules (causal.ts, workspace-migrate.ts, etc.)
 * that only receive raw {store, embeddings} can call us without plumbing a
 * full state through.
 */
export interface CommitDeps {
    store: SurrealStore;
    embeddings: EmbeddingService;
}
export interface CommitConceptData {
    kind: "concept";
    /** The concept label (also used as the embedding target). */
    name: string;
    /** Optional source node asserting this concept (turn:xxx, memory:xxx, artifact:xxx). */
    sourceId?: string;
    /** Edge type from sourceId to the concept. Required if sourceId set. */
    edgeName?: string;
    /** Tag passed to upsertConcept as `source` — used in provenance. */
    source?: string;
    /** Rich provenance (session_id, source_kind, skill_name). Preserved across migration. */
    provenance?: ConceptProvenance;
    /** Run linkConceptHierarchy (broader/narrower) — default true. */
    linkHierarchy?: boolean;
    /** Run linkToRelevantConcepts against other concepts — default true. */
    linkRelated?: boolean;
    /** Auto-seal `relevant_to` edge (concept → project) when projectId is set.
     *  Default true. Set false to opt out (e.g. for tests, or to retrofit an
     *  existing concept without writing the project edge). */
    linkProject?: boolean;
    /** Outgoing `derived_from` edge target (task | artifact | session record id
     *  per the schema's widened OUT type at schema.surql:209). When set,
     *  auto-seals `concept → derived_from → derivedFromTargetId`. Distinct from
     *  sourceId+edgeName which wires an INCOMING edge (source → concept).
     *  v0.7.78 added so concept-extract.ts and the gem flow can stop hand-wiring
     *  this edge after commitKnowledge returns. */
    derivedFromTargetId?: string;
    /** Precomputed embedding vector. Skip embed() if provided. */
    precomputedVec?: number[] | null;
    /** 0.7.26: project this concept belongs to (denormalized for fast retrieval
     *  filter). Caller passes session.projectId. NONE-on-write means cross-
     *  project visibility under the soft filter. */
    projectId?: string;
}
export interface CommitMemoryData {
    kind: "memory";
    /** The memory text (also used as the embedding target unless embeddingText is set). */
    text: string;
    /** Optional shorter text to embed instead of `text`. Use when the stored text
     *  has prefixes/rationale that dilute embedding quality for short query matching. */
    embeddingText?: string;
    /** Graph importance (1-10). */
    importance: number;
    /** Category label (e.g. "correction", "preference", "decision", "causal_trigger_debug"). */
    category: string;
    /** Session owning this memory. */
    sessionId?: string;
    /** Run linkToRelevantConcepts via `about_concept` edge — default true. */
    linkConcepts?: boolean;
    /** Precomputed embedding vector. Skip embed() if provided. */
    precomputedVec?: number[] | null;
    /** 0.7.26: project scope — see CommitConceptData.projectId. */
    projectId?: string;
}
export interface CommitArtifactData {
    kind: "artifact";
    /** Path or identifier of the artifact (file path, URL, etc). */
    path: string;
    /** Kind tag — e.g. "file", "created", "modified", "read", "discussed". */
    type: string;
    /** Short description — used as the embedding target. */
    description: string;
    /** Run linkToRelevantConcepts via `artifact_mentions` edge — default true. */
    linkConcepts?: boolean;
    /** Precomputed embedding vector. Skip embed() if provided. */
    precomputedVec?: number[] | null;
    /** 0.7.26: project scope — see CommitConceptData.projectId. */
    projectId?: string;
    /** Auto-seal `used_in` edge (artifact → project) when projectId is set.
     *  Default true. */
    linkProject?: boolean;
}
export interface CommitReflectionData {
    kind: "reflection";
    /** The reflection text. Stored payload AND embedding target. */
    text: string;
    /** kc_session_id UUID. Written to reflection.session_id column. */
    sessionId: string;
    /** SurrealDB Thing record id (e.g. "session:abc123") for the session row.
     *  REQUIRED: the reflects_on edge cannot be sealed without it. If a caller
     *  cannot supply this, commitReflection refuses the write rather than
     *  silently producing an orphan row. This is the architectural anchor that
     *  makes orphan reflection writes impossible at the API boundary, closing
     *  the bug class fixed in v0.7.73-v0.7.74. */
    surrealSessionId: string;
    /** Schema categories: "failure_pattern" | "efficiency" | "approach_strategy".
     *  Live data also uses "session_review". Falls through to schema DEFAULT
     *  ("efficiency") when omitted. */
    category?: string;
    /** "minor" | "moderate" | "critical". Falls through to schema DEFAULT
     *  ("minor") when omitted. */
    severity?: string;
    /** 1-10. Schema DEFAULT is 7.0 when omitted. */
    importance?: number;
    /** Precomputed embedding vector. Skip embed() if provided. */
    precomputedVec?: number[] | null;
    /** SCHEMALESS shadow column (no DEFINE FIELD on reflection.project_id
     *  yet; formalisation deferred to a later release). */
    projectId?: string;
    /** Run the v0.7.73 content filter: anti-thoroughness DROP +
     *  save-summary/work-completion DOWNGRADE (importance=3, no embedding).
     *  Default true. Setting false bypasses the filter (tests, migrations). */
    applyContentFilter?: boolean;
    /** Cosine-similarity dedup threshold against existing reflections.
     *  undefined → 0.85 (matches pre-v0.7.76 commitReflection). Set null to
     *  disable dedup entirely. */
    dedupCosineThreshold?: number | null;
}
export interface CommitSubagentData {
    kind: "subagent";
    /** kc_session_id UUID of the spawning session. Written to
     *  subagent.parent_session_id. NOT the SurrealDB Thing record id —
     *  that goes in surrealSessionId below. */
    parent_session_id: string;
    /** SurrealDB Thing record id (e.g. "session:abc123"). Used as IN for
     *  `spawned`, OUT for `spawned_from`, and the fallback OUT for
     *  `derived_from` when taskId is unset. REQUIRED: without it, none of
     *  the three edges can be sealed and v0.7.74's provenance guarantee is
     *  lost. */
    surrealSessionId: string;
    /** Natural key for upsert dedup. UNIQUE-indexed at schema.surql:668.
     *  REQUIRED because the schema UNIQUE collapses NONE values into one
     *  bucket — a second NONE-key CREATE collides. */
    correlation_key: string;
    /** Second UNIQUE-indexed natural key at schema.surql:669. ASSERT
     *  non-empty when set. REQUIRED for the same reason as correlation_key.
     *  Round-2 caller contract: PreToolUse sets run_id = correlation_key as
     *  a placeholder when the real run_id isn't yet known; SubagentStop
     *  overwrites it later via UPDATE. */
    run_id: string;
    child_session_id?: string;
    /** "full" | "incognito" | "unset". Schema OVERWRITE relaxed to option
     *  in v0.7.23 because PreToolUse creates rows before mode is known. */
    mode?: string;
    /** Free-text task description. Schema OVERWRITE relaxed in v0.7.33. */
    task?: string;
    /** "running" | "completed" | "error". Schema DEFAULT "running". */
    status?: string;
    description?: string;
    incognito_id?: string;
    summary?: string;
    /** Subagent execution outcome at CREATE time (e.g. "in_progress"). The
     *  same field is overwritten on SubagentStop; commitKnowledge only
     *  handles the CREATE path. */
    outcome?: string;
    agent_type?: string;
    prompt_preview?: string;
    parent_session_key?: string;
    child_session_key?: string;
    label?: string;
    prompt_length?: number;
    tool_call_count?: number;
    /** SurrealDB Thing record id of the parent task. When defined,
     *  derived_from is sealed to taskId. When undefined, derived_from
     *  falls back to surrealSessionId — the v0.7.74 fallback baked into
     *  the type signature so future callers can't accidentally omit it. */
    taskId?: string;
    /** Auto-seal `spawned` edge (session → subagent). Default true. */
    linkSpawned?: boolean;
    /** Auto-seal `spawned_from` edge (subagent → session). Default true. */
    linkSpawnedFrom?: boolean;
    /** Auto-seal `derived_from` edge with task-or-session fallback.
     *  Default true. */
    linkDerivedFrom?: boolean;
}
export type CommitData = CommitConceptData | CommitMemoryData | CommitArtifactData | CommitReflectionData | CommitSubagentData;
export interface CommitResult {
    /** The record ID written (e.g. "concept:abc123"). */
    id: string;
    /** Number of auto-seal edges created for this write. Observable for verification. */
    edges: number;
}
export declare function commitKnowledge(deps: CommitDeps, data: CommitData): Promise<CommitResult>;
