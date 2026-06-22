/**
 * Regression suite for HTTP-HOOK-FD-ASYMMETRY (the http-api.ts side of H5).
 *
 * Background: the JSON-RPC DaemonServer got H5 (maxConnections + a persistent
 * EMFILE/ENFILE accept-pause handler — server.ts applyConnectionPolicy). The
 * HTTP hook listener (src/http-api.ts) is the OTHER transport in the SAME
 * daemon process and shares the process fd table, yet it set NO
 * server.maxConnections and attached NO steady-state 'error' handler. An
 * accept-time EMFILE/ENFILE on that server emits an UNHANDLED 'error' event,
 * which crashes the per-host daemon (and crash-loops on respawn into the same
 * fd-starved state) — taking down EVERY session's hooks.
 *
 * The fix mirrors the H5 boundary onto the hook listener via
 * applyHookConnectionPolicy: it sets server.maxConnections and attaches a
 * PERSISTENT 'error' handler that, on EMFILE/ENFILE, pauses accepting (close)
 * and schedules a re-listen instead of crashing. Any other steady-state error
 * is logged, never rethrown. The H4 per-handler deadline and the fail-open hook
 * boundary are unchanged.
 *
 * These tests exercise the REAL production handler against a live http.Server,
 * mirroring the daemon's _testEmitAcceptError approach — no full listener stood
 * up, so they run fast and deterministically.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { __testing as httpApiTesting } from "../src/http-api.js";

describe("HTTP-HOOK-FD-ASYMMETRY: H5 accept policy on the hook listener", () => {
  const made: HttpServer[] = [];
  function policiedServer(): HttpServer {
    const srv = createServer(() => {});
    httpApiTesting.applyHookConnectionPolicy(srv);
    made.push(srv);
    return srv;
  }

  afterEach(() => {
    // Cancel any resume timers the EMFILE path scheduled (unref'd, but we clear
    // them so they can't fire a re-listen into a torn-down test) and drop refs.
    for (const t of httpApiTesting.acceptResumeTimers) clearTimeout(t);
    httpApiTesting.acceptResumeTimers.clear();
    for (const s of made) { try { s.close(); } catch { /* ignore */ } }
    made.length = 0;
  });

  it("sets server.maxConnections to the configured hook cap", () => {
    const srv = policiedServer();
    // Pre-fix this was undefined — nothing bounded accepted sockets, so a hook
    // fork-bomb / socket leak could exhaust the shared process fd table.
    expect(srv.maxConnections).toBe(httpApiTesting.HOOK_MAX_CONNECTIONS);
    expect(httpApiTesting.HOOK_MAX_CONNECTIONS).toBeGreaterThan(0);
  });

  it("attaches a persistent 'error' listener (so an accept error has a handler)", () => {
    const srv = policiedServer();
    // The whole point: an http.Server with NO 'error' listener throws on an
    // emitted 'error' (Node's default), which would crash the daemon. The policy
    // must leave exactly such a steady-state listener attached for the lifetime.
    expect(srv.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });

  it("does NOT crash on an EMFILE accept error — schedules a resume instead", () => {
    const srv = policiedServer();
    const before = httpApiTesting.acceptResumeTimers.size;

    // Emitting 'error' with an EMFILE code must NOT throw — pre-fix (no listener)
    // this would throw the error (== uncaught → daemon crash). With the handler
    // attached it is swallowed into the pause path.
    expect(() => srv.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }))).not.toThrow();

    // And the degrade path must have SCHEDULED a resume (pause → re-listen),
    // proving we took the "pause, don't crash" branch rather than swallowing
    // silently. One resume timer per pause.
    expect(httpApiTesting.acceptResumeTimers.size).toBe(before + 1);
  });

  it("ENFILE takes the same pause-don't-crash path", () => {
    const srv = policiedServer();
    const before = httpApiTesting.acceptResumeTimers.size;
    expect(() => srv.emit("error", Object.assign(new Error("accept ENFILE"), { code: "ENFILE" }))).not.toThrow();
    expect(httpApiTesting.acceptResumeTimers.size).toBe(before + 1);
  });

  it("a non-fd steady-state server error is swallowed (logged, never rethrown)", () => {
    const srv = policiedServer();
    const before = httpApiTesting.acceptResumeTimers.size;
    // An arbitrary listener hiccup (e.g. ECONNRESET surfacing on the server)
    // must not crash the per-host singleton and must NOT schedule a resume —
    // only fd-exhaustion pauses accepting.
    expect(() => srv.emit("error", Object.assign(new Error("transient"), { code: "ECONNRESET" }))).not.toThrow();
    expect(httpApiTesting.acceptResumeTimers.size).toBe(before);
  });

  it("the hook accept-pause budget is a sane positive default", () => {
    // Mirrors the daemon's acceptPauseMs default band — short enough to recover
    // quickly once fds free, long enough not to burn CPU re-hitting the limit.
    expect(httpApiTesting.HOOK_ACCEPT_PAUSE_MS).toBeGreaterThan(0);
  });
});
