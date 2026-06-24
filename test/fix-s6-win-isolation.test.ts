/**
 * Regression test for S6 (MEDIUM): Windows / TCP multi-OS-user isolation.
 *
 * Round-3 (commit efb671a, GH #13) gave every OS user a private daemon on the
 * UNIX-SOCKET path (per-user $HOME/.laqrumcode-daemon.sock) and a per-user
 * managed-SurrealDB port (bootstrap.pickPort() = 18765 + uid%10000). But the
 * Windows / LAQRUMCODE_DAEMON_TRANSPORT=tcp path was left on a FLAT shared
 * loopback port (DEFAULT_DAEMON_TCP_PORT = 18764) with NO per-user offset and
 * NO IPC auth. On a shared host a 2nd OS user's client fast-path-pinged
 * 127.0.0.1:18764, reached the 1st user's already-running daemon, and adopted
 * their private graph — a privacy/isolation breach.
 *
 * The fix is two layers, mirroring the patterns round-3 already established:
 *
 *   1. PER-USER PORT — resolveTcpPort() now returns
 *      DEFAULT_DAEMON_TCP_PORT + (stableHash32(osUserDiscriminator) % 10000),
 *      the same modulus shape as bootstrap.pickPort(). Different OS accounts
 *      land on different ports, so cross-adoption almost never even reaches a
 *      shared port. An explicit LAQRUMCODE_DAEMON_PORT override is used verbatim
 *      (no offset), matching pickPort's env-wins rule. The SAME exported helper
 *      is imported by BOTH the client (daemon-spawn) and the daemon
 *      (daemon/index), so the two derive an identical port — verified here.
 *
 *   2. HANDSHAKE TOKEN — defense in depth for the rare hash collision. Loopback
 *      TCP is reachable by ANY local user (unlike the 0600 Unix socket), so the
 *      daemon writes a 256-bit secret to a 0600 per-user file at TCP-bind, and
 *      meta.handshake rejects a missing/mismatched token. A different OS user
 *      can't read the 0600 file, so even a port collision is turned away.
 *
 * These tests use REAL node:net sockets and a REAL on-disk 0600 token file —
 * no mocks. The token-rejection server replicates the daemon's exact inline
 * check (daemon/index.ts meta.handshake) and drives the REAL IpcClient.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveTcpPort,
  osUserDiscriminator,
  stableHash32,
  resolveDaemonTokenPath,
  readDaemonToken,
  PORT_OFFSET_BASE,
  PORT_OFFSET_RANGE,
} from "../src/mcp-client/daemon-spawn.js";
import { IpcClient } from "../src/mcp-client/ipc-client.js";
import { DEFAULT_DAEMON_TCP_PORT, PROTOCOL_VERSION } from "../src/shared/ipc-types.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };
// T3: PORT_OFFSET_BASE/PORT_OFFSET_RANGE are imported from daemon-spawn (single
// source of truth). The window must sit ABOVE the SurrealDB port window
// ([18765, 28764] = 18765 + uid%10000; fixed 18765 on win32) and BELOW the
// 32768 ephemeral-port floor.
const SURREAL_WINDOW_MAX = 28764;

// ── Layer 1: per-user port derivation ─────────────────────────────────────

describe("S6: resolveTcpPort derives a PER-USER loopback port (no more flat 18764)", () => {
  it("two different OS users resolve to different ports", () => {
    // resolveTcpPort() reads the live uid/username, so exercise the underlying
    // deterministic composition the daemon and client both use. Distinct
    // discriminators must (for these fixed sample names) map to distinct ports.
    const portFor = (who: string) =>
      PORT_OFFSET_BASE + (stableHash32(who) % PORT_OFFSET_RANGE);
    const alice = portFor("user:alice");
    const bob = portFor("user:bob");
    const carol = portFor("user:carol");
    expect(alice).not.toBe(bob);
    expect(bob).not.toBe(carol);
    expect(alice).not.toBe(carol);
    // ...and none of them is the old flat default (that was the breach).
    // (At least one differing is enough to prove the offset is applied; in
    //  practice all three differ from the bare base.)
    expect([alice, bob, carol].some((p) => p !== PORT_OFFSET_BASE)).toBe(true);
  });

  it("every derived port stays in the per-user window, DISJOINT from the SurrealDB port + ephemeral range (T3)", () => {
    // T3 regression guard: the window must NOT overlap [18765, 28764] (managed
    // SurrealDB; fixed 18765 on win32) and must stay below the 32768 ephemeral
    // floor. The pre-T3 window [18764, 28763] overlapped 18765 → ~1/10000
    // usernames collided and wedged the daemon on Windows.
    expect(PORT_OFFSET_BASE).toBeGreaterThan(SURREAL_WINDOW_MAX);
    expect(PORT_OFFSET_BASE + PORT_OFFSET_RANGE).toBeLessThanOrEqual(32768);
    for (const who of ["uid:0", "uid:1000", "user:Administrator", "user:SYSTEM", "user:zero"]) {
      const p = PORT_OFFSET_BASE + (stableHash32(who) % PORT_OFFSET_RANGE);
      expect(p).toBeGreaterThanOrEqual(PORT_OFFSET_BASE);
      expect(p).toBeLessThan(PORT_OFFSET_BASE + PORT_OFFSET_RANGE);
      expect(p).toBeGreaterThan(SURREAL_WINDOW_MAX); // never collides with SurrealDB
    }
  });

  it("stableHash32 is deterministic and unsigned-32-bit", () => {
    expect(stableHash32("user:zero")).toBe(stableHash32("user:zero"));
    for (const s of ["", "a", "user:zero", "uid:1000", "x".repeat(300)]) {
      const h = stableHash32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("an explicit LAQRUMCODE_DAEMON_PORT override is used verbatim — NO per-user offset", () => {
    // Operator intent wins (mirrors bootstrap.pickPort's env-override rule), so
    // a shared explicit port is honoured as-is on every account.
    expect(resolveTcpPort({ LAQRUMCODE_DAEMON_PORT: "23456" })).toBe(23456);
    expect(resolveTcpPort({ LAQRUMCODE_DAEMON_PORT: "23456" })).not.toBe(
      PORT_OFFSET_BASE + (stableHash32(osUserDiscriminator() ?? "") % PORT_OFFSET_RANGE),
    );
  });

  it("the no-override default resolves into the per-user window (offset is applied)", () => {
    const who = osUserDiscriminator();
    const got = resolveTcpPort({});
    if (who === null) {
      // No uid and no username (degenerate sandbox) → flat default is the only
      // safe choice; isolation then leans entirely on the handshake token.
      expect(got).toBe(DEFAULT_DAEMON_TCP_PORT);
    } else {
      expect(got).toBe(PORT_OFFSET_BASE + (stableHash32(who) % PORT_OFFSET_RANGE));
      expect(got).toBeGreaterThanOrEqual(PORT_OFFSET_BASE);
      expect(got).toBeLessThan(PORT_OFFSET_BASE + PORT_OFFSET_RANGE);
    }
  });
});

// ── Token file plumbing (real 0600 file on disk) ──────────────────────────

describe("S6: handshake token file is per-user and 0600", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} dir = null; }
  });

  it("resolveDaemonTokenPath co-locates the token in the user's own home", () => {
    // Compare via join() so the expected uses the platform separator — on Windows
    // resolveDaemonTokenPath() returns a backslash path, so a hardcoded forward-slash
    // literal would (and did) fail the win32 CI leg.
    expect(resolveDaemonTokenPath("/home/alice")).toBe(join("/home/alice", ".laqrumcode-daemon.token"));
    expect(resolveDaemonTokenPath("/home/bob")).not.toBe(resolveDaemonTokenPath("/home/alice"));
  });

  it("readDaemonToken reads our token but returns null for a missing/empty file", () => {
    dir = mkdtempSync(join(tmpdir(), "kc-s6-tok-"));
    expect(readDaemonToken(dir)).toBeNull(); // not written yet
    const secret = "a".repeat(64);
    const p = resolveDaemonTokenPath(dir);
    writeFileSync(p, secret + "\n", { mode: 0o600 });
    chmodSync(p, 0o600);
    expect(readDaemonToken(dir)).toBe(secret); // trimmed
    // On POSIX, assert the perms are owner-only (the property that keeps a
    // different OS user from reading the secret). Skipped on win32 (no mode).
    if (process.platform !== "win32") {
      expect(statSync(p).mode & 0o077).toBe(0);
    }
    writeFileSync(p, "   \n", { mode: 0o600 }); // whitespace-only → null
    expect(readDaemonToken(dir)).toBeNull();
  });
});

// ── Layer 2: handshake-token enforcement over the REAL wire ───────────────

/** Fake daemon that replicates daemon/index.ts's EXACT inline token check in
 *  meta.handshake: if it was started with a token, a client's params.handshake
 *  must match or the handshake errors (HANDLER_ERROR family). meta.health is
 *  always answered (liveness must never require the token). */
