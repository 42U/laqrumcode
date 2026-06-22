/**
 * E2-META-DOS (HIGH) regression: the pre-auth meta exemption was too broad.
 *
 * The E2 TCP auth gate (src/daemon/server.ts dispatchLine) used to admit EVERY
 * method starting with "meta." on an unauthenticated socket:
 *
 *     !req.method.startsWith("meta.")          // old: blanket prefix exemption
 *
 * But only meta.handshake actually verifies the per-user token. meta.shutdown
 * (schedules gracefulCleanup) and meta.requestSupersede (arms the E8 grace-exit)
 * do NO token check of their own. So on the TCP transport (Windows /
 * KONGCODE_DAEMON_TRANSPORT=tcp) a hash-collided cross-OS-user on the shared
 * loopback port could send meta.shutdown as their FIRST line and kill another
 * user's daemon — an availability DoS. (Not a data breach: tool.* never matched
 * the prefix, so the graph stayed gated.)
 *
 * The fix replaces the prefix test with an explicit allow-set:
 *
 *     !PRE_AUTH_METHODS.has(req.method)        // new: {meta.handshake, meta.health}
 *
 * so meta.shutdown / meta.requestSupersede fall under the SAME token gate as
 * tool.* / hook.* when requireHandshakeAuth is true, while meta.handshake (which
 * establishes auth) and meta.health (the probeTcpOccupant liveness path at
 * server.ts:441) remain reachable pre-auth.
 *
 * These tests drive the real DaemonServer over a raw TCP loopback socket (same
 * harness shape as fix-e2-tcp-auth.test.ts). The lifecycle handlers register
 * SIDE-EFFECT sentinels (a flag they flip when they actually run) so we can
 * prove the gate rejects the call BEFORE the handler executes — i.e. the daemon
 * is never actually asked to shut down on an unauthed meta.shutdown.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { DaemonServer } from "../src/daemon/server.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Wire code for "complete meta.handshake first". Mirrors RPC_UNAUTHORIZED in
 *  server.ts (IpcErrorCode.UNAUTHORIZED). */
const RPC_UNAUTHORIZED = -32006;

/** Mirror of the daemon's per-user token check (src/daemon/index.ts
 *  meta.handshake handler): throws on mismatch, marks the socket authed on a
 *  match OR when no token is required. */
function makeHandshakeHandler(token: string | null) {
  return async (params: unknown, ctx: { markAuthed: () => void }) => {
    const p = (params as { handshake?: string }) ?? {};
    if (token !== null) {
      const presented = typeof p.handshake === "string" ? p.handshake : "";
      const ok = presented.length === token.length && presented === token;
      if (!ok) throw new Error("handshake token mismatch — this daemon belongs to a different OS user");
    }
    ctx.markAuthed();
    return { daemonVersion: "test", protocolVersion: 1 };
  };
}

/** One TCP socket, kept open across multiple line-delimited RPCs (auth is
 *  socket-scoped, so the per-socket lifetime is the whole point). */
function openClient(port: number): { send: (payload: object) => Promise<any>; close: () => void } {
  const sock = connect({ host: "127.0.0.1", port });
  let buffer = "";
  const waiters: Array<(resp: any) => void> = [];
  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  const ready = new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  return {
    send: async (payload: object) =>
      ready.then(
        () =>
          new Promise<any>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("rpc timeout")), 2000);
            waiters.push((resp: any) => { clearTimeout(t); resolve(resp); });
            sock.write(JSON.stringify(payload) + "\n");
          }),
      ),
    close: () => { try { sock.end(); } catch {} },
  };
}

/** Sentinels flipped by the lifecycle handlers when (and only when) they
 *  actually run. The gate must reject unauthed calls BEFORE the handler — so
 *  these stay false on an unauthed meta.shutdown / meta.requestSupersede. */
interface Sentinels { shutdownCalled: boolean; supersedeCalled: boolean }

async function startServer(opts: { requireHandshakeAuth: boolean; token: string | null }): Promise<{
  server: DaemonServer;
  port: number;
  sentinels: Sentinels;
}> {
  const sentinels: Sentinels = { shutdownCalled: false, supersedeCalled: false };
  const server = new DaemonServer({
    socketPath: null,
    tcpPort: 0, // OS-assigned
    log: SILENT_LOG,
    requireHandshakeAuth: opts.requireHandshakeAuth,
  });
  server.register("meta.handshake", makeHandshakeHandler(opts.token));
  server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
  // Mirror the real daemon's lifecycle handlers — but record the side effect
  // instead of actually tearing the process down, and return a sentinel result
  // so an ALLOWED dispatch is unambiguous vs the UNAUTHORIZED error.
  server.register("meta.shutdown", async () => {
    sentinels.shutdownCalled = true;
    return { ok: true };
  });
  server.register("meta.requestSupersede", async () => {
    sentinels.supersedeCalled = true;
    return { accepted: true, daemonVersion: "test", attachedClients: 1 };
  });
  await server.listen();
  return { server, port: server.getTcpPort()!, sentinels };
}

