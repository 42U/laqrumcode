/**
 * Regression suite for the daemon-concurrency hardening lane (H4 + H5 + M2).
 *
 * H4 — daemon-side hook handler execution deadline (src/http-api.ts).
 *   Before: handleRequest dispatched a bare `await handler(state, payload)` with
 *   no daemon-side timeout. The proxy's own timeout calls req.destroy() (closes
 *   the CLIENT socket) but does NOT abort the daemon-side handler, so under DB
 *   degradation a wedged handler keeps the daemon's single event loop busy long
 *   after the proxy gave up, starving every other session. The fix wraps the
 *   dispatch in raceWithDeadline (HOOK_HANDLER_DEADLINE_MS) and fails open ({})
 *   on timeout so the loop is freed. The user-turn fail-open boundary is intact.
 *
 * H5 — connection ceiling + fd-exhaustion accept policy (src/daemon/server.ts).
 *   Before: createServer + listen with no backlog, maxConnections never set, no
 *   EMFILE/ENFILE handling — an accept-time fd exhaustion would crash the daemon
 *   (and crash-loop on respawn). The fix sets server.maxConnections, passes an
 *   explicit backlog, and attaches a persistent 'error' handler that pauses
 *   accepting (then resumes) on EMFILE/ENFILE instead of crashing.
 *
 * M2 — fair, retryable backpressure (embeddings.ts + server.ts).
 *   (a) embed-queue-full threw a PLAIN Error → the dispatcher flattened it to
 *       HANDLER_ERROR (non-retryable) → the user's turn FAILED. The fix throws
 *       EmbedBusyError carrying DAEMON_RESTARTING, and the dispatcher passes a
 *       retryable code through so the client backs off + retries.
 *   (b) the K12 global in-flight cap is whole-daemon and unfair — one heavy
 *       session can trip it and reject others. The fix adds a per-connection
 *       sub-cap (maxInFlight/4) returning the same retryable code, so one socket
 *       can't starve others while the global K12 cap still stands.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { DaemonServer } from "../src/daemon/server.js";
import { EmbeddingService, EmbedBusyError } from "../src/engine/embeddings.js";
import type { EmbeddingConfig } from "../src/engine/config.js";
import { __testing as httpApiTesting } from "../src/http-api.js";
import type { GlobalPluginState } from "../src/engine/state.js";
import type { HookResponse } from "../src/http-api.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Retryable JSON-RPC codes (mirror IpcErrorCode). DAEMON_RESTARTING is the one
 *  the busy/backpressure paths use; the client retries on this family. */
const DAEMON_RESTARTING = -32002;
const HANDLER_ERROR = -32003;

/** Open ONE TCP socket and keep it open across multiple line-delimited RPCs.
 *  Resolves each send by JSON-RPC `id` (NOT FIFO arrival order) — the M2(b)
 *  tests deliberately have multiple concurrent in-flight RPCs on one socket
 *  whose responses come back OUT of order (a fast busy-rejection for a later id
 *  precedes a gated earlier id), so id-keyed matching is required. */
function openClient(port: number): {
  send: (payload: { id: number | string } & object) => Promise<any>;
  close: () => void;
} {
  const sock = connect({ host: "127.0.0.1", port });
  let buffer = "";
  const byId = new Map<number | string, (v: any) => void>();
  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const resp = JSON.parse(line);
      const w = resp && resp.id != null ? byId.get(resp.id) : undefined;
      if (w) { byId.delete(resp.id); w(resp); }
    }
  });
  return {
    send: (payload) =>
      new Promise((resolve) => {
        byId.set(payload.id, resolve);
        sock.write(JSON.stringify(payload) + "\n");
      }),
    close: () => { try { sock.destroy(); } catch { /* ignore */ } },
  };
}

describe("H4: daemon-side hook handler execution deadline", () => {
  const orig = process.env.LAQRUMCODE_HOOK_HANDLER_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.LAQRUMCODE_HOOK_HANDLER_TIMEOUT_MS;
    else process.env.LAQRUMCODE_HOOK_HANDLER_TIMEOUT_MS = orig;
  });

  const fakeState = {} as unknown as GlobalPluginState;

  it("fails open fast (loop freed) when a handler exceeds the deadline", async () => {
    // A handler that NEVER settles — the wedged-under-DB-degradation case. The
    // pre-fix bare `await` would hang on this forever, pinning the loop.
    const wedged = () => new Promise<HookResponse>(() => { /* never resolves */ });

    const started = Date.now();
    // Drive a tiny deadline (50ms) via the override so the test is fast. The
    // dispatcher must resolve to {} via the deadline rather than hang. A
    // separate 5s guard converts a regression (hang) into a clear failure.
    const resp = await Promise.race([
      httpApiTesting.dispatchHookWithDeadline(wedged as any, fakeState, {}, "userPromptSubmit", 50),
      new Promise<HookResponse>((_, rej) => setTimeout(() => rej(new Error("DISPATCH HUNG — loop not freed")), 5_000)),
    ]);
    const elapsed = Date.now() - started;
    expect(resp).toEqual({}); // fail-open response — user turn unblocked
    expect(elapsed).toBeLessThan(2_000); // returned ~promptly after the 50ms deadline
  });

  it("the default deadline sits in the designed band (45s transform < deadline < 55s proxy)", () => {
    // The net must be ABOVE the longest legitimate inner work (45s CPU-tier
    // transform) and BELOW the largest proxy budget (55s) — so healthy-but-slow
    // handlers complete and only genuinely-wedged ones trip it.
    expect(httpApiTesting.HOOK_HANDLER_DEADLINE_MS).toBeGreaterThan(45_000);
    expect(httpApiTesting.HOOK_HANDLER_DEADLINE_MS).toBeLessThan(55_000);
  });

  it("a fast handler is returned verbatim (no deadline interference on happy path)", async () => {
    const fast = async (): Promise<HookResponse> => ({ systemMessage: "ok" });
    const resp = await httpApiTesting.dispatchHookWithDeadline(fast as any, fakeState, {}, "stop");
    expect(resp).toEqual({ systemMessage: "ok" });
  });

  it("fails open ({}) on an ordinary handler throw too (boundary intact)", async () => {
    const boom = async (): Promise<HookResponse> => { throw new Error("handler blew up"); };
    const resp = await httpApiTesting.dispatchHookWithDeadline(boom as any, fakeState, {}, "preToolUse");
    expect(resp).toEqual({});
  });
});

