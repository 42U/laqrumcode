/**
 * Internal HTTP API on Unix socket for hook communication.
 *
 * The MCP server is the long-lived daemon; hook scripts are ephemeral.
 * Hooks discover this server via the .kongcode.sock file and POST
 * Claude Code hook payloads. The server processes them using the
 * shared GlobalPluginState and returns hook response JSON.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve as resolvePath } from "node:path";
import { platform } from "node:os";
import type { GlobalPluginState } from "./engine/state.js";
import { log } from "./engine/log.js";
import { raceWithDeadline } from "./engine/surreal.js";
import { startUiServer, stopUiServer } from "./ui-server.js";

let server: HttpServer | null = null;
let socketPath: string | null = null;
let portFilePath: string | null = null;
let authToken: string | null = null;
let authTokenPath: string | null = null;

// ── /health diagnostic state ──────────────────────────────────────────
//
// Agent E flagged that the existing minimal `/health` (just `{ok:true}`) is
// insufficient to detect a hung-but-not-crashed daemon. The endpoint must
// remain CHEAP and SYNCHRONOUS — a hung DB shouldn't block ops from probing
// liveness. We cache the DB-derived fields (pending_work_count, embedding_gap_pct)
// on a background interval and the request handler returns the cached snapshot.

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

const healthCache: HealthCacheSnapshot = {
  refreshedAt: null,
  dbConnected: false,
  pendingWorkCount: -1,
  embeddingGapPct: -1,
};

/** ms timestamp of the last error logged through the HTTP API path. */
let lastErrorAt: number | null = null;

/** Process start time used for `uptime_ms`. Set on module load (the daemon
 *  process this http-api lives in starts at module load). */
const HTTP_API_STARTED_AT = Date.now();

/** Daemon version, resolved once at module load. Read from injected define
 *  (SEA bundle) or package.json (dev). Falls back to "0.0.0" if neither found. */
const DAEMON_VERSION: string = (() => {
  // @ts-expect-error — replaced by esbuild --define at bundle time
  try { if (typeof __KONGCODE_VERSION__ === "string") return __KONGCODE_VERSION__; } catch {}
  // Try walking up from this module's location for package.json. The compiled
  // dist/ layout places this file two dirs deep relative to package.json.
  for (const candidate of [
    join(process.cwd(), "package.json"),
    join(import.meta?.url ? new URL("../../package.json", import.meta.url).pathname : "", ""),
    join(import.meta?.url ? new URL("../package.json", import.meta.url).pathname : "", ""),
  ]) {
    if (!candidate) continue;
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {}
  }
  return "0.0.0";
})();

/** Background refresher handle. unref'd so it doesn't keep the event loop alive. */
let healthRefreshTimer: NodeJS.Timeout | null = null;

/** How often to refresh the DB-derived cached fields. 30s is cheap relative
 *  to typical poll cadences and keeps `/health` numbers fresh enough for ops. */
const HEALTH_REFRESH_INTERVAL_MS = 30_000;

/** H4: daemon-side execution deadline for a single hook handler dispatch.
 *
 *  The handler runs INSIDE the daemon's single event loop. The hook proxy has
 *  its own per-event budget (hook-proxy.cjs EVENT_TIMEOUTS_MS: 3s..55s) and on
 *  expiry calls req.destroy() — but that only closes the CLIENT socket; it does
 *  NOT abort the daemon-side handler. Under DB degradation a handler can keep
 *  the loop busy long after the proxy gave up (a 60s QUERY_DEADLINE_MS query
 *  plus a withRetry re-run ≈ 120s), starving every other session's hooks on
 *  the shared per-host daemon.
 *
 *  This is a SAFETY NET above the legitimate inner work, not the user-facing
 *  fail-open boundary (that stays the proxy's job). It must sit:
 *    - ABOVE the longest legitimate inner deadline (the UserPromptSubmit
 *      transform may run to 45s on a CPU tier — graph-context
 *      resolveTransformTimeoutMs), so healthy-but-slow work is never abandoned;
 *    - BELOW the largest proxy budget (55s) so on timeout we still return a
 *      response on THIS request and free the loop before the proxy would.
 *  50s threads that needle. On timeout we resolve the request fail-open ({})
 *  exactly like the catch path; the orphaned handler's own query deadline
 *  (QUERY_DEADLINE_MS) settles it in the background without blocking the loop
 *  on a bare un-raced await. Env-overridable; clamped to [1s, 10min]. */
