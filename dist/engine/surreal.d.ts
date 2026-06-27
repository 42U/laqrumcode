import type { SurrealConfig } from "./config.js";
/** Record with a vector similarity score from SurrealDB search */
export interface VectorSearchResult {
    id: string;
    text: string;
    score: number;
    role?: string;
    timestamp?: string;
    importance?: number;
    accessCount?: number;
    source?: string;
    sessionId?: string;
    table: string;
    embedding?: number[];
    category?: string;
}
export interface TurnRecord {
    session_id: string;
    role: string;
    text: string;
    embedding: number[] | null;
    token_count?: number;
    tool_name?: string;
    model?: string;
    usage?: Record<string, unknown>;
}
export interface CoreMemoryEntry {
    id: string;
    text: string;
    category: string;
    priority: number;
    tier: number;
    active: boolean;
    session_id?: string;
    created_at?: string;
    updated_at?: string;
}
export interface UtilityCacheEntry {
    avg_utilization: number;
    retrieval_count: number;
}
/** Phase 3: provenance attached to every concept write so drift audit,
 * supersede-stale, and "where did this come from" debugging are possible. */
export interface ConceptProvenance {
    session_id?: string;
    turn_id?: string;
    skill_name?: string;
    prompt_hash?: string;
    source_kind?: "daemon" | "skill" | "user" | "gem" | "synthesis";
}
declare function assertRecordId(id: string): void;
/** K21 — read-time mean for memory_utility_cache rows. The race-free writer
 *  stores commutative accumulators (util_sum, retrieval_count) instead of a
 *  materialized running average; the mean is util_sum/retrieval_count. Legacy
 *  rows written before K21 carry a materialized avg_utilization and util_sum
 *  IS NONE — fall back to that. Returns null when neither is derivable.
 *  Exported for unit tests (test/fix-k21-utility-cache-race.test.ts). */
export declare function utilityMean(row: {
    util_sum?: number | null;
    retrieval_count?: number | null;
    avg_utilization?: number | null;
}): number | null;
/** Whitelist of valid SurrealDB edge table names — prevents SQL injection via edge interpolation. */
declare const VALID_EDGES: Set<string>;
declare function assertValidEdge(edge: string): void;
/** 0.7.118: hard ceiling on any single SDK query round-trip. Generous by
 *  default (60s — only genuine zombies blow it, not slow CPU-tier queries);
 *  env-overridable for constrained machines. Clamped to [1s, 10min]. */
export declare const QUERY_DEADLINE_MS: number;
/** Race a promise against a deadline. The losing arm's rejection is consumed
 *  by the race; the timer is cleared on every exit path. Exported for unit
 *  tests (test/surreal-deadline.test.ts). */
export declare function raceWithDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T>;
/** Errors worth one reconnect+retry (0.7.118 widened from connection-drop
 *  only). Three production-observed classes on 2026-06-10:
 *  - connection drop: "must be connected" / "ConnectionUnavailable"
 *  - blown deadline: zombie WS whose queries never settle (no error event)
 *  - auth drop: the SDK auto-reconnects WITHOUT re-signin after a WS blip,
 *    so the next statement runs anonymous ("Anonymous access not allowed" /
 *    "Not enough permissions") — a fresh connect+signin fixes it; if creds
 *    are genuinely wrong the retry fails identically and throws.
 *  Exported for unit tests. */
export declare function isRetryableSurrealError(e: unknown): boolean;
export declare function patchOrderByFields(sql: string): string;
/**
 * SurrealDB store — wraps all database operations for the LaqrumCode plugin.
 * Replaces the module-level singleton pattern from standalone LaqrumCode.
 */
