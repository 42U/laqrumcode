import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect } from "node:net";
import { DaemonServer } from "../src/daemon/server.js";
import { __testing as httpApiTesting } from "../src/http-api.js";

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** v0.7.45: tests now pass `tcpPort: 0` to let the OS pick an actually-
 *  available ephemeral port and read it back via `server.getTcpPort()`
 *  after listen() resolves. The previous random-port-from-IANA-range
 *  approach (v0.7.34) was still flaking on win32 CI runners that randomly
 *  restrict permissions on individual ports inside 49152-65535 (saw
 *  EACCES on port 49686 in v0.7.43). OS-assigned dodges this entirely.
 *  Kept for any test that needs a *fixed* port — none currently. */
function _ephemeralPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}
void _ephemeralPort; // suppress "declared but never used"

/** Send a line-delimited JSON-RPC request and resolve when one response
 *  arrives. Closes the socket after. */
async function sendRpc(port: number, payload: object, opts: { keepAlive?: boolean } = {}): Promise<{ socket: any; response: any }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify(payload) + "\n");
    });
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        try {
          const resp = JSON.parse(line);
          if (!opts.keepAlive) sock.end();
          resolve({ socket: sock, response: resp });
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("rpc timeout")), 2000);
  });
}

describe("DaemonServer: basic lifecycle", () => {
  let server: DaemonServer;
  let port: number;

  beforeEach(async () => {
    port = 0; // OS-assigned; read back via server.getTcpPort() after listen
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
    });
    server.register("meta.handshake", async () => ({ daemonVersion: "test", protocolVersion: 1 }));
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
    port = server.getTcpPort()!; // OS-assigned port now known
  });

  afterEach(async () => {
    await server.close();
  });

  it("starts with zero clients and zero supersede flag", () => {
    const stats = server.getStats();
    expect(stats.activeClients).toBe(0);
    expect(stats.pendingSupersede).toBe(false);
  });

  it("answers a known method (meta.health)", async () => {
    const { response } = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} });
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(response.result.ok).toBe(true);
    expect(typeof response.result.stats.activeClients).toBe("number");
  });

  it("returns -32601 for unknown method", async () => {
    const { response } = await sendRpc(port, { jsonrpc: "2.0", id: 2, method: "no.such.method", params: {} });
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
  });

  it("returns -32700 for malformed JSON", async () => {
    const sock = connect({ host: "127.0.0.1", port });
    await new Promise((r) => sock.on("connect", r));
    const responsePromise = new Promise<any>((resolve, reject) => {
      let buffer = "";
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          try { resolve(JSON.parse(buffer.slice(0, nl))); } catch (e) { reject(e); }
        }
      });
      setTimeout(() => reject(new Error("timeout")), 1000);
    });
    sock.write("{ this is not valid json\n");
    const response = await responsePromise;
    expect(response.error.code).toBe(-32700);
    sock.end();
  });
});

describe("DaemonServer: supersede flag", () => {
  let server: DaemonServer;
  let port: number;
  let onSupersedeReady: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    port = 0; // OS-assigned; read back via server.getTcpPort() after listen
    onSupersedeReady = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      onSupersedeReady,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
    port = server.getTcpPort()!; // OS-assigned port now known
  });

  afterEach(async () => {
    await server.close();
  });

  it("markPendingSupersede sets the flag visible in getStats", () => {
    expect(server.getStats().pendingSupersede).toBe(false);
    server.markPendingSupersede();
    expect(server.getStats().pendingSupersede).toBe(true);
    expect(server.isPendingSupersede()).toBe(true);
  });

  it("does not fire onSupersedeReady when no clients have ever connected", () => {
    server.markPendingSupersede();
    expect(onSupersedeReady).not.toHaveBeenCalled();
  });

  it("fires onSupersedeReady on last-client-disconnect when flag is set", async () => {
    // Connect a client; flag the daemon while client is attached.
    const { socket } = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(1);
    server.markPendingSupersede();
    expect(onSupersedeReady).not.toHaveBeenCalled(); // not yet — client still attached

    // Close the client. After socket-close handler fires, callback should run.
    socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onSupersedeReady when one of multiple clients disconnects", async () => {
    const r1 = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });
    const r2 = await sendRpc(port, { jsonrpc: "2.0", id: 2, method: "meta.health", params: {} }, { keepAlive: true });
    server.markPendingSupersede();
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(2);

    r1.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).not.toHaveBeenCalled();
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(1);

    r2.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1);
  });

  it("fires onSupersedeReady only once even if checkSupersedeReady triggers twice", async () => {
    const r1 = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });
    server.markPendingSupersede();
    r1.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1);

    // Connect again, disconnect again — flag was already cleared
    const r2 = await sendRpc(port, { jsonrpc: "2.0", id: 2, method: "meta.health", params: {} }, { keepAlive: true });
    r2.socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(onSupersedeReady).toHaveBeenCalledTimes(1); // still 1
  });
});

