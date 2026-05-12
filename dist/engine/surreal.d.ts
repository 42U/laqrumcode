import { Surreal } from "surrealdb";
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
/** Whitelist of valid SurrealDB edge table names — prevents SQL injection via edge interpolation. */
declare const VALID_EDGES: Set<string>;
declare function assertValidEdge(edge: string): void;
/**
 * SurrealDB store — wraps all database operations for the KongBrain plugin.
 * Replaces the module-level singleton pattern from standalone KongBrain.
 */
export declare class SurrealStore {
    private db;
    private config;
    private reconnecting;
    private shutdownFlag;
    private initialized;
    constructor(config: SurrealConfig);
    /** Connect and run schema. Returns true if a new connection was made, false if already initialized. */
    initialize(): Promise<boolean>;
    markShutdown(): void;
    private ensureConnected;
    private runSchema;
    getConnection(): Surreal;
    isConnected(): boolean;
    getInfo(): {
        url: string;
        ns: string;
        db: string;
        connected: boolean;
    };
    ping(): Promise<boolean>;
    close(): Promise<void>;
    /** Returns true if an error is a connection-level failure worth retrying. */
    private isConnectionError;
    /** Run a query function with one retry on connection errors.
     *  Reconnection is routed through ensureConnected() so concurrent
     *  callers share a single reconnection attempt instead of racing. */
    private withRetry;
    queryFirst<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>;
    queryMulti<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T | undefined>;
    queryExec(sql: string, bindings?: Record<string, unknown>): Promise<void>;
    /**
     * Execute N SQL statements in a single SurrealDB round-trip.
     * Returns one result array per statement; bindings are shared across all statements.
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
        role: string;
        text: string;
        tool_name?: string;
    }[]>;
    relate(fromId: string, edge: string, toId: string): Promise<void>;
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
    /** @deprecated since 0.7.12 — split into bumpSessionTurn + addSessionTokens.
     *  Kept as a backward-compat shim for any external caller; new code should
     *  call the split methods directly. Will be removed in 0.8.x. */
    updateSessionStats(sessionId: string, inputTokens: number, outputTokens: number): Promise<void>;
    endSession(sessionId: string, summary?: string): Promise<void>;
    markSessionActive(sessionId: string): Promise<void>;
    markSessionEnded(sessionId: string): Promise<void>;
    getOrphanedSessions(limit?: number): Promise<{
        id: string;
        started_at: string;
        kc_session_id: string | null;
    }[]>;
    /** One-shot: for sessions created before 0.5.5 that lack kc_session_id,
     * walk their `part_of` turn edges and copy the kc id from any turn row.
     * Idempotent — only updates rows where kc_session_id is currently NONE.
     * Bounded per call so a backlog of hundreds chips down across SessionStarts. */
    backfillOrphanKcSessionIds(limit?: number): Promise<number>;
    countTurnsForSession(kcSessionId: string): Promise<number>;
    linkSessionToTask(sessionId: string, taskId: string): Promise<void>;
    linkTaskToProject(taskId: string, projectId: string): Promise<void>;
    linkAgentToTask(agentId: string, taskId: string): Promise<void>;
    linkAgentToProject(agentId: string, projectId: string): Promise<void>;
    /**
     * BFS expansion from seed nodes along typed edges, with batched per-hop queries.
     * Each edge query is LIMIT 3 (EDGE_NEIGHBOR_LIMIT) to bound fan-out per node.
     */
    /**
     * Tag-boosted concept retrieval: extract keywords from query text,
     * find concepts tagged with matching terms, score by cosine similarity.
     * Returns concepts that pure vector search might miss due to embedding mismatch.
     */
    tagBoostedConcepts(queryText: string, queryVec: number[], limit?: number): Promise<VectorSearchResult[]>;
    graphExpand(nodeIds: string[], queryVec: number[], hops?: number): Promise<VectorSearchResult[]>;
    bumpAccessCounts(ids: string[]): Promise<void>;
    upsertConcept(content: string, embedding: number[] | null, source?: string, provenance?: ConceptProvenance, projectId?: string): Promise<string>;
    createArtifact(path: string, type: string, description: string, embedding: number[] | null, projectId?: string): Promise<string>;
    createMemory(text: string, embedding: number[] | null, importance: number, category?: string, sessionId?: string, projectId?: string): Promise<string>;
    createMonologue(sessionId: string, category: string, content: string, embedding: number[] | null): Promise<string>;
    getAllCoreMemory(tier?: number): Promise<CoreMemoryEntry[]>;
    createCoreMemory(text: string, category: string, priority: number, tier: number, sessionId?: string): Promise<string>;
    updateCoreMemory(id: string, fields: Partial<Pick<CoreMemoryEntry, "text" | "category" | "priority" | "tier" | "active">>): Promise<boolean>;
    deleteCoreMemory(id: string): Promise<void>;
    deactivateSessionMemories(sessionId: string): Promise<void>;
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
     */
    private shouldRunMaintenance;
    private recordMaintenanceRun;
    runMemoryMaintenance(): Promise<void>;
    garbageCollectMemories(): Promise<number>;
    garbageCollectConcepts(): Promise<number>;
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
    getReflectionSessionIds(): Promise<Set<string>>;
    private static readonly FIB_DAYS;
    advanceSurfaceFade(memoryId: string): Promise<void>;
    resolveSurfaceMemory(memoryId: string, outcome: "engaged" | "dismissed"): Promise<void>;
    dispose(): Promise<void>;
}
export { assertRecordId, assertValidEdge, VALID_EDGES };
