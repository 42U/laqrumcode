/**
 * Regression test for R6: the MCP CLIENT must be transport-aware and symmetric
 * with the daemon. Before this fix the client was hardwired to Unix-domain
 * sockets:
 *   - ensureDaemon only resolved a socketPath and gated readiness on
 *     existsSync(socketPath) — meaningless on Windows, where the daemon binds
 *     TCP-only and no socket file ever exists. Result: daemon unreachable on
 *     100% of Windows installs, and the LAQRUMCODE_DAEMON_TRANSPORT=tcp opt-in
 *     was dead because the client never set tcpHost/tcpPort on IpcClient.
 *
 * The fix makes the client mirror the daemon's transport selection
 * (daemon/index.ts: `useUds = TRANSPORT !== "tcp" && platform !== "win32"`,
 * port = LAQRUMCODE_DAEMON_PORT ?? DEFAULT_DAEMON_TCP_PORT, host 127.0.0.1) and
 * threads tcpHost/tcpPort into IpcClient at every construction site.
 *
 * These tests use REAL sockets (node:net) standing in for the daemon — no
 * mocks. The daemon-binary-spawn variant is gated behind itDaemon (skips when
 * the compiled dist/daemon is absent, e.g. CI before build) but documents the
 * end-to-end intent: spawn the daemon in tcp mode, complete meta.handshake
 * over TCP.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureDaemon,
  resolveTransport,
  resolveTcpPort,
} from "../src/mcp-client/daemon-spawn.js";
import { IpcClient } from "../src/mcp-client/ipc-client.js";
import { DEFAULT_DAEMON_TCP_PORT, PROTOCOL_VERSION } from "../src/shared/ipc-types.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Minimal line-delimited JSON-RPC daemon stand-in. Answers meta.health and
 *  meta.handshake — exactly what ensureDaemon's readiness probe and the
 *  client's handshake need. Works the same over TCP and a Unix socket because
 *  the wire format is transport-independent (which is the whole point). */
function startFakeDaemon(opts: { port?: number; socketPath?: string }): Promise<{ server: Server; port: number }> {
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; method?: string };
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id !== "number") continue;
        let result: unknown;
        if (msg.method === "meta.health") {
          result = { ok: true, stats: { activeClients: 1 } };
        } else if (msg.method === "meta.handshake") {
          result = {
            daemonVersion: "0.0.0-fake",
            protocolVersion: PROTOCOL_VERSION,
            startedAt: Date.now(),
            bootstrapPhase: "ready",
            bootstrapError: null,
          };
        } else {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\n");
          continue;
        }
        sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (opts.socketPath) {
      server.listen(opts.socketPath, () => { server.removeListener("error", reject); resolve({ server, port: 0 }); });
    } else {
      // port 0 → OS assigns a free port; read it back for the client to target.
      server.listen(opts.port ?? 0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const addr = server.address();
        resolve({ server, port: addr && typeof addr === "object" ? addr.port : 0 });
      });
    }
  });
}

// ── Transport selection parity with the daemon ───────────────────────────

describe("R6: resolveTransport mirrors the daemon's useUds decision", () => {
  it("picks tcp on win32 regardless of env", () => {
    expect(resolveTransport({}, "win32")).toBe("tcp");
    expect(resolveTransport({ LAQRUMCODE_DAEMON_TRANSPORT: "tcp" }, "win32")).toBe("tcp");
    // Even an explicit non-tcp value can't give a win32 box a Unix socket.
    expect(resolveTransport({ LAQRUMCODE_DAEMON_TRANSPORT: "uds" }, "win32")).toBe("tcp");
  });

  it("picks tcp when LAQRUMCODE_DAEMON_TRANSPORT=tcp on any non-windows platform", () => {
    expect(resolveTransport({ LAQRUMCODE_DAEMON_TRANSPORT: "tcp" }, "linux")).toBe("tcp");
    expect(resolveTransport({ LAQRUMCODE_DAEMON_TRANSPORT: "tcp" }, "darwin")).toBe("tcp");
  });

  it("picks uds by default on linux/macOS", () => {
    expect(resolveTransport({}, "linux")).toBe("uds");
    expect(resolveTransport({}, "darwin")).toBe("uds");
    // A non-"tcp" value is treated as uds (matches the daemon's strict === check).
    expect(resolveTransport({ LAQRUMCODE_DAEMON_TRANSPORT: "" }, "linux")).toBe("uds");
  });
});

