/**
 * Internal HTTP API on Unix socket for hook communication.
 *
 * The MCP server is the long-lived daemon; hook scripts are ephemeral.
 * Hooks discover this server via the .kongcode.sock file and POST
 * Claude Code hook payloads. The server processes them using the
 * shared GlobalPluginState and returns hook response JSON.
 */
import { createServer } from "node:http";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve as resolvePath } from "node:path";
import { platform } from "node:os";
import { log } from "./engine/log.js";
import { raceWithDeadline } from "./engine/surreal.js";
import { startUiServer, stopUiServer } from "./ui-server.js";
let server = null;
let socketPath = null;
let portFilePath = null;
let authToken = null;
let authTokenPath = null;
const healthCache = {
    refreshedAt: null,
    dbConnected: false,
    pendingWorkCount: -1,
    embeddingGapPct: -1,
};
/** ms timestamp of the last error logged through the HTTP API path. */
let lastErrorAt = null;
/** Process start time used for `uptime_ms`. Set on module load (the daemon
 *  process this http-api lives in starts at module load). */
const HTTP_API_STARTED_AT = Date.now();
/** Daemon version, resolved once at module load. Read from injected define
 *  (SEA bundle) or package.json (dev). Falls back to "0.0.0" if neither found. */
const DAEMON_VERSION = (() => {
    // @ts-expect-error — replaced by esbuild --define at bundle time
    try {
        if (typeof __KONGCODE_VERSION__ === "string")
            return __KONGCODE_VERSION__;
    }
    catch { }
    // Try walking up from this module's location for package.json. The compiled
    // dist/ layout places this file two dirs deep relative to package.json.
    for (const candidate of [
        join(process.cwd(), "package.json"),
        join(import.meta?.url ? new URL("../../package.json", import.meta.url).pathname : "", ""),
        join(import.meta?.url ? new URL("../package.json", import.meta.url).pathname : "", ""),
    ]) {
        if (!candidate)
            continue;
        try {
            const pkg = JSON.parse(readFileSync(candidate, "utf8"));
            if (typeof pkg.version === "string")
                return pkg.version;
        }
        catch { }
    }
    return "0.0.0";
})();
/** Background refresher handle. unref'd so it doesn't keep the event loop alive. */
let healthRefreshTimer = null;
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
// ── HTTP-HOOK-FD-ASYMMETRY: H5-equivalent accept policy for THIS listener ──
//
// The JSON-RPC DaemonServer got H5 (maxConnections + a persistent EMFILE/ENFILE
// accept-pause handler — server.ts applyConnectionPolicy). This HTTP hook
// listener is the OTHER transport in the SAME process (the two share the
// process fd table), yet it set no maxConnections and attached no steady-state
// 'error' handler. An accept-time EMFILE/ENFILE here emits an UNHANDLED 'error'
// on the http.Server — which crashes the per-host daemon and takes down EVERY
// session's hooks. The fix mirrors the H5 boundary: bound the open-socket count
// and degrade-don't-crash on fd exhaustion (pause accepting, then re-listen).
/** H5(http): hard ceiling on concurrently-OPEN hook-client sockets. Hooks are
 *  short-lived request/response (the proxy opens, POSTs, reads, closes), so the
 *  realistic concurrency is far below the JSON-RPC socket count — a smaller cap
 *  than the daemon's 512 leaves more of the shared fd budget for the daemon's
 *  own DB/embedder/log fds and the JSON-RPC listener. Past this, Node stops
 *  accepting and queues at the kernel backlog until sockets free.
 *  Override via KONGCODE_HOOK_MAX_CONNECTIONS. */
const HOOK_MAX_CONNECTIONS = (() => {
    const n = Number(process.env.KONGCODE_HOOK_MAX_CONNECTIONS);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 256;
})();
/** H5(http): how long to pause accepting after an EMFILE/ENFILE accept error
 *  before re-listening, instead of crash-looping on the same starved state.
 *  Mirrors the daemon's acceptPauseMs default. Override via
 *  KONGCODE_HOOK_ACCEPT_PAUSE_MS. */
