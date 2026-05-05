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
}
export type CommitData = CommitConceptData | CommitMemoryData | CommitArtifactData;
export interface CommitResult {
    /** The record ID written (e.g. "concept:abc123"). */
    id: string;
    /** Number of auto-seal edges created for this write. Observable for verification. */
    edges: number;
}
export declare function commitKnowledge(deps: CommitDeps, data: CommitData): Promise<CommitResult>;
