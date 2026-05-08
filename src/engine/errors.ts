/**
 * Lightweight error swallowing with severity levels.
 *
 * - swallow(ctx, e)       — SILENT: expected degradation (embeddings offline, non-critical telemetry).
 *                           Only visible with KONGCODE_DEBUG=1.
 * - swallow.warn(ctx, e)  — WARN: unexpected but recoverable (DB query failure, compaction failure).
 *                           Always logged to stderr.
 * - swallow.error(ctx, e) — ERROR: something is genuinely broken (cleanup failure, schema failure).
 *                           Always logged to stderr with stack trace.
 */

import { log } from "./log.js";

const DEBUG = process.env.KONGCODE_DEBUG === "1";

/**
 * Swallow an error silently. Only visible with KONGCODE_DEBUG=1.
 * Use for expected degradation (embeddings down, non-critical graph edges).
 */
function swallow(context: string, err?: unknown): void {
  if (!DEBUG) return;
  const msg = err instanceof Error ? err.message : String(err ?? "unknown");
  log.debug(`[swallow] ${context}: ${msg}`);
}

/**
 * Swallow an error but log a warning. Always visible.
 * Use for unexpected-but-recoverable issues (DB failures, compaction failures).
 */
swallow.warn = function swallowWarn(context: string, err?: unknown): void {
  const msg = err instanceof Error ? err.message : String(err ?? "unknown");
  log.warn(`${context}: ${msg}`);
};

/**
 * Swallow an error but log an error. Always visible, includes stack.
 * Use for genuinely broken things (cleanup failure, schema failure).
 */
swallow.error = function swallowError(context: string, err?: unknown): void {
  const msg = err instanceof Error ? err.message : String(err ?? "unknown");
  let detail = "";
  if (DEBUG && err instanceof Error && err.stack) {
    detail = "\n" + err.stack;
  } else if (err instanceof Error && err.stack) {
    const firstFrame = err.stack.split("\n").find(l => l.trimStart().startsWith("at "));
    if (firstFrame) detail = ` (${firstFrame.trim()})`;
  }
  log.error(`${context}: ${msg}${detail}`);
};

export { swallow };