const HOOK_ACCEPT_PAUSE_MS = (() => {
    const n = Number(process.env.KONGCODE_HOOK_ACCEPT_PAUSE_MS);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 1_000;
})();
/** H5(http): timers that resume accepting after an fd-exhaustion pause — tracked
 *  so stopHttpApi() can clear them. unref'd so they never keep the loop alive. */
const acceptResumeTimers = new Set();
/** H5(http): re-arm the hook listener on the SAME endpoint after an EMFILE/ENFILE
 *  accept pause. The hook server binds EITHER a UDS path (socketPath) OR a
 *  fallback TCP port (we recover the port from the bound address before close).
 *  Best-effort and never throws into the caller — a daemon that truly can't
 *  re-listen is left to the supervisor; the fail-open hook boundary already
 *  keeps user turns unblocked. Re-applies the connection policy on re-listen so
 *  the resumed server carries the same ceiling + 'error' handler. */
function relistenHookAfterPause(srv, fallbackPort) {
    if (srv.listening)
        return; // already accepting again
    const onErr = (e) => {
        log.error(`[http-api] re-listen error after accept pause: ${e.message}`);
    };
    srv.once("error", onErr);
    const onListening = () => {
        srv.removeListener("error", onErr);
        log.info("[http-api] resumed accepting after fd-exhaustion pause");
    };
    if (socketPath) {
        // Re-unlink any stale socket file left by the close() above before re-bind.
        if (existsSync(socketPath)) {
            try {
                unlinkSync(socketPath);
            }
            catch { /* ignore */ }
        }
        srv.listen(socketPath, () => {
            try {
                chmodSync(socketPath, 0o600);
            }
            catch { /* ignore */ }
            onListening();
        });
    }
    else if (fallbackPort != null) {
        srv.listen(fallbackPort, "127.0.0.1", onListening);
    }
    else {
        // No known endpoint to re-bind (shouldn't happen — listen always set one).
        srv.removeListener("error", onErr);
    }
}
/** H5(http): mirror the daemon's applyConnectionPolicy onto the hook listener.
 *
 *  (1) maxConnections — Node stops accepting past this count (queued at the
 *      kernel backlog) so a runaway hook-client count can't exhaust the shared
 *      process fd table and take down the JSON-RPC listener + every session.
 *
 *  (2) a PERSISTENT 'error' handler for accept-time fd exhaustion
 *      (EMFILE/ENFILE). Node emits these on the SERVER (not a socket) when
 *      accept() fails for lack of fds; the default is to THROW, and an uncaught
 *      http.Server 'error' crashes the daemon (then crash-loops on respawn into
 *      the same starved state). Instead we pause accepting (server.close()) and
 *      schedule a re-listen once fds have had a chance to free — the same
 *      "degrade, don't crash" boundary as server.ts. Any OTHER steady-state
 *      error is logged and swallowed (never rethrown) so a transient listener
 *      hiccup can't crash the per-host singleton.
 *
 *  This handler is attached for the server's whole lifetime — distinct from the
 *  one-shot bind-error listener listen() uses to detect EADDRINUSE/bind failure
 *  (that one is removed the moment listen succeeds). Exported via __testing. */
