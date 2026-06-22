/**
 * E2 (CRITICAL) regression: TCP daemon auth bypass.
 *
 * Before the fix, dispatchLine (src/daemon/server.ts) dispatched EVERY method
 * with no per-socket auth state. The S6 handshake token was verified ONLY
 * inside the meta.handshake handler (src/daemon/index.ts), so a TCP client on
 * the shared loopback port could send tool.recall / tool.* / hook.* as its
 * FIRST line and skip the handshake entirely — reading/writing another OS
 * user's graph (the Windows/TCP multi-user path).
 *
 * The fix adds:
 *   - DaemonServerOpts.requireHandshakeAuth (set true by daemon/index.ts only
 *     when it binds TCP and mints a per-user token).
 *   - A per-socket `authedSockets` set + HandlerContext.markAuthed(), called by
 *     the meta.handshake handler AFTER the token check passes.
 *   - A gate in dispatchLine (after isKnownMethod, before handler dispatch)
 *     that rejects any non-meta method on an unauthed socket with UNAUTHORIZED
 *     (-32006) when requireHandshakeAuth is on. meta.* stays exempt.
 *
 * These tests drive the real DaemonServer over a raw TCP loopback socket
 * (OS-assigned port, like daemon-server.test.ts) and assert the wire contract.
 * The meta.handshake handler registered here mirrors src/daemon/index.ts's:
 * it throws on token mismatch and calls ctx.markAuthed() on success.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { DaemonServer } from "../src/daemon/server.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** The wire code the dispatcher uses for "complete meta.handshake first".
 *  Mirrors RPC_UNAUTHORIZED in server.ts (a server-defined JSON-RPC code that
 *  does not collide with any IpcErrorCode literal). */
const RPC_UNAUTHORIZED = -32006;

/** Mirror of the daemon's per-user token check (src/daemon/index.ts
 *  meta.handshake handler). Throws on mismatch; marks the socket authed on a
 *  match OR when no token is required. */
function makeHandshakeHandler(token: string | null) {
  return async (params: unknown, ctx: { markAuthed: () => void; registerIdentity: (i: unknown) => void }) => {
    const p = (params as { handshake?: string; clientInfo?: unknown }) ?? {};
    if (token !== null) {
      const presented = typeof p.handshake === "string" ? p.handshake : "";
      const ok = presented.length === token.length && presented === token;
      if (!ok) throw new Error("handshake token mismatch — this daemon belongs to a different OS user");
    }
    ctx.markAuthed();
    return { daemonVersion: "test", protocolVersion: 1 };
  };
}

/** Open ONE TCP socket and keep it open across multiple line-delimited RPCs.
 *  Returns a sender that resolves with the next response object per call. The
 *  per-socket lifetime is the whole point of this test — auth is socket-scoped. */
function openClient(port: number): {
  send: (payload: object) => Promise<any>;
  close: () => void;
} {
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
    send: async (payload: object) => {
      await ready;
      return new Promise<any>((resolve, reject) => {
        waiters.push(resolve);
        const t = setTimeout(() => reject(new Error("rpc timeout")), 2000);
        const wrapped = (resp: any) => { clearTimeout(t); resolve(resp); };
        waiters[waiters.length - 1] = wrapped;
        sock.write(JSON.stringify(payload) + "\n");
      });
    },
    close: () => { try { sock.end(); } catch {} },
  };
}

async function startServer(opts: { requireHandshakeAuth: boolean; token: string | null }): Promise<{ server: DaemonServer; port: number }> {
  const server = new DaemonServer({
    socketPath: null,
    tcpPort: 0, // OS-assigned
    log: SILENT_LOG,
    requireHandshakeAuth: opts.requireHandshakeAuth,
  });
  server.register("meta.handshake", makeHandshakeHandler(opts.token));
  server.register("meta.health", async () => ({ ok: true, stats: server.getStats() }));
  // A representative non-meta method. Returns a sentinel so a successful
  // dispatch is unambiguous vs the UNAUTHORIZED error.
  server.register("tool.recall", async () => ({ content: [{ type: "text", text: "RECALL_OK" }] }));
  server.register("hook.stop", async () => ({ hookSpecificOutput: "HOOK_OK" }));
  await server.listen();
  return { server, port: server.getTcpPort()! };
}