describe("E2-META-DOS: meta.shutdown / meta.requestSupersede are token-gated (requireHandshakeAuth ON)", () => {
  const TOKEN = "a".repeat(64); // 256-bit hex, same shape as the real per-user token
  let server: DaemonServer;
  afterEach(async () => { if (server) await server.close(); });

  it("rejects meta.shutdown as the FIRST line (no handshake) with UNAUTHORIZED — and the handler never runs", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const c = openClient(s.port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.shutdown", params: {} });
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(RPC_UNAUTHORIZED);
    // The DoS vector: the daemon must NOT have been asked to shut down.
    expect(s.sentinels.shutdownCalled).toBe(false);
    c.close();
  });

  it("rejects meta.requestSupersede as the first line too (arms E8 grace-exit) — handler never runs", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const c = openClient(s.port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.requestSupersede", params: { clientVersion: "9.9.9" } });
    expect(resp.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(s.sentinels.supersedeCalled).toBe(false);
    c.close();
  });

  it("a WRONG-token handshake leaves the socket unauthed — meta.shutdown still rejected", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const c = openClient(s.port);
    const hs = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: "b".repeat(64) } });
    expect(hs.error).toBeDefined(); // token mismatch threw; markAuthed not reached
    const resp = await c.send({ jsonrpc: "2.0", id: 2, method: "meta.shutdown", params: {} });
    expect(resp.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(s.sentinels.shutdownCalled).toBe(false);
    c.close();
  });

  it("meta.handshake stays reachable pre-auth (it ESTABLISHES auth)", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const c = openClient(s.port);
    const hs = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: TOKEN } });
    expect(hs.error).toBeUndefined();
    expect(hs.result).toMatchObject({ protocolVersion: 1 });
    c.close();
  });

  it("meta.health stays reachable pre-auth (the probeTcpOccupant liveness path)", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const c = openClient(s.port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.health", params: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result.ok).toBe(true);
    c.close();
  });

  it("AFTER a valid handshake, meta.shutdown is allowed on the same socket (and the handler runs)", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const c = openClient(s.port);
    const hs = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: TOKEN } });
    expect(hs.error).toBeUndefined();
    const resp = await c.send({ jsonrpc: "2.0", id: 2, method: "meta.shutdown", params: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result.ok).toBe(true);
    expect(s.sentinels.shutdownCalled).toBe(true);
    c.close();
  });

  it("auth is PER-SOCKET: handshaking on socket A does not let socket B call meta.shutdown", async () => {
    const s = await startServer({ requireHandshakeAuth: true, token: TOKEN });
    server = s.server;
    const a = openClient(s.port);
    const b = openClient(s.port);
    const hsA = await a.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: TOKEN } });
    expect(hsA.error).toBeUndefined();
    // B never handshook — its meta.shutdown must be rejected even though A is authed.
    const rejB = await b.send({ jsonrpc: "2.0", id: 1, method: "meta.shutdown", params: {} });
    expect(rejB.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(s.sentinels.shutdownCalled).toBe(false);
    a.close();
    b.close();
  });
});

describe("E2-META-DOS: UDS / no-token mode (requireHandshakeAuth OFF) — lifecycle unchanged", () => {
  let server: DaemonServer;
  afterEach(async () => { if (server) await server.close(); });

  it("allows meta.shutdown WITHOUT any handshake when auth is not required", async () => {
    // The Unix-socket daemon: 0600 perms isolate OS users, so the gate is off
    // and `kongcode-daemon stop` (meta.shutdown, no handshake) keeps working.
    const s = await startServer({ requireHandshakeAuth: false, token: null });
    server = s.server;
    const c = openClient(s.port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.shutdown", params: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result.ok).toBe(true);
    expect(s.sentinels.shutdownCalled).toBe(true);
    c.close();
  });

  it("allows meta.requestSupersede WITHOUT a handshake when auth is off", async () => {
    const s = await startServer({ requireHandshakeAuth: false, token: null });
    server = s.server;
    const c = openClient(s.port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.requestSupersede", params: { clientVersion: "9.9.9" } });
    expect(resp.error).toBeUndefined();
    expect(s.sentinels.supersedeCalled).toBe(true);
    c.close();
  });
});
