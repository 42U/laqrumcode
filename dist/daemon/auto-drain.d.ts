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
export declare const DRAIN_FAST_FAIL_MS = 120000;
export declare const DRAIN_FAILURE_COOLDOWN_THRESHOLD = 3;
export declare const DRAIN_COOLDOWN_BASE_MS: number;
export declare const DRAIN_COOLDOWN_MAX_MS: number;
/** Pure: cooldown for the Nth consecutive fast failure (0 = no cooldown). */
export declare function computeDrainCooldown(consecutiveFailures: number): number;
/** Pure: classify a finished drain run. "progress" resets the failure
 *  counter; "fast-failure" increments it; "neutral" (a long run with no queue
 *  progress — ambiguous, e.g. a slow extractor that crashed mid-item) leaves
 *  it unchanged so legitimate slow work never accrues a cooldown. */
export declare function classifyDrainOutcome(runtimeMs: number, queueBefore: number, queueAfter: number): "progress" | "fast-failure" | "neutral";
/** Test hook — reset backoff state between cases. */
export declare function resetDrainBackoffForTest(): void;
/** Build a minimal environment for the drain subprocess.
 *  The subprocess talks to the daemon over IPC — it never needs DB
 *  credentials, API keys, or other secrets from the parent. */
declare function buildDrainEnv(): Record<string, string | undefined>;
/** Look up the claude binary — env override, then PATH, then known locations.
 *  Cached after first lookup. Returns null if not findable; caller should
 *  log once and self-disable. */
declare function findClaudeBin(): string | null;
declare function pidFilePath(cacheDir: string): string;
declare function isPidAlive(pid: number): boolean;
/** Marker written into auto-drain.pid as JSON. The 'marker' field
 *  distinguishes a real drainer (or its parent daemon) from any other
 *  process that may have recycled the same PID. */
interface DrainLockMarker {
    marker: "kongcode-auto-drain";
    /** PID of the drainer child OR the daemon parent during the brief pre-spawn
     *  window between O_EXCL claim and child launch. */
    pid: number;
    /** Daemon process that owns this drain lifecycle. Used by the close-time
     *  identity check so a recycled drainer-PID can't fool us. */
    daemonPid: number;
    /** Wall-clock time the lock was claimed. */
    startedAt: number;
}
/** Check whether a PID's /proc cmdline looks like a plausible drainer.
 *  Returns true → looks like claude/node (likely real drainer)
 *  Returns false → confirmed different process (e.g. shell, browser)
 *  Returns null → cannot determine (non-Linux, or proc read failed)
 *
 *  We accept any cmdline containing 'claude' or 'node' since the auto-drain
 *  child is a detached `claude --agent ...` invocation which spawns a node
 *  subprocess. On macOS and Windows /proc doesn't exist, so we return null
 *  and callers fall back to PID-alive checking. */
declare function cmdlineLooksLikeDrainer(pid: number): boolean | null;
/** Parse the existing lock file. Returns the marker on success or null if
 *  the file is unreadable / unparseable / wrong shape. Tolerates legacy
 *  plain-PID files (returns a synthesized marker so callers can apply the
 *  same identity logic).
 *
 *  Implementation note: JSON.parse("12345") succeeds and returns a number,
 *  so we must check whether the parse produced an object-with-marker before
 *  falling back to bare-PID parsing — the catch-block alone isn't enough. */
declare function readLockMarker(lockPath: string): DrainLockMarker | null;
/** Try to acquire the auto-drain lock. Returns the fd on success, or null
 *  if another live drainer (verified by PID-alive AND cmdline) already
 *  owns it. Stale locks (dead PID, unparseable file, OR alive-PID-but-
 *  cmdline-doesn't-match-a-drainer i.e. recycled PID) are reclaimed.
 *
 *  IMPORTANT: The fd returned must be held open until the spawned child
 *  exits. Closing it early downgrades the lock to a regular file and lets
 *  the next drainer race in even though our child is still running. */
