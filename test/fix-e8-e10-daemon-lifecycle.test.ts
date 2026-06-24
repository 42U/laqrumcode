/**
 * Regression tests for the daemon-lifecycle enterprise-readiness lane:
 *
 *   E8 (HIGH) — stale daemon after upgrade. meta.requestSupersede previously
 *     only exited the daemon at the LAST-client-disconnect boundary
 *     (onSupersedeReady). On a busy single-host install whose client count
 *     never reaches zero, a daemon flagged superseded by a newer mcp-client
 *     kept running OLD dist/ code indefinitely after `npm upgrade`. The fix
 *     adds a BOUNDED grace window (supersedeGraceMs): once the supersede flag
 *     is set, the daemon waits at most that long for a clean drain, then fires
 *     onSupersedeDeadline so daemon main drains in-flight RPCs (server.close())
 *     and exits ANYWAY — letting a fresh-dist daemon spawn on the next connect.
 *
 *   E10 (MEDIUM) — TCP bind EADDRINUSE had no recovery + no diagnostic. The TCP
 *     listen path rethrew a raw Error('listen EADDRINUSE') with no probe of WHO
 *     holds the port — asymmetric with the UDS path, which unlinks a stale
 *     socket first. The fix probes the occupant via an unauthenticated
 *     meta.health call and throws a DISTINGUISHABLE TcpPortInUseError whose
 *     `kind` is "laqrumcode-daemon" (a sibling laqrumcode daemon already serving)
 *     vs "foreign" (an unrelated process squatting the port).
 *
 * These tests use REAL sockets (node:net) — no mocks of the transport. TCP with
 * port 0 lets the OS assign a free port (read back via getTcpPort()), dodging
 * win32 CI ephemeral-port permission flakes, per the daemon-server.test.ts
 * convention.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect, createServer, type Server as NetServer } from "node:net";
import { DaemonServer, TcpPortInUseError } from "../src/daemon/server.js";
import { PROTOCOL_VERSION } from "../src/shared/ipc-types.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Open a client socket to the daemon and keep it attached. Resolves once the
 *  TCP connection is established so the daemon has registered it in `clients`. */
function attachClient(port: number): Promise<ReturnType<typeof connect>> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => resolve(sock));
    sock.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
}

// ───────────────────────── E8: supersede grace window ─────────────────────────

