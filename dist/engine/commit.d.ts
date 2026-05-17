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
    /** Opt-in cosine-similarity dedup threshold against existing reflections.
     *  v0.7.93: dedup is now OFF by default (per the "nothing should be
     *  deleted" append-only rule). Pass a number (e.g. 0.85) to opt into
     *  silently dropping the incoming write when an active same-category
     *  reflection exists with cosine > threshold. undefined/null = disabled. */
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
export interface CommitSkillData {
    kind: "skill";
    name: string;
    description: string;
    /** Step list. Permissive shape covers all three current writers:
     *    - memory-daemon writes `string[]` from extraction.
     *    - workspace-migrate writes `string[]` from markdown parsing.
     *    - pending-work normalizes to `{tool, description}` shape via
     *      `coerceSkill` before this layer ever sees it.
     *  No normalization in commitSkill; downstream readers handle both. */
    steps: (string | {
        tool?: string;
        description?: string;
        argsPattern?: string;
    })[];
    preconditions?: string;
    postconditions?: string;
    /** Override the default `${name}: ${description}` embed target. Three
     *  current writers use three different embed strings; preserved here via
     *  this field rather than forced-unifying at the API boundary. */
    embeddingText?: string;
    precomputedVec?: number[] | null;
    /** Task record id. When set, auto-seals `skill_from_task`. */
    taskId?: string;
    /** Pre-resolved concept ids to wire `skill_uses_concept` against. When
     *  empty/absent, linkToRelevantConcepts runs a similarity scan against
     *  the skill description (preserves memory-daemon's existing behavior). */
    conceptIds?: string[];
    linkFromTask?: boolean;
    linkUsesConcepts?: boolean;
    /** Call supersedeOldSkills(skillId, embedding) to mark prior similar
     *  skills as superseded. Field-on-row, not edge. */
    supersede?: boolean;
    sessionId?: string;
    projectId?: string;
    /** SCHEMALESS fields written by individual callers (e.g. memory-daemon's
     *  `content` / `trigger_context` / `tags` / `session_id`; pending-work's
     *  `confidence`; workspace-migrate's `source` / `source_path`
     *  / `full_content`). Merged into the CREATE record. */
    extras?: Record<string, unknown>;
}
export interface CommitCorrectionData {
    kind: "correction";
    /** The new (correct) text. Stored as the memory's text and used as the
     *  default embedding target. */
    text: string;
    /** Memory importance (1-10). */
    importance: number;
    /** Session id (kc_session_id UUID) owning the correction memory. */
    sessionId: string;
    /** Direct record id of the supersession target. Skips cosine resolution.
     *  Kind inferred from the record-id prefix (`memory:xxx` → memory,
     *  `concept:xxx` → concept) unless oldKind is set. */
    oldId?: string;
    /** Text describing the OLD (incorrect) belief. commitCorrection resolves
     *  the best-matching concept and/or memory via cosine similarity against
     *  this text. */
    oldText?: string;
    /** Optional hint when oldId's prefix is ambiguous or oldText resolution
     *  should be restricted to one kind. */
    oldKind?: "concept" | "memory";
    /** Override the default embed target (which is `text`). Used when the
     *  stored text has prefixes/rationale that dilute embedding quality for
     *  short query matching. */
    embeddingText?: string;
    projectId?: string;
    precomputedVec?: number[] | null;
    /** Optional turn id for trace provenance. Stored as part of the memory's
     *  category if set. */
    sourceTurnId?: string;
    /** Auto-seal `supersedes` edge to the resolved target. Default true.
     *  When false, commitCorrection just writes the memory and skips
     *  resolution + decay. */
    linkSupersedes?: boolean;
    /** Run stability decay on the target (concept) or status flip (memory).
     *  Default true. */
    runDecay?: boolean;
    /** Pass through to commitMemory's linkConcepts knob (about_concept
     *  similarity scan against the correction text). Default true. */
    linkConcepts?: boolean;
}
export type CommitData = CommitConceptData | CommitMemoryData | CommitArtifactData | CommitReflectionData | CommitSubagentData | CommitSkillData | CommitCorrectionData;
export interface CommitResult {
    /** The record ID written (e.g. "concept:abc123"). */
    id: string;
    /** Number of auto-seal edges created for this write. Observable for verification. */
    edges: number;
    /** v0.7.80: ids of concepts/memories superseded by this correction write.
     *  Only populated by commitKnowledge({ kind: "correction" }); undefined for
     *  other kinds. */
    supersededIds?: string[];
    /** v0.7.80: decay applied per superseded target. Only populated for
     *  correction writes. For concepts, records stability transition; for
     *  memories, records status flip (oldStability=1.0, newStability=0.0). */
    decayApplied?: Array<{
        id: string;
        oldStability: number;
        newStability: number;
    }>;
}
export declare function commitKnowledge(deps: CommitDeps, data: CommitData): Promise<CommitResult>;
/**
 * Auto-seal the concept→project (`relevant_to`) or artifact→project
 * (`used_in`) edge for a freshly-written or existing row.
 *
 * SurrealQL has no UNIQUE on `relevant_to` or `used_in`, and `store.relate()`
 * is a bare RELATE with no idempotency guard. On this workstation pre-v0.7.78
 * the top duplicate count was 139 edges on a single (concept, project) pair
 * because a hand-wired writer hit the same source-project pair every turn.
 * Pre-check via SELECT before RELATE collapses the writer's intent to "at
 * most one edge per (source, project) pair from this code path." It does
 * NOT clean up existing duplicates — that's a separate migration.
 *
 * Returns the number of edges added (0 if already present or on error,
 * 1 if newly written) so callers can compose with `edges +=`.
 */
/**
 * Auto-seal an explicit concept→concept cross-link edge (broader / narrower
 * / related_to). v0.7.81 added so the create_knowledge_gems flow at
 * `pending-work.ts:linkConceptCrossLink` (gem cross-links between concepts
 * created in the same call) can route through a canonical helper instead of
 * hand-wiring store.relate directly. The edge is gated by the
 * `VALID_GEM_EDGES` whitelist so callers can't accidentally write a
 * non-concept-to-concept edge name. Returns 1 on success, 0 on failure or
 * invalid edge.
 */
export declare function linkConceptCrossLink(deps: CommitDeps, fromId: string, toId: string, edge: "broader" | "narrower" | "related_to"): Promise<number>;