export declare class SurrealStore {
    private db;
    private config;
    private reconnecting;
    private shutdownFlag;
    private initialized;
    /** S1: true ONLY after runSchema() has resolved against the live connection.
     *  isAvailable() gates on this so a connect-OK-but-schema-FAILED store reports
     *  unavailable (degraded mode) instead of serving writes ungated for the
     *  daemon's whole lifetime — the UNIQUE seals / DEFINE INDEX the dedup +
     *  committing_token CAS campaign relies on would otherwise never exist on that
     *  store. Set false on any runSchema throw; re-set true when a reconnect heals
     *  the schema apply (ensureConnected). */
    private schemaApplied;
    constructor(config: SurrealConfig, opts?: {
        skipSupervisorRegister?: boolean;
    });
    /** K32: shared connect timeout for BOTH the first connect (initialize) and
     *  every reconnect (ensureConnected). A non-settling WS handshake at boot used
     *  to hang initialize() forever — the daemon sat in "connecting" and never
     *  entered degraded mode, while only the reconnect path had a guard. */
    private static readonly CONNECT_TIMEOUT_MS;
    /** K32: one connect path, deadlined. Builds a fresh Surreal handshake and
     *  races it against CONNECT_TIMEOUT_MS via raceWithDeadline (which clears the
     *  timer on every exit path, so a fast connect leaks no pending Timeout that
     *  would keep the process alive). Used by initialize() and ensureConnected(). */
    private connectWithTimeout;
    /** Connect and run schema. Returns true if a new connection was made, false if already initialized. */
    initialize(): Promise<boolean>;
    /** S1: run runSchema() with a small bounded retry, owning the schemaApplied
     *  flag. On success sets schemaApplied=true (MONOTONIC — T1: never reset to
     *  false, since the schema is idempotent and persists in the DB once applied);
     *  rethrows the last error so callers (initialize / ensureConnected) can react.
     *  Kept separate from runSchema() so the reconnect path can re-arm the schema
     *  (and thus isAvailable()) without duplicating the retry logic. */
    private applySchemaWithRetry;
    /** SCHEMA-UPGRADE-WEDGE recovery record (C2 pattern). A UNIQUE DEFINE INDEX in
     *  schema.surql was rejected because pre-existing duplicate rows violate it
     *  (subagent / retrieval_outcome / turn_score / identity_chunk / maturity_stage
     *  / causal_chain / artifact.path). The fix is data-PRESERVING dedup
     *  (keep-oldest) which scripts/predeploy-dedup.mjs performs — but for the
     *  CONTENT table `artifact` that delete MUST route through the gcHardDelete
     *  keystone, so we do NOT auto-run it from schema apply. We instead persist a
     *  LOUD maintenance_runs error row that memory_health surfaces as RED, naming
     *  the exact recovery command, so an operator (or an enterprise fleet monitor
     *  polling memory_health) gets an unambiguous, copy-pasteable remediation
     *  rather than a silent degraded daemon. Best-effort: the write itself is
     *  guarded so a failure to record never masks the original schema error.
     *  Uses queryExec directly (not recordMaintenanceRun) because the schema has
     *  NOT applied — but maintenance_runs is plain SCHEMALESS-compatible CONTENT,
     *  and queryExec routes through ensureConnected/withRetry like every write. */
    private recordSchemaWedgeRecovery;
    markShutdown(): void;
    private ensureConnected;
    private runSchema;
    isConnected(): boolean;
    getInfo(): {
        url: string;
        ns: string;
        db: string;
        connected: boolean;
    };
    ping(): Promise<boolean>;
    close(): Promise<void>;
    /** 0.7.118: a zombie WS (queries never settle, no error event, isConnected
     *  still true) was observed in production — rpcsInFlight grew unboundedly
     *  while meta.health stayed green and every DB-touching tool hung. Set by
     *  deadlineQuery() on a blown deadline; ensureConnected() treats it as
     *  disconnected even though the SDK disagrees. */
    private zombieSuspect;
    /** Run a query function with one retry on retryable failures (connection
     *  drops, blown deadlines, auth-dropped reconnects). Reconnection is routed
     *  through ensureConnected() so concurrent callers share a single
     *  reconnection attempt instead of racing.
     *
     *  Retry-once safety note (0.7.118): a deadline'd write MAY have executed
     *  server-side, so the retry can double-fire. Post-W2 this is acceptable —
     *  edges carry UNIQUE (in,out) indexes, concepts/memories carry content
     *  seals, subagents carry correlation keys — and the alternative (hanging
     *  forever on a zombie connection) is strictly worse. */
    private withRetry;
    /** All SDK query round-trips route through here. The Promise.race deadline
     *  converts a never-settling zombie query into a typed, retryable error —
     *  withRetry() then forces a reconnect (fresh Surreal instance) and the
     *  daemon self-heals on the next traffic instead of wedging forever. */
    private deadlineQuery;
    queryFirst<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>;
    queryMulti<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T | undefined>;
    queryExec(sql: string, bindings?: Record<string, unknown>): Promise<void>;
    /**
     * Execute N SQL statements in a single SurrealDB round-trip.
     * Returns one result array per statement; bindings are shared across all statements.
     *
     * CONTRACT (QA-0.7.121 A2): result-index alignment assumes ONE statement
     * per array element. An element containing embedded ';' statements (e.g.
     * bumpAccessCounts' LET+UPDATE pairs) makes the server return MORE results
     * than elements — fine only when the caller discards the return value.
     * Do not read positional results after passing multi-statement elements.
     */
    queryBatch<T = any>(statements: string[], bindings?: Record<string, unknown>): Promise<T[][]>;
    private safeQuery;
    /** Multi-table cosine similarity search across turns, concepts, memories, artifacts, monologues, and identity chunks. Returns merged results sorted by score.
     *
     * 0.7.26: optional projectId scopes concept/memory/artifact retrieval. Soft
     * filter: rows without project_id (pre-migration) still surface, items with
     * scope='global' always surface, items with project_id matching $pid surface.
     * Pass undefined for cross-project retrieval (legacy behavior). */
    vectorSearch(vec: number[], sessionId: string, limits?: {
        turn?: number;
        identity?: number;
        concept?: number;
        memory?: number;
        artifact?: number;
        monologue?: number;
    }, withEmbeddings?: boolean, projectId?: string): Promise<VectorSearchResult[]>;
    upsertTurn(turn: TurnRecord): Promise<string>;
    getSessionTurns(sessionId: string, limit?: number): Promise<{
        role: string;
        text: string;
    }[]>;
    getSessionTurnsRich(sessionId: string, limit?: number): Promise<{
        turnId: string;
        role: string;
        text: string;
        tool_name?: string;
        tool_result?: string;
        file_paths?: string[];
    }[]>;
    /** Returns true when a new edge row was written, false when a UNIQUE
     *  (in,out) index reported the edge already exists (idempotent no-op).
     *  W2-06 (2026-06-10): with ensureEdgeIndexes() armed, every duplicate
     *  RELATE — hook re-fires, RPC-timeout retries, per-turn re-linking —
     *  surfaces as a unique violation; treating it as success-without-write
     *  is the central backstop that made 92% of production edge rows
     *  impossible to recreate. Callers that need created-vs-existed (e.g.
     *  decay-once) read the boolean; void-style callers are unaffected. */
    relate(fromId: string, edge: string, toId: string): Promise<boolean>;
    ensureAgent(name: string, model?: string): Promise<string>;
    ensureProject(name: string): Promise<string>;
    createTask(description: string, projectId?: string): Promise<string>;
    createSession(agentId?: string, kcSessionId?: string, projectId?: string): Promise<string>;
    /** Idempotent session-row resolver. If a session row already exists for the
     *  given Claude Code session id, returns it; otherwise creates one. Used by
     *  UserPromptSubmit to backfill resumed conversations that Claude Code's
     *  hook engine doesn't refire SessionStart for — without this, every
     *  resumed session is a graph orphan (turns ingested but unattributable).
     *
     *  0.7.29: also backfills the project_id field on existing rows that
     *  predate project-scope persistence. Idempotent: only sets when NONE. */
    ensureSessionRow(kcSessionId: string, agentId?: string, projectId?: string): Promise<string>;
    /** Increment turn_count by 1 and bump last_active. Called from
     *  UserPromptSubmit (0.7.12+) — the reliable hook that fires at turn
     *  start. Earlier versions did this from Stop, which is dropped/timed-out
     *  often enough to leave session.turn_count chronically undercounted. */
    bumpSessionTurn(sessionId: string): Promise<void>;
    /** Add the per-turn input/output token deltas to the session row's
     *  cumulative totals. Called from Stop (when the assistant response
     *  has been transcribed and token usage is known) and PreCompact (to
     *  flush any tokens accrued mid-compaction). No-op when both deltas
     *  are zero, which is the common-no-tokens-accrued path. */
    addSessionTokens(sessionId: string, inputTokens: number, outputTokens: number): Promise<void>;
    markSessionActive(sessionId: string): Promise<void>;
    markSessionEnded(sessionId: string): Promise<void>;
    /**
     * Atomically claim a session for cleanup. Only one worker wins per session.
     *
     * Sets cleanup_completed = true and ended_at = time::now() in a single
     * conditional UPDATE. Returns true when this caller won the claim (a row
     * was matched and updated), false when another worker already claimed it
     * (or the record does not exist).
     *
     * Callers MUST roll back via releaseSessionClaim() if the follow-up work
     * (e.g. CREATEing pending_work rows) fails, otherwise the session will
     * never be retried by deferred cleanup. On successful cleanup completion,
     * callers SHOULD call clearSessionClaim() so the cleanup_claim_token does
     * not linger on the row (it accumulates otherwise).
     *
     * Retry idempotency: queryFirst() wraps every call in withRetry(), which
     * retries on connection error. The WHERE clause accepts either "row not
     * yet claimed" OR "row already claimed by us (token matches)". So if the
     * first attempt landed but the response was lost and withRetry re-runs,
     * the second branch fires, RETURN BEFORE is non-empty, and we correctly
     * report won=true on the retry.
     *
     * The cleanup_claim_token field is schemaless — schema rev still pending
     * (Agent F3 owns the schema patch), but SCHEMALESS accepts the field
     * without a definition, so the runtime path can land ahead of schema.
     */
    claimSessionForCleanup(sessionId: string): Promise<boolean>;
    /**
     * Roll back a prior claimSessionForCleanup() when the follow-up work failed.
     * Resets cleanup_completed = false and clears ended_at so deferredCleanup
     * picks the session up again on next boot. Also clears the claim token so
     * a fresh claim attempt starts from a clean slate.
     */
    releaseSessionClaim(sessionId: string): Promise<void>;
    /**
     * Clear the cleanup_claim_token after successful cleanup completion. Leaves
     * cleanup_completed = true so the session stays "done"; only the token is
     * reset so it does not accumulate across re-runs on the same record. Safe
     * to call multiple times (idempotent on the NONE write).
     */
    clearSessionClaim(sessionId: string): Promise<void>;
    getOrphanedSessions(limit?: number): Promise<{
        id: string;
        started_at: string;
        kc_session_id: string | null;
    }[]>;
    countTurnsForSession(kcSessionId: string): Promise<number>;
    linkSessionToTask(sessionId: string, taskId: string): Promise<void>;
    linkTaskToProject(taskId: string, projectId: string): Promise<void>;
    linkAgentToTask(agentId: string, taskId: string): Promise<void>;
    linkAgentToProject(agentId: string, projectId: string): Promise<void>;
    /**
     * BFS expansion from seed nodes along typed edges, with batched per-hop queries.
     * Uses multi-edge traversal (LIMIT 25 forward, LIMIT 10 reverse) to bound fan-out.
     */
    /**
     * Tag-boosted concept retrieval: extract keywords from query text,
     * find concepts tagged with matching terms, score by cosine similarity.
     * Returns concepts that pure vector search might miss due to embedding mismatch.
     */
    tagBoostedConcepts(queryText: string, queryVec: number[], limit?: number): Promise<VectorSearchResult[]>;
    graphExpand(nodeIds: string[], queryVec: number[], hops?: number): Promise<VectorSearchResult[]>;
    /** 0.7.121 — counter side-table. The old per-retrieval
     *  `UPDATE <row> SET access_count += 1` rewrote the ENTIRE row (embedding
     *  included, 4–12KB) into surrealkv's append-only value log on every bump:
     *  measured production damage was a 63.8GB vlog wrapping ~0.3GB of live
     *  data (~200× write amplification; 2026-06-12 forensics). Bumps now land
     *  in tiny `access_stats` rows (deterministic id = target id with ':'→'_';
     *  ~100B/version). Two safety valves keep legacy readers correct:
     *  - AMORTIZED ROW SYNC: at most once per 7 days per row, the real row's
     *    access_count/last_accessed are refreshed from the side table — the
     *    WHERE gate means a no-op sync writes NO row version. Keeps
     *    maintenance/GC predicates that read row.last_accessed within a week
     *    of truth instead of frozen forever.
     *  - SCORING MERGE: fetchAccessDeltas() lets the hot path see exact
     *    counts (graph-context merges before WMR scoring).
     *  Field is named `hits` (not `count`) — `count` collides with the
     *  SurrealQL function in SET expressions. */
    bumpAccessCounts(ids: Array<string | unknown>): Promise<void>;
    /** 0.7.121 — exact access counts for scoring: row's (possibly week-stale)
     *  access_count + un-synced side-table delta. Direct record fetches, O(1)
     *  per id. Returns Map<targetId, {hits, syncedHits}> for ids that have any
     *  side-table row. */
    fetchAccessDeltas(ids: Array<string | unknown>): Promise<Map<string, number>>;
    /** W2-07 (2026-06-10): returns { id, existed } — `existed: true` when the
     *  content resolved to a pre-existing concept (exact or >0.92-cosine dedup,
     *  including race-recovery paths). commitConcept uses the flag to skip
     *  re-running hierarchy/related_to link scans for recurring concepts — the
     *  per-turn re-wiring that produced ×4,541 duplicate edges on hot pairs. */
    upsertConcept(content: string, embedding: number[] | null, source?: string, provenance?: ConceptProvenance, projectId?: string, embeddingTarget?: string): Promise<{
        id: string;
        existed: boolean;
    }>;
    /** W2-09 (2026-06-10): returns { id, existed } — `existed: true` when the
     *  path-unique dedup resolved to a pre-existing artifact row. commitArtifact
     *  uses the flag to skip re-running the artifact_mentions link scan on every
     *  re-edit of the same file (~5 duplicate edges + one wasted embed per
     *  Write/Edit before the fix). */
    createArtifact(path: string, type: string, description: string, embedding: number[] | null, projectId?: string): Promise<{
        id: string;
        existed: boolean;
    }>;
    createMemory(text: string, embedding: number[] | null, importance: number, category?: string, sessionId?: string, projectId?: string, embeddingTarget?: string): Promise<string>;
    createMonologue(sessionId: string, category: string, content: string, embedding: number[] | null): Promise<string>;
    getAllCoreMemory(tier?: number): Promise<CoreMemoryEntry[]>;
    createCoreMemory(text: string, category: string, priority: number, tier: number, sessionId?: string): Promise<string>;
    updateCoreMemory(id: string, fields: Partial<Pick<CoreMemoryEntry, "text" | "category" | "priority" | "tier" | "active">>): Promise<boolean>;
    deleteCoreMemory(id: string): Promise<void>;
    getLatestHandoff(): Promise<{
        text: string;
        created_at: string;
    } | null>;
    countResolvedSinceHandoff(handoffCreatedAt: string): Promise<number>;
    getAllIdentityChunks(): Promise<{
        text: string;
    }[]>;
    getRecentMonologues(limit?: number): Promise<{
        category: string;
        content: string;
        timestamp: string;
    }[]>;
    getPreviousSessionTurns(currentSessionId?: string, limit?: number): Promise<{
        role: string;
        text: string;
        tool_name?: string;
        timestamp: string;
    }[]>;
    getUnresolvedMemories(limit?: number): Promise<{
        id: string;
        text: string;
        importance: number;
        category: string;
    }[]>;
    getRecentFailedCausal(limit?: number): Promise<{
        description: string;
        chain_type: string;
    }[]>;
    resolveMemory(memoryId: string): Promise<boolean>;
    updateUtilityCache(memoryId: string, utilization: number): Promise<void>;
    getUtilityFromCache(ids: string[]): Promise<Map<string, number>>;
    getUtilityCacheEntries(ids: string[]): Promise<Map<string, UtilityCacheEntry>>;
    /**
     * Time-relative scheduling gate for maintenance jobs. Returns true when
     * either (a) no prior run is recorded, (b) the last run is older than
     * maxDaysSince, or (c) the row count exceeds the absolute floor.
     *
     * Without this gate, absolute-count floors (count<=200/2000/50) meant
     * brand-new installs got zero maintenance for weeks or months until the
     * graph organically grew large enough to cross the floor. Now a fresh
     * install runs each job once in the first session (baselining), then
     * weekly, plus any time volume crosses the legacy floor.
     *
     * E11 (failure backoff): E1 now records status='error' rows for jobs that
     * throw (via runJob's finally). Without a backoff, a PERMANENTLY-failing job
     * hot-loops: its newest row is an error (not a success), so the time gate
     * above treats it as "due" and re-runs it every boot — wasting the scan on a
     * job that cannot succeed (e.g. a SurrealQL parse error that survives until
     * the next release). Mirroring auto-drain's fast-fail cooldown, if the most
     * recent row for this job is status='error' AND younger than
     * FAILURE_BACKOFF_MS, we skip the retry until the cooldown elapses. A fresh
     * daemon (newer dist) is unaffected: the error row pre-dates its boot only by
     * the cooldown window at most, so a real fix retries within ~30 min.
     */
    private static readonly FAILURE_BACKOFF_MS;
    private shouldRunMaintenance;
    private recordMaintenanceRun;
    runMemoryMaintenance(): Promise<void>;
    garbageCollectMemories(): Promise<number>;
    garbageCollectConcepts(): Promise<number>;
    /**
     * True if a pending+active pending_work row of `workType` already exists in
     * ANY session — the enqueue gate for session-end + deferred-cleanup.
     *
     * causal_graduate / soul_* builders run GLOBAL eligibility queries, so ONE
     * pending row of a type drains ALL eligible work; enqueuing one per session
     * just piles up self-completing empties that inflate the DRAIN-NOW banner
     * (the recurring empty-drain report, 2026-06-18). Checks `pending` ONLY (not
     * `processing`): a stuck processing row is recovered by the 10-min stale-
     * recovery in fetch_pending_work, so this gate cannot starve graduation.
     */
    hasPendingWorkOfType(workType: string): Promise<boolean>;
    /**
     * Drop pending_work rows older than 7 days, regardless of status.
     *
     * The queue is consumer-pull (subagents call fetch_pending_work). Without
     * this purge, stale items from long-gone sessions accumulate and pollute
     * health metrics. 7d is well past the useful window — extraction work for
     * a week-old session has missed its tagging window, and graduation work
     * will be re-enqueued by future maintenance if still relevant.
     */
    purgeStalePendingWork(): Promise<number>;
    /**
     * Hard-delete old retrieval_outcome rows beyond the retention window.
     *
     * retrieval_outcome is the fastest-growing table — ~5-15 rows per turn, each
     * carrying a 1024-dim query_embedding (~4-8 KB) — and is pure ACAN training
     * telemetry, NOT knowledge (the D4 no-DELETE-content-tables lint exempts it).
     * The trainer only ever reads the most recent MAX_TRAINING_SAMPLES (15K);
     * older rows have zero value. Keep 2x the window (30K) for margin and
     * hard-delete the rest so the table — the dominant disk consumer at scale —
     * stays bounded instead of growing forever.
     */
    purgeOldRetrievalOutcomes(): Promise<number>;
    /**
     * Hard-delete old turn_score rows beyond the retention window.
     *
     * turn_score is per-turn scoring TELEMETRY (one composite per turn), NOT
     * knowledge — it is absent from the D4 no-DELETE-content-tables lint's
     * CONTENT_TABLES list, exactly like retrieval_outcome. It was the one
     * telemetry table with no retention (K29): on a long-lived per-host daemon
     * it grows ~1 row/turn forever, and observability.ts / soul.ts range-scan it
     * by created_at. Mirror purgeOldRetrievalOutcomes: keep the most-recent
     * RETAIN rows and hard-delete the rest so the table stays bounded. Uses
     * ts_created_idx (K8) for the ORDER BY and the DELETE predicate.
     */
    purgeOldTurnScores(): Promise<number>;
    /** E1: bound maintenance_runs (telemetry — runJob writes a row per job per
     *  cycle, ~24/day, forever). Mirror purgeOldTurnScores: keep the most-recent
     *  RETAIN rows by ran_at, hard-delete older. DELETE OK (telemetry, D4-exempt;
     *  uses maintenance_runs_ran_at_idx). The newest-row-per-job memory_health
     *  reader is unaffected (latest rows are always retained). */
    purgeOldMaintenanceRuns(): Promise<number>;
    /** M4: bound compaction_checkpoint (telemetry — one row per compaction per
     *  session, written forever by the compaction path; src/engine/surreal.ts
     *  CREATE compaction_checkpoint). It was the one checkpoint/telemetry table
     *  with NO retention: on a long-lived per-host daemon it grows without bound,
     *  one row per compaction. Mirror purgeOldMaintenanceRuns: keep the
     *  most-recent RETAIN rows by created_at, hard-delete older.
     *
     *  DELETE OK: compaction_checkpoint is TELEMETRY, NOT a content table — it is
     *  absent from the D4 no-DELETE-content-tables lint's CONTENT_TABLES list and
     *  from gc.ts GC_CONTENT_TABLES, exactly like turn_score / maintenance_runs.
     *  Nothing points AT a checkpoint row (its only cross-ref is the OUTBOUND
     *  memory_id string back-pointer, which gc.ts NULLs when a memory is deleted),
     *  so deleting old rows dangles nothing. Uses cc_created_idx for the ORDER BY
     *  and the DELETE predicate. The pending/failed-checkpoint reader
     *  (getPendingCompactionCheckpoints) is unaffected: those are the freshest
     *  rows and are always retained well within RETAIN. */
    purgeOldCompactionCheckpoints(): Promise<number>;
    archiveOldTurns(): Promise<number>;
    consolidateMemories(embedFn: (text: string) => Promise<number[]>): Promise<number>;
    getSessionRetrievedMemories(sessionId: string): Promise<{
        id: string;
        text: string;
    }[]>;
    markSurfaceable(memoryId: string): Promise<void>;
    getDueMemories(limit?: number): Promise<{
        id: string;
        text: string;
        importance: number;
        fib_index: number;
        surface_count: number;
        created_at: string;
    }[]>;
    createCompactionCheckpoint(sessionId: string, rangeStart: number, rangeEnd: number): Promise<string>;
    completeCompactionCheckpoint(checkpointId: string, memoryId: string): Promise<void>;
    getPendingCheckpoints(sessionId: string): Promise<{
        id: string;
        msg_range_start: number;
        msg_range_end: number;
    }[]>;
    isAvailable(): boolean;
    private _reflectionSessions;
    clearReflectionCache(): void;
    /** Returns the subset of session ids that have at least one reflection.
     *
     *  K18: the per-turn caller (graph-context.ts reflectionBoost) only ever
     *  checks `.has(sessionId)` for the sessionIds present in the CURRENT result
     *  set. The old form `SELECT session_id FROM reflection GROUP BY session_id`
     *  full-scanned the entire (forever-growing) reflection table into an
     *  unbounded Set on every turn. When called WITH the result-set ids we run a
     *  targeted `WHERE session_id IN $ids` (served by reflection_session_idx),
     *  bounding the work to |ids| — not the table. The set returned is membership-
     *  equivalent for those ids, so the caller's `.has()` checks are unchanged.
     *
     *  Back-compat: a no-arg call keeps the cached full-membership behaviour but
     *  BOUNDS it with a LIMIT so a pathological reflection table can't blow up
     *  the Set. The targeted path is NOT cached (the answer is id-set-specific).
     *  Param is OPTIONAL so the build stays valid regardless of caller-edit order. */
    getReflectionSessionIds(sessionIds?: string[]): Promise<Set<string>>;
    private static readonly FIB_DAYS;
    advanceSurfaceFade(memoryId: string): Promise<void>;
    resolveSurfaceMemory(memoryId: string, outcome: "engaged" | "dismissed"): Promise<void>;
    dispose(): Promise<void>;
}
export { assertRecordId, assertValidEdge, VALID_EDGES };