describe("H5: connection ceiling + EMFILE accept policy", () => {
  let server: DaemonServer | null = null;
  afterEach(async () => {
    if (server) { await server.close(); server = null; }
  });

  it("sets server.maxConnections and an explicit backlog after listen()", async () => {
    server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
    await server.listen();
    const limits = server._testLimits();
    expect(limits.maxConnections).toBe(512); // default
    expect(limits.backlog).toBe(511); // default
    expect(limits.maxInFlightPerSocket).toBe(64); // 256/4 default
    // The ceiling is actually applied to the bound server object, not just held
    // as config — proves applyConnectionPolicy ran.
    expect(server._testLiveMaxConnections()).toBe(512);
  });

  it("honors env overrides for the ceiling", async () => {
    const prevMax = process.env.LAQRUMCODE_DAEMON_MAX_CONNECTIONS;
    const prevBacklog = process.env.LAQRUMCODE_DAEMON_BACKLOG;
    process.env.LAQRUMCODE_DAEMON_MAX_CONNECTIONS = "8";
    process.env.LAQRUMCODE_DAEMON_BACKLOG = "16";
    try {
      const s = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
      await s.listen();
      expect(s._testLiveMaxConnections()).toBe(8);
      expect(s._testLimits().backlog).toBe(16);
      await s.close();
    } finally {
      if (prevMax === undefined) delete process.env.LAQRUMCODE_DAEMON_MAX_CONNECTIONS;
      else process.env.LAQRUMCODE_DAEMON_MAX_CONNECTIONS = prevMax;
      if (prevBacklog === undefined) delete process.env.LAQRUMCODE_DAEMON_BACKLOG;
      else process.env.LAQRUMCODE_DAEMON_BACKLOG = prevBacklog;
    }
  });

  it("does NOT crash on an EMFILE accept error — pauses accepting instead", async () => {
    // Keep the pause long so the resume timer doesn't race teardown; close()
    // clears it. The key assertion: emitting 'error' with EMFILE does not throw
    // (a listener is attached) and schedules a resume. Pre-fix, no 'error'
    // listener existed → an unhandled 'error' event would crash the daemon.
    const prevPause = process.env.LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS;
    process.env.LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS = "60000";
    try {
      server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
      await server.listen();
      let survived = false;
      expect(() => { survived = server!._testEmitAcceptError("EMFILE"); }).not.toThrow();
      expect(survived).toBe(true); // handler attached + resume timer scheduled
      // ENFILE takes the same path.
      expect(() => server!._testEmitAcceptError("ENFILE")).not.toThrow();
    } finally {
      if (prevPause === undefined) delete process.env.LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS;
      else process.env.LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS = prevPause;
    }
  });
});

