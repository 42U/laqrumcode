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
import {
  linkToRelevantConcepts,
  linkConceptHierarchy,
} from "./concept-links.js";
import { swallow, isUniqueViolation } from "./errors.js";
import { log } from "./log.js";
import { classifyReflection } from "./reflection-filter.js";
import { supersedeOldSkills } from "./skills.js";

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

// ── Payload shapes (discriminated union) ──────────────────────────────────

export interface CommitConceptData {
  kind: "concept";
  /** The concept label (also used as the embedding target unless embeddingTarget is set). */
  name: string;
  /** R12/K16: optional richer embed target (e.g. the daemon's
   *  `${content} ${searchTerms}`). When set, this is embedded instead of `name`
   *  and persisted on the row (when it diverges from name) so
   *  backfillConceptEmbeddings can reproduce the same vector on a heal.
   *  Mirrors CommitMemoryData.embeddingText (K51). */
  embeddingTarget?: string;
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

  // ── Required ───────────────────────────────────────────────────────────
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

  // ── Optional core fields ───────────────────────────────────────────────
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

  // ── Optional v0.7.74 typed extras (flat, not nested) ───────────────────
  agent_type?: string;
  prompt_preview?: string;
  parent_session_key?: string;
  child_session_key?: string;
  label?: string;
  prompt_length?: number;
  tool_call_count?: number;

  // ── Provenance ─────────────────────────────────────────────────────────
  /** SurrealDB Thing record id of the parent task. When defined,
   *  derived_from is sealed to taskId. When undefined, derived_from
   *  falls back to surrealSessionId — the v0.7.74 fallback baked into
   *  the type signature so future callers can't accidentally omit it. */
  taskId?: string;

  // ── Linking knobs ──────────────────────────────────────────────────────
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

  // ── Required ───────────────────────────────────────────────────────────
  name: string;
  description: string;
  /** Step list. Permissive shape covers all three current writers:
   *    - memory-daemon writes `string[]` from extraction.
   *    - workspace-migrate writes `string[]` from markdown parsing.
   *    - pending-work normalizes to `{tool, description}` shape via
   *      `coerceSkill` before this layer ever sees it.
   *  No normalization in commitSkill; downstream readers handle both. */
  steps: (string | { tool?: string; description?: string; argsPattern?: string })[];

  // ── Optional core fields ───────────────────────────────────────────────
  preconditions?: string;
  postconditions?: string;
  /** Default true. When false, skip the creation-time semantic-dedup pre-check
   *  (used by migration/import and by tests that intentionally seed near-dup
   *  skill rows). Production graduation/extraction leaves it on so a recurring
   *  pattern reuses the existing canonical instead of minting a redundant row. */
  dedupOnCreate?: boolean;
  /** Full markdown body. When set, `get_skill_body` returns this verbatim.
   *  Manual writes (create_skill tool, migration-from-md) populate this.
   *  Auto-gen writers (causal_graduate, v0.7.96) should stitch a body from
   *  steps + trigger so get_skill_body returns substantive markdown rather
   *  than a thin steps[] dump. */
  body?: string;
  /** Provenance tag — distinguishes auto-gen from manual at query time.
   *  Conventional values: "create_skill_v091" (manual API), "migration-from-md"
   *  (one-time SKILL.md migration), "causal_graduate" (auto-gen from session
   *  traces), "manual-revision-<date>" (in-place updates via raw SurrealQL). */
  source?: string;

  // ── Embedding controls ─────────────────────────────────────────────────
  /** Override the default `${name}: ${description}` embed target. Three
   *  current writers use three different embed strings; preserved here via
   *  this field rather than forced-unifying at the API boundary. */
  embeddingText?: string;
  precomputedVec?: number[] | null;

  // ── Edge seeding ───────────────────────────────────────────────────────
  /** Task record id. When set, auto-seals `skill_from_task`. */
  taskId?: string;
  /** Pre-resolved concept ids to wire `skill_uses_concept` against. When
   *  empty/absent, linkToRelevantConcepts runs a similarity scan against
   *  the skill description (preserves memory-daemon's existing behavior). */
  conceptIds?: string[];

  // ── Linking knobs (default true) ───────────────────────────────────────
  linkFromTask?: boolean;
  linkUsesConcepts?: boolean;
  /** Call supersedeOldSkills(skillId, embedding) to mark prior similar
   *  skills as superseded. Field-on-row, not edge. */
  supersede?: boolean;

  // ── Scope ──────────────────────────────────────────────────────────────
  sessionId?: string;
  projectId?: string;

  // ── Escape hatch ───────────────────────────────────────────────────────
  /** SCHEMALESS fields written by individual callers (e.g. memory-daemon's
   *  `content` / `trigger_context` / `tags` / `session_id`; pending-work's
   *  `confidence`; workspace-migrate's `source` / `source_path`
   *  / `full_content`). Merged into the CREATE record. */
  extras?: Record<string, unknown>;
}

export interface CommitCorrectionData {
  kind: "correction";

  // ── Required ───────────────────────────────────────────────────────────
  /** The new (correct) text. Stored as the memory's text and used as the
   *  default embedding target. */
  text: string;
  /** Memory importance (1-10). */
  importance: number;
  /** Session id (kc_session_id UUID) owning the correction memory. */
  sessionId: string;

  // ── Target (exactly one of oldId | oldText when linkSupersedes !== false)
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

  // ── Optional ───────────────────────────────────────────────────────────
  /** Override the default embed target (which is `text`). Used when the
   *  stored text has prefixes/rationale that dilute embedding quality for
   *  short query matching. */
  embeddingText?: string;
  projectId?: string;
  precomputedVec?: number[] | null;
  /** Optional turn id for trace provenance. Stored as part of the memory's
   *  category if set. */
  sourceTurnId?: string;

