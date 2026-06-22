/**
 * H1 — single-generation log rotation, called at OPEN time (not per-write).
 *
 * daemon.log (daemon-spawn.ts) and auto-drain.log (auto-drain.ts) are opened
 * with O_APPEND and inherited by long-lived detached children, so they grow
 * FOREVER on the common single-host install that never restarts for weeks.
 * Nothing pruned them — only this comment's predecessor (the historical TODO
 * that lived here) acknowledged the gap.
 *
 * Strategy (dead-simple + crash-safe): just before opening a log for append,
 * stat it; if it is at/over `capBytes`, rename it to `<path>.1` (replacing any
 * prior `.1`), so the subsequent open creates a fresh empty file. ONE backup
 * generation is kept — bounded total disk is ~2x the cap per log, which is the
 * point. We deliberately do NOT gzip or keep N generations: the logs are a
 * forensic tail, not an archive, and extra machinery is extra failure surface.
 *
 * SAFETY (paramount): this can NEVER block or break logging.
 *   - A missing file (ENOENT on stat) is the normal first-run case → no-op.
 *   - ANY error (stat race, rename EACCES/EXDEV, a platform without rename
 *     semantics) is swallowed and the function returns normally, so the caller
 *     proceeds to open the (possibly still-oversized) log. A rotate failure
 *     degrades to "log keeps growing", never to "daemon won't start".
 *   - It does NOT truncate in place (which could race a concurrent appender and
 *     corrupt a partial line); rename is atomic on POSIX same-filesystem, and
 *     the fresh file is created by the caller's own openSync(...,"a").
 *
 * Returns true if it rotated, false otherwise — only for tests/diagnostics;
 * callers ignore it.
 */
export declare const LOG_ROTATE_CAP_BYTES: number;
export declare function rotateLogIfOversized(path: string, capBytes?: number): boolean;
export declare const log: {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
};