describe("M2(a): embed-queue-full throws a RETRYABLE error", () => {
  const orig = process.env.LAQRUMCODE_EMBED_QUEUE_MAX;
  afterEach(() => {
    if (orig === undefined) delete process.env.LAQRUMCODE_EMBED_QUEUE_MAX;
    else process.env.LAQRUMCODE_EMBED_QUEUE_MAX = orig;
  });

  function makeReadyService(): any {
    process.env.LAQRUMCODE_EMBED_QUEUE_MAX = "2";
    const config = { modelPath: "/tmp/fake-model.gguf", dimensions: 1024 } as unknown as EmbeddingConfig;
    const svc = new EmbeddingService(config) as any;
    svc.ready = true;
    svc.ctx = { getEmbeddingFor: () => new Promise(() => {}) }; // never settles
    return svc;
  }
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("throws EmbedBusyError with code DAEMON_RESTARTING past the cap", async () => {
    const svc = makeReadyService();
    // Fill: 1 held in-flight by the drain + 2 queued = 3 embed() calls to leave
    // the queue at its cap (2).
    for (let i = 0; i < 3; i++) {
      const p = svc.embed(`t-${i}`); p.catch(() => {});
      await flush();
    }
    expect(svc.embedQueue.length).toBe(2);
    let caught: unknown;
    try { await svc.embed("overflow"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbedBusyError);
    expect((caught as EmbedBusyError).code).toBe(DAEMON_RESTARTING);
    expect((caught as EmbedBusyError).retryable).toBe(true);
    expect((caught as Error).message).toMatch(/queue full/i);
  });
});

describe("M2(a): dispatcher maps a retryable-coded throw to that code", () => {
  let server: DaemonServer | null = null;
  afterEach(async () => {
    if (server) { await server.close(); server = null; }
  });

  it("a handler throwing EmbedBusyError yields DAEMON_RESTARTING (not HANDLER_ERROR)", async () => {
    server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
    // tool.recall handler that simulates the embed FIFO being full.
    server.register("tool.recall", async () => {
      throw new EmbedBusyError("Embedding queue full (2048/2048) — embedder is underwater; retry shortly");
    });
    // A plain-Error handler must STILL map to HANDLER_ERROR (no over-broad pass).
    server.register("tool.introspect", async () => { throw new Error("genuine bug"); });
    await server.listen();
    const port = server.getTcpPort()!;
    const c = openClient(port);

    const busy = await c.send({ jsonrpc: "2.0", id: 1, method: "tool.recall", params: {} });
    expect(busy.error).toBeDefined();
    expect(busy.error.code).toBe(DAEMON_RESTARTING); // retryable → client backs off

    const bug = await c.send({ jsonrpc: "2.0", id: 2, method: "tool.introspect", params: {} });
    expect(bug.error).toBeDefined();
    expect(bug.error.code).toBe(HANDLER_ERROR); // non-retryable bug surfaces

    c.close();
  });
});

describe("M2(b): per-connection in-flight sub-cap", () => {
  let server: DaemonServer | null = null;
  const prev = process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET;
  afterEach(async () => {
    if (server) { await server.close(); server = null; }
    if (prev === undefined) delete process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET;
    else process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET = prev;
  });

  it("one socket over its sub-cap gets the retryable code while a second socket still succeeds", async () => {
    process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET = "2";
    server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });

    // A handler we can hold open: it resolves only when we release a gate, so we
    // can pin in-flight RPCs on one socket and exceed its sub-cap.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server.register("tool.recall", async () => { await gate; return { ok: true }; });
    // A fast handler for the second socket — must succeed despite socket-1's load.
    server.register("tool.introspect", async () => ({ ok: true, fast: true }));

    await server.listen();
    const port = server.getTcpPort()!;
    const heavy = openClient(port);
    const other = openClient(port);

    // Fire 2 calls on the heavy socket that PIN in-flight (they await the gate).
    // We don't await these — they stay pending, occupying the socket's 2 slots.
    const p1 = heavy.send({ jsonrpc: "2.0", id: 1, method: "tool.recall", params: {} });
    const p2 = heavy.send({ jsonrpc: "2.0", id: 2, method: "tool.recall", params: {} });
    // Give the daemon a beat to admit both into in-flight.
    await new Promise((r) => setTimeout(r, 50));

    // The 3rd call on the SAME socket exceeds its sub-cap (2) → retryable busy.
    const third = await heavy.send({ jsonrpc: "2.0", id: 3, method: "tool.recall", params: {} });
    expect(third.error).toBeDefined();
    expect(third.error.code).toBe(DAEMON_RESTARTING);
    expect(third.error.message).toMatch(/this session/i);

    // A DIFFERENT socket is unaffected — fairness: one session can't starve all.
    const otherResp = await other.send({ jsonrpc: "2.0", id: 1, method: "tool.introspect", params: {} });
    expect(otherResp.result).toEqual({ ok: true, fast: true });

    // Release the gate; the two pinned calls now settle successfully.
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.result).toEqual({ ok: true });
    expect(r2.result).toEqual({ ok: true });

    // After they drain, the socket's slots free and a new call admits again.
    const fourth = await heavy.send({ jsonrpc: "2.0", id: 4, method: "tool.recall", params: {} });
    expect(fourth.result).toEqual({ ok: true });

    heavy.close();
    other.close();
  });

  it("meta.* is exempt from the per-socket sub-cap (lifecycle never starved)", async () => {
    process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET = "1";
    server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server.register("tool.recall", async () => { await gate; return { ok: true }; });
    server.register("meta.health", async () => ({ ok: true }));
    await server.listen();
    const port = server.getTcpPort()!;
    const c = openClient(port);

    // Pin the single non-meta slot.
    const pinned = c.send({ jsonrpc: "2.0", id: 1, method: "tool.recall", params: {} });
    await new Promise((r) => setTimeout(r, 50));

    // meta.health must STILL succeed even though the socket's non-meta slot is
    // full — meta.* is exempt so handshake/health/shutdown never wedge.
    const health = await c.send({ jsonrpc: "2.0", id: 2, method: "meta.health", params: {} });
    expect(health.result).toEqual({ ok: true });

    release();
    await pinned;
    c.close();
  });
});
