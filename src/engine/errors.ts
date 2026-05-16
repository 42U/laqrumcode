/**
 * Lightweight error swallowing with severity levels.
 *
 * - swallow(ctx, e)       — SILENT: expected degradation (embeddings offline, non-critical telemetry).
 *                           Only visible with KONGCODE_DEBUG=1.
 * - swallow.warn(ctx, e)  — WARN: unexpected but recoverable (DB query failure, compaction failure).
 *                           Always logged to stderr.
 * - swallow.error(ctx, e) — ERROR: something is genuinely broken (cleanup failure, schema failure).
 *                           Always logged to stderr with stack trace.
 *
 * Also exports `isUniqueViolation` — the single shared SurrealDB UNIQUE-index
 * rejection detector, reused by surreal.ts and the hook handlers that race
 * on UNIQUE-constrained CREATEs (subagent.correlation_key, artifact.path, etc).
 * One source of truth so the three detection layers (kind / name / message
 * regex) cannot drift between callers.
 */

import { log } from "./log.js";

const DEBUG = process.env.KONGCODE_DEBUG === "1";

/**
 * Canonical SurrealDB record-id validator. Matches `table:id` where the table
 * is a JS-style identifier and the id is `[a-zA-Z0-9_-]+`. Re-exported from
 * here so every caller that needs to reject malformed ids before a query
 * shares one source of truth.
 */
export const RECORD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-]+$/;

/**
 * Internal: extract a printable message from any thrown value. Used by the
 * three swallow variants so the "Error vs unknown vs null" coercion lives in
 * exactly one place.
 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown");
}

/**
 * SurrealDB UNIQUE-index violation detector.
 *
 * Detection layers (most specific first):
 *   1. `err.kind === "AlreadyExists"` — SurrealDB JS client error class
 *      (AlreadyExistsError extends ServerError, see node_modules/surrealdb
 *      surrealdb.d.ts). Matches both record-id and index UNIQUE violations
 *      at the wire level.
 *   2. `err.name === "AlreadyExistsError"` — same class via the name prop
 *      (constructor.name on the prototype chain).
 *   3. message regex fallback — older driver versions / re-wrapped errors
 *      that lose the `kind` field. Matches the same message pattern that
 *      test/dedup-integration.test.ts already asserts on.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { kind?: unknown; name?: unknown; message?: unknown };
  if (typeof e.kind === "string" && e.kind === "AlreadyExists") return true;
  if (typeof e.name === "string" && e.name === "AlreadyExistsError") return true;
  if (typeof e.message === "string") {
    return /\b(unique|already.{0,20}exists|database index.*contains|index.*already)/i.test(e.message);
  }
  return false;
}

/**
 * Swallow an error silently. Only visible with KONGCODE_DEBUG=1.
 * Use for expected degradation (embeddings down, non-critical graph edges).
 */
function swallow(context: string, err?: unknown): void {
  if (!DEBUG) return;
  log.debug(`[swallow] ${context}: ${errMsg(err)}`);
}

/**
 * Swallow an error but log a warning. Always visible.
 * Use for unexpected-but-recoverable issues (DB failures, compaction failures).
 */
swallow.warn = function swallowWarn(context: string, err?: unknown): void {
  log.warn(`${context}: ${errMsg(err)}`);
};

/**
 * Swallow an error but log an error. Always visible, includes stack.
 * Use for genuinely broken things (cleanup failure, schema failure).
 */
swallow.error = function swallowError(context: string, err?: unknown): void {
  let detail = "";
  if (DEBUG && err instanceof Error && err.stack) {
    detail = "\n" + err.stack;
  } else if (err instanceof Error && err.stack) {
    const firstFrame = err.stack.split(/\r?\n/).find(l => l.trimStart().startsWith("at "));
    if (firstFrame) detail = ` (${firstFrame.trim()})`;
  }
  log.error(`${context}: ${errMsg(err)}${detail}`);
};

export { swallow };

/**
 * Coerce a possibly-undefined/null value into a string id safely.
 *
 * R7 (hotfix): the R7 tightening "only strings in, strings out" silently
 * regressed every call site that consumes a SurrealDB driver row — the
 * driver returns `r.id` as a RecordId object, not a string. The
 * `typeof v === "string"` gate rejected every real id and the rows
 * downstream were dropped by `.filter(r => r.id)`. This revision keeps
 * R7's original intent (reject numbers / booleans / NaN that would
 * otherwise stringify to truthy junk like "0" / "false" / "NaN") while
 * accepting RecordId-like objects whose `.toString()` returns the
 * canonical `"table:id"` form. Plain objects with no useful toString
 * stringify to "[object Object]" — those still return "" so an upstream
 * projection bug (e.g. accidentally pulling a whole row into an id
 * column) still gets dropped at this boundary instead of propagating.
 */
export function safeId(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.length > 0 ? v : "";
  // Reject numeric/boolean falsy-stringifications that motivated R7's tightening
  if (typeof v === "number" || typeof v === "boolean") return "";
  // RecordId-like objects (and other reasonable shapes) — accept via toString
  if (typeof v === "object") {
    const s = String(v);
    return s.length > 0 && s !== "[object Object]" ? s : "";
  }
  return "";
}
