import type { KongCodeConfig } from "./config.js";
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
    readonly config: KongCodeConfig;
    readonly store: SurrealStore;
    readonly embeddings: EmbeddingService;
    workspaceDir?: string;
    schemaApplied: boolean;
    private sessions;
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
    constructor(config: KongCodeConfig, store: SurrealStore, embeddings: EmbeddingService);
    /** Get or create a SessionState for the given session key. */
    getOrCreateSession(sessionKey: string, sessionId: string): SessionState;
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
    /** Reap sessions that have been idle for longer than maxAgeMs. */
    reapStaleSessions(maxAgeMs?: number): number;
    /**
     * Invoke every registered session-removed callback. Errors are swallowed
     * after a console.error so a bad callback can't strand the cleanup or
     * abort an end-of-session flush. Intentionally synchronous — the hot
     * SessionEnd path can't afford an extra microtask per callback.
     */
    private fireSessionRemovedCallbacks;
    /** Shut down all shared resources. */
    shutdown(): Promise<void>;
}