describe("E8: supersede grace window bounds a busy daemon's stale-code lifetime", () => {
  let server: DaemonServer | null = null;
  afterEach(async () => {
    if (server) { try { await server.close(); } catch {} server = null; }
  });

  it("fires onSupersedeDeadline within the grace window even with a client STILL attached", async () => {
    let deadlineFired = false;
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      supersedeGraceMs: 150, // short bound for the test
      onSupersedeDeadline: () => { deadlineFired = true; },
      // Graceful path also wired so we can prove the DEADLINE (not the graceful
      // last-disconnect path) is what fires while a client is attached.
      onSupersedeReady: () => { /* would fire only at clients===0 */ },
    });
    server.register("meta.health", async () => ({ ok: true, stats: server!.getStats() }));
    await server.listen();
    const port = server.getTcpPort()!;

    // Keep a client attached for the whole window so the graceful
    // last-client-disconnect path can NEVER fire — only the bounded deadline can.
    const client = await attachClient(port);
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(1);

    server.markPendingSupersede();
    expect(deadlineFired).toBe(false); // not yet — inside the window

    // Wait past the grace window.
    await new Promise((r) => setTimeout(r, 300));
    expect(deadlineFired).toBe(true);
    expect(server.attachedClientCount).toBeGreaterThanOrEqual(1); // client never left

    try { client.destroy(); } catch {}
  });

  it("prefers the graceful path: last-client-disconnect inside the window fires onSupersedeReady, NOT the deadline", async () => {
    let deadlineFired = false;
    let readyFired = 0;
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      supersedeGraceMs: 1_000, // generous window so the disconnect wins the race
      onSupersedeDeadline: () => { deadlineFired = true; },
      onSupersedeReady: () => { readyFired++; },
    });
    server.register("meta.health", async () => ({ ok: true, stats: server!.getStats() }));
    await server.listen();
    const port = server.getTcpPort()!;

    const client = await attachClient(port);
    server.markPendingSupersede();
    // Disconnect promptly — well inside the 1s window.
    client.destroy();

    // Give the close handler time to run checkSupersedeReady.
    await new Promise((r) => setTimeout(r, 150));
    expect(readyFired).toBe(1);

    // Wait out the REST of the grace window: the deadline must NOT also fire
    // (supersedeFired is the shared guard; graceful path disarmed the timer).
    await new Promise((r) => setTimeout(r, 1_100));
    expect(deadlineFired).toBe(false);
    expect(readyFired).toBe(1); // still exactly one exit
  });

  it("DRAINS in-flight RPCs when the deadline-driven exit calls close()", async () => {
    // Wire onSupersedeDeadline to the real shutdown action (server.close()),
    // mirroring daemon main's reaperExit → gracefulCleanup → server.close().
    // Prove the in-flight handler finishes and its result is delivered (the K11
    // drain) rather than being severed by the deadline-driven exit.
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((r) => { releaseHandler = r; });
    let handlerStarted!: () => void;
    const started = new Promise<void>((r) => { handlerStarted = r; });

    let closeP: Promise<void> | null = null;
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      supersedeGraceMs: 100,
      onSupersedeDeadline: () => { closeP = server!.close(); },
    });
    server.register("meta.health", async () => {
      handlerStarted();
      await handlerGate; // hold the RPC in-flight across the deadline
      return { ok: true, stats: { drained: true } };
    });
    await server.listen();
    const port = server.getTcpPort()!;

    // Fire an RPC and keep the socket open to receive the result.
    const sock = connect({ host: "127.0.0.1", port });
    let buffer = "";
    const responseP = new Promise<any>((resolve, reject) => {
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          try { resolve(JSON.parse(buffer.slice(0, nl))); } catch (e) { reject(e); }
        }
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("response timeout")), 4000);
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "meta.health" }) + "\n");

    await started; // handler is now in-flight

    // Flag supersede; the 100ms deadline will fire while the handler is held.
    server.markPendingSupersede();

    // Wait until the deadline has fired and kicked off close().
    await new Promise((r) => setTimeout(r, 250));
    expect(closeP).not.toBeNull();

    // close() must NOT have resolved yet — it is draining the held handler.
    let closeResolved = false;
    closeP!.then(() => { closeResolved = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(closeResolved).toBe(false);

    // Release the handler → drain completes → result delivered → close resolves.
    releaseHandler();
    const resp = await responseP;
    await closeP!;

    expect(resp.id).toBe(7);
    expect(resp.result).toEqual({ ok: true, stats: { drained: true } });

    try { sock.destroy(); } catch {}
    server = null; // already closed
  });

  it("does not arm any deadline when supersedeGraceMs is 0 (legacy behavior)", async () => {
    let deadlineFired = false;
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      supersedeGraceMs: 0,
      onSupersedeDeadline: () => { deadlineFired = true; },
    });
    server.register("meta.health", async () => ({ ok: true, stats: {} }));
    await server.listen();
    const port = server.getTcpPort()!;
    const client = await attachClient(port);

    server.markPendingSupersede();
    await new Promise((r) => setTimeout(r, 250));
    // With the bound disabled and a client still attached, nothing fires.
    expect(deadlineFired).toBe(false);
    try { client.destroy(); } catch {}
  });

  it("markPendingSupersede is idempotent and does not extend the window on re-flag", async () => {
    let deadlineFired = false;
    server = new DaemonServer({
      socketPath: null,
      tcpPort: 0,
      log: SILENT_LOG,
      supersedeGraceMs: 200,
      onSupersedeDeadline: () => { deadlineFired = true; },
    });
    server.register("meta.health", async () => ({ ok: true, stats: {} }));
    await server.listen();
    const port = server.getTcpPort()!;
    const client = await attachClient(port);

    server.markPendingSupersede();
    // Re-flag repeatedly partway through — must NOT reset the timer.
    await new Promise((r) => setTimeout(r, 120));
    server.markPendingSupersede();
    server.markPendingSupersede();
    // The deadline is anchored to the FIRST flag (~200ms total), so by ~260ms
    // total it must have fired despite the later re-flags.
    await new Promise((r) => setTimeout(r, 180));
    expect(deadlineFired).toBe(true);
    try { client.destroy(); } catch {}
  });
});