describe("DaemonServer: idle reaper", () => {
  let server: DaemonServer;
  let port: number;
  let onIdleReap: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("does not arm timer when idleTimeoutMs is 0", async () => {
    port = 0; // OS-assigned; read back via server.getTcpPort() after listen
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      idleTimeoutMs: 0,
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
    port = server.getTcpPort()!; // OS-assigned port now known

    await new Promise(r => setTimeout(r, 100));
    expect(onIdleReap).not.toHaveBeenCalled();
  });

  it("arms timer on listen and fires onIdleReap after timeout with no clients", async () => {
    port = 0; // OS-assigned; read back via server.getTcpPort() after listen
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      idleTimeoutMs: 100, // short for test
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
    port = server.getTcpPort()!; // OS-assigned port now known

    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).toHaveBeenCalledTimes(1);
  });

  it("cancels timer on client connect, re-arms on last disconnect", async () => {
    port = 0; // OS-assigned; read back via server.getTcpPort() after listen
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
      idleTimeoutMs: 150,
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
    port = server.getTcpPort()!; // OS-assigned port now known

    // Connect well before the 150ms timer would fire
    await new Promise(r => setTimeout(r, 50));
    const { socket } = await sendRpc(port, { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} }, { keepAlive: true });

    // Wait past the original timer deadline; should NOT have fired (client attached)
    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).not.toHaveBeenCalled();

    // Close client, then wait for re-armed timer
    socket.end();
    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).toHaveBeenCalledTimes(1);
  });
});