const HOOK_HANDLER_DEADLINE_MS = (() => {
  const n = Number(process.env.KONGCODE_HOOK_HANDLER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 1_000), 600_000) : 50_000;
})();

/** Record a daemon-side error timestamp, exposed via /health's last_error_ms_ago.
 *  Internal — called from the request error catch and any future error path
 *  that wants to be surfaced through /health. The optional `message` arg is
 *  accepted but only the timestamp is tracked through /health; callers that
 *  also want the message logged should pass it to `log.error` separately. */
function recordLastError(_message?: string): void {
  lastErrorAt = Date.now();
}

/** Refresh the cached health fields from the store. Background only — never
 *  called from a request handler. Failures degrade the cache to "DB down" but
 *  do not throw. */
async function refreshHealthCache(state: GlobalPluginState): Promise<void> {
  // isAvailable() is a synchronous flag read, but ping() may exist on the
  // store and exercise an actual round-trip. Either is fine for the cached
  // field; the request-path uses isAvailable() directly so the cache value
  // here just informs the cached snapshot for clients reading older fields.
  try {
    healthCache.dbConnected = state.store.isAvailable();
  } catch {
    healthCache.dbConnected = false;
  }
  if (!healthCache.dbConnected) {
    healthCache.refreshedAt = Date.now();
    return;
  }
  // pending_work_count: claimable backlog — status='pending' AND active
  // (W2-04). Identical query to tools/memory-health.ts so the two surfaces
  // report the same number; both match fetch_pending_work's claim filter so
  // soft-archived forensic rows never read as backlog.
  try {
    const rows = await state.store.queryFirst<{ n: number }>(
      "SELECT count() AS n FROM pending_work WHERE status = 'pending' AND (active = true OR active IS NONE) GROUP ALL",
    );
    healthCache.pendingWorkCount = rows?.[0]?.n ?? 0;
  } catch (e) {
    recordLastError();
    log.warn(`[http-api] refreshHealthCache: pending_work count failed: ${(e as Error).message}`);
    // Leave previous value in place; -1 (initial) stays until first success.
  }
  // embedding_gap_pct: aggregate across concept/memory/turn/artifact. Same
  // formula as tools/memory-health.ts.
  try {
    const [conceptTotal, conceptEmb, memTotal, memEmb, turnTotal, turnEmb, artTotal, artEmb] = await Promise.all([
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM concept GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM concept WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM memory GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM memory WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM turn GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM turn WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM artifact GROUP ALL"),
      state.store.queryFirst<{ n: number }>("SELECT count() AS n FROM artifact WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
    ]);
    const total = (conceptTotal?.[0]?.n ?? 0) + (memTotal?.[0]?.n ?? 0) + (turnTotal?.[0]?.n ?? 0) + (artTotal?.[0]?.n ?? 0);
    const embedded = (conceptEmb?.[0]?.n ?? 0) + (memEmb?.[0]?.n ?? 0) + (turnEmb?.[0]?.n ?? 0) + (artEmb?.[0]?.n ?? 0);
    healthCache.embeddingGapPct = total > 0 ? Math.round(((total - embedded) / total) * 100) : 0;
  } catch (e) {
    recordLastError();
    log.warn(`[http-api] refreshHealthCache: embedding gap query failed: ${(e as Error).message}`);
  }
  healthCache.refreshedAt = Date.now();
}

/** Compute the {ok|degraded|error} status grade once — shared by both the
 *  public /health and the auth-gated /health/detailed responders. */
function gradeHealth(state: GlobalPluginState | null): { status: "ok" | "degraded" | "error"; dbAvailable: boolean } {
  const dbAvailable = state ? (() => { try { return state.store.isAvailable(); } catch { return false; } })() : false;
  let status: "ok" | "degraded" | "error";
  if (!dbAvailable) {
    status = "error";
  } else if (healthCache.embeddingGapPct > 15 || healthCache.pendingWorkCount > 50) {
    status = "degraded";
  } else {
    status = "ok";
  }
  return { status, dbAvailable };
}

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
function buildHealthResponse(state: GlobalPluginState | null): { status: number; body: Record<string, unknown> } {
  // "initializing" is its own 503 status separate from "error" so probes can
  // tell startup-in-progress from a broken daemon. Two triggers:
  //   - state is null (called before startHttpApi got a state ref)
  //   - the background refresher has not completed its first round yet
  //     (healthCache.refreshedAt === null)
  // Body is intentionally minimal — no status grade, no cache fields — only
  // db_connection so probes know whether the DB ping has at least been tried.
  if (state === null || healthCache.refreshedAt === null) {
    const dbAvailable = state ? (() => { try { return state.store.isAvailable(); } catch { return false; } })() : false;
    return {
      status: 503,
      body: { status: "initializing", db_connection: dbAvailable },
    };
  }
  const { status, dbAvailable } = gradeHealth(state);
  return {
    status: dbAvailable ? 200 : 503,
    body: { status, db_connection: dbAvailable },
  };
}

/** Auth-gated /health/detailed responder. Returns the full diagnostic shape
 *  (pid, version, uptime, memory, last-error, cached counts). Bearer token
 *  required — same secret as /hook/* — so a local-socket attacker can't
 *  cheaply fingerprint the daemon. */
function buildHealthDetailedResponse(state: GlobalPluginState | null): { status: number; body: Record<string, unknown> } {
  const now = Date.now();
  const { status, dbAvailable } = gradeHealth(state);
  const uptimeMs = now - HTTP_API_STARTED_AT;
  const memoryUsageMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const lastErrorMsAgo = lastErrorAt === null ? null : now - lastErrorAt;
  const body = {
    status,
    uptime_ms: uptimeMs,
    pid: process.pid,
    version: DAEMON_VERSION,
    daemon_uptime: uptimeMs, // alias kept for the task-specified shape
    db_connection: dbAvailable,
    pending_work_count: healthCache.pendingWorkCount,
    embedding_gap_pct: healthCache.embeddingGapPct,
    memory_usage_mb: memoryUsageMb,
    last_error_ms_ago: lastErrorMsAgo,
  };
  return { status: dbAvailable ? 200 : 503, body };
}

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
export function makeHookOutput(eventName: string, additionalContext?: string, extra?: Record<string, unknown>): HookResponse {
  if (!additionalContext && !extra) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      ...(additionalContext ? { additionalContext } : {}),
      ...extra,
    },
  };
}