  // ── Linking knobs (default true) ───────────────────────────────────────
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

// Future kinds will extend this union:
// | CommitMonologueData
// | CommitPreferenceData
// | CommitDecisionData
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
  decayApplied?: Array<{ id: string; oldStability: number; newStability: number }>;
  /** v0.7.115: candidates that crossed the similarity threshold but were
   *  excluded by the long-body collateral guard. Surfaced so callers can
   *  verify the guard didn't skip a legitimate target (dry-run-lite). */
  skippedByGuard?: Array<{ id: string; kind: "concept" | "memory"; score: number; reason: string }>;
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function commitKnowledge(
  deps: CommitDeps,
  data: CommitData,
): Promise<CommitResult> {
  switch (data.kind) {
    case "concept":
      return commitConcept(deps, data);
    case "memory":
      return commitMemory(deps, data);
    case "artifact":
      return commitArtifact(deps, data);
    case "reflection":
      return commitReflection(deps, data);
    case "subagent":
      return commitSubagent(deps, data);
    case "skill":
      return commitSkill(deps, data);
    case "correction":
      return commitCorrection(deps, data);
    default: {
      // Exhaustiveness check — new kinds must add a case here.
      const _exhaustive: never = data;
      throw new Error(`commitKnowledge: unsupported kind ${String((_exhaustive as { kind: string }).kind)}`);
    }
  }
}

// ── Per-kind implementations ──────────────────────────────────────────────

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
export async function linkConceptCrossLink(
  deps: CommitDeps,
  fromId: string,
  toId: string,
  edge: "broader" | "narrower" | "related_to",
): Promise<number> {
  const { store } = deps;
  if (edge !== "broader" && edge !== "narrower" && edge !== "related_to") {
    swallow.warn("commit:linkConceptCrossLink:invalid-edge", new Error(`unsupported edge "${edge}"`));
    return 0;
  }
  // 0.7.118 (QA item 4): gem links can resolve both names to the same concept
  // after >0.92 dedup folding; relate() refuses the self-loop, so counting it
  // as a wired edge over-reported. Skip before the exists-query.
  if (fromId === toId) return 0;
  try {
    // Idempotency guard (2026-06-09, gems-retry double-write trap): RELATE
    // creates a NEW edge row every call, so a client retry of
    // create_knowledge_gems (e.g. after an RPC timeout whose server side
    // actually succeeded) duplicated every cross-link. Endpoints MUST be
    // wrapped with type::record() — string bindings never match record
    // values (the linkToProject guard below had exactly that bug and never
    // matched, which is why its "dedup pre-check" silently grew duplicates).
    const existing = await store.queryFirst<{ id: string }>(
      `SELECT id FROM ${edge} WHERE in = type::record($f) AND out = type::record($t) LIMIT 1`,
      { f: fromId, t: toId },
    );
    if (existing[0]?.id) return 1; // edge already present — idempotent success
    await store.relate(fromId, edge, toId);
    return 1;
  } catch (e) {
    swallow.warn("commit:linkConceptCrossLink:relate", e);
    return 0;
  }
}

async function linkToProject(
  deps: CommitDeps,
  sourceId: string,
  sourceKind: "concept" | "artifact",
  projectId: string,
): Promise<number> {
  const { store } = deps;
  const edgeTable = sourceKind === "concept" ? "relevant_to" : "used_in";
  const logTag = `commit:linkToProject:${sourceKind}`;
  try {
    // 2026-06-09: type::record() wrap — the previous bare string bindings
    // never matched record values, so this dedup pre-check was a silent no-op
    // and every re-link grew a duplicate relevant_to/used_in edge.
    const existing = await store.queryFirst<{ id: string }>(
      `SELECT id FROM ${edgeTable} WHERE in = type::record($sid) AND out = type::record($pid) LIMIT 1`,
      { sid: sourceId, pid: projectId },
    );
    if (existing[0]?.id) return 0;
    await store.relate(sourceId, edgeTable, projectId);
    return 1;
  } catch (e) {
    swallow.warn(`${logTag}:relate`, e);
    return 0;
  }
}

async function commitConcept(
  deps: CommitDeps,
  data: CommitConceptData,
): Promise<CommitResult> {
  const { store, embeddings } = deps;
  const logTag = `commit:concept:${data.source ?? "anon"}`;

  // 1. Embed the target (or reuse caller's vec). R12/K16: when embeddingTarget
  //    is set, embed it (not the bare name) so the create-time vector matches
  //    the daemon's richer `${content} ${searchTerms}` form; the same target is
  //    persisted in step 2 so a heal reproduces it. Mirrors commitMemory's
  //    `embeddingText ?? text` (K51).
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && embeddings.isAvailable()) {
    try { embedding = await embeddings.embed(data.embeddingTarget ?? data.name); }
    catch (e) { swallow.warn(`${logTag}:embed`, e); }
  }

  // 2. Upsert the concept row (provenance + embed target passed through when
  //    supplied). embeddingTarget is persisted only when it diverges from name.
  const { id: conceptId, existed: conceptExisted } = await store.upsertConcept(data.name, embedding, data.source, data.provenance, data.projectId, data.embeddingTarget);
  let edges = 0;

  // 3. Link source → concept via the requested edge, if caller provided one.
  // 0.7.118 (QA item 4): source can dedup-fold into the same concept id —
  // relate() refuses self-loops, so don't count one as a wired edge.
  if (data.sourceId && data.edgeName && data.sourceId !== conceptId) {
    try {
      await store.relate(data.sourceId, data.edgeName, conceptId);
      edges++;
    } catch (e) {
      swallow.warn(`${logTag}:relate`, e);
    }
  }

