import { inspect } from "node:util";
import { statSync, renameSync, openSync, closeSync } from "node:fs";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

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
export const LOG_ROTATE_CAP_BYTES = 50 * 1024 * 1024; // 50MB

export function rotateLogIfOversized(path: string, capBytes: number = LOG_ROTATE_CAP_BYTES): boolean {
  try {
    const size = statSync(path).size; // throws ENOENT if absent → caught below
    if (size < capBytes) return false;
    const rotated = `${path}.1`;
    // rename() atomically replaces an existing .1 on POSIX. On the off chance
    // the platform/FS rejects an over-existing-target rename, the catch below
    // leaves the live log in place (no data loss, just no rotation this time).
    renameSync(path, rotated);
    // Best-effort: pre-create a fresh empty file so a reader that races the
    // caller's open still finds the log. Harmless if the caller opens first.
    try { closeSync(openSync(path, "a")); } catch { /* caller will create it */ }
    return true;
  } catch {
    // ENOENT (first run) or any rotate failure — NEVER block the caller.
    return false;
  }
}

const currentLevel: Level = (process.env.LAQRUMCODE_LOG_LEVEL as Level) ?? "warn";

if (currentLevel === "debug") {
  console.warn("[agent-memory] LAQRUMCODE_LOG_LEVEL=debug — logs may contain user prompts and query data. Do not use in shared environments.");
}

/**
 * Default console depth is 2, which collapses nested `.cause.cause` chains to
 * `[Object]`. Errors thrown across SurrealDB / async hops routinely carry a
 * `.cause` (and the cause carries its own cause), so we re-format any Error
 * argument with depth=6 before handing it to the underlying console method.
 * Non-Error args are passed through untouched so console formatting (printf
 * %s/%d substitution, colorization, etc.) still works for prefix strings.
 *
 * MED M6 (Round 6): cap string and array length inside the inspect output so
 * a single SurrealDB error carrying a multi-KB query payload (or a giant
 * embedding array on a wrapped error) cannot blow up daemon.log with
 * multi-megabyte lines that destroy log rotation and grepability. The 4096
 * char / 100 element budget keeps `.cause.cause` chains readable for forensic
 * work while ensuring no single log line dominates the file.
 */
function expandErrors(args: unknown[]): unknown[] {
  return args.map(a => {
    if (!(a instanceof Error)) return a;
    // R7 F4: inspect() can itself throw on pathological values — a Proxy with
    // a throwing get/getOwnPropertyDescriptor, a getter that throws, a
    // circular structure deeper than depth=6 that hits an internal limit.
    // If inspect blows up here it propagates out of every log.warn/log.error
    // call (including swallow.warn from the error paths themselves), masking
    // the original error with an inspect failure. Fall back to String(err)
    // so the log line still records something rather than crashing the call.
    try {
      return inspect(a, { depth: 6, maxStringLength: 4096, maxArrayLength: 100 });
    } catch {
      return String(a);
    }
  });
}

export const log = {
  error: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.error) console.error("[agent-memory]", ...expandErrors(args)); },
  warn: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.warn) console.warn("[agent-memory]", ...expandErrors(args)); },
  info: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.info) console.info("[agent-memory]", ...expandErrors(args)); },
  debug: (...args: unknown[]) => { if (LEVELS[currentLevel] >= LEVELS.debug) console.debug("[agent-memory]", ...expandErrors(args)); },
};