function applyHookConnectionPolicy(srv) {
    srv.maxConnections = HOOK_MAX_CONNECTIONS;
    srv.on("error", (err) => {
        const code = err.code;
        if (code === "EMFILE" || code === "ENFILE") {
            // Capture the bound TCP port (if any) BEFORE close() drops the address —
            // relisten needs it to re-bind the fallback path. UDS re-binds via the
            // module-level socketPath, so the port is only relevant when socketPath is
            // null. address() is { port } for TCP, a string for UDS, or null.
            let fallbackPort = null;
            if (!socketPath) {
                const addr = srv.address();
                if (addr && typeof addr === "object")
                    fallbackPort = addr.port;
            }
            let resumed = false;
            try {
                srv.close();
            }
            catch { /* may already be closing */ }
            recordLastError(`accept ${code}`);
            log.error(`[http-api] hook listener accept error ${code} (fd exhaustion) — pausing accept for ${HOOK_ACCEPT_PAUSE_MS}ms instead of crashing`);
            const timer = setTimeout(() => {
                acceptResumeTimers.delete(timer);
                if (resumed)
                    return;
                resumed = true;
                try {
                    relistenHookAfterPause(srv, fallbackPort);
                }
                catch (e) {
                    log.error(`[http-api] re-listen after accept pause failed: ${e.message}`);
                }
            }, HOOK_ACCEPT_PAUSE_MS);
            timer.unref?.();
            acceptResumeTimers.add(timer);
            return;
        }
        // Any other steady-state server error: log, don't rethrow — an uncaught
        // http.Server 'error' crashes the daemon, and the per-host singleton must
        // survive transient listener hiccups to keep serving other sessions' hooks.
        recordLastError(err.message);
        log.error(`[http-api] hook listener server error: ${err.message}`);
    });
}
/** Record a daemon-side error timestamp, exposed via /health's last_error_ms_ago.
 *  Internal — called from the request error catch and any future error path
 *  that wants to be surfaced through /health. The optional `message` arg is
 *  accepted but only the timestamp is tracked through /health; callers that
 *  also want the message logged should pass it to `log.error` separately. */
function recordLastError(_message) {
    lastErrorAt = Date.now();
}
/** Refresh the cached health fields from the store. Background only — never
 *  called from a request handler. Failures degrade the cache to "DB down" but
 *  do not throw. */
