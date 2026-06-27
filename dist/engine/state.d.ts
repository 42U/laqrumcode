import type { MemoryConfig } from "./config.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import type { AdaptiveConfig } from "./orchestrator.js";
/** Per-session mutable state: turn counters, daemon refs, 5-pillar IDs, and adaptive config. */
export declare class SessionState {
    readonly sessionId: string;
    readonly sessionKey: string;
    lastUserTurnId: string;
    lastAssistantTurnId: string;
    lastUserText: string;
    lastAssistantText: string;
    /** Embedding of last user message from ingest — reused in buildContextualQueryVec to avoid re-embedding. */
    lastUserEmbedding: number[] | null;
    toolCallCount: number;
    toolLimit: number;
    turnTextLength: number;
    toolCallsSinceLastText: number;
    softInterrupted: boolean;
    turnStartMs: number;
    userTurnCount: number;
    readonly pendingThinking: string[];
    cumulativeTokens: number;
    lastCleanupTokens: number;
    midSessionCleanupThreshold: number;
    /** Last cumulative usage total seen — used to compute per-call deltas. */
    lastSeenUsageTotal: number;
    _pendingInputTokens: number;
    _pendingOutputTokens: number;
    _statsFlushCounter: number;
    currentConfig: AdaptiveConfig | null;
    _pendingPreflight: import("./orchestrator.js").PreflightResult | null;
    _pendingPreflightAt: number;
    _pendingPreflightInput: string;
    _turnToolCalls: number;
    _turnTokensInStart: number;
    _turnTokensOutStart: number;
    readonly _activeSubagents: Map<string, string>;
    readonly pendingToolArgs: Map<string, unknown>;
    readonly _editGateChecked: Set<string>;
    _editGateLastActivity: number;
    readonly _observedFilePaths: Set<string>;
    /** K48: hard cap on {@link _observedFilePaths}. The Set is fed by every
     *  Read/Edit/Write (pre-tool-use) AND by path-extraction over Grep/Glob/
     *  recall result text (post-tool-use) — a single multi-thousand-match Grep
     *  can balloon it, and on a long-lived session it only ever grows. The
     *  edit-gate ("has this path been investigated?") only needs RECENTLY
     *  observed paths, so we keep the most-recent {@link OBSERVED_PATHS_CAP}
     *  and evict oldest. JS Set preserves insertion order, so the first key is
     *  the oldest. */
    static readonly OBSERVED_PATHS_CAP = 2000;
    /** Insert a path into {@link _observedFilePaths}, evicting oldest entries
     *  (FIFO) once the cap is exceeded. Re-inserting an existing path does NOT
     *  refresh its recency (Set semantics) — acceptable here since the gate only
     *  cares about membership, and any path re-touched will be re-added on its
     *  next Read anyway. */
    observeFilePath(path: string): void;
    _pushDetected: boolean;
    /** Query vector from this turn's context retrieval — used to detect redundant recall calls. */
    lastQueryVec: number[] | null;
    /** Summary of what graphTransformContext injected — shown in planning gate. */
    lastRetrievalSummary: string;
    /** API request cycle counter — hard cap prevents runaway token spend. */
    apiCycleCount: number;
    /** Tracks which static context sections the model has already seen in the conversation window.
     *  Persists across turns (NOT cleared in resetTurn) — cleared only when messages drop from window. */
    readonly injectedSections: Set<string>;
    agentId: string;
    projectId: string;
    taskId: string;
    surrealSessionId: string;
    /** 0.7.31: turn number on which the Reflexion grounding-nudge most recently
     *  fired. Used to apply a 1-turn cooldown so we don't nag the model when
     *  it ignores high-salience items twice in a row. -1 sentinel = never. */
    lastReflexionFireTurn: number;
    /** Structured summary stashed after compaction for next assemble() injection. */
    _compactionSummary?: string;
    /** Promise resolving to wakeup briefing text (synthesized at session start). */
    _wakeupPromise?: Promise<string | null>;
    /** Graduation celebration payload for context injection. */
    _graduationCelebration?: {
        qualityScore: number;
        volumeScore: number;
        soulSummary: string;
    };
    /** Whether workspace has files from the default context engine that can be migrated. */
    _hasMigratableFiles?: boolean;
    /** Cached previous-session turns (stable within a session). */
    _cachedPrevTurns?: {
        role: string;
        text: string;
        tool_name?: string;
        timestamp: string;
    }[];
    /** Prefetch promise for previous-session turns — fires at session start, awaited in ensureRecentTurns. */
    _prevTurnsPrefetch?: Promise<{
        role: string;
        text: string;
        tool_name?: string;
        timestamp: string;
    }[]>;
    constructor(sessionId: string, sessionKey: string);
    /** Reset per-turn counters at the start of each prompt. */
    resetTurn(): void;
}
/**
 * Callback signature for session-removal hooks.
 *
 * Fired synchronously from {@link GlobalPluginState.removeSession} and from
 * {@link GlobalPluginState.reapStaleSessions} right after the session is
 * deleted from the in-memory map. Receives both the Claude Code-issued
 * `sessionId` (which is reused across SessionEnd→SessionStart for resumes
 * of the same conversation, so any string-keyed module-scoped map keyed by
 * it MUST clear on this callback) and the Surreal record id
 * `surrealSessionId` (which is unique per session row in the DB and may be
 * the empty string if the session was removed before bootstrap completed).
 *
 * Callbacks must not throw — errors are caught and logged but cannot block
 * the removal. Callbacks must be cheap and synchronous; the registry runs
 * inline on the hot SessionEnd path.
 */
