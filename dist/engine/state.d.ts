import type { KongBrainConfig } from "./config.js";
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
    cleanedUp: boolean;
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
/** Singleton shared state: config, SurrealDB store, embedding service, and session map. */
export declare class GlobalPluginState {
    readonly config: KongBrainConfig;
    readonly store: SurrealStore;
    readonly embeddings: EmbeddingService;
    workspaceDir?: string;
    schemaApplied: boolean;
    private sessions;
    readonly observabilityCooldown: import("./observability.js").CooldownState;
    lastRollupDay: string;
    constructor(config: KongBrainConfig, store: SurrealStore, embeddings: EmbeddingService);
    /** Get or create a SessionState for the given session key. */
    getOrCreateSession(sessionKey: string, sessionId: string): SessionState;
    /** Get an existing session by key. */
    getSession(sessionKey: string): SessionState | undefined;
    /** Remove a session from the map (after dispose/cleanup). */
    removeSession(sessionKey: string): void;
    /** Return all active sessions (for exit handlers). */
    allSessions(): SessionState[];
    /** Reap sessions that have been idle for longer than maxAgeMs. */
    reapStaleSessions(maxAgeMs?: number): number;
    /** Shut down all shared resources. */
    shutdown(): Promise<void>;
}
