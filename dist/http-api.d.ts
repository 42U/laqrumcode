/**
 * Internal HTTP API on Unix socket for hook communication.
 *
 * The MCP server is the long-lived daemon; hook scripts are ephemeral.
 * Hooks discover this server via the .kongcode.sock file and POST
 * Claude Code hook payloads. The server processes them using the
 * shared GlobalPluginState and returns hook response JSON.
 */
import type { GlobalPluginState } from "./engine/state.js";
interface HealthCacheSnapshot {
    /** Last refresh timestamp (Date.now()). null = never refreshed yet. */
    refreshedAt: number | null;
    /** Was the store reachable at last refresh? */
    dbConnected: boolean;
    /** Backlog of pending_work rows in 'pending' status. -1 = not yet measured. */
    pendingWorkCount: number;
    /** Aggregate embedding-gap percentage across concept/memory/turn/artifact. -1 = not yet measured. */
    embeddingGapPct: number;
}
/** Record a daemon-side error timestamp, exposed via /health's last_error_ms_ago.
 *  Internal — called from the request error catch and any future error path
 *  that wants to be surfaced through /health. The optional `message` arg is
 *  accepted but only the timestamp is tracked through /health; callers that
 *  also want the message logged should pass it to `log.error` separately. */
declare function recordLastError(_message?: string): void;
/** Public /health responder. Auth-free. Returns ONLY the minimum needed for
 *  external liveness probes: a status grade and db_connection bool. No pid,
 *  no version, no memory_usage, no uptime — those leak host-fingerprint
 *  details to anyone who can reach the Unix socket (which on many setups
 *  is just "any local user"). Detailed shape lives at /health/detailed
 *  behind the bearer token (same gate as /hook/*).
 *
 *  Status grading:
 *    initializing → state is null OR the background health cache has not yet
 *                   completed its first refresh → 503. External probes use
 *                   this to back off rather than treating the daemon as
 *                   permanently broken during startup.
 *    error        → DB unreachable right now (regardless of cache) → 503
 *    degraded     → DB up but embedding_gap_pct > 15 OR pending_work_count > 50
 *    ok           → DB up and within thresholds */
declare function buildHealthResponse(state: GlobalPluginState | null): {
    status: number;
    body: Record<string, unknown>;
};
/** Auth-gated /health/detailed responder. Returns the full diagnostic shape
 *  (pid, version, uptime, memory, last-error, cached counts). Bearer token
 *  required — same secret as /hook/* — so a local-socket attacker can't
 *  cheaply fingerprint the daemon. */
declare function buildHealthDetailedResponse(state: GlobalPluginState | null): {
    status: number;
    body: Record<string, unknown>;
};
/** Hook response format matching Claude Code's expected output.
 *
 * IMPORTANT: `additionalContext` must be inside `hookSpecificOutput` with a
 * matching `hookEventName` — Claude Code's Zod schema silently strips
 * unknown top-level keys. Top-level fields are only: continue,
 * suppressOutput, decision, reason, stopReason, systemMessage, hookSpecificOutput.
 *
 * PreToolUse blocking (0.7.47+) uses `hookSpecificOutput.permissionDecision`
 * and `permissionDecisionReason` — the documented modern contract. The older
 * top-level `decision: "approve" | "block"` is for Stop hooks.
 */
export interface HookResponse {
    continue?: boolean;
    suppressOutput?: boolean;
    /** Warning shown in UI — NOT sent to the model. */
    systemMessage?: string;
    stopReason?: string;
    hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
        /** PreToolUse only: gate the tool call. */
        permissionDecision?: "allow" | "deny" | "ask";
        /** PreToolUse only: reason text shown to the agent on deny. */
        permissionDecisionReason?: string;
        [key: string]: unknown;
    };
    /** For Stop hooks: approve or block the stop. */
    decision?: "approve" | "block";
    reason?: string;
}
/** Helper: wrap additionalContext in the hookSpecificOutput envelope Claude Code expects. */
export declare function makeHookOutput(eventName: string, additionalContext?: string, extra?: Record<string, unknown>): HookResponse;
type HookHandler = (state: GlobalPluginState, payload: Record<string, unknown>) => Promise<HookResponse>;
/** Register a hook handler for an event. */
export declare function registerHookHandler(event: string, handler: HookHandler): void;
/** Read /proc/<pid>/cmdline on Linux and check it looks like a kongcode
 *  MCP-client process. Mirrors `cmdlineLooksLikeKongcodeDaemon` in
 *  src/daemon/index.ts (~L371) but matches the per-session MCP relay rather
 *  than the long-lived daemon: substrings like 'mcp-client/index.js',
 *  'kongcode-mcp', or 'kongcode' alongside an mcp-ish path component.
 *
 *  Returns true  → confirmed to be a kongcode MCP (safe to SIGTERM)
 *  Returns false → confirmed to be a different process (do NOT SIGTERM — PID was recycled)
 *  Returns null  → cannot determine (non-Linux, or /proc unreadable) */
declare function cmdlineLooksLikeKongcodeMcp(pid: number): boolean | null;
/**
 * Remove `.kongcode-<pid>.sock` files in `dir` whose PID is no longer alive.
 * Skips ownPid and any PID that exists but we can't signal (EPERM).
 *
 * Also reaps live sibling MCPs by sending SIGTERM to their PIDs (default on).
 * The hook proxy routes to whichever per-PID socket has the newest mtime, so
 * older MCPs become unreachable after a Claude Code restart and just sit
 * holding memory until killed manually. Reaping closes that loop.
 *
 * SAFETY (round-2): before SIGTERMing a PID derived from the socket filename
 * we verify via /proc/<pid>/cmdline that it actually IS a kongcode MCP
 * process. PIDs can recycle quickly under load — a daemon restart could find
 * the socket file's PID number now belongs to an unrelated user process, and
 * the original behavior would SIGTERM that innocent process. Verification
 * mirrors the cmdlineLooksLikeKongcodeDaemon pattern used in
 * src/daemon/index.ts for daemon.pid lock validation.
 *
 * Non-Linux platforms (no /proc): cmdline check returns null and we
 * CONSERVATIVELY skip the SIGTERM — only unlink if the PID is already dead.
 *
 * Set `KONGCODE_KEEP_SIBLINGS=1` to opt out — required when running multiple
 * Claude Code windows simultaneously, since each window has its own MCP and
 * killing siblings would orphan the others. Single-window users (the common
 * case) want default-on behavior so no zombies linger.
 */
export declare function sweepStaleSockets(dir: string, ownPid: number): void;
/**
 * Start the internal HTTP API.
 * Listens on a Unix socket (preferred) or localhost:0 (fallback).
 */
export declare function startHttpApi(state: GlobalPluginState, sock?: string, projectDir?: string): Promise<void>;
/** Stop the internal HTTP API and clean up socket/port files. */
export declare function stopHttpApi(): Promise<void>;
/**
 * Test-only handle: exposes the synchronous /health builder + cache state so
 * the test suite can verify the response shape and 503-on-DB-down behavior
 * without standing up a real HTTP listener. Not part of the public API.
 * @internal
 */
export declare const __testing: {
    buildHealthResponse: typeof buildHealthResponse;
    buildHealthDetailedResponse: typeof buildHealthDetailedResponse;
    healthCache: HealthCacheSnapshot;
    recordLastError: typeof recordLastError;
    cmdlineLooksLikeKongcodeMcp: typeof cmdlineLooksLikeKongcodeMcp;
    resetHealthCache(): void;
};
export {};