// ───────────────────────── E10: EADDRINUSE diagnostics ────────────────────────

/** Minimal foreign occupant: accepts the connection but never speaks
 *  line-delimited JSON-RPC, so the probe must classify it as "foreign". */
function startForeignOccupant(): Promise<{ server: NetServer; port: number }> {
  const server = createServer((sock) => {
    // Stay silent — a real foreign service (or one that speaks a different
    // protocol) would not answer a meta.health JSON-RPC line. Swallow input.
    sock.on("data", () => {});
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

/** A stand-in laqrumcode daemon: answers meta.health with a well-formed JSON-RPC
 *  result, exactly as DaemonServer's real meta.health does. The probe must
 *  classify this as "laqrumcode-daemon". */
function startLaqrumcodeHealthOccupant(): Promise<{ server: NetServer; port: number }> {
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
        if (msg.method === "meta.health") {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: { ok: true, stats: { activeClients: 1, protocolVersion: PROTOCOL_VERSION } } }) + "\n");
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

describe("E10: TCP EADDRINUSE produces a distinguishable error", () => {
  let occupant: { server: NetServer; port: number } | null = null;
  let second: DaemonServer | null = null;

  afterEach(async () => {
    if (second) { try { await second.close(); } catch {} second = null; }
    if (occupant) { await new Promise<void>((r) => occupant!.server.close(() => r())); occupant = null; }
  });

  it("throws TcpPortInUseError kind=foreign when a non-laqrumcode process holds the port", async () => {
    occupant = await startForeignOccupant();
    second = new DaemonServer({
      socketPath: null,
      tcpPort: occupant.port, // collide deliberately
      log: SILENT_LOG,
      probeTimeoutMs: 500,
    });

    let caught: unknown;
    try { await second.listen(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TcpPortInUseError);
    expect((caught as TcpPortInUseError).kind).toBe("foreign");
    expect((caught as TcpPortInUseError).port).toBe(occupant.port);
    expect((caught as Error).message).toMatch(/FOREIGN/);
    second = null; // never bound — nothing to close
  });

  it("throws TcpPortInUseError kind=laqrumcode-daemon when a laqrumcode daemon already serves the port", async () => {
    occupant = await startLaqrumcodeHealthOccupant();
    second = new DaemonServer({
      socketPath: null,
      tcpPort: occupant.port,
      log: SILENT_LOG,
      probeTimeoutMs: 500,
    });

    let caught: unknown;
    try { await second.listen(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TcpPortInUseError);
    expect((caught as TcpPortInUseError).kind).toBe("laqrumcode-daemon");
    expect((caught as TcpPortInUseError).port).toBe(occupant.port);
    expect((caught as Error).message).toMatch(/already served by another laqrumcode daemon/);
    second = null; // never bound
  });

  it("the SAME collision against a REAL DaemonServer occupant is classified laqrumcode-daemon", async () => {
    // End-to-end: a real DaemonServer (with its real meta.health) holds the
    // port; a second real DaemonServer attempting the same port must recognize
    // it as a sibling laqrumcode daemon, not a foreign squatter.
    const first = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
    first.register("meta.health", async () => ({ ok: true, stats: first.getStats() }));
    await first.listen();
    const port = first.getTcpPort()!;

    second = new DaemonServer({ socketPath: null, tcpPort: port, log: SILENT_LOG, probeTimeoutMs: 500 });
    let caught: unknown;
    try { await second.listen(); } catch (e) { caught = e; }
    second = null; // never bound

    expect(caught).toBeInstanceOf(TcpPortInUseError);
    expect((caught as TcpPortInUseError).kind).toBe("laqrumcode-daemon");

    await first.close();
  });
});