type HookHandler = (
  state: GlobalPluginState,
  payload: Record<string, unknown>,
) => Promise<HookResponse>;

// Hook handler registry — populated in later phases
const handlers = new Map<string, HookHandler>();

/** Register a hook handler for an event. */
export function registerHookHandler(event: string, handler: HookHandler): void {
  handlers.set(event, handler);
}

/** H4: run a hook handler under a daemon-side execution deadline and ALWAYS
 *  resolve to a HookResponse (never reject).
 *
 *  A bare `await handler(...)` pins the daemon's single event loop for the
 *  full handler duration. Under DB degradation that can be ~120s (a 60s
 *  QUERY_DEADLINE_MS query + a withRetry re-run) — long after the hook proxy
 *  already timed out and called req.destroy(). req.destroy only closes the
 *  CLIENT socket; it does NOT abort this handler, so the orphaned handler keeps
 *  burning the shared loop and starves every other session's hooks.
 *
 *  Racing the handler against HOOK_HANDLER_DEADLINE_MS lets us return a
 *  response on THIS request and free the loop. The orphaned handler is left to
 *  settle in the background bounded by its own per-query deadline — we cannot
 *  truly abort it, but we stop AWAITING it, which is what unblocks the loop.
 *  The deadline sits ABOVE the longest legitimate inner work (the 45s
 *  UserPromptSubmit transform) and BELOW the largest proxy budget (55s), so a
 *  healthy-but-slow handler completes normally and only a genuinely-wedged one
 *  trips the net.
 *
 *  Fail-open is mandatory: on EITHER a deadline timeout OR a handler throw we
 *  return {} (the same response the pre-extraction catch produced), keeping the
 *  user's turn unblocked — the known-good hook fail-open boundary. The deadline
 *  case is logged distinctly so ops can name "the loop was held and we cut it
 *  loose" when other sessions report slow hooks. Exported via __testing. */