  // 4. Auto-seal: concept → other concepts (narrower/broader hierarchy).
  // W2-07 gate (2026-06-10): only on FIRST creation. Re-running the link
  // scans on every mention of a recurring concept re-wired identical pairs
  // every turn (the ×4,541-duplicate hot-pair mechanism). New relations for
  // an OLD concept still get discovered symmetrically — when the new
  // neighbor concept is born, ITS scan finds the old one. The UNIQUE
  // (in,out) edge indexes (ensureEdgeIndexes) backstop any residual path.
  if (data.linkHierarchy !== false && !conceptExisted) {
    const before = edges;
    try {
      await linkConceptHierarchy(conceptId, data.name, store, embeddings, logTag, embedding);
      // linkConceptHierarchy writes edges internally; we don't get a count back,
      // so we approximate by marking "hierarchy attempted" — +1 for observability.
      edges += 1;
    } catch (e) {
      swallow(`${logTag}:hierarchy`, e);
      edges = before;
    }
  }

  // 5. Auto-seal: concept → other concepts (related_to by embedding similarity).
  // W2-07 gate: first-creation only — same rationale as step 4.
  if (data.linkRelated !== false && !conceptExisted && embedding && embedding.length > 0) {
    const before = edges;
    try {
      await linkToRelevantConcepts(
        conceptId, "related_to", data.name,
        store, embeddings, logTag,
        5, 0.65, embedding,
      );
      edges += 1;
    } catch (e) {
      swallow(`${logTag}:related`, e);
      edges = before;
    }
  }

  // 6. Auto-seal: concept → project (`relevant_to`). v0.7.78 expansion.
  //    Previously this edge was hand-wired by callers (concept-extract.ts,
  //    memory-daemon.ts, pending-work.ts gem flow); v0.7.78 centralizes it
  //    here so callers can't omit it. Dedup pre-check inside linkToProject.
  if (data.projectId && data.linkProject !== false) {
    edges += await linkToProject(deps, conceptId, "concept", data.projectId);
  }

  // 6b. Auto-seal: concept → task|artifact|session (`derived_from`) when
  //     caller provides derivedFromTargetId. Mirrors the v0.7.74 task-or-
  //     session fallback pattern from CommitSubagentData — the caller
  //     decides which target makes sense for their route. Hand-wired today
  //     in concept-extract.ts:174 (→task) and pending-work.ts gem flow
  //     (→artifact); v0.7.78 collapses both into this auto-seal.
  if (data.derivedFromTargetId) {
    try {
      await store.relate(conceptId, "derived_from", data.derivedFromTargetId);
      edges++;
    } catch (e) {
      swallow.warn(`${logTag}:derived_from`, e);
    }
  }

  // 7. SOFT tightening (v0.7.78): warn when a concept is written with no
  //    sourceId+edgeName AND no projectId. Such concepts are floating
  //    islands — retrievable by vector search but unreachable via the
  //    schema-defined provenance / project paths. The warn is observable
  //    in logs; HARD enforcement (TypeScript discriminated union) is
  //    deferred until the gem migration has shipped one clean release.
  if (!data.sourceId && !data.projectId) {
    log.warn(`${logTag}: orphan_concept created with no provenance (sourceId/edgeName) and no projectId. name="${data.name.slice(0, 80)}"`);
  }

  return { id: conceptId, edges };
}

async function commitMemory(
  deps: CommitDeps,
  data: CommitMemoryData,
): Promise<CommitResult> {
  const { store, embeddings } = deps;
  const logTag = `commit:memory:${data.category}`;

  // 1. Embed the text (or reuse caller's vec). When embeddingText is set,
  //    embed that shorter form for better query matching while storing the
  //    full text in the row. Fixes issue #10: category prefixes and rationale
  //    dilute embedding quality for short keyword queries.
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && embeddings.isAvailable()) {
    try { embedding = await embeddings.embed(data.embeddingText ?? data.text); }
    catch (e) { swallow.warn(`${logTag}:embed`, e); }
  }

  // 2. Insert the memory row. createMemory signature is
  //    (text, embedding, importance, category, sessionId?, projectId?,
  //     embeddingTarget?). K51: pass embeddingText as the persisted embed
  //    target so backfillMemoryEmbeddings can heal an un-embedded row with the
  //    same short target this path used (preserving short-query match quality).
  const memoryId = await store.createMemory(
    data.text,
    embedding,
    data.importance,
    data.category,
    data.sessionId,
    data.projectId,
    data.embeddingText,
  );
  let edges = 0;

  // 3. Auto-seal: memory → concepts (about_concept) by semantic similarity.
  //    Previously this linking was only done inside the dormant memory-daemon;
  //    hot paths like causal.ts created memory nodes that never got
  //    concept edges, leaving them as islands in the graph.
  if (memoryId && data.linkConcepts !== false && embedding && embedding.length > 0) {
    const before = edges;
    try {
      await linkToRelevantConcepts(
        memoryId, "about_concept", data.text,
        store, embeddings, logTag,
        5, 0.65, embedding,
      );
      edges += 1;
    } catch (e) {
      swallow(`${logTag}:about_concept`, e);
      edges = before;
    }
  }

  return { id: memoryId, edges };
}