declare function tryAcquireLock(lockPath: string): number | null;
declare function releaseLock(fd: number, lockPath: string): void;
/** Write the daemon's interim marker into the freshly-claimed lock fd.
 *  Done immediately after tryAcquireLock so an external observer sees a
 *  valid identity even before the drainer child has been forked. */
declare function writeDaemonInterimMarker(fd: number): void;
/** Rewrite the lock fd with the child PID once spawn() succeeds. The fd is
 *  truncated first so an observer never sees a partial JSON document. */
declare function writeChildMarker(fd: number, childPid: number): void;
declare function spendingFilePath(cacheDir: string): string;
/** Legacy spending file kept around so existing installs migrate gracefully
 *  (any pre-existing count is treated as authoritative for the recorded
 *  date and merged with new ndjson entries). */
declare function legacySpendingFilePath(cacheDir: string): string;
/**
 * Daily-key helper — `YYYY-MM-DD` in UTC. Exported so the other modules that
 * roll per-UTC-day counters (stop.ts spending state, workspace-migrate.ts
 * roll-forward) stop reinventing `new Date().toISOString().slice(0, 10)`.
 */
export declare function todayUtc(): string;
interface SpendingState {
    date: string;
    count: number;
}
/** Read today's spawn count from the append-only deltas log. Counts only
 *  entries whose `date` matches today's UTC date so the per-day cap resets
 *  cleanly at UTC midnight without any rewrite. Tolerant of missing files
 *  and partial/truncated trailing lines (skipped silently — they don't
 *  count). Merges in any pre-existing legacy JSON's count for the same
 *  date so an upgrade doesn't reset a user's running cap. */
declare function readSpending(cacheDir: string): SpendingState;
/** Rewrite the spending file with only today's entries. Atomic via
 *  write-temp-then-rename. Silent on failure — the file stays large but
 *  remains parseable, so a failed prune just defers cleanup to a later call. */
declare function pruneStaleSpending(cacheDir: string): void;
/** Append one delta to the spending log. O_APPEND + a single write under
 *  PIPE_BUF is atomic on POSIX: even with two daemons racing (which the
 *  singleton lock should prevent, but belt-and-suspenders), each delta
 *  lands on its own line and the sum stays correct.
 *
 *  After append, if the file has grown past SPENDING_PRUNE_THRESHOLD_BYTES,
 *  rewrite it keeping only today's entries. Bounds growth at roughly one
 *  day's worth of activity (~5KB at the default 50/day cap). */
declare function bumpSpending(cacheDir: string): SpendingState;
/** Start the periodic drain scheduler. Idempotent — calling twice is a no-op. */
export declare function startDrainScheduler(state: GlobalPluginState, opts: DrainSchedulerOpts): void;
/** Stop the periodic drain scheduler (call during shutdown). */
export declare function stopDrainScheduler(): void;
/** Event-driven trigger — call from SessionEnd handler after items get queued. */
export declare function triggerDrainCheck(state: GlobalPluginState, opts: DrainSchedulerOpts, reason?: string): void;
/**
 * Test-only exports. Not part of the public API.
 * @internal
 */
export declare const __testing: {
    findClaudeBin: typeof findClaudeBin;
    resetClaudeBinCache: () => void;
    tryAcquireLock: typeof tryAcquireLock;
    releaseLock: typeof releaseLock;
    isPidAlive: typeof isPidAlive;
    readSpending: typeof readSpending;
    bumpSpending: typeof bumpSpending;
    pruneStaleSpending: typeof pruneStaleSpending;
    todayUtc: typeof todayUtc;
    spendingFilePath: typeof spendingFilePath;
    legacySpendingFilePath: typeof legacySpendingFilePath;
    pidFilePath: typeof pidFilePath;
    readLockMarker: typeof readLockMarker;
    writeDaemonInterimMarker: typeof writeDaemonInterimMarker;
    writeChildMarker: typeof writeChildMarker;
    cmdlineLooksLikeDrainer: typeof cmdlineLooksLikeDrainer;
    buildDrainEnv: typeof buildDrainEnv;
    SPENDING_PRUNE_THRESHOLD_BYTES: number;
};
export {};