async function refreshHealthCache(state) {
    // isAvailable() is a synchronous flag read, but ping() may exist on the
    // store and exercise an actual round-trip. Either is fine for the cached
    // field; the request-path uses isAvailable() directly so the cache value
    // here just informs the cached snapshot for clients reading older fields.
    try {
        healthCache.dbConnected = state.store.isAvailable();
    }
    catch {
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
        const rows = await state.store.queryFirst("SELECT count() AS n FROM pending_work WHERE status = 'pending' AND (active = true OR active IS NONE) GROUP ALL");
        healthCache.pendingWorkCount = rows?.[0]?.n ?? 0;
    }
    catch (e) {
        recordLastError();
        log.warn(`[http-api] refreshHealthCache: pending_work count failed: ${e.message}`);
        // Leave previous value in place; -1 (initial) stays until first success.
    }
    // embedding_gap_pct: aggregate across concept/memory/turn/artifact. Same
    // formula as tools/memory-health.ts.
    try {
        const [conceptTotal, conceptEmb, memTotal, memEmb, turnTotal, turnEmb, artTotal, artEmb] = await Promise.all([
            state.store.queryFirst("SELECT count() AS n FROM concept GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM concept WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM memory GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM memory WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM turn GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM turn WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM artifact GROUP ALL"),
            state.store.queryFirst("SELECT count() AS n FROM artifact WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
        ]);
        const total = (conceptTotal?.[0]?.n ?? 0) + (memTotal?.[0]?.n ?? 0) + (turnTotal?.[0]?.n ?? 0) + (artTotal?.[0]?.n ?? 0);
        const embedded = (conceptEmb?.[0]?.n ?? 0) + (memEmb?.[0]?.n ?? 0) + (turnEmb?.[0]?.n ?? 0) + (artEmb?.[0]?.n ?? 0);
        healthCache.embeddingGapPct = total > 0 ? Math.round(((total - embedded) / total) * 100) : 0;
    }
    catch (e) {
        recordLastError();
        log.warn(`[http-api] refreshHealthCache: embedding gap query failed: ${e.message}`);
    }
    healthCache.refreshedAt = Date.now();
}
/** Compute the {ok|degraded|error} status grade once — shared by both the
 *  public /health and the auth-gated /health/detailed responders. */
function gradeHealth(state) {
    const dbAvailable = state ? (() => { try {
        return state.store.isAvailable();
    }
    catch {
        return false;
    } })() : false;
    let status;
    if (!dbAvailable) {
        status = "error";
    }
    else if (healthCache.embeddingGapPct > 15 || healthCache.pendingWorkCount > 50) {
        status = "degraded";
    }
    else {
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
function buildHealthResponse(state) {
    // "initializing" is its own 503 status separate from "error" so probes can
    // tell startup-in-progress from a broken daemon. Two triggers:
    //   - state is null (called before startHttpApi got a state ref)
    //   - the background refresher has not completed its first round yet
    //     (healthCache.refreshedAt === null)
    // Body is intentionally minimal — no status grade, no cache fields — only
    // db_connection so probes know whether the DB ping has at least been tried.
    if (state === null || healthCache.refreshedAt === null) {
        const dbAvailable = state ? (() => { try {
            return state.store.isAvailable();
        }
        catch {
            return false;
        } })() : false;
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
function buildHealthDetailedResponse(state) {
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
/** Helper: wrap additionalContext in the hookSpecificOutput envelope Claude Code expects. */
export function makeHookOutput(eventName, additionalContext, extra) {
    if (!additionalContext && !extra)
        return {};
    return {
        hookSpecificOutput: {
            hookEventName: eventName,
            ...(additionalContext ? { additionalContext } : {}),
            ...extra,
        },
    };
}
// Hook handler registry — populated in later phases
const handlers = new Map();
/** Register a hook handler for an event. */
export function registerHookHandler(event, handler) {
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
async function dispatchHookWithDeadline(handler, state, payload, event, deadlineMs = HOOK_HANDLER_DEADLINE_MS) {
    try {
        return await raceWithDeadline(handler(state, payload), deadlineMs, `hook handler ${event}`);
    }
    catch (err) {
        // Surface the failure through /health/detailed's last_error_ms_ago BEFORE
        // logging. The proxy fail-opens with {}, so without this the only signal of
        // a broken/wedged handler is the daemon log — ops probes would see clean
        // state otherwise.
        const msg = err instanceof Error ? err.message : String(err);
        recordLastError(msg);
        if (err instanceof Error && /deadline exceeded/.test(msg)) {
            log.error(`Hook handler [${event}] exceeded daemon deadline (${deadlineMs}ms) — failing open and freeing the event loop; handler continues in background, bounded by its own query deadline`);
        }
        else {
            log.error(`Hook handler error [${event}]: ${msg || "unknown"}`);
        }
        return {}; // Fail open — never block the user's turn on a kongcode problem.
    }
}
async function handleRequest(state, req, res) {
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
        const chunks = [];
        let bodyLen = 0;
        const MAX_BODY = 8 * 1024 * 1024;
        for await (const chunk of req) {
            bodyLen += chunk.length;
            if (bodyLen > MAX_BODY) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "payload too large" }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        }
        let payload = {};
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        }
        catch {
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
function cmdlineLooksLikeKongcodeMcp(pid) {
    if (platform() !== "linux")
        return null;
    try {
        const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!raw)
            return false;
        // cmdline is NUL-separated; rejoin with spaces for substring tests.
        const joined = raw.replace(/\0/g, " ").toLowerCase();
        if (!joined.includes("node"))
            return false;
        if (joined.includes("mcp-client/index.js") || joined.includes("mcp-client/index.cjs"))
            return true;
        if (joined.includes("kongcode-mcp"))
            return true;
        if (joined.includes("kongcode") && joined.includes("mcp"))
            return true;
        return false;
    }
    catch {
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
export function sweepStaleSockets(dir, ownPid) {
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return;
    }
    const keepSiblings = process.env.KONGCODE_KEEP_SIBLINGS === "1";
    let removedFiles = 0;
    let reapedLive = 0;
    let skippedForeign = 0;
    for (const name of entries) {
        const m = /^\.kongcode-(\d+)\.sock$/.exec(name);
        if (!m)
            continue;
        const pid = Number(m[1]);
        if (!Number.isFinite(pid) || pid === ownPid)
            continue;
        let alive = true;
        let foreign = false;
        try {
            process.kill(pid, 0);
        }
        catch (e) {
            const code = e?.code;
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
                    try {
                        unlinkSync(`${dir}/${name}`);
                        removedFiles++;
                    }
                    catch { /* ignore */ }
                }
                catch { /* ignore — race or perms */ }
                continue;
            }
            // PID alive but isn't us → recycled. Unlink the orphan socket file but
            // do NOT signal the stranger.
            skippedForeign++;
            try {
                unlinkSync(`${dir}/${name}`);
                removedFiles++;
            }
            catch { /* ignore */ }
            continue;
        }
        if (alive)
            continue;
        try {
            unlinkSync(`${dir}/${name}`);
            removedFiles++;
        }
        catch { /* ignore */ }
    }
    if (removedFiles > 0)
        log.info(`Swept ${removedFiles} stale kongcode socket file(s)`);
    if (reapedLive > 0)
        log.info(`Reaped ${reapedLive} sibling MCP process(es) (set KONGCODE_KEEP_SIBLINGS=1 to opt out)`);
    if (skippedForeign > 0)
        log.info(`Skipped SIGTERM on ${skippedForeign} recycled PID(s) — cmdline did not match kongcode MCP`);
}
/**
 * Start the internal HTTP API.
 * Listens on a Unix socket (preferred) or localhost:0 (fallback).
 */
export async function startHttpApi(state, sock, projectDir) {
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
                if (!m)
                    continue;
                const orphanPid = Number(m[1]);
                if (!Number.isFinite(orphanPid))
                    continue;
                let alive = true;
                try {
                    process.kill(orphanPid, 0);
                }
                catch (e) {
                    const code = e?.code;
                    alive = code !== "ESRCH";
                }
                // Live PID + cmdline matches kongcode MCP → leave it alone.
                // Anything else (dead PID, recycled PID owned by stranger, or a
                // non-Linux box where we can't verify cmdline) → unlink the orphan.
                // On non-Linux, cmdlineLooksLikeKongcodeMcp returns null; treat null
                // as "not us" so the orphan gets cleaned (the only daemon that could
                // legitimately own it would be ourselves, and our PID hasn't written
                // the tmpfile yet at this point in startHttpApi).
                if (alive && cmdlineLooksLikeKongcodeMcp(orphanPid) === true)
                    continue;
                try {
                    unlinkSync(join(cacheDir, name));
                }
                catch { /* ignore */ }
            }
        }
        catch { /* cacheDir missing — openSync below will surface the real error */ }
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
        const fd = openSync(tmpPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_EXCL, 0o600);
        try {
            writeSync(fd, authToken);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmpPath, authTokenPath);
        log.info("[http-api] auth token written to", authTokenPath);
    }
    catch (err) {
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
    // H5(http): mirror the daemon's accept-policy onto the hook listener — bound
    // the open-socket count and attach a persistent EMFILE/ENFILE handler so an
    // accept-time fd exhaustion degrades (pause→resume) instead of crashing the
    // per-host daemon via an unhandled 'error'. Attached BEFORE listen() so the
    // ceiling is live the instant the server binds.
    applyHookConnectionPolicy(server);
    // Start background /health cache refresher. Runs cheap COUNT queries off
    // the request path so the /health endpoint stays synchronous and won't
    // block on a hung DB. Fire one immediately so the first /health call
    // after startup has populated values (catch in async wrapper — never
    // throws into startup). unref'd so it doesn't keep the loop alive.
    refreshHealthCache(state).catch(e => {
        log.warn(`[http-api] initial health cache refresh failed: ${e.message}`);
    });
    if (healthRefreshTimer) {
        clearInterval(healthRefreshTimer);
        healthRefreshTimer = null;
    }
    healthRefreshTimer = setInterval(() => {
        refreshHealthCache(state).catch(e => {
            log.warn(`[http-api] health cache refresh failed: ${e.message}`);
        });
    }, HEALTH_REFRESH_INTERVAL_MS);
    healthRefreshTimer.unref?.();
    // Read-only web UI (GH #15): a dedicated 127.0.0.1 TCP listener, since the
    // hook HTTP API below is UDS-only and a browser can't reach it. Never fatal
    // to daemon startup; inert until the frontend bundle (dist/ui/) exists.
    await startUiServer(state, authToken).catch((e) => {
        log.warn(`[http-api] UI server start failed (non-fatal): ${e.message}`);
    });
    if (sock) {
        // Sweep sibling sockets whose owning MCP process is dead. Uses
        // ESRCH-only detection so a foreign-owned (EPERM) PID is left alone.
        sweepStaleSockets(dirname(sock), process.pid);
        // Clean up our own stale socket file from a prior crash with same PID
        if (existsSync(sock)) {
            try {
                unlinkSync(sock);
            }
            catch { /* ignore */ }
        }
        socketPath = sock;
        try {
            await new Promise((resolve, reject) => {
                // One-shot bind-error listener (EADDRINUSE / bind failure). Removed on
                // success so the persistent H5 accept-policy 'error' handler attached by
                // applyHookConnectionPolicy becomes the sole steady-state error path.
                const onBindError = (err) => reject(err);
                server.once("error", onBindError);
                server.listen(sock, () => {
                    server.removeListener("error", onBindError);
                    log.info(`HTTP API listening on Unix socket: ${sock}`);
                    resolve();
                });
            });
            try {
                chmodSync(sock, 0o600);
            }
            catch { }
            return;
        }
        catch (err) {
            log.warn(`Unix socket failed, falling back to TCP:`, err);
            socketPath = null;
        }
    }
    // Fallback: random port — write port file so hook proxy can discover us
    await new Promise((resolve, reject) => {
        // One-shot bind-error listener; removed on success so the persistent H5
        // accept-policy handler is the sole steady-state error path (see UDS branch).
        const onBindError = (err) => reject(err);
        server.once("error", onBindError);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", onBindError);
            const addr = server.address();
            if (addr && typeof addr === "object") {
                log.info(`HTTP API listening on port ${addr.port}`);
                const dir = resolvePath(projectDir || process.cwd());
                portFilePath = join(dir, ".kongcode-port");
                try {
                    writeFileSync(portFilePath, String(addr.port), { mode: 0o600 });
                    log.info(`Port file written: ${portFilePath}`);
                }
                catch (e) {
                    log.warn(`Failed to write port file:`, e);
                }
            }
            resolve();
        });
    });
}
/** Stop the internal HTTP API and clean up socket/port files. */
export async function stopHttpApi() {
    await stopUiServer();
    if (healthRefreshTimer) {
        clearInterval(healthRefreshTimer);
        healthRefreshTimer = null;
    }
    // H5(http): cancel any pending accept-resume timers — a daemon shutting down
    // must not re-listen on its endpoint after an fd-exhaustion pause.
    for (const t of acceptResumeTimers)
        clearTimeout(t);
    acceptResumeTimers.clear();
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => {
            server.close(() => resolve());
        });
        server = null;
    }
    if (socketPath && existsSync(socketPath)) {
        try {
            unlinkSync(socketPath);
        }
        catch { /* ignore */ }
        socketPath = null;
    }
    if (portFilePath && existsSync(portFilePath)) {
        try {
            unlinkSync(portFilePath);
        }
        catch { /* ignore */ }
        portFilePath = null;
    }
    if (authTokenPath && existsSync(authTokenPath)) {
        try {
            unlinkSync(authTokenPath);
        }
        catch { /* ignore */ }
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
    // H5(http) / HTTP-HOOK-FD-ASYMMETRY: the accept-policy applier + its config,
    // so the regression test can prove the hook listener carries a maxConnections
    // ceiling AND that an emitted EMFILE/ENFILE 'error' does NOT crash (a handler
    // is attached) and schedules a resume — without standing up the real listener.
    applyHookConnectionPolicy,
    HOOK_MAX_CONNECTIONS,
    HOOK_ACCEPT_PAUSE_MS,
    acceptResumeTimers,
    resetHealthCache() {
        healthCache.refreshedAt = null;
        healthCache.dbConnected = false;
        healthCache.pendingWorkCount = -1;
        healthCache.embeddingGapPct = -1;
        lastErrorAt = null;
    },
};