async function commitArtifact(
  deps: CommitDeps,
  data: CommitArtifactData,
): Promise<CommitResult> {
  const { store, embeddings } = deps;
  const logTag = `commit:artifact:${data.type}`;

  // Embed the description (richer than the path alone for similarity).
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && embeddings.isAvailable()) {
    try { embedding = await embeddings.embed(`${data.path} ${data.description}`); }
    catch (e) { swallow.warn(`${logTag}:embed`, e); }
  }

  // Insert the artifact row.
  const { id: artifactId, existed: artifactExisted } = await store.createArtifact(
    data.path,
    data.type,
    data.description,
    embedding,
    data.projectId,
  );
  let edges = 0;

  // Auto-seal: artifact → concepts (artifact_mentions) by similarity.
  // Previously only the dormant memory-daemon did this for artifact writes;
  // hot-path artifact creation from post-tool-use.ts left artifacts
  // disconnected from the concept graph.
  // W2-09 gate (2026-06-10): first-creation only. createArtifact path-dedups,
  // but the mentions link scan re-ran on EVERY re-commit of the same path
  // (one per Write/Edit hook) — ~150 duplicate artifact_mentions edges for a
  // file edited 30×, plus a wasted embed each time. An existing artifact's
  // description (the link-scan input) is never updated, so re-linking adds
  // nothing the first pass didn't.
  if (artifactId && !artifactExisted && data.linkConcepts !== false && embedding && embedding.length > 0) {
    const before = edges;
    try {
      await linkToRelevantConcepts(
        artifactId, "artifact_mentions", `${data.path} ${data.description}`,
        store, embeddings, logTag,
        5, 0.65, embedding,
      );
      edges += 1;
    } catch (e) {
      swallow(`${logTag}:artifact_mentions`, e);
      edges = before;
    }
  }

  // Auto-seal: artifact → project (`used_in`). v0.7.78 expansion. Mirrors
  // commitConcept's relevant_to wiring; same dedup pre-check inside
  // linkToProject.
  if (artifactId && data.projectId && data.linkProject !== false) {
    edges += await linkToProject(deps, artifactId, "artifact", data.projectId);
  }

  return { id: artifactId, edges };
}

async function commitReflection(
  deps: CommitDeps,
  data: CommitReflectionData,
): Promise<CommitResult> {
  const { store, embeddings } = deps;
  const logTag = `commit:reflection:${data.category ?? "default"}`;

  // 0. Validate: the architectural anchor making orphan reflects_on writes
  //    impossible at the API boundary. surrealSessionId is required by the
  //    interface (no `?`), TypeScript enforces at compile time. Runtime
  //    check is defense-in-depth for JS callers / type erasure paths.
  if (!data.surrealSessionId) {
    throw new Error(
      "commitReflection: surrealSessionId is required; reflects_on edge cannot be sealed without it",
    );
  }

  // 1. Content filter — v0.7.73 regex set, extracted to reflection-filter.ts.
  let importance = data.importance ?? 7.0;
  let allowEmbedding = true;
  if (data.applyContentFilter !== false) {
    const verdict = classifyReflection(data.text);
    if (verdict === "drop") {
      log.warn(`${logTag}: dropped anti-thoroughness reflection: ${data.text.slice(0, 120)}`);
      return { id: "", edges: 0 };
    }
    if (verdict === "downgrade") {
      log.warn(`${logTag}: downgrading audit-log style reflection: ${data.text.slice(0, 120)}`);
      importance = 3.0;
      allowEmbedding = false;
    }
  }

  // 2. Embed text (or reuse precomputedVec). Downgraded rows skip embedding
  //    so they neither rank in retrieval nor compete in dedup.
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && allowEmbedding && embeddings.isAvailable()) {
    try { embedding = await embeddings.embed(data.text); }
    catch (e) { swallow.warn(`${logTag}:embed`, e); }
  }

  // v0.7.93 append-only: was a cosine-≥0.85 silent-discard that dropped the
  // incoming reflection across the WHOLE reflection table (name-blind, no
  // category guard, no session guard). Same family-2 silent-data-loss bug as
  // createMemory's old dedup. Per the founder's "nothing should be deleted"
  // rule, every reflection persists. consolidateMemories Pass 3 (now
  // soft-archiving) collapses duplicates later, audit chain intact.
  // The dedupCosineThreshold option is preserved for callers that opt in
  // explicitly with a non-default value, scoped to same-category active rows.
  if (data.dedupCosineThreshold != null && embedding?.length) {
    const threshold = data.dedupCosineThreshold;
    const existing = await store.queryFirst<{ score: number }>(
      `SELECT vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection
       WHERE embedding != NONE
         AND category = $cat
         AND (active = true OR active IS NONE)
       ORDER BY score DESC LIMIT 1`,
      { vec: embedding, cat: data.category ?? "efficiency" },
    );
    if ((existing[0]?.score ?? 0) > threshold) {
      return { id: "", edges: 0 };
    }
  }

  // 4. CREATE the reflection row.
  const record: Record<string, unknown> = {
    session_id: data.sessionId,
    text: data.text,
    category: data.category ?? "efficiency",
    severity: data.severity ?? "minor",
    importance,
  };
  if (embedding?.length) record.embedding = embedding;
  if (data.projectId) record.project_id = data.projectId;
  const rows = await store.queryFirst<{ id: string }>(
    `CREATE reflection CONTENT $record RETURN id`,
    { record },
  );
  const reflectionId = String(rows[0]?.id ?? "");
  if (!reflectionId) {
    swallow.warn(`${logTag}:create`, new Error("CREATE reflection returned no id"));
    return { id: "", edges: 0 };
  }

  // 5. Auto-seal the reflects_on edge. Failure is logged but doesn't bubble;
  //    the row exists with an observable edges=0 orphan canary in the result.
  let edges = 0;
  try {
    await store.relate(reflectionId, "reflects_on", data.surrealSessionId);
    edges = 1;
  } catch (e) {
    swallow.warn(`${logTag}:reflects_on`, e);
  }

  // 6. Invalidate the reflection cache used by retrieval injection.
  store.clearReflectionCache();

  return { id: reflectionId, edges };
}

