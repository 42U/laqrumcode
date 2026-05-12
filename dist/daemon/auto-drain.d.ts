/**
 * Auto-drain scheduler — restores the auto-extraction behavior that lived in
 * the in-process MemoryDaemon before commit 4f7b962 (2026-04-07) removed the
 * Anthropic SDK. Instead of the daemon making its own LLM calls, we shell
 * out to `claude --agent kongcode:memory-extractor -p "..."` which invokes
 * the existing subagent definition via the user's already-authenticated
 * Claude Code CLI.
 *
 * Triggers:
 *   - Daemon startup (one-shot if queue > threshold)
 *   - Periodic timer (default 5min)
 *   - SessionEnd hook (debounced)
 *
 * Safety:
 *   - PID-file lock at <cacheDir>/auto-drain.pid prevents overlapping spawns
 *   - Threshold gate prevents draining tiny queues
 *   - claude binary lookup with graceful fallback (logs warning, self-disables)
 *
 * Env-var overrides:
 *   KONGCODE_AUTO_DRAIN=0          → disable scheduler entirely
 *   KONGCODE_AUTO_DRAIN_THRESHOLD  → min queue size to trigger (default 5)
 *   KONGCODE_AUTO_DRAIN_INTERVAL_MS → periodic check cadence (default 300_000)
 *   KONGCODE_CLAUDE_BIN            → explicit path to claude binary
 */
import type { GlobalPluginState } from "../engine/state.js";
interface DrainSchedulerOpts {
    /** Min pending count to trigger a drain. Below this, scheduler is a no-op. */
    threshold: number;
    /** Interval between periodic checks (ms). 0 = no periodic, only event-driven. */
    intervalMs: number;
    /** Cache dir for the PID lock file. */
    cacheDir: string;
    /** Max headless-drain spawns per UTC day. 0 = unlimited (default 50). Above
     *  this, scheduler logs a warning and skips. Cheap insurance against runaway
     *  loops since each spawn consumes the user's API quota. Resets when UTC
     *  date changes (state persisted to <cacheDir>/auto-drain-spending.json). */
    maxDaily: number;
}
/** Look up the claude binary — env override, then PATH, then known locations.
 *  Cached after first lookup. Returns null if not findable; caller should
 *  log once and self-disable. */
declare function findClaudeBin(): string | null;
declare function pidFilePath(cacheDir: string): string;
declare function isPidAlive(pid: number): boolean;
/** Try to acquire the auto-drain lock. Returns the fd on success, or null
 *  if another extractor is already running (live PID in lock file). Stale
 *  locks (dead PID) are auto-cleaned. */
declare function tryAcquireLock(lockPath: string): number | null;
declare function releaseLock(fd: number, lockPath: string): void;
declare function spendingFilePath(cacheDir: string): string;
declare function todayUtc(): string;
interface SpendingState {
    date: string;
    count: number;
}
/** Read today's spawn count from the spending file. Auto-resets to 0 if the
 *  recorded date is not today. Tolerant of missing/corrupt files. */
declare function readSpending(cacheDir: string): SpendingState;
declare function bumpSpending(cacheDir: string): SpendingState;
/** Start the periodic drain scheduler. Idempotent — calling twice is a no-op. */
export declare function startDrainScheduler(state: GlobalPluginState, opts: DrainSchedulerOpts): void;
/** Stop the periodic drain scheduler (call during shutdown). */
export declare function stopDrainScheduler(): void;
/** Event-driven trigger — call from SessionEnd handler after items get queued. */
export declare function triggerDrainCheck(state: GlobalPluginState, opts: DrainSchedulerOpts, reason?: string): void;
/** Test-only exports. Not part of the public API. */
export declare const __testing: {
    findClaudeBin: typeof findClaudeBin;
    resetClaudeBinCache: () => void;
    tryAcquireLock: typeof tryAcquireLock;
    releaseLock: typeof releaseLock;
    isPidAlive: typeof isPidAlive;
    readSpending: typeof readSpending;
    bumpSpending: typeof bumpSpending;
    todayUtc: typeof todayUtc;
    spendingFilePath: typeof spendingFilePath;
    pidFilePath: typeof pidFilePath;
};
export {};