export type SessionRemovedCallback = (sessionId: string, surrealSessionId: string) => void;
/** Singleton shared state: config, SurrealDB store, embedding service, and session map. */
export declare class GlobalPluginState {
    readonly config: MemoryConfig;
    readonly store: SurrealStore;
    /** Optional dedicated connection for heavy maintenance jobs, isolating them
     *  from the hook-serving `store` socket (a maintenance deadline/zombie-reconnect
     *  cannot reject in-flight hook queries). Set by the daemon after boot; callers
     *  fall back to `store` when it is absent or not yet available. */
    maintenanceStore?: SurrealStore;
    readonly embeddings: EmbeddingService;
    workspaceDir?: string;
    schemaApplied: boolean;
    private sessions;
    /** K1 backstop: hard cap on the in-memory sessions Map. The periodic reaper
     *  ({@link reapStaleSessions}, armed from daemon/index.ts) handles the normal
     *  case, but a deterministic leak (a code path that creates sessions faster
     *  than SessionEnd removes them, or SessionEnd never firing) would otherwise
     *  grow this Map without bound on a long-lived per-host daemon → OOM. When a
     *  new session would exceed the cap we evict the OLDEST entry (Map preserves
     *  insertion order) and fire onSessionRemoved so dependent module-scoped maps
     *  GC too. Co-located Claude Code installs run a handful of sessions; 512 is
     *  far above any legitimate steady state. Override via LAQRUMCODE_MAX_SESSIONS. */
    private readonly maxSessions;
    readonly observabilityCooldown: import("./observability.js").CooldownState;
    lastRollupDay: string;
    /**
     * Registry of cleanup callbacks invoked by {@link removeSession} and
     * {@link reapStaleSessions}. Modules that own session-keyed state living
     * OUTSIDE the {@link SessionState} instance (e.g. module-scoped
     * `Map<sessionId, ...>` such as `tier0WritesPerSession` in
     * `engine/tools/core-memory.ts`) MUST register a callback via
     * {@link onSessionRemoved} so their map entry is cleared when the
     * session ends. Otherwise the entry leaks across SessionEnd→SessionStart
     * for the same `sessionId` (Claude Code reuses ids on resume) and
     * bleeds counters/state into a session that thinks it's fresh.
     *
     * State that lives directly on the {@link SessionState} instance
     * (`pendingToolArgs`, `_activeSubagents`, `_pendingPreflight`,
     * `_pendingInputTokens`, `_pushDetected`, etc.) does NOT need a
     * callback — deleting the map entry drops the only strong reference, so
     * GC reclaims those maps with the instance.
     */
    private readonly sessionRemovedCallbacks;
    /**
     * R3: registry of detached "fire-and-forget" background promises that the
     * graceful-shutdown path must drain before disposing shared resources.
     *
     * The Stop hook kicks off {@link import("./retrieval-quality.js").evaluateRetrieval}
     * fire-and-forget so the user-visible turn boundary isn't blocked on the
     * cross-encoder. But that work writes the LAST turn's ACAN rows
     * (retrieval_outcome + turn_score). The server's in-flight drain only counts
     * RPCs still executing in dispatchLine — the Stop RPC has already returned by
     * the time the eval runs, so the drain skipped it, and gracefulCleanup raced
     * straight into disposeReranker()/shutdownManagedSurreal({force}), tearing the
     * reranker and DB out from under the in-flight eval and losing those rows.
     *
     * Register the promise here; gracefulCleanup awaits {@link awaitPendingTasks}
     * (bounded) BEFORE disposing the reranker / force-closing Surreal. Entries
     * self-remove on settle so the Set never grows unbounded on a long-lived
     * daemon (the same per-host leak class this round of hardening targets).
     */
    private readonly pendingTasks;
    constructor(config: MemoryConfig, store: SurrealStore, embeddings: EmbeddingService);
    /** Get or create a SessionState for the given session key. */
    getOrCreateSession(sessionKey: string, sessionId: string): SessionState;
    /** Current number of live in-memory sessions. Exposed for the periodic
     *  reaper's logging and for tests asserting the K1 size cap. */
    get sessionCount(): number;
    /** Get an existing session by key. */
    getSession(sessionKey: string): SessionState | undefined;
    /**
     * Register a callback to run when a session is removed (via SessionEnd
     * or stale-session reaping). Use this from modules that own
     * session-keyed state living outside the {@link SessionState} instance,
     * so the entry is cleared on session-end and doesn't bleed into the
     * next session with the same id.
     *
     * Returns a disposer that unregisters the callback. Callers that
     * register once at module load typically discard the disposer; tests
     * should call it to avoid cross-test contamination.
     *
     * Example (from `engine/tools/core-memory.ts` — NOT yet wired):
     * ```ts
     * state.onSessionRemoved((sessionId) => {
     *   tier0WritesPerSession.delete(sessionId);
     * });
     * ```
     */
    onSessionRemoved(callback: SessionRemovedCallback): () => void;
    /**
     * Remove a session from the map and fire every registered
     * {@link onSessionRemoved} callback so module-scoped session-keyed state
     * gets cleared too. In-memory state hanging off the SessionState
     * instance (subagent map, pendingToolArgs, _pendingPreflight, etc.)
     * is freed when the map entry drops its last strong reference; module-
     * scoped maps keyed by sessionId string must be cleared via callback.
     *
     * Callback errors are caught and never block removal — a single buggy
     * callback shouldn't strand other modules in a half-cleaned state.
     */
    removeSession(sessionKey: string): void;
    /**
     * Reap sessions that have been idle for longer than maxAgeMs.
     *
     * R13: the bare turnStartMs-age test could drop a session that is still
     * LIVE — a long agentic turn (turnStartMs is only reset at turn start, so a
     * single multi-hour turn looks "stale") or a session whose client socket is
     * still attached. Reaping such a session orphans its subagent rows and
     * unconsumed pending tool args, and resets mid-conversation state. We add two
     * guards, both fail-safe (skip-on-doubt — never reap when liveness is
     * uncertain):
     *
     *   1. {@link isLive} — daemon threads in a predicate backed by the set of
     *      session ids whose client socket is currently attached (server.clients).
     *      A session with a live socket is never idle, regardless of turn age.
     *
     *   2. in-progress turn — a non-empty {@link SessionState._activeSubagents} or
     *      {@link SessionState.pendingToolArgs} means a turn is mid-flight (a
     *      subagent hasn't reported SubagentStop, or a PreToolUse stashed args a
     *      PostToolUse hasn't consumed). Reaping here would strand those rows.
     *
     * isLive is matched against {@link SessionState.sessionId} (the Claude Code
     * session id the attached client reports), NOT the map key — the two differ
     * for daemon tool calls that key by sessionId-as-sessionKey but the contract
     * is the sessionId identity either way.
     */
    reapStaleSessions(maxAgeMs?: number, isLive?: (sessionId: string) => boolean): number;
    /**
     * Invoke every registered session-removed callback. Errors are swallowed
     * after a console.error so a bad callback can't strand the cleanup or
     * abort an end-of-session flush. Intentionally synchronous — the hot
     * SessionEnd path can't afford an extra microtask per callback.
     */
    private fireSessionRemovedCallbacks;
    /**
     * R3: register a detached background promise that {@link awaitPendingTasks}
     * (called from the daemon's graceful shutdown) should drain before shared
     * resources are torn down. The promise is removed from the set when it
     * settles — register-and-forget; callers keep their own `.catch`. Swallows
     * the rejection here too so a rejected detached task can't surface as an
     * unhandledRejection just because we held a second reference to it.
     */
    registerPendingTask(p: Promise<unknown>): void;
    /** Number of detached background tasks not yet settled. Exposed for tests. */
    get pendingTaskCount(): number;
    /**
     * R3: await all currently-registered detached tasks, bounded by timeoutMs so
     * a wedged task can't hang shutdown past the daemon's 8s watchdog. Uses
     * allSettled (a rejected eval must not abort the drain) raced against a
     * timer. Snapshots the set up front; tasks registered after the call begins
     * are not awaited (shutdown is in progress — no new Stop hooks should arrive).
     */
    awaitPendingTasks(timeoutMs?: number): Promise<void>;
    /** Shut down all shared resources. */
    shutdown(): Promise<void>;
}