async function commitSubagent(
  deps: CommitDeps,
  data: CommitSubagentData,
): Promise<CommitResult> {
  const { store } = deps;
  const logTag = `commit:subagent:${data.agent_type ?? "default"}`;

  // 0. Validate required fields. The architectural anchor that makes
  //    orphan subagent rows + missing provenance impossible at the API
  //    boundary. Without surrealSessionId none of the three edges can be
  //    sealed; without correlation_key / run_id the UNIQUE indexes
  //    collapse multiple NONE values into one bucket and a second CREATE
  //    collides.
  if (!data.parent_session_id) throw new Error("commitSubagent: parent_session_id is required");
  if (!data.surrealSessionId) throw new Error("commitSubagent: surrealSessionId is required");
  if (!data.correlation_key) throw new Error("commitSubagent: correlation_key is required (schema UNIQUE-on-NONE)");
  if (!data.run_id) throw new Error("commitSubagent: run_id is required (schema UNIQUE-on-NONE)");

  // 1. Build CONTENT object, omitting undefined keys so SurrealDB
  //    schema-default and OVERWRITE-relaxed fields aren't shadowed.
  const record: Record<string, unknown> = {
    parent_session_id: data.parent_session_id,
    correlation_key: data.correlation_key,
    run_id: data.run_id,
  };
  if (data.child_session_id !== undefined) record.child_session_id = data.child_session_id;
  if (data.mode !== undefined) record.mode = data.mode;
  if (data.task !== undefined) record.task = data.task;
  if (data.status !== undefined) record.status = data.status;
  if (data.description !== undefined) record.description = data.description;
  if (data.incognito_id !== undefined) record.incognito_id = data.incognito_id;
  if (data.summary !== undefined) record.summary = data.summary;
  if (data.outcome !== undefined) record.outcome = data.outcome;
  if (data.agent_type !== undefined) record.agent_type = data.agent_type;
  if (data.prompt_preview !== undefined) record.prompt_preview = data.prompt_preview;
  if (data.parent_session_key !== undefined) record.parent_session_key = data.parent_session_key;
  if (data.child_session_key !== undefined) record.child_session_key = data.child_session_key;
  if (data.label !== undefined) record.label = data.label;
  if (data.prompt_length !== undefined) record.prompt_length = data.prompt_length;
  if (data.tool_call_count !== undefined) record.tool_call_count = data.tool_call_count;

  // 2. CREATE the subagent row. UNIQUE-violation on correlation_key or
  //    run_id is recoverable: a sibling already exists for this spawn,
  //    return its id with edges=0 (idempotent dedup).
  let subagentId = "";
  try {
    const rows = await store.queryFirst<{ id: string }>(
      `CREATE subagent CONTENT $record RETURN id`,
      { record },
    );
    subagentId = String(rows[0]?.id ?? "");
  } catch (createErr) {
    if (isUniqueViolation(createErr)) {
      const existing = await store.queryFirst<{ id: string }>(
        `SELECT id FROM subagent WHERE correlation_key = $cid OR run_id = $rid LIMIT 1`,
        { cid: data.correlation_key, rid: data.run_id },
      );
      const existingId = String(existing[0]?.id ?? "");
      if (existingId) return { id: existingId, edges: 0 };
    }
    throw createErr;
  }
  if (!subagentId) {
    swallow.warn(`${logTag}:create`, new Error("CREATE subagent returned no id"));
    return { id: "", edges: 0 };
  }

  // 3. Auto-seal edges sequentially. Non-transactional matches existing
  //    pre-tool-use.ts behavior (asymmetric writes are tolerated under
  //    transient DB blips). Each edge has its own swallow tag for
  //    observability.
  let edges = 0;

  if (data.linkSpawned !== false) {
    try {
      await store.relate(data.surrealSessionId, "spawned", subagentId);
      edges++;
    } catch (e) { swallow.warn(`${logTag}:spawned`, e); }
  }

  if (data.linkSpawnedFrom !== false) {
    try {
      await store.relate(subagentId, "spawned_from", data.surrealSessionId);
      edges++;
    } catch (e) { swallow.warn(`${logTag}:spawned_from`, e); }
  }

  if (data.linkDerivedFrom !== false) {
    // v0.7.88 Wave 4 fix: state.taskId defaults to "" (empty string), NOT
    // undefined. The previous `data.taskId ?? data.surrealSessionId` only
    // fell through on null/undefined, so an empty taskId from PreToolUse
    // produced target="" and `store.relate(...,"")` threw "Invalid record
    // ID format:" (empty after colon). The truthy check is required.
    const target = (data.taskId && data.taskId.length > 0)
      ? data.taskId
      : data.surrealSessionId;
    const tag = (data.taskId && data.taskId.length > 0)
      ? `${logTag}:derived_from`
      : `${logTag}:derived_from_session_fallback`;
    // Belt-and-suspenders: if target is somehow still empty (defensive —
    // surrealSessionId is validated non-empty at line 748, but a future
    // refactor could break that invariant), skip the relate entirely
    // instead of throwing the "Invalid record ID format:" noise. The
    // subagent row is still useful without this edge.
    if (target && target.length > 0) {
      try {
        await store.relate(subagentId, "derived_from", target);
        edges++;
      } catch (e) { swallow.warn(tag, e); }
    } else {
      log.debug(`${tag}: target empty, skipping relate (subagentId=${subagentId.slice(-8)})`);
    }
  }

  return { id: subagentId, edges };
}

