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

// Future kinds will extend this union:
// | CommitSkillData
// | CommitMonologueData
// | CommitCorrectionData
// | CommitPreferenceData
// | CommitDecisionData
export type CommitData = CommitConceptData | CommitMemoryData | CommitArtifactData | CommitReflectionData | CommitSubagentData;

export interface CommitResult {
  /** The record ID written (e.g. "concept:abc123"). */
  id: string;
  /** Number of auto-seal edges created for this write. Observable for verification. */
  edges: number;
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
    const existing = await store.queryFirst<{ id: string }>(
      `SELECT id FROM ${edgeTable} WHERE in = $sid AND out = $pid LIMIT 1`,
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

  // 1. Embed the name (or reuse caller's vec).
  let embedding: number[] | null = data.precomputedVec ?? null;
  if (!embedding && embeddings.isAvailable()) {
    try { embedding = await embeddings.embed(data.name); }
    catch (e) { swallow(`${logTag}:embed`, e); }
  }

  // 2. Upsert the concept row (provenance passed through when supplied).
  const conceptId = await store.upsertConcept(data.name, embedding, data.source, data.provenance, data.projectId);
  let edges = 0;

  // 3. Link source → concept via the requested edge, if caller provided one.
  if (data.sourceId && data.edgeName) {
    try {
      await store.relate(data.sourceId, data.edgeName, conceptId);
      edges++;
    } catch (e) {
      swallow.warn(`${logTag}:relate`, e);
    }
  }

  // 4. Auto-seal: concept → other concepts (narrower/broader hierarchy).
  if (data.linkHierarchy !== false) {
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
  if (data.linkRelated !== false && embedding && embedding.length > 0) {
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
    catch (e) { swallow(`${logTag}:embed`, e); }
  }

  // 2. Insert the memory row. createMemory signature is
  //    (text, embedding, importance, category, sessionId?).
  const memoryId = await store.createMemory(
    data.text,
    embedding,
    data.importance,
    data.category,
    data.sessionId,
    data.projectId,
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
    catch (e) { swallow(`${logTag}:embed`, e); }
  }

  // Insert the artifact row.
  const artifactId = await store.createArtifact(
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
  if (artifactId && data.linkConcepts !== false && embedding && embedding.length > 0) {
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
    catch (e) { swallow(`${logTag}:embed`, e); }
  }

  // 3. Cosine-similarity dedup. undefined → 0.85 (matches pre-v0.7.76).
  //    null → disable.
  const threshold = data.dedupCosineThreshold === undefined ? 0.85 : data.dedupCosineThreshold;
  if (threshold !== null && embedding?.length) {
    const existing = await store.queryFirst<{ score: number }>(
      `SELECT vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection WHERE embedding != NONE
       ORDER BY score DESC LIMIT 1`,
      { vec: embedding },
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
    const target = data.taskId ?? data.surrealSessionId;
    // The v0.7.74 fallback: when taskId is unset we anchor derived_from
    // to the session row, using a distinct swallow tag so production log
    // alerts keying on 'derived_from_session_fallback' still fire.
    const tag = data.taskId ? `${logTag}:derived_from` : `${logTag}:derived_from_session_fallback`;
    try {
      await store.relate(subagentId, "derived_from", target);
      edges++;
    } catch (e) { swallow.warn(tag, e); }
  }

  return { id: subagentId, edges };
}