describe("R6: resolveTcpPort matches daemon/index.ts port logic", () => {
  // S6 update: the no-override default is no longer the FLAT DEFAULT_DAEMON_TCP_PORT
  // (that flat port was the multi-OS-user breach). It is now the PER-USER port
  // base + hash(osUserDiscriminator)%10000. The full per-user behavior is
  // covered in fix-s6-win-isolation.test.ts; here we just assert R6's parity
  // claim still holds under the corrected contract.
  it("defaults into the per-user window, disjoint from the SurrealDB port (T3)", () => {
    const got = resolveTcpPort({});
    // who===null (degenerate sandbox) → flat DEFAULT; otherwise the T3 per-user
    // window [28765, 32764] — ABOVE the SurrealDB window [18765, 28764], BELOW
    // the 32768 ephemeral floor. Full coverage in fix-s6-win-isolation.test.ts.
    const inWindow = got === DEFAULT_DAEMON_TCP_PORT || (got >= 28765 && got < 32765);
    expect(inWindow).toBe(true);
  });

  it("honors a valid LAQRUMCODE_DAEMON_PORT override (verbatim, no per-user offset)", () => {
    expect(resolveTcpPort({ LAQRUMCODE_DAEMON_PORT: "23456" })).toBe(23456);
  });

  it("ignores an invalid/zero/negative override and falls through to the per-user derivation", () => {
    // Invalid overrides no longer pin the flat default; they fall through to the
    // per-user port (identical to the no-override default on this host).
    const perUser = resolveTcpPort({});
    expect(resolveTcpPort({ LAQRUMCODE_DAEMON_PORT: "0" })).toBe(perUser);
    expect(resolveTcpPort({ LAQRUMCODE_DAEMON_PORT: "-1" })).toBe(perUser);
    expect(resolveTcpPort({ LAQRUMCODE_DAEMON_PORT: "notanumber" })).toBe(perUser);
  });
});

// ── ensureDaemon returns the correct endpoint shape per transport ─────────

describe("R6: ensureDaemon returns a TCP endpoint under LAQRUMCODE_DAEMON_TRANSPORT=tcp", () => {
  let fake: { server: Server; port: number } | null = null;
  const prevTransport = process.env.LAQRUMCODE_DAEMON_TRANSPORT;
  const prevPort = process.env.LAQRUMCODE_DAEMON_PORT;

  afterEach(async () => {
    if (fake) { await new Promise<void>((r) => fake!.server.close(() => r())); fake = null; }
    if (prevTransport === undefined) delete process.env.LAQRUMCODE_DAEMON_TRANSPORT;
    else process.env.LAQRUMCODE_DAEMON_TRANSPORT = prevTransport;
    if (prevPort === undefined) delete process.env.LAQRUMCODE_DAEMON_PORT;
    else process.env.LAQRUMCODE_DAEMON_PORT = prevPort;
  });

  it("fast-path reaches an existing TCP daemon and returns {tcpHost,tcpPort}", async () => {
    fake = await startFakeDaemon({});
    process.env.LAQRUMCODE_DAEMON_TRANSPORT = "tcp";
    process.env.LAQRUMCODE_DAEMON_PORT = String(fake.port);

    const ep = await ensureDaemon({ log: SILENT_LOG, readyTimeoutMs: 3_000 });

    expect(ep.spawned).toBe(false);
    expect(ep.tcpHost).toBe("127.0.0.1");
    expect(ep.tcpPort).toBe(fake.port);
  });
});