describe("E2: TCP daemon auth gate (requireHandshakeAuth ON)", () => {
  const TOKEN = "a".repeat(64); // 256-bit hex, same shape as the real token
  let server: DaemonServer;

  afterEach(async () => { if (server) await server.close(); });

  it("rejects tool.recall as the FIRST line (no prior handshake) with UNAUTHORIZED", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: true, token: TOKEN }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "tool.recall", params: { sessionId: "s", args: {} } });
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(RPC_UNAUTHORIZED);
    c.close();
  });

  it("rejects hook.stop as the first line too (all non-meta methods gated)", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: true, token: TOKEN }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "hook.stop", params: {} });
    expect(resp.error?.code).toBe(RPC_UNAUTHORIZED);
    c.close();
  });

  it("allows tool.recall AFTER a valid meta.handshake on the same socket", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: true, token: TOKEN }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    const hs = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: TOKEN } });
    expect(hs.result).toMatchObject({ protocolVersion: 1 });
    expect(hs.error).toBeUndefined();
    const resp = await c.send({ jsonrpc: "2.0", id: 2, method: "tool.recall", params: { sessionId: "s", args: {} } });
    expect(resp.error).toBeUndefined();
    expect(resp.result.content[0].text).toBe("RECALL_OK");
    c.close();
  });

  it("meta.* is exempt pre-auth: meta.health works WITHOUT a handshake", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: true, token: TOKEN }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.health", params: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result.ok).toBe(true);
    c.close();
  });

  it("a WRONG token handshake leaves the socket unauthed — tool.recall still rejected", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: true, token: TOKEN }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    // Handshake with the wrong token: the handler throws → JSON-RPC error,
    // and markAuthed() is NOT reached, so the socket stays unauthed.
    const hs = await c.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: "b".repeat(64) } });
    expect(hs.error).toBeDefined();
    const resp = await c.send({ jsonrpc: "2.0", id: 2, method: "tool.recall", params: { sessionId: "s", args: {} } });
    expect(resp.error?.code).toBe(RPC_UNAUTHORIZED);
    c.close();
  });

  it("auth is PER-SOCKET: handshaking on socket A does not authorize socket B", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: true, token: TOKEN }));
    const port = server.getTcpPort()!;
    const a = openClient(port);
    const b = openClient(port);
    // A authenticates.
    const hsA = await a.send({ jsonrpc: "2.0", id: 1, method: "meta.handshake", params: { handshake: TOKEN } });
    expect(hsA.error).toBeUndefined();
    const okA = await a.send({ jsonrpc: "2.0", id: 2, method: "tool.recall", params: { sessionId: "s", args: {} } });
    expect(okA.result.content[0].text).toBe("RECALL_OK");
    // B never handshook — must still be rejected.
    const rejB = await b.send({ jsonrpc: "2.0", id: 1, method: "tool.recall", params: { sessionId: "s", args: {} } });
    expect(rejB.error?.code).toBe(RPC_UNAUTHORIZED);
    a.close();
    b.close();
  });
});

describe("E2: UDS / no-token mode (requireHandshakeAuth OFF) — happy path unchanged", () => {
  let server: DaemonServer;
  afterEach(async () => { if (server) await server.close(); });

  it("allows tool.recall WITHOUT any handshake when auth is not required", async () => {
    // Mirrors the Unix-socket daemon: 0600 perms isolate OS users, so no
    // per-socket gate. requireHandshakeAuth is false and token is null.
    ({ server } = await startServer({ requireHandshakeAuth: false, token: null }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "tool.recall", params: { sessionId: "s", args: {} } });
    expect(resp.error).toBeUndefined();
    expect(resp.result.content[0].text).toBe("RECALL_OK");
    c.close();
  });

  it("hook.* also works pre-handshake when auth is off", async () => {
    ({ server } = await startServer({ requireHandshakeAuth: false, token: null }));
    const port = server.getTcpPort()!;
    const c = openClient(port);
    const resp = await c.send({ jsonrpc: "2.0", id: 1, method: "hook.stop", params: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result.hookSpecificOutput).toBe("HOOK_OK");
    c.close();
  });
});
