/**
 * Regression test for K11: DaemonServer.close() must DRAIN in-flight RPCs
 * before tearing down client sockets and returning.
 *
 * The old close() ended every client socket and cleared the client map FIRST,
 * then closed the listeners — so a handler still awaiting the store mid-RPC had
 * its response socket destroyed (client saw a closed connection, not a result),
 * and the daemon's caller then disposed the store/embeddings while that handler
 * was still using them. The fix: stop accepting new connections, await
 * rpcsInFlight===0 (bounded), reply to anything still pending at the deadline,
 * THEN end sockets.
 *
 * This test starts a slow handler, calls close() while it's mid-flight, and
 * asserts (a) close() does NOT resolve before the handler finishes, and (b) the
 * client receives the handler's real result instead of a dropped connection.
 * Against the old code the client's socket would be ended mid-flight and the
 * result never delivered.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { DaemonServer } from "../src/daemon/server.js";

const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

describe("K11: close() drains in-flight RPCs before ending sockets", () => {
  let server: DaemonServer | null = null;
  afterEach(async () => {
    if (server) { try { await server.close(); } catch {} server = null; }
  });

  it("waits for an in-flight handler to finish and delivers its result", async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((r) => { releaseHandler = r; });
    let handlerStarted!: () => void;
    const started = new Promise<void>((r) => { handlerStarted = r; });

    server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
    // meta.health is a known method; give it a handler we can hold mid-flight.
    server.register("meta.health", async () => {
      handlerStarted();
      await handlerGate; // block until the test releases us
      return { ok: true, stats: { drained: true } };
    });
    await server.listen();
    const port = server.getTcpPort()!;

    // Fire an RPC and keep the socket open to receive the result.
    const sock = connect({ host: "127.0.0.1", port });
    let buffer = "";
    const responseP = new Promise<any>((resolve, reject) => {
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          try { resolve(JSON.parse(buffer.slice(0, nl))); }
          catch (e) { reject(e); }
        }
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("response timeout")), 4000);
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "meta.health" }) + "\n");

    // Wait until the handler is actually executing (rpcsInFlight === 1).
    await started;

    // Begin shutdown while the handler is mid-flight.
    let closeResolved = false;
    const closeP = server.close().then(() => { closeResolved = true; });

    // Give close() a chance to run its drain loop; it MUST NOT resolve yet,
    // because the handler is still in-flight.
    await new Promise((r) => setTimeout(r, 150));
    expect(closeResolved).toBe(false);

    // Release the handler; now the drain completes and close() resolves.
    releaseHandler();
    const resp = await responseP;
    await closeP;

    expect(closeResolved).toBe(true);
    // The client got the handler's REAL result, not a torn connection.
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ ok: true, stats: { drained: true } });

    try { sock.end(); } catch {}
  });

  it("close() returns promptly when there are no in-flight RPCs", async () => {
    server = new DaemonServer({ socketPath: null, tcpPort: 0, log: SILENT_LOG });
    server.register("meta.health", async () => ({ ok: true, stats: {} }));
    await server.listen();
    const t0 = Date.now();
    await server.close();
    server = null;
    // No drain wait when idle — well under the 5s default drain timeout.
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