async function dispatchHookWithDeadline(
  handler: HookHandler,
  state: GlobalPluginState,
  payload: Record<string, unknown>,
  event: string,
  deadlineMs: number = HOOK_HANDLER_DEADLINE_MS,
): Promise<HookResponse> {
  try {
    return await raceWithDeadline(
      handler(state, payload),
      deadlineMs,
      `hook handler ${event}`,
    );
  } catch (err) {
    // Surface the failure through /health/detailed's last_error_ms_ago BEFORE
    // logging. The proxy fail-opens with {}, so without this the only signal of
    // a broken/wedged handler is the daemon log — ops probes would see clean
    // state otherwise.
    const msg = err instanceof Error ? err.message : String(err);
    recordLastError(msg);
    if (err instanceof Error && /deadline exceeded/.test(msg)) {
      log.error(`Hook handler [${event}] exceeded daemon deadline (${deadlineMs}ms) — failing open and freeing the event loop; handler continues in background, bounded by its own query deadline`);
    } else {
      log.error(`Hook handler error [${event}]: ${msg || "unknown"}`);
    }
    return {}; // Fail open — never block the user's turn on a kongcode problem.
  }
}

async function handleRequest(
  state: GlobalPluginState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Public /health: auth-free, minimal shape. Just status+db_connection.
  // Synchronous: reads cached snapshot, no DB round-trip on the request path,
  // so a hung DB still allows the probe to detect it via status=error/503.
  if (req.method === "GET" && req.url === "/health") {
    const { status, body } = buildHealthResponse(state);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Detailed /health/detailed: full diagnostic shape (pid, version, uptime,
  // memory, cached counts). Bearer-token gated so local-socket attackers
  // can't fingerprint the daemon for free. Same secret as /hook/*.
  if (req.method === "GET" && req.url === "/health/detailed") {
    if (authToken) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!bearer || bearer.length !== authToken.length ||
          !timingSafeEqual(Buffer.from(bearer), Buffer.from(authToken))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    const { status, body } = buildHealthDetailedResponse(state);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Hook endpoints: POST /hook/<event-name>
  if (req.method === "POST" && req.url?.startsWith("/hook/")) {
    if (authToken) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!bearer || bearer.length !== authToken.length ||
          !timingSafeEqual(Buffer.from(bearer), Buffer.from(authToken))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    const event = req.url.slice("/hook/".length);

    // Read body (capped at 8 MB to prevent OOM from malicious payloads)
    const chunks: Buffer[] = [];
    let bodyLen = 0;
    const MAX_BODY = 8 * 1024 * 1024;
    for await (const chunk of req) {
      bodyLen += (chunk as Buffer).length;
      if (bodyLen > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      // Empty or invalid JSON — use empty payload
    }

    // Find handler
    const handler = handlers.get(event);
    if (!handler) {
      // No handler registered — pass through (allow)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    // H4: dispatch under a daemon-side deadline; always fail-open to {} on
    // timeout or throw so the request completes and the event loop is freed.
    const response = await dispatchHookWithDeadline(handler, state, payload, event);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // Unknown route
  res.writeHead(404);
  res.end("Not found");
}

/** Read /proc/<pid>/cmdline on Linux and check it looks like a kongcode
 *  MCP-client process. Mirrors `cmdlineLooksLikeKongcodeDaemon` in
 *  src/daemon/index.ts (~L371) but matches the per-session MCP relay rather
 *  than the long-lived daemon: substrings like 'mcp-client/index.js',
 *  'kongcode-mcp', or 'kongcode' alongside an mcp-ish path component.
 *
 *  Returns true  → confirmed to be a kongcode MCP (safe to SIGTERM)
 *  Returns false → confirmed to be a different process (do NOT SIGTERM — PID was recycled)
 *  Returns null  → cannot determine (non-Linux, or /proc unreadable) */
function cmdlineLooksLikeKongcodeMcp(pid: number): boolean | null {
  if (platform() !== "linux") return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!raw) return false;
    // cmdline is NUL-separated; rejoin with spaces for substring tests.
    const joined = raw.replace(/\0/g, " ").toLowerCase();
    if (!joined.includes("node")) return false;
    if (joined.includes("mcp-client/index.js") || joined.includes("mcp-client/index.cjs")) return true;
    if (joined.includes("kongcode-mcp")) return true;
    if (joined.includes("kongcode") && joined.includes("mcp")) return true;
    return false;
  } catch {
    // /proc/<pid>/cmdline missing → PID isn't running. Caller treats this
    // as 'stale, safe to unlink' via the separate process.kill(pid,0) probe.
    return false;
  }
}

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
export function sweepStaleSockets(dir: string, ownPid: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const keepSiblings = process.env.KONGCODE_KEEP_SIBLINGS === "1";
  let removedFiles = 0;
  let reapedLive = 0;
  let skippedForeign = 0;
  for (const name of entries) {
    const m = /^\.kongcode-(\d+)\.sock$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid === ownPid) continue;
    let alive = true;
    let foreign = false;
    try {
      process.kill(pid, 0);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      alive = code !== "ESRCH";
      foreign = code === "EPERM";
    }
    if (alive && !foreign && !keepSiblings) {
      // Verify PID actually points at a kongcode MCP before signalling. PIDs
      // recycle; a stale socket file might name a number that's now an
      // innocent user process. cmdline check returns:
      //   true  → kongcode MCP confirmed, SIGTERM safe
      //   false → different process (recycled PID) → skip SIGTERM, just unlink the orphan
      //   null  → non-Linux (no /proc), can't verify → skip SIGTERM to be safe
      const looksLike = cmdlineLooksLikeKongcodeMcp(pid);
      if (looksLike === true) {
        try {
          process.kill(pid, "SIGTERM");
          reapedLive++;
          // Sibling will unlink its own socket on graceful shutdown; remove
          // here too in case SIGTERM handling is slow or absent.
          try { unlinkSync(`${dir}/${name}`); removedFiles++; } catch { /* ignore */ }
        } catch { /* ignore — race or perms */ }
        continue;
      }
      // PID alive but isn't us → recycled. Unlink the orphan socket file but
      // do NOT signal the stranger.
      skippedForeign++;
      try { unlinkSync(`${dir}/${name}`); removedFiles++; } catch { /* ignore */ }
      continue;
    }
    if (alive) continue;
    try {
      unlinkSync(`${dir}/${name}`);
      removedFiles++;
    } catch { /* ignore */ }
  }
  if (removedFiles > 0) log.info(`Swept ${removedFiles} stale kongcode socket file(s)`);
  if (reapedLive > 0) log.info(`Reaped ${reapedLive} sibling MCP process(es) (set KONGCODE_KEEP_SIBLINGS=1 to opt out)`);
  if (skippedForeign > 0) log.info(`Skipped SIGTERM on ${skippedForeign} recycled PID(s) — cmdline did not match kongcode MCP`);
}

/**
 * Start the internal HTTP API.
 * Listens on a Unix socket (preferred) or localhost:0 (fallback).
 */
export async function startHttpApi(
  state: GlobalPluginState,
  sock?: string,
  projectDir?: string,
): Promise<void> {
  const cacheDir = join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".kongcode", "cache");
  try {
    authToken = randomBytes(24).toString("hex");
    authTokenPath = join(cacheDir, "auth-token");
    // Sweep orphan auth-token tmpfiles from previously-crashed daemons before
    // the O_EXCL open below. Without this, a prior daemon that crashed
    // between openSync and renameSync leaves `auth-token.<pid>.tmp` on disk;
    // if the kernel later recycles that PID for us, our O_EXCL open here
    // fails with EEXIST and the daemon refuses to start. Worse, even when
    // PIDs don't collide, those tmpfiles accumulate forever.
    //
    // Sweep rules: for each `auth-token.<digits>.tmp`, parse the PID.
    //   - If the PID is alive AND its cmdline looks like a kongcode MCP,
    //     leave it alone — another live daemon owns that tmpfile.
    //   - Otherwise unlink it (orphan from a crashed daemon, or recycled
    //     PID now owned by an unrelated process).
    try {
      const cacheEntries = readdirSync(cacheDir);
      for (const name of cacheEntries) {
        const m = /^auth-token\.(\d+)\.tmp$/.exec(name);
        if (!m) continue;
        const orphanPid = Number(m[1]);
        if (!Number.isFinite(orphanPid)) continue;
        let alive = true;
        try {
          process.kill(orphanPid, 0);
        } catch (e: unknown) {
          const code = (e as NodeJS.ErrnoException)?.code;
          alive = code !== "ESRCH";
        }
        // Live PID + cmdline matches kongcode MCP → leave it alone.
        // Anything else (dead PID, recycled PID owned by stranger, or a
        // non-Linux box where we can't verify cmdline) → unlink the orphan.
        // On non-Linux, cmdlineLooksLikeKongcodeMcp returns null; treat null
        // as "not us" so the orphan gets cleaned (the only daemon that could
        // legitimately own it would be ourselves, and our PID hasn't written
        // the tmpfile yet at this point in startHttpApi).
        if (alive && cmdlineLooksLikeKongcodeMcp(orphanPid) === true) continue;
        try { unlinkSync(join(cacheDir, name)); } catch { /* ignore */ }
      }
    } catch { /* cacheDir missing — openSync below will surface the real error */ }
    // Atomic write: tmpfile + rename so a crash mid-write can never leave a
    // truncated/empty auth-token file. Two extra constraints on top of the
    // bare rename pattern:
    //   1. tmpfile name includes our PID — two concurrent daemon starts (e.g.
    //      a fast restart racing the prior process's exit handler) won't
    //      overwrite each other's tmpfile or rename a half-written stranger.
    //   2. open with O_CREAT|O_EXCL|O_TRUNC + mode 0o600 so we ALWAYS create
    //      a fresh file at exactly the right mode. writeFileSync's mode arg
    //      is ignored on pre-existing files (umask path), which would leak a
    //      0o644 tmpfile if one was left behind by a prior crash. Failing-
    //      noisily with EEXIST when that happens is the safe default; the
    //      catch below logs and rethrows so the daemon refuses to start
    //      unauthenticated rather than reuse a stale tmpfile.
    const tmpPath = `${authTokenPath}.${process.pid}.tmp`;
    const fd = openSync(
      tmpPath,
      fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, authToken);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, authTokenPath);
    log.info("[http-api] auth token written to", authTokenPath);
  } catch (err) {
    log.error("[http-api] FATAL: failed to write auth token — refusing to start unauthenticated:", err);
    throw err;
  }

  server = createServer((req, res) => {
    handleRequest(state, req, res).catch(err => {
      recordLastError();
      log.error(`HTTP API error: ${err instanceof Error ? err.message : "unknown"}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal error");
      }
    });
  });

  // Start background /health cache refresher. Runs cheap COUNT queries off
  // the request path so the /health endpoint stays synchronous and won't
  // block on a hung DB. Fire one immediately so the first /health call
  // after startup has populated values (catch in async wrapper — never
  // throws into startup). unref'd so it doesn't keep the loop alive.
  refreshHealthCache(state).catch(e => {
    log.warn(`[http-api] initial health cache refresh failed: ${(e as Error).message}`);
  });
  if (healthRefreshTimer) {
    clearInterval(healthRefreshTimer);
    healthRefreshTimer = null;
  }
  healthRefreshTimer = setInterval(() => {
    refreshHealthCache(state).catch(e => {
      log.warn(`[http-api] health cache refresh failed: ${(e as Error).message}`);
    });
  }, HEALTH_REFRESH_INTERVAL_MS);
  healthRefreshTimer.unref?.();

  // Read-only web UI (GH #15): a dedicated 127.0.0.1 TCP listener, since the
  // hook HTTP API below is UDS-only and a browser can't reach it. Never fatal
  // to daemon startup; inert until the frontend bundle (dist/ui/) exists.
  await startUiServer(state, authToken!).catch((e) => {
    log.warn(`[http-api] UI server start failed (non-fatal): ${(e as Error).message}`);
  });

  if (sock) {
    // Sweep sibling sockets whose owning MCP process is dead. Uses
    // ESRCH-only detection so a foreign-owned (EPERM) PID is left alone.
    sweepStaleSockets(dirname(sock), process.pid);
    // Clean up our own stale socket file from a prior crash with same PID
    if (existsSync(sock)) {
      try { unlinkSync(sock); } catch { /* ignore */ }
    }
    socketPath = sock;
    try {
      await new Promise<void>((resolve, reject) => {
        server!.listen(sock, () => {
          log.info(`HTTP API listening on Unix socket: ${sock}`);
          resolve();
        });
        server!.once("error", reject);
      });
      try { chmodSync(sock, 0o600); } catch {}
      return;
    } catch (err) {
      log.warn(`Unix socket failed, falling back to TCP:`, err);
      socketPath = null;
    }
  }

  // Fallback: random port — write port file so hook proxy can discover us
  await new Promise<void>((resolve, reject) => {
    server!.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") {
        log.info(`HTTP API listening on port ${addr.port}`);
        const dir = resolvePath(projectDir || process.cwd());
        portFilePath = join(dir, ".kongcode-port");
        try {
          writeFileSync(portFilePath, String(addr.port), { mode: 0o600 });
          log.info(`Port file written: ${portFilePath}`);
        } catch (e) {
          log.warn(`Failed to write port file:`, e);
        }
      }
      resolve();
    });
    server!.once("error", reject);
  });
}

/** Stop the internal HTTP API and clean up socket/port files. */
export async function stopHttpApi(): Promise<void> {
  await stopUiServer();
  if (healthRefreshTimer) {
    clearInterval(healthRefreshTimer);
    healthRefreshTimer = null;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (socketPath && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    socketPath = null;
  }
  if (portFilePath && existsSync(portFilePath)) {
    try { unlinkSync(portFilePath); } catch { /* ignore */ }
    portFilePath = null;
  }
  if (authTokenPath && existsSync(authTokenPath)) {
    try { unlinkSync(authTokenPath); } catch { /* ignore */ }
    authTokenPath = null;
    authToken = null;
  }
}

/**
 * Test-only handle: exposes the synchronous /health builder + cache state so
 * the test suite can verify the response shape and 503-on-DB-down behavior
 * without standing up a real HTTP listener. Not part of the public API.
 * @internal
 */
export const __testing = {
  buildHealthResponse,
  buildHealthDetailedResponse,
  healthCache,
  recordLastError,
  cmdlineLooksLikeKongcodeMcp,
  // H4: the deadline-wrapped hook dispatcher + its configured budget, so the
  // regression test can prove a slow handler fails open fast (loop freed)
  // without standing up the full HTTP listener.
  dispatchHookWithDeadline,
  HOOK_HANDLER_DEADLINE_MS,
  resetHealthCache(): void {
    healthCache.refreshedAt = null;
    healthCache.dbConnected = false;
    healthCache.pendingWorkCount = -1;
    healthCache.embeddingGapPct = -1;
    lastErrorAt = null;
  },
};