/** Creation-time semantic-dedup threshold (v0.8.x). An ACTIVE skill within this
 *  cosine of a new one is treated as the same procedure → reuse it instead of
 *  minting a redundant row (this is what stops the corpus re-bloating: the
 *  daemon graduates a new skill for every recurring task and the LLM renames it
 *  each time, so name-exact supersede misses the twin). 0.85 is conservative by
 *  design — a PERMANENT skip — given measured separation (distinct ≤0.66,
 *  redundant ≥0.80) it only blocks near-identical skills and leaves margin
 *  against long-body cosine inflation (the v0.7.92 over-supersede footgun). The
 *  weekly consolidateMemories Pass 4 (0.80, reversible) sweeps the 0.80–0.85 band. */
const SKILL_CREATE_DEDUP = 0.85;

async function commitSkill(
  deps: CommitDeps,
  data: CommitSkillData,
): Promise<CommitResult> {
  const { store, embeddings } = deps;
  const logTag = `commit:skill:${data.name.slice(0, 30)}`;

  // 0. Validate required fields. `steps` must be an array (empty is allowed
  //    because workspace-migrate produces skills from docs that occasionally
  //    have no extractable step list — the row is still useful for retrieval).
  if (!data.name) throw new Error("commitSkill: name is required");
  if (!data.description) throw new Error("commitSkill: description is required");
  if (!Array.isArray(data.steps)) throw new Error("commitSkill: steps must be an array (use [] for skills with no documented steps)");

  // 1. Embed. Default target is `${name}: ${description}`; callers can
  //    override via embeddingText (memory-daemon uses a multi-line content
  //    blob; workspace-migrate uses a different format).
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && embeddings.isAvailable()) {
    try {
      embedding = await embeddings.embed(data.embeddingText ?? `${data.name}: ${data.description}`);
    } catch (e) { swallow.warn(`${logTag}:embed`, e); }
  }

  // 1b. Creation-time semantic dedup. If an ACTIVE skill is already within
  //     SKILL_CREATE_DEDUP cosine, this is the same procedure under new wording
  //     — return that canonical's id instead of creating a redundant row. This
  //     is the source-level guard against re-bloat (the name-exact supersede in
  //     step 6 can't see semantic twins). Skippable via dedupOnCreate:false.
  if (data.dedupOnCreate !== false && embedding?.length && store.isAvailable()) {
    try {
      const near = await store.queryFirst<{ id: string; score: number }>(
        // COSINE_GUARD_OK: read-only pre-check, no destructive op — decides only whether to CREATE; skill namespace has no name/category identity axis to scope by.
        `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
         FROM skill
         WHERE (active = NONE OR active = true) AND embedding != NONE AND array::len(embedding) > 0
         ORDER BY score DESC LIMIT 1`,
        { vec: embedding },
      );
      if (near[0] && (near[0].score ?? 0) >= SKILL_CREATE_DEDUP) {
        return { id: String(near[0].id), edges: 0 };
      }
    } catch (e) { swallow.warn(`${logTag}:createDedup`, e); }
  }

  // 2. Build CREATE record. Schema-default fields (confidence=1.0,
  //    active=true) match what pending-work.ts:createSkillRecord wrote
  //    today. Caller-supplied extras merge in for SCHEMALESS columns
  //    without trampling declared fields.
  const record: Record<string, unknown> = {
    name: data.name,
    description: data.description,
    steps: data.steps,
    confidence: 1.0,
    active: true,
  };
  if (data.preconditions !== undefined) record.preconditions = data.preconditions;
  if (data.postconditions !== undefined) record.postconditions = data.postconditions;
  if (data.body !== undefined) {
    record.body = data.body;
    record.body_len = data.body.length;
  }
  if (data.source !== undefined) record.source = data.source;
  if (embedding?.length) record.embedding = embedding;
  if (data.projectId) record.project_id = data.projectId;
  if (data.extras) {
    for (const [k, v] of Object.entries(data.extras)) {
      if (record[k] === undefined) record[k] = v;
    }
  }

  // 3. CREATE skill.
  const rows = await store.queryFirst<{ id: string }>(
    `CREATE skill CONTENT $record RETURN id`,
    { record },
  );
  const skillId = String(rows[0]?.id ?? "");
  if (!skillId) {
    swallow.warn(`${logTag}:create`, new Error("CREATE skill returned no id"));
    return { id: "", edges: 0 };
  }

  let edges = 0;

  // 4. Auto-seal `skill_from_task` when taskId provided.
  if (data.taskId && data.linkFromTask !== false) {
    try {
      await store.relate(skillId, "skill_from_task", data.taskId);
      edges++;
    } catch (e) { swallow.warn(`${logTag}:skill_from_task`, e); }
  }

  // 5. Auto-seal `skill_uses_concept`. Two paths:
  //    (a) Caller supplies conceptIds — wire each explicitly.
  //    (b) Caller doesn't — fall back to similarity scan via
  //        linkToRelevantConcepts (matches memory-daemon's existing
  //        behavior). pending-work.ts:createSkillRecord currently skips
  //        this entirely; post-migration it starts writing these edges,
  //        which is a deliberate behavior improvement.
  if (data.linkUsesConcepts !== false) {
    if (data.conceptIds?.length) {
      for (const cid of data.conceptIds) {
        try {
          await store.relate(skillId, "skill_uses_concept", cid);
          edges++;
        } catch (e) { swallow.warn(`${logTag}:skill_uses_concept`, e); }
      }
    } else if (embedding?.length) {
      try {
        await linkToRelevantConcepts(
          skillId, "skill_uses_concept", data.description,
          store, embeddings, logTag,
          5, 0.65, embedding,
        );
        edges += 1;
      } catch (e) { swallow.warn(`${logTag}:skill_uses_concept_dynamic`, e); }
    }
  }

  // 6. Supersede prior similar skills (field-on-row, not edge). Same-named
  //    only as of 2026-05-17 — see supersedeOldSkills jsdoc for the bug
  //    that motivated the name guard.
  if (data.supersede !== false && embedding?.length) {
    try {
      await supersedeOldSkills(skillId, data.name, embedding, store);
    } catch (e) { swallow.warn(`${logTag}:supersede`, e); }
  }

  return { id: skillId, edges };
}