describe("DaemonServer: client identity registry", () => {
  let server: DaemonServer;
  let port: number;

  beforeEach(async () => {
    port = 0; // OS-assigned; read back via server.getTcpPort() after listen
    server = new DaemonServer({
      socketPath: null,
      tcpPort: port,
      log: SILENT_LOG,
    });
    server.register("meta.handshake", async (params, ctx) => {
      const p = (params as any) ?? {};
      if (p.clientInfo) ctx.registerIdentity(p.clientInfo);
      return { daemonVersion: "test", protocolVersion: 1 };
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();
    port = server.getTcpPort()!; // OS-assigned port now known
  });

  afterEach(async () => {
    await server.close();
  });

  it("registers identity from meta.handshake clientInfo", async () => {
    const { socket } = await sendRpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "meta.handshake",
      params: { clientInfo: { pid: 12345, version: "0.7.99", sessionId: "test-session" } },
    }, { keepAlive: true });
    await new Promise(r => setTimeout(r, 50));

    const stats = server.getStats();
    expect(stats.clients.length).toBeGreaterThan(0);
    const us = stats.clients.find(c => c.pid === 12345);
    expect(us).toBeDefined();
    expect(us?.version).toBe("0.7.99");
    expect(us?.sessionId).toBe("test-session");
    expect(typeof us?.attachedAt).toBe("number");
    socket.end();
  });

  it("anonymous clients (no clientInfo in handshake) still count toward activeClients", async () => {
    const { socket } = await sendRpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "meta.health",
      params: {},
    }, { keepAlive: true });
    await new Promise(r => setTimeout(r, 50));

    const stats = server.getStats();
    expect(stats.activeClients).toBeGreaterThan(0);
    // No identified clients (no handshake with clientInfo was sent)
    expect(stats.clients.length).toBe(0);
    socket.end();
  });

  it("removes identity from registry on socket close", async () => {
    const { socket } = await sendRpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "meta.handshake",
      params: { clientInfo: { pid: 99999, version: "0.7.99", sessionId: "leaving" } },
    }, { keepAlive: true });
    await new Promise(r => setTimeout(r, 50));
    expect(server.getStats().clients.find(c => c.pid === 99999)).toBeDefined();

    socket.end();
    await new Promise(r => setTimeout(r, 100));
    expect(server.getStats().clients.find(c => c.pid === 99999)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP /health endpoint — Agent E gap #1: off-band liveness probe.
// Tests verify buildHealthResponse directly (no real HTTP listener) — the
// route handler is a trivial wrapper that calls into this function, so unit
// testing the function covers the contract without flake-prone network IO.
// ─────────────────────────────────────────────────────────────────────────────

describe("http-api /health endpoint", () => {
  beforeEach(() => {
    httpApiTesting.resetHealthCache();
  });

  it("returns 200 with expected shape on healthy daemon", () => {
    // Simulate the background refresher having populated the cache once.
    httpApiTesting.healthCache.dbConnected = true;
    httpApiTesting.healthCache.pendingWorkCount = 3;
    httpApiTesting.healthCache.embeddingGapPct = 5;
    httpApiTesting.healthCache.refreshedAt = Date.now();
    const fakeState = {
      store: { isAvailable: () => true },
    } as Parameters<typeof httpApiTesting.buildHealthResponse>[0];
    // Public /health is intentionally minimal — only {status, db_connection}
    // to avoid leaking host-fingerprint details on the open Unix socket.
    const minimal = httpApiTesting.buildHealthResponse(fakeState);
    expect(minimal.status).toBe(200);
    expect(minimal.body).toEqual({ status: "ok", db_connection: true });
    // Full diagnostic shape lives behind the bearer token at /health/detailed.
    const { status, body } = httpApiTesting.buildHealthDetailedResponse(fakeState);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      db_connection: true,
      pending_work_count: 3,
      embedding_gap_pct: 5,
      pid: process.pid,
    });
    // Shape fields the task contract requires.
    expect(typeof body.uptime_ms).toBe("number");
    expect(typeof body.daemon_uptime).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(typeof body.memory_usage_mb).toBe("number");
    // null is the legitimate value when no error has been recorded yet.
    expect(body.last_error_ms_ago === null || typeof body.last_error_ms_ago === "number").toBe(true);
  });

  it("returns 503 with status=initializing before the first cache refresh", () => {
    // resetHealthCache() in beforeEach already set refreshedAt to null. The
    // initializing branch must fire here regardless of whether the store
    // would otherwise grade ok/degraded/error.
    const fakeState = {
      store: { isAvailable: () => true },
    } as Parameters<typeof httpApiTesting.buildHealthResponse>[0];
    const { status, body } = httpApiTesting.buildHealthResponse(fakeState);
    expect(status).toBe(503);
    expect(body.status).toBe("initializing");
    expect(body.db_connection).toBe(true);
    // No other fields: just status + db_connection, per the contract.
    expect(Object.keys(body).sort()).toEqual(["db_connection", "status"]);
  });

  it("returns 503 with status=initializing when state is null", () => {
    httpApiTesting.healthCache.refreshedAt = Date.now(); // cache ready, state isn't
    const { status, body } = httpApiTesting.buildHealthResponse(null);
    expect(status).toBe(503);
    expect(body.status).toBe("initializing");
    expect(body.db_connection).toBe(false);
  });

  it("returns 503 with status=error when DB is unavailable", () => {
    // Mark cache as refreshed so we exercise the post-startup grading path
    // rather than the new "initializing" branch (which short-circuits before
    // status grading whenever refreshedAt is still null).
    httpApiTesting.healthCache.refreshedAt = Date.now();
    const fakeState = {
      store: { isAvailable: () => false },
    } as Parameters<typeof httpApiTesting.buildHealthResponse>[0];
    const { status, body } = httpApiTesting.buildHealthResponse(fakeState);
    expect(status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.db_connection).toBe(false);
  });

  it("status=degraded when DB is up but embedding gap is high", () => {
    httpApiTesting.healthCache.dbConnected = true;
    httpApiTesting.healthCache.pendingWorkCount = 0;
    httpApiTesting.healthCache.embeddingGapPct = 42; // > 15 threshold
    httpApiTesting.healthCache.refreshedAt = Date.now();
    const fakeState = {
      store: { isAvailable: () => true },
    } as Parameters<typeof httpApiTesting.buildHealthResponse>[0];
    const { status, body } = httpApiTesting.buildHealthResponse(fakeState);
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
  });

  it("last_error_ms_ago tracks recordLastError calls", () => {
    httpApiTesting.healthCache.dbConnected = true;
    httpApiTesting.healthCache.pendingWorkCount = 0;
    httpApiTesting.healthCache.embeddingGapPct = 0;
    httpApiTesting.healthCache.refreshedAt = Date.now();
    const fakeState = {
      store: { isAvailable: () => true },
    } as Parameters<typeof httpApiTesting.buildHealthResponse>[0];
    // last_error_ms_ago is only emitted by the auth-gated /health/detailed
    // shape — the public /health endpoint deliberately strips it (and every
    // other host-fingerprint field). Test against the detailed responder.
    // Before any error: null.
    expect(httpApiTesting.buildHealthDetailedResponse(fakeState).body.last_error_ms_ago).toBeNull();
    // After recording: a non-negative number.
    httpApiTesting.recordLastError();
    const after = httpApiTesting.buildHealthDetailedResponse(fakeState).body.last_error_ms_ago;
    expect(typeof after).toBe("number");
    expect(after as number).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Periodic pruneDeadClients — Agent E gap #2: phantom clients on idle daemon.
// The interval runs every 60s in production; tests exercise the same logic
// synchronously via _testRunPrune and verify the timer handle is installed.
// ─────────────────────────────────────────────────────────────────────────────

describe("DaemonServer: periodic pruneDeadClients", () => {
  let server: DaemonServer;
  let port: number;
  let onIdleReap: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("installs a periodic prune timer on listen() and clears it on close()", async () => {
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    expect(server._testHasPruneTimer()).toBe(false);
    await server.listen();
    expect(server._testHasPruneTimer()).toBe(true);
    await server.close();
    expect(server._testHasPruneTimer()).toBe(false);
  });

  it("periodic prune drops phantom client entries that lost their close event", async () => {
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      idleTimeoutMs: 100_000, // long — we only care about the prune path
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();

    // Inject a phantom: a destroyed socket sitting in the clients Map as if
    // its 'close' event never fired. This is exactly the edge case Agent E
    // flagged — Node sometimes drops close events for short-lived probe
    // connections and SIGKILL'd peers.
    server._testInjectPhantomClient();
    expect(server.attachedClientCount).toBe(1);

    // Run the same prune logic the periodic interval runs.
    const pruned = server._testRunPrune();
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(server.attachedClientCount).toBe(0);
  });

  it("periodic prune re-arms idle timer when pruning drops phantoms to zero clients", async () => {
    onIdleReap = vi.fn();
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      idleTimeoutMs: 100, // short — we want to observe re-arm + fire
      onIdleReap,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    await server.listen();

    // Inject a phantom — armIdleTimer should now see clients.size==1 and
    // refuse to arm. (Verify the gap Agent E flagged: without periodic
    // prune, this state persists forever and onIdleReap never fires.)
    server._testInjectPhantomClient();
    expect(server.attachedClientCount).toBe(1);
    // Wait past the idle deadline — phantom keeps the timer disarmed.
    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).not.toHaveBeenCalled();

    // Now run the periodic prune. Phantom dies, clients.size==0, idle
    // timer re-arms.
    const pruned = server._testRunPrune();
    expect(pruned).toBe(1);
    expect(server.attachedClientCount).toBe(0);

    // Wait past idleTimeoutMs; onIdleReap should fire now.
    await new Promise(r => setTimeout(r, 200));
    expect(onIdleReap).toHaveBeenCalledTimes(1);
  });

  it("setInterval-based periodic prune is wired up via the real timer (not just _testRunPrune)", () => {
    // Verify the production path uses an unref'd setInterval. We mock
    // setInterval before constructing the server, then check it was called
    // with the expected cadence and the returned handle had unref() called.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
    });
    server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
    return server.listen().then(() => {
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(server._testHasPruneTimer()).toBe(true);
      // The handle returned by setInterval should have had unref() called.
      const handle = setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1].value as NodeJS.Timeout;
      // Node Timer objects expose hasRef(); after unref() it returns false.
      // Fall back to a truthy check on the symbol if hasRef is unavailable.
      if (typeof (handle as { hasRef?: () => boolean }).hasRef === "function") {
        expect((handle as { hasRef: () => boolean }).hasRef()).toBe(false);
      }
      setIntervalSpy.mockRestore();
    });
  });
});
