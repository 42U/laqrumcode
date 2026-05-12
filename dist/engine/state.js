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
    // Cleanup tracking
    cleanedUp = false;
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
    // idle timeout (default 30min, configurable via KONGCODE_GATE_TIMEOUT_MS).
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
// --- Global plugin state (shared across all sessions) ---
/** Singleton shared state: config, SurrealDB store, embedding service, and session map. */
export class GlobalPluginState {
    config;
    store;
    embeddings;
    workspaceDir;
    schemaApplied = false;
    sessions = new Map();
    // Anomaly cooldown state (in-memory, resets on MCP restart). Per-flag
    // last-fired timestamps prevent spamming the model with the same alert
    // every turn while the underlying condition persists.
    observabilityCooldown = makeCooldownState();
    // Last day (YYYY-MM-DD) the daily rollup pass ran. Stop hook checks this
    // against the current day; if different, fires rollup for the prior day.
    // Turn-driven rather than timer-driven — no setInterval drift in long
    // processes, no firing on idle MCPs.
    lastRollupDay = "";
    constructor(config, store, embeddings) {
        this.config = config;
        this.store = store;
        this.embeddings = embeddings;
    }
    /** Get or create a SessionState for the given session key. */
    getOrCreateSession(sessionKey, sessionId) {
        let session = this.sessions.get(sessionKey);
        if (!session) {
            session = new SessionState(sessionId, sessionKey);
            session.midSessionCleanupThreshold = this.config.thresholds.midSessionCleanupThreshold;
            this.sessions.set(sessionKey, session);
        }
        return session;
    }
    /** Get an existing session by key. */
    getSession(sessionKey) {
        return this.sessions.get(sessionKey);
    }
    /** Remove a session from the map (after dispose/cleanup). */
    removeSession(sessionKey) {
        this.sessions.delete(sessionKey);
    }
    /** Return all active sessions (for exit handlers). */
    allSessions() {
        return [...this.sessions.values()];
    }
    /** Reap sessions that have been idle for longer than maxAgeMs. */
    reapStaleSessions(maxAgeMs = 2 * 60 * 60_000) {
        const now = Date.now();
        let reaped = 0;
        for (const [key, session] of this.sessions) {
            if (now - session.turnStartMs > maxAgeMs) {
                this.sessions.delete(key);
                reaped++;
            }
        }
        return reaped;
    }
    /** Shut down all shared resources. */
    async shutdown() {
        this.sessions.clear();
        await this.embeddings.dispose();
        await this.store.dispose();
    }
}