// ── Supersede constants (mirror of src/engine/supersedes.ts) ─────────────
/** Minimum cosine similarity to consider a candidate the target of a correction. */
const COMMIT_SUPERSEDE_THRESHOLD = 0.70;
/** Long-body collateral guard (2026-06-09 incident, memory:ety7rj662y98liipw70c):
 *  a short oldText slug appearing VERBATIM inside a healthy long-form concept
 *  inflates cosine past 0.70 (token overlap), so supersede decayed the real
 *  spec gem alongside the stub it targeted. A candidate whose content is more
 *  than LONG_BODY_RATIO× the oldText length is almost certainly a document
 *  that MENTIONS the belief rather than the belief itself — require the
 *  STRICT bar (the same 0.85 the skill-supersede path chose against
 *  "long-body cosine inflation", see supersedeOldSkills) or skip it.
 *  Skipped candidates are reported in CommitResult.skippedByGuard so callers
 *  can verify nothing legitimate was excluded. */
const COMMIT_SUPERSEDE_LONG_BODY_RATIO = 4;
const COMMIT_SUPERSEDE_LONG_BODY_STRICT = 0.85;
/** Multiplicative decay applied to a superseded concept's stability score. */
const COMMIT_STABILITY_DECAY_FACTOR = 0.4;
/** Floor: don't decay below this so the concept remains discoverable. */
const COMMIT_STABILITY_FLOOR = 0.15;

