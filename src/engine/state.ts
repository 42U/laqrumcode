import type { MemoryConfig } from "./config.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import type { AdaptiveConfig } from "./orchestrator.js";
import { makeCooldownState } from "./observability.js";

// --- Per-session mutable state ---

const DEFAULT_TOOL_LIMIT = 10;

/** Per-session mutable state: turn counters, daemon refs, 5-pillar IDs, and adaptive config. */
export class SessionState {
  readonly sessionId: string;
  readonly sessionKey: string;

  // Turn tracking
  lastUserTurnId = "";
  lastAssistantTurnId = "";
  lastUserText = "";
  lastAssistantText = "";
  /** Embedding of last user message from ingest — reused in buildContextualQueryVec to avoid re-embedding. */
  lastUserEmbedding: number[] | null = null;
  toolCallCount = 0;
  toolLimit = DEFAULT_TOOL_LIMIT;
  turnTextLength = 0;
  toolCallsSinceLastText = 0;
  softInterrupted = false;
  turnStartMs = Date.now();
  userTurnCount = 0;

  // Thinking capture
  readonly pendingThinking: string[] = [];

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
  currentConfig: AdaptiveConfig | null = null;

  // Turn-boundary telemetry — stashed at preflight, consumed at Stop to
  // drive postflight() which writes orchestrator_metrics. Without these
  // fields postflight had nothing to work with across hook boundaries, so
  // orchestrator_metrics stayed at 0 rows despite the writer being intact.
  _pendingPreflight: import("./orchestrator.js").PreflightResult | null = null;
  _pendingPreflightAt = 0;
  _pendingPreflightInput = "";
  _turnToolCalls = 0;
  _turnTokensInStart = 0;
  _turnTokensOutStart = 0;

  // Subagent tracking — map tool_use_id → subagent record id so SubagentStop
  // can find the row written by PreToolUse(Agent) and mark it complete.
  readonly _activeSubagents = new Map<string, string>();

  // Pending tool args for artifact tracking
  readonly pendingToolArgs = new Map<string, unknown>();

  // First-touch edit-gate state (0.7.47+). In-memory cache of file paths
  // and bash-command patterns the gate has cleared this session. Wiped on
  // idle timeout (default 30min, configurable via KONGCODE_GATE_TIMEOUT_MS).
  // Internal — do not inspect from outside engine/hooks/edit-gates.ts.
  readonly _editGateChecked = new Set<string>();
  _editGateLastActivity = 0;

  // Paths the agent has touched via file-aware tools (Read/Edit/Write/
  // MultiEdit) anywhere in this session. Populated by pre-tool-use.ts at
  // the top of every handler call so the edit-gate's "investigated" check
  // resolves immediately when a Read precedes an Edit in the same response
  // — at that point neither the Read nor the Edit has been ingested into
  // the turn table yet (Stop is what writes assistant tool I/O), so the
  // cold-path turn.text query would otherwise miss them. 0.7.48 fix.
  readonly _observedFilePaths = new Set<string>();

  // Post-push CI reminder: set by PostToolUse when a Bash call contains
  // "git push", consumed by Stop to inject a Tier-0 reminder telling the
  // agent to verify CI before declaring done. Structural gate — the agent
  // can't skip it because it fires automatically.
  _pushDetected = false;

  // Tool call optimization state (claw-code patterns)
  /** Query vector from this turn's context retrieval — used to detect redundant recall calls. */
  lastQueryVec: number[] | null = null;
  /** Summary of what graphTransformContext injected — shown in planning gate. */
  lastRetrievalSummary = "";
  /** API request cycle counter — hard cap prevents runaway token spend. */
  apiCycleCount = 0;
  /** Tracks which static context sections the model has already seen in the conversation window.
   *  Persists across turns (NOT cleared in resetTurn) — cleared only when messages drop from window. */
  readonly injectedSections = new Set<string>();

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
  _cachedPrevTurns?: { role: string; text: string; tool_name?: string; timestamp: string }[];
  /** Prefetch promise for previous-session turns — fires at session start, awaited in ensureRecentTurns. */
  _prevTurnsPrefetch?: Promise<{ role: string; text: string; tool_name?: string; timestamp: string }[]>;

  constructor(sessionId: string, sessionKey: string) {
    this.sessionId = sessionId;
    this.sessionKey = sessionKey;
  }

  /** Reset per-turn counters at the start of each prompt. */
  resetTurn(): void {
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
export type SessionRemovedCallback = (
  sessionId: string,
  surrealSessionId: string,
) => void;

/** Singleton shared state: config, SurrealDB store, embedding service, and session map. */
export class GlobalPluginState {
  readonly config: MemoryConfig;
  readonly store: SurrealStore;
  readonly embeddings: EmbeddingService;
  workspaceDir?: string;
  schemaApplied = false;
  private sessions = new Map<string, SessionState>();

  // Anomaly cooldown state (in-memory, resets on MCP restart). Per-flag
  // last-fired timestamps prevent spamming the model with the same alert
  // every turn while the underlying condition persists.
  readonly observabilityCooldown = makeCooldownState();

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
  private readonly sessionRemovedCallbacks = new Set<SessionRemovedCallback>();

  constructor(
    config: MemoryConfig,
    store: SurrealStore,
    embeddings: EmbeddingService,
  ) {
    this.config = config;
    this.store = store;
    this.embeddings = embeddings;
  }

  /** Get or create a SessionState for the given session key. */
  getOrCreateSession(sessionKey: string, sessionId: string): SessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = new SessionState(sessionId, sessionKey);
      session.midSessionCleanupThreshold = this.config.thresholds.midSessionCleanupThreshold;
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  /** Get an existing session by key. */
  getSession(sessionKey: string): SessionState | undefined {
    return this.sessions.get(sessionKey);
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
  onSessionRemoved(callback: SessionRemovedCallback): () => void {
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
  removeSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    if (!session) return;
    this.fireSessionRemovedCallbacks(session.sessionId, session.surrealSessionId);
  }

  /** Reap sessions that have been idle for longer than maxAgeMs. */
  reapStaleSessions(maxAgeMs = 2 * 60 * 60_000): number {
    const now = Date.now();
    let reaped = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.turnStartMs > maxAgeMs) {
        this.sessions.delete(key);
        this.fireSessionRemovedCallbacks(session.sessionId, session.surrealSessionId);
        reaped++;
      }
    }
    return reaped;
  }

  /**
   * Invoke every registered session-removed callback. Errors are swallowed
   * after a console.error so a bad callback can't strand the cleanup or
   * abort an end-of-session flush. Intentionally synchronous — the hot
   * SessionEnd path can't afford an extra microtask per callback.
   */
  private fireSessionRemovedCallbacks(sessionId: string, surrealSessionId: string): void {
    for (const callback of this.sessionRemovedCallbacks) {
      try {
        callback(sessionId, surrealSessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[state] onSessionRemoved callback threw:", err);
      }
    }
  }

  /** Shut down all shared resources. */
  async shutdown(): Promise<void> {
    this.sessions.clear();
    await this.embeddings.dispose();
    await this.store.dispose();
  }
}