function startTokenDaemon(opts: { token: string | null }): Promise<{ server: Server; port: number }> {
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; method?: string; params?: { handshake?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id !== "number") continue;
        const reply = (result: unknown) =>
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
        const fail = (message: string) =>
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32003, message } }) + "\n");

        if (msg.method === "meta.health") {
          reply({ ok: true, stats: { activeClients: 1 } });
        } else if (msg.method === "meta.handshake") {
          if (opts.token !== null) {
            const presented = typeof msg.params?.handshake === "string" ? msg.params.handshake : "";
            const ok = presented.length === opts.token.length && presented === opts.token;
            if (!ok) { fail("handshake token mismatch — this daemon belongs to a different OS user"); continue; }
          }
          reply({
            daemonVersion: "0.0.0-fake",
            protocolVersion: PROTOCOL_VERSION,
            startedAt: Date.now(),
            bootstrapPhase: "ready",
            bootstrapError: null,
          });
        } else {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\n");
        }
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      resolve({ server, port: addr && typeof addr === "object" ? addr.port : 0 });
    });
  });
}

describe("S6: a TCP daemon rejects a missing/wrong per-user token and accepts the right one", () => {
  let fake: { server: Server; port: number } | null = null;
  afterEach(async () => {
    if (fake) { await new Promise<void>((r) => fake!.server.close(() => r())); fake = null; }
  });

  const SECRET = "deadbeef".repeat(8); // 64 hex chars, like randomBytes(32).toString("hex")

  it("rejects a client that presents NO token (the cross-user adoption case)", async () => {
    fake = await startTokenDaemon({ token: SECRET });
    const client = new IpcClient({ socketPath: null, tcpHost: "127.0.0.1", tcpPort: fake.port, log: SILENT_LOG, defaultTimeoutMs: 3_000 });
    await client.connect();
    // No token passed and no token file in this user's home → handshake() sends
    // nothing → daemon rejects. (A different OS user can't read the 0600 file,
    // so this is exactly their experience after a port collision.)
    await expect(client.handshake({ pid: 1, version: "test", sessionId: "s" }, undefined)).rejects.toThrow(/token mismatch/);
    client.close();
  });

  it("rejects a client that presents the WRONG token", async () => {
    fake = await startTokenDaemon({ token: SECRET });
    const client = new IpcClient({ socketPath: null, tcpHost: "127.0.0.1", tcpPort: fake.port, log: SILENT_LOG, defaultTimeoutMs: 3_000 });
    await client.connect();
    await expect(
      client.handshake({ pid: 1, version: "test", sessionId: "s" }, "f".repeat(64)),
    ).rejects.toThrow(/token mismatch/);
    client.close();
  });

  it("ACCEPTS a client that presents the correct token", async () => {
    fake = await startTokenDaemon({ token: SECRET });
    const client = new IpcClient({ socketPath: null, tcpHost: "127.0.0.1", tcpPort: fake.port, log: SILENT_LOG, defaultTimeoutMs: 3_000 });
    await client.connect();
    const resp = await client.handshake({ pid: 1, version: "test", sessionId: "s" }, SECRET);
    client.close();
    expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(resp.daemonVersion).toBe("0.0.0-fake");
  });

  it("a UDS-style daemon with NO token accepts a tokenless handshake (back-compat unchanged)", async () => {
    // token:null models the Unix-socket daemon (already 0600-isolated). The
    // existing tokenless handshake path must keep working untouched.
    fake = await startTokenDaemon({ token: null });
    const client = new IpcClient({ socketPath: null, tcpHost: "127.0.0.1", tcpPort: fake.port, log: SILENT_LOG, defaultTimeoutMs: 3_000 });
    await client.connect();
    const resp = await client.handshake({ pid: 1, version: "test", sessionId: "s" });
    client.close();
    expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

// ── Client↔daemon parity: the two use the SAME exported helper ────────────

describe("S6: client and daemon derive the SAME port from the SAME helper", () => {
  it("daemon/index.ts imports resolveTcpPort from daemon-spawn (single source of truth)", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const daemonSrc = fs.readFileSync(path.join(here, "..", "src", "daemon", "index.ts"), "utf8");
    // The daemon must import the shared port + token-path helpers, not redefine
    // its own — that parity is what prevents a client/daemon port split.
    expect(daemonSrc).toMatch(/import\s*\{[^}]*resolveTcpPort[^}]*\}\s*from\s*["']\.\.\/mcp-client\/daemon-spawn\.js["']/);
    expect(daemonSrc).toContain("resolveDaemonTokenPath");
    // And it must call resolveTcpPort() rather than binding the flat constant.
    expect(daemonSrc).toMatch(/tcpPort\s*=\s*\([^)]*\)\s*\?\s*resolveTcpPort\(\)/);
  });
});