async function commitCorrection(
  deps: CommitDeps,
  data: CommitCorrectionData,
): Promise<CommitResult> {
  const { store, embeddings } = deps;
  const logTag = "commit:correction";

  // 0. Validate.
  if (!data.text) throw new Error("commitCorrection: text is required");
  if (data.importance == null) throw new Error("commitCorrection: importance is required");
  if (!data.sessionId) throw new Error("commitCorrection: sessionId is required");
  if (data.linkSupersedes !== false && !data.oldId && !data.oldText) {
    throw new Error("commitCorrection: oldId or oldText is required when linkSupersedes is true");
  }

  // 1. Write the correction memory via commitMemory. Composes the existing
  //    about_concept auto-seal + project scope + embed.
  const memResult = await commitMemory(deps, {
    kind: "memory",
    text: data.text,
    importance: data.importance,
    category: "correction",
    sessionId: data.sessionId,
    embeddingText: data.embeddingText,
    precomputedVec: data.precomputedVec,
    projectId: data.projectId,
    linkConcepts: data.linkConcepts,
  });
  const memoryId = memResult.id;
  if (!memoryId) {
    return { id: "", edges: 0, supersededIds: [], decayApplied: [] };
  }

  let edges = memResult.edges;
  const supersededIds: string[] = [];
  const decayApplied: Array<{ id: string; oldStability: number; newStability: number }> = [];
  const skippedByGuard: Array<{ id: string; kind: "concept" | "memory"; score: number; reason: string }> = [];

  if (data.linkSupersedes === false) {
    return { id: memoryId, edges, supersededIds, decayApplied, skippedByGuard };
  }

  // 2. Resolve targets. Two paths:
  //    (a) oldId provided → direct, kind inferred from id prefix or oldKind.
  //    (b) oldText provided → cosine match against concept + memory tables.
  //        Resolution runs AFTER memory write but the candidate query
  //        explicitly excludes the correction memory's id, so self-edges
  //        cannot happen by this path. Stage 2 of v0.7.80 also adds a
  //        belt-and-suspenders id-equality check below to handle the 7
  //        existing self-edges' pattern (which had `in == out` historically
  //        for reasons that remain UNCONFIRMED at audit time).
  type ResolvedTarget = { id: string; kind: "concept" | "memory"; stability?: number };
  const targets: ResolvedTarget[] = [];

  if (data.oldId) {
    const inferred: "concept" | "memory" = data.oldId.startsWith("memory:") ? "memory" : "concept";
    targets.push({ id: data.oldId, kind: data.oldKind ?? inferred });
  } else if (data.oldText) {
    try {
      const vec = await embeddings.embed(data.oldText);
      if (vec?.length) {
        const [conceptCandidates, memoryCandidates] = await Promise.all([
          store.queryFirst<{ id: string; score: number; stability: number; content: string }>(
            // COSINE_GUARD_OK: read-only supersede-candidate search; the destructive supersede UPDATE is a separate guarded step downstream.
            `SELECT id, vector::similarity::cosine(embedding, $vec) AS score, stability, content
             FROM concept
             WHERE embedding != NONE AND array::len(embedding) > 0
               AND superseded_at IS NONE
               AND stability > $floor
             ORDER BY score DESC LIMIT 5`,
            { vec, floor: COMMIT_STABILITY_FLOOR },
          ),
          store.queryFirst<{ id: string; score: number; content: string }>(
            // COSINE_GUARD_OK: read-only supersede-candidate search; the destructive supersede UPDATE is a separate guarded step downstream.
            `SELECT id, vector::similarity::cosine(embedding, $vec) AS score, text AS content
             FROM memory
             WHERE embedding != NONE AND array::len(embedding) > 0
               AND (status = 'active' OR status IS NONE)
               AND id != type::record($correctionId)
             ORDER BY score DESC LIMIT 5`,
            { vec, correctionId: memoryId },
          ),
        ]);
        // 2026-06-09 collateral-decay guards (memory:ety7rj662y98liipw70c):
        //  (1) exact-content short-circuit — when any candidate's content IS
        //      the oldText (normalized), target only those: the belief itself
        //      always outranks documents that merely reference it.
        //  (2) long-body ratio guard — a candidate much longer than oldText
        //      that only PARTIALLY matches is a doc mentioning the phrase,
        //      not the stale belief; require the strict bar or skip+report.
        const normalize = (s: string) => s.trim().toLowerCase();
        const oldNorm = normalize(data.oldText);
        const oldLen = Math.max(oldNorm.length, 1);
        type Cand = { id: string; kind: "concept" | "memory"; score: number; stability?: number; content: string };
        const all: Cand[] = [
          ...conceptCandidates.map((c): Cand => ({ id: String(c.id), kind: "concept", score: c.score ?? 0, stability: c.stability, content: String(c.content ?? "") })),
          ...memoryCandidates.map((m): Cand => ({ id: String(m.id), kind: "memory", score: m.score ?? 0, content: String(m.content ?? "") })),
        ];
        const exact = all.filter((c) => normalize(c.content) === oldNorm);
        if (exact.length > 0) {
          for (const c of exact) targets.push({ id: c.id, kind: c.kind, stability: c.stability });
        } else {
          for (const c of all) {
            if (c.score < COMMIT_SUPERSEDE_THRESHOLD) continue;
            const longBody = c.content.trim().length > COMMIT_SUPERSEDE_LONG_BODY_RATIO * oldLen;
            if (longBody && c.score < COMMIT_SUPERSEDE_LONG_BODY_STRICT) {
              skippedByGuard.push({
                id: c.id,
                kind: c.kind,
                score: Number(c.score.toFixed(3)),
                reason: `long-body partial match (content ${c.content.trim().length} chars > ${COMMIT_SUPERSEDE_LONG_BODY_RATIO}x old_text ${oldLen}; score ${c.score.toFixed(3)} < strict ${COMMIT_SUPERSEDE_LONG_BODY_STRICT})`,
              });
              continue;
            }
            targets.push({ id: c.id, kind: c.kind, stability: c.stability });
          }
        }
      }
    } catch (e) {
      swallow.warn(`${logTag}:resolve`, e);
    }
  }

  if (targets.length === 0) {
    swallow.warn(`${logTag}:no_target`, new Error(`oldText="${(data.oldText ?? "").slice(0, 80)}" did not resolve to any concept/memory above threshold ${COMMIT_SUPERSEDE_THRESHOLD}`));
    return { id: memoryId, edges, supersededIds, decayApplied, skippedByGuard };
  }

  // 3. For each target: relate supersedes, decay (if enabled), record.
  for (const target of targets) {
    // Belt-and-suspenders against the 7 historical self-edges. The candidate
    // query already excludes the correction memory id, so this should never
    // fire, but it's cheap insurance.
    if (target.id === memoryId) continue;
    // W2-10 decay-once (2026-06-10): a retried correction (RPC-timeout class)
    // re-related supersedes AND re-applied stability decay multiplicatively
    // (1.0 → 0.4 → 0.16), over-demoting the target. If the edge already
    // exists, the decay already ran — record the id and skip both.
    try {
      const already = await store.queryFirst<{ id: string }>(
        `SELECT id FROM supersedes WHERE in = type::record($m) AND out = type::record($t) LIMIT 1`,
        { m: memoryId, t: target.id },
      );
      if (already[0]?.id) {
        supersededIds.push(target.id);
        continue;
      }
    } catch (e) {
      swallow.warn(`${logTag}:supersedesCheck`, e);
    }
    try {
      const createdEdge = await store.relate(memoryId, "supersedes", target.id);
      edges++;
      supersededIds.push(target.id);
      // Backstop: with the UNIQUE (in,out) index armed, relate() reports
      // existed-as-false — skip decay then too (pre-check raced).
      if (!createdEdge) continue;
    } catch (e) {
      swallow.warn(`${logTag}:relate`, e);
      continue;
    }
    if (data.runDecay !== false) {
      if (target.kind === "concept") {
        const oldStability = target.stability ?? 1.0;
        const newStability = Math.max(COMMIT_STABILITY_FLOOR, oldStability * COMMIT_STABILITY_DECAY_FACTOR);
        try {
          assertRecordIdLocal(target.id);
          assertRecordIdLocal(memoryId);
          await store.queryExec(
            `UPDATE ${target.id} SET stability = $s, superseded_at = time::now(), superseded_by = type::record($cid)`,
            { s: newStability, cid: memoryId },
          );
          decayApplied.push({ id: target.id, oldStability, newStability });
        } catch (e) { swallow.warn(`${logTag}:decay`, e); }
      } else {
        try {
          assertRecordIdLocal(target.id);
          await store.queryExec(
            `UPDATE ${target.id} SET status = 'superseded', resolved_at = time::now(), resolved_by = $cid`,
            { cid: memoryId },
          );
          decayApplied.push({ id: target.id, oldStability: 1.0, newStability: 0.0 });
        } catch (e) { swallow.warn(`${logTag}:decay-memory`, e); }
      }
    }
  }

  return { id: memoryId, edges, supersededIds, decayApplied, skippedByGuard };
}

// Inline assertion to avoid the cross-import; mirrors src/engine/surreal.ts's
// assertRecordId but kept here so commit.ts doesn't acquire a new surreal
// dependency.
function assertRecordIdLocal(id: string): void {
  if (!/^[a-z_][a-z0-9_]*:[a-zA-Z0-9_]+$/i.test(id)) {
    throw new Error(`commitCorrection: invalid record id: ${id}`);
  }
}