describe("R6: ensureDaemon returns a UDS endpoint in default (linux/macOS) mode", () => {
  let fake: { server: Server; port: number } | null = null;
  let dir: string | null = null;
  const prevTransport = process.env.LAQRUMCODE_DAEMON_TRANSPORT;

  afterEach(async () => {
    if (fake) { await new Promise<void>((r) => fake!.server.close(() => r())); fake = null; }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} dir = null; }
    if (prevTransport === undefined) delete process.env.LAQRUMCODE_DAEMON_TRANSPORT;
    else process.env.LAQRUMCODE_DAEMON_TRANSPORT = prevTransport;
  });

  it("fast-path reaches an existing Unix socket and returns no tcpPort", async () => {
    // Skip on win32 (no Unix sockets there — and resolveTransport would force
    // tcp anyway, which is its own test above).
    if (process.platform === "win32") return;
    delete process.env.LAQRUMCODE_DAEMON_TRANSPORT;
    dir = mkdtempSync(join(tmpdir(), "kc-r6-uds-"));
    const socketPath = join(dir, "d.sock");
    fake = await startFakeDaemon({ socketPath });

    const ep = await ensureDaemon({ socketPath, log: SILENT_LOG, readyTimeoutMs: 3_000 });

    expect(ep.spawned).toBe(false);
    expect(ep.socketPath).toBe(socketPath);
    expect(ep.tcpPort).toBeUndefined();
    expect(ep.tcpHost).toBeUndefined();
  });
});

// ── The core R6 proof: IpcClient actually speaks TCP ──────────────────────

describe("R6: IpcClient connects over TCP and completes meta.handshake", () => {
  let fake: { server: Server; port: number } | null = null;
  afterEach(async () => {
    if (fake) { await new Promise<void>((r) => fake!.server.close(() => r())); fake = null; }
  });

  it("constructs with {socketPath:null, tcpHost, tcpPort} and handshakes", async () => {
    fake = await startFakeDaemon({});
    const client = new IpcClient({
      socketPath: null,
      tcpHost: "127.0.0.1",
      tcpPort: fake.port,
      log: SILENT_LOG,
      defaultTimeoutMs: 3_000,
    });
    await client.connect();
    const resp = await client.handshake();
    client.close();
    expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(resp.daemonVersion).toBe("0.0.0-fake");
  });

  it("rejects TCP construction with no usable port (port-0 footgun guard)", async () => {
    const client = new IpcClient({ socketPath: null, log: SILENT_LOG, defaultTimeoutMs: 500 });
    await expect(client.connect()).rejects.toThrow(/positive tcpPort/);
    client.close();
  });
});

// ── Gated end-to-end: real daemon binary, real TCP handshake ──────────────

/** Skip when the compiled daemon script isn't present (CI before `npm run
 *  build`). Documents the full intent: a real daemon spawned in tcp mode is
 *  reachable over TCP. Real-DB / real-binary, so it follows the itDb-style
 *  skip convention. */
const daemonScript = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "dist", "daemon", "index.js");
  } catch { return ""; }
})();
const DAEMON_AVAILABLE = !!daemonScript && existsSync(daemonScript);
const itDaemon = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(name, async () => { if (!DAEMON_AVAILABLE) return; await fn(); }, timeout);

describe("R6 (gated): spawning the real daemon in tcp mode is reachable over TCP", () => {
  const prevTransport = process.env.LAQRUMCODE_DAEMON_TRANSPORT;
  const prevPort = process.env.LAQRUMCODE_DAEMON_PORT;
  afterEach(() => {
    if (prevTransport === undefined) delete process.env.LAQRUMCODE_DAEMON_TRANSPORT;
    else process.env.LAQRUMCODE_DAEMON_TRANSPORT = prevTransport;
    if (prevPort === undefined) delete process.env.LAQRUMCODE_DAEMON_PORT;
    else process.env.LAQRUMCODE_DAEMON_PORT = prevPort;
  });

  itDaemon("ensureDaemon spawns/returns a TCP endpoint the client can handshake", async () => {
    // Use a non-default high port to avoid clobbering a real local daemon.
    const port = 28764;
    process.env.LAQRUMCODE_DAEMON_TRANSPORT = "tcp";
    process.env.LAQRUMCODE_DAEMON_PORT = String(port);
    const ep = await ensureDaemon({ log: SILENT_LOG, readyTimeoutMs: 120_000 });
    expect(ep.tcpHost).toBe("127.0.0.1");
    expect(ep.tcpPort).toBe(port);
    const client = new IpcClient({ socketPath: null, tcpHost: ep.tcpHost, tcpPort: ep.tcpPort, log: SILENT_LOG });
    await client.connect();
    const resp = await client.handshake();
    client.close();
    expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
  }, 130_000);
});
