import { makeCooldownState } from "./observability.js";
// --- Per-session mutable state ---
const DEFAULT_TOOL_LIMIT = 10;
/** Per-session mutable state: turn counters, daemon refs, 5-pillar IDs, and adaptive config. */
export class SessionState {
    sessionId;
    sessionKey;
    // Turn tracking
    lastUserTurnId = "";
    lastAssistantTurnId = "";
    lastUserText = "";
    lastAssistantText = "";
    /** Embedding of last user message from ingest — reused in buildContextualQueryVec to avoid re-embedding. */
    lastUserEmbedding = null;
    toolCallCount = 0;
    toolLimit = DEFAULT_TOOL_LIMIT;
    turnTextLength = 0;
    toolCallsSinceLastText = 0;
    softInterrupted = false;
    turnStartMs = Date.now();
    userTurnCount = 0;
    // Thinking capture
    pendingThinking = [];
    // Cumulative session token tracking (for mid-session cleanup trigger)
    cumulativeTokens = 0;
    lastCleanupTokens = 0;
    midSessionCleanupThreshold = 25_000;
    /** Last cumulative usage total seen — used to compute per-call deltas. */
    lastSeenUsageTotal = 0;
    // Stats batching (accumulated in-memory, flushed every 5 responses)
    _pendingInputTokens = 0;
    _pendingOutputTokens = 0;
    _statsFlushCounter = 0;
    // Current adaptive config (set by orchestrator preflight each turn)
    currentConfig = null;
    // Turn-boundary telemetry — stashed at preflight, consumed at Stop to
    // drive postflight() which writes orchestrator_metrics. Without these
    // fields postflight had nothing to work with across hook boundaries, so
    // orchestrator_metrics stayed at 0 rows despite the writer being intact.
    _pendingPreflight = null;
    _pendingPreflightAt = 0;
    _pendingPreflightInput = "";
    _turnToolCalls = 0;
    _turnTokensInStart = 0;
    _turnTokensOutStart = 0;
    // Subagent tracking — map tool_use_id → subagent record id so SubagentStop
    // can find the row written by PreToolUse(Agent) and mark it complete.
    _activeSubagents = new Map();
    // Pending tool args for artifact tracking
    pendingToolArgs = new Map();
    // First-touch edit-gate state (0.7.47+). In-memory cache of file paths
    // and bash-command patterns the gate has cleared this session. Wiped on
    // idle timeout (default 30min, configurable via LAQRUMCODE_GATE_TIMEOUT_MS).
    // Internal — do not inspect from outside engine/hooks/edit-gates.ts.
    _editGateChecked = new Set();
    _editGateLastActivity = 0;
    // Paths the agent has touched via file-aware tools (Read/Edit/Write/
    // MultiEdit) anywhere in this session. Populated by pre-tool-use.ts at
    // the top of every handler call so the edit-gate's "investigated" check
    // resolves immediately when a Read precedes an Edit in the same response
    // — at that point neither the Read nor the Edit has been ingested into
    // the turn table yet (Stop is what writes assistant tool I/O), so the
    // cold-path turn.text query would otherwise miss them. 0.7.48 fix.
    _observedFilePaths = new Set();
    /** K48: hard cap on {@link _observedFilePaths}. The Set is fed by every
     *  Read/Edit/Write (pre-tool-use) AND by path-extraction over Grep/Glob/
     *  recall result text (post-tool-use) — a single multi-thousand-match Grep
     *  can balloon it, and on a long-lived session it only ever grows. The
     *  edit-gate ("has this path been investigated?") only needs RECENTLY
     *  observed paths, so we keep the most-recent {@link OBSERVED_PATHS_CAP}
     *  and evict oldest. JS Set preserves insertion order, so the first key is
     *  the oldest. */
    static OBSERVED_PATHS_CAP = 2000;
    /** Insert a path into {@link _observedFilePaths}, evicting oldest entries
     *  (FIFO) once the cap is exceeded. Re-inserting an existing path does NOT
     *  refresh its recency (Set semantics) — acceptable here since the gate only
     *  cares about membership, and any path re-touched will be re-added on its
     *  next Read anyway. */
    observeFilePath(path) {
        const set = this._observedFilePaths;
        set.add(path);
        while (set.size > SessionState.OBSERVED_PATHS_CAP) {
            const oldest = set.values().next().value;
            if (oldest === undefined)
                break;
            set.delete(oldest);
        }
    }
    // Post-push CI reminder: set by PostToolUse when a Bash call contains
    // "git push", consumed by Stop to inject a Tier-0 reminder telling the
    // agent to verify CI before declaring done. Structural gate — the agent
    // can't skip it because it fires automatically.
    _pushDetected = false;
    // Tool call optimization state (claw-code patterns)
    /** Query vector from this turn's context retrieval — used to detect redundant recall calls. */
    lastQueryVec = null;
    /** Summary of what graphTransformContext injected — shown in planning gate. */
    lastRetrievalSummary = "";
    /** API request cycle counter — hard cap prevents runaway token spend. */
    apiCycleCount = 0;
    /** Tracks which static context sections the model has already seen in the conversation window.
     *  Persists across turns (NOT cleared in resetTurn) — cleared only when messages drop from window. */
    injectedSections = new Set();
    // 5-pillar IDs (populated at bootstrap)
    agentId = "";
    projectId = "";
    taskId = "";
    surrealSessionId = "";
    /** 0.7.31: turn number on which the Reflexion grounding-nudge most recently
     *  fired. Used to apply a 1-turn cooldown so we don't nag the model when
     *  it ignores high-salience items twice in a row. -1 sentinel = never. */
    lastReflexionFireTurn = -1;
    // Cross-concern state (set by hook handlers, consumed by context assembly)
    /** Structured summary stashed after compaction for next assemble() injection. */
    _compactionSummary;
    /** Promise resolving to wakeup briefing text (synthesized at session start). */
    _wakeupPromise;
    /** Graduation celebration payload for context injection. */
    _graduationCelebration;
    /** Whether workspace has files from the default context engine that can be migrated. */
    _hasMigratableFiles;
    /** Cached previous-session turns (stable within a session). */
    _cachedPrevTurns;
    /** Prefetch promise for previous-session turns — fires at session start, awaited in ensureRecentTurns. */
    _prevTurnsPrefetch;
    constructor(sessionId, sessionKey) {
        this.sessionId = sessionId;
        this.sessionKey = sessionKey;
    }
    /** Reset per-turn counters at the start of each prompt. */
    resetTurn() {
        this.toolCallCount = 0;
        this.toolLimit = DEFAULT_TOOL_LIMIT;
        this.turnTextLength = 0;
        this.toolCallsSinceLastText = 0;
        this.softInterrupted = false;
        this.turnStartMs = Date.now();
        this.pendingThinking.length = 0;
        this.lastRetrievalSummary = "";
        this.apiCycleCount = 0;
        // NOTE: lastQueryVec and injectedSections are NOT cleared here —
        // they persist across turns within the session.
    }
}
/** Singleton shared state: config, SurrealDB store, embedding service, and session map. */
export class GlobalPluginState {
    config;
    store;
    embeddings;
    workspaceDir;
    schemaApplied = false;
    sessions = new Map();
    /** K1 backstop: hard cap on the in-memory sessions Map. The periodic reaper
     *  ({@link reapStaleSessions}, armed from daemon/index.ts) handles the normal
     *  case, but a deterministic leak (a code path that creates sessions faster
     *  than SessionEnd removes them, or SessionEnd never firing) would otherwise
     *  grow this Map without bound on a long-lived per-host daemon → OOM. When a
     *  new session would exceed the cap we evict the OLDEST entry (Map preserves
     *  insertion order) and fire onSessionRemoved so dependent module-scoped maps
     *  GC too. Co-located Claude Code installs run a handful of sessions; 512 is
     *  far above any legitimate steady state. Override via LAQRUMCODE_MAX_SESSIONS. */
    maxSessions = Number(process.env.LAQRUMCODE_MAX_SESSIONS) > 0
        ? Number(process.env.LAQRUMCODE_MAX_SESSIONS)
        : 512;
    // Anomaly cooldown state (in-memory, resets on MCP restart). Per-flag
    // last-fired timestamps prevent spamming the model with the same alert
    // every turn while the underlying condition persists.
    observabilityCooldown = makeCooldownState();
    // Last day (YYYY-MM-DD) the daily rollup pass ran. Stop hook checks this
    // against the current day; if different, fires rollup for the prior day.
    // Turn-driven rather than timer-driven — no setInterval drift in long
    // processes, no firing on idle MCPs.
    lastRollupDay = "";
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
    sessionRemovedCallbacks = new Set();
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
    pendingTasks = new Set();
    constructor(config, store, embeddings) {
        this.config = config;
        this.store = store;
        this.embeddings = embeddings;
    }
    /** Get or create a SessionState for the given session key. */
    getOrCreateSession(sessionKey, sessionId) {
        let session = this.sessions.get(sessionKey);
        if (!session) {
            // K1 backstop: evict the COLDEST session(s) before inserting a new one if
            // we're at the cap. Fires onSessionRemoved for each eviction so
            // module-scoped session-keyed maps clear too (same contract as
            // removeSession / reapStaleSessions). Guards against an unbounded Map on
            // a long-lived daemon when normal removal lags or stalls.
            //
            // R7: eviction targets the least-recently-ACCESSED entry, not the
            // oldest-by-creation. We maintain LRU recency by deleting+re-setting on
            // every access (the existing-session branch below and getSession), so
            // sessions.keys().next() yields the genuinely coldest entry — the same
            // delete+re-insert trick embeddings.ts uses for its L1 cache. Without
            // this the cap dropped the longest-LIVED active session first (FIFO),
            // silently resetting a live mid-conversation session.
            while (this.sessions.size >= this.maxSessions) {
                const coldestKey = this.sessions.keys().next().value;
                if (coldestKey === undefined)
                    break;
                const evicted = this.sessions.get(coldestKey);
                this.sessions.delete(coldestKey);
                if (evicted) {
                    this.fireSessionRemovedCallbacks(evicted.sessionId, evicted.surrealSessionId);
                }
            }
            session = new SessionState(sessionId, sessionKey);
            session.midSessionCleanupThreshold = this.config.thresholds.midSessionCleanupThreshold;
            this.sessions.set(sessionKey, session);
        }
        else {
            // R7: refresh LRU recency — move this key to the most-recent position so
            // the cap eviction above never drops an actively-used session.
            this.sessions.delete(sessionKey);
            this.sessions.set(sessionKey, session);
        }
        return session;
    }
    /** Current number of live in-memory sessions. Exposed for the periodic
     *  reaper's logging and for tests asserting the K1 size cap. */
    get sessionCount() {
        return this.sessions.size;
    }
    /** Get an existing session by key. */
    getSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (session !== undefined) {
            // R7: refresh LRU recency on every read so the K1 size-cap eviction in
            // getOrCreateSession drops the genuinely coldest session, not the oldest
            // by insertion order. Every hook (Stop/PostToolUse/…) routes through here,
            // so an actively-used session keeps getting bumped to the most-recent slot
            // and survives the cap. Delete+re-set is the same O(1) LRU bump pattern in
            // embeddings.ts's L1 cache.
            this.sessions.delete(sessionKey);
            this.sessions.set(sessionKey, session);
        }
        return session;
    }
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
    onSessionRemoved(callback) {
        this.sessionRemovedCallbacks.add(callback);
        return () => {
            this.sessionRemovedCallbacks.delete(callback);
        };
    }
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
    removeSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        this.sessions.delete(sessionKey);
        if (!session)
            return;
        this.fireSessionRemovedCallbacks(session.sessionId, session.surrealSessionId);
    }
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
    reapStaleSessions(maxAgeMs = 2 * 60 * 60_000, isLive) {
        const now = Date.now();
        let reaped = 0;
        for (const [key, session] of this.sessions) {
            if (now - session.turnStartMs <= maxAgeMs)
                continue;
            // Guard 1: client socket still attached → not idle, never reap.
            if (isLive && isLive(session.sessionId))
                continue;
            // Guard 2: a turn is in progress (unfinished subagent / unconsumed tool
            // args) → reaping would orphan those rows. Skip until the turn settles.
            if (session._activeSubagents.size > 0 || session.pendingToolArgs.size > 0)
                continue;
            this.sessions.delete(key);
            this.fireSessionRemovedCallbacks(session.sessionId, session.surrealSessionId);
            reaped++;
        }
        return reaped;
    }
    /**
     * Invoke every registered session-removed callback. Errors are swallowed
     * after a console.error so a bad callback can't strand the cleanup or
     * abort an end-of-session flush. Intentionally synchronous — the hot
     * SessionEnd path can't afford an extra microtask per callback.
     */
    fireSessionRemovedCallbacks(sessionId, surrealSessionId) {
        for (const callback of this.sessionRemovedCallbacks) {
            try {
                callback(sessionId, surrealSessionId);
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error("[state] onSessionRemoved callback threw:", err);
            }
        }
    }
    /**
     * R3: register a detached background promise that {@link awaitPendingTasks}
     * (called from the daemon's graceful shutdown) should drain before shared
     * resources are torn down. The promise is removed from the set when it
     * settles — register-and-forget; callers keep their own `.catch`. Swallows
     * the rejection here too so a rejected detached task can't surface as an
     * unhandledRejection just because we held a second reference to it.
     */
    registerPendingTask(p) {
        this.pendingTasks.add(p);
        const done = () => { this.pendingTasks.delete(p); };
        p.then(done, done);
    }
    /** Number of detached background tasks not yet settled. Exposed for tests. */
    get pendingTaskCount() {
        return this.pendingTasks.size;
    }
    /**
     * R3: await all currently-registered detached tasks, bounded by timeoutMs so
     * a wedged task can't hang shutdown past the daemon's 8s watchdog. Uses
     * allSettled (a rejected eval must not abort the drain) raced against a
     * timer. Snapshots the set up front; tasks registered after the call begins
     * are not awaited (shutdown is in progress — no new Stop hooks should arrive).
     */
    async awaitPendingTasks(timeoutMs = 3_000) {
        const tasks = [...this.pendingTasks];
        if (tasks.length === 0)
            return;
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        });
        try {
            await Promise.race([Promise.allSettled(tasks), timeout]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    /** Shut down all shared resources. */
    async shutdown() {
        this.sessions.clear();
        await this.embeddings.dispose();
        await this.store.dispose();
    }
}
