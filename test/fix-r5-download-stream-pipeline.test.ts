/**
 * R5 / R14 / R15 regression — bootstrap.ts downloadFile() stream rewrite.
 *
 * Three coupled defects in the K39 download path, all fixed together by
 * replacing the manual fetch-body write/drain loop with a node:stream/promises
 * pipeline() + a scoped connect-only AbortController:
 *
 *  - R5 (wall-clock body cap): the old code put AbortSignal.timeout(120_000) on
 *    the WHOLE body fetch, so a healthy slow-but-progressing large download
 *    (BGE-M3 ~420MB) on a modest link was aborted at 120s → deterministic
 *    cold-start failure. The fix scopes a SHORT abort to the connection/headers
 *    phase only and clears it once headers arrive; the body phase is governed
 *    solely by the per-chunk inactivity watchdog. A body that keeps making
 *    progress (gaps < inactivity) must complete no matter how long it runs.
 *
 *  - R14 (writer fd leak / leftover .partial): the old try/finally cleared only
 *    the stall timer; when the read loop threw, writer.end() was skipped and the
 *    .partial write-stream fd leaked. The fix routes through pipeline() (which
 *    destroys the destination on source error) plus an explicit rm() of the
 *    .partial on the error path. After a failed download no .partial remains.
 *
 *  - R15 (drain hang on write error): the old `writer.once("drain")` had only a
 *    resolve path; an ENOSPC/EIO while parked on drain would hang forever.
 *    pipeline() propagates write-side errors and rejects. We force a write-side
 *    failure (destination parent is a regular file → createWriteStream errors)
 *    and assert downloadFile REJECTS within a bound rather than hanging.
 *
 * These are real-behavior tests: a real node:http server drives the bytes and a
 * real temp dir backs the writer. No DB needed, so no itDb gating. The
 * inactivity/connect bounds are injected (4th arg) so the watchdog runs in ms.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { downloadFile, DOWNLOAD_INACTIVITY_MS } from "../src/engine/bootstrap.js";

let server: Server | undefined;
const openSockets = new Set<Socket>();
const tmpDirs: string[] = [];

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kc-dlfix-"));
  tmpDirs.push(d);
  return d;
}

/** Start an HTTP server with a per-request handler; resolve its base URL. Tracks
 *  live sockets so afterEach can force-close even the "silent body" connections
 *  (stall test) that would otherwise keep server.close() pending. */
function startServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.on("connection", (sock: Socket) => {
      openSockets.add(sock);
      sock.on("close", () => openSockets.delete(sock));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/file`);
    });
  });
}

afterEach(async () => {
  for (const sock of openSockets) { try { sock.destroy(); } catch { /* ignore */ } }
  openSockets.clear();
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("R5/R14/R15: downloadFile stream pipeline", () => {
  // ---- Sanity: the exported production constant is unchanged (30s). ----
  it("keeps the production inactivity window at 30s", () => {
    expect(DOWNLOAD_INACTIVITY_MS).toBe(30_000);
  });

  // ---- R5: slow-but-progressing body must NOT be wall-clock-aborted. ----
  // The fix scopes the abort to the CONNECT/headers phase and clears it once
  // headers arrive, so the connect bound can never cut off a healthy body. We
  // prove that directly: the body keeps dripping (gaps < inactivity) for a
  // TOTAL duration well BEYOND the connect timeout. If the connect signal were
  // still attached to the body (the pre-fix single-signal-for-everything shape),
  // the body fetch would abort once total time crossed the bound and reject.
  // The fix lets it complete.
  it("R5: a slow body that runs past the connect timeout still completes (connect bound is scoped, not a total cap)", async () => {
    const CHUNKS = 8;
    const GAP_MS = 120;
    const url = await startServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      for (let i = 0; i < CHUNKS; i++) {
        res.write(Buffer.from(`chunk-${i};`));
        await delay(GAP_MS);
      }
      res.end();
    });
    const dest = join(freshTmpDir(), "slow.bin");
    const started = Date.now();
    // connectTimeout (250ms) is DELIBERATELY shorter than total body time
    // (~840ms). inactivity (1s) > per-chunk gap (120ms) so the watchdog never
    // trips. A correct (connect-only) bound is disarmed at headers → success.
    const out = await downloadFile(url, dest, null, { inactivityMs: 1_000, connectTimeoutMs: 250 });
    const elapsed = Date.now() - started;

    expect(existsSync(dest)).toBe(true);
    expect(out.sizeBytes).toBeGreaterThan(0);
    // Body genuinely outlived the connect bound — the precise R5 scenario.
    expect(elapsed).toBeGreaterThan(250);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  // ---- Stall (R5 watchdog half): silent body trips the inactivity watchdog. ----
  it("watchdog: rejects a body that goes silent past the inactivity window, and removes .partial", async () => {
    const url = await startServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(Buffer.from("partial-data;")); // some bytes, then go quiet forever
      // intentionally never end / never write again
    });
    const dest = join(freshTmpDir(), "stalled.bin");
    await expect(
      downloadFile(url, dest, null, { inactivityMs: 150, connectTimeoutMs: 1_000 }),
    ).rejects.toThrow(/stalled/i);
    // R14 corollary: no leftover .partial after a failed transfer.
    expect(existsSync(`${dest}.partial`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  // ---- R14: mid-stream connection reset → reject + writer torn down + .partial gone. ----
  // pipeline() destroys the destination writer when the source errors (so no fd
  // is left dangling in the long-lived daemon), and the error-path rm() removes
  // the .partial so a retry starts clean. Asserting the absence of a leftover
  // .partial is the observable post-fix teardown contract; the explicit rm() on
  // the error path is a NEW guarantee the pre-fix code never made (it relied on
  // writer autoClose and skipped writer.end() entirely on throw).
  it("R14: tears down the writer and removes .partial when the body errors mid-stream", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        // Promise more bytes than we send, then destroy the socket → the client
        // body read errors mid-stream (premature close) and pipeline rejects.
        "Content-Length": "1000",
      });
      res.write(Buffer.from("only-a-few-bytes"));
      res.socket?.destroy(); // hard reset
    });
    const dest = join(freshTmpDir(), "reset.bin");
    await expect(
      downloadFile(url, dest, null, { inactivityMs: 5_000, connectTimeoutMs: 2_000 }),
    ).rejects.toThrow();
    expect(existsSync(`${dest}.partial`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  // ---- R15: write-side error must REJECT, not hang on drain. ----
  // Trigger a write-side failure AFTER the writer opens (so we exercise the
  // streaming path, not the up-front mkdir): pre-create a DIRECTORY at the
  // `${dest}.partial` path. dirname(dest) is a real dir so the up-front mkdir()
  // succeeds, but createWriteStream("${dest}.partial") then tries to open a
  // path that is a directory → the writer emits an async 'error' (EISDIR).
  //
  // Pre-fix: the read loop's writer.write() fails / returns false, the code
  // parks on writer.once("drain") which never fires for a dead writer → HANGS.
  // Post-fix: pipeline() propagates the writer error and rejects. We bound the
  // assertion FAR below the (10s) inactivity window so a hang can't be mistaken
  // for a slow success — a hang trips the 4s race / 15s test timeout instead.
  it("R15: rejects on a write-side error instead of hanging on drain", async () => {
    const url = await startServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      // Stream enough volume that backpressure/drain is plausibly exercised.
      for (let i = 0; i < 50; i++) res.write(Buffer.alloc(64 * 1024, i % 256));
      res.end();
    });
    const base = freshTmpDir();
    const dest = join(base, "inner.bin");
    mkdirSync(`${dest}.partial`); // a DIRECTORY where the writer wants a file

    const settled = await Promise.race([
      downloadFile(url, dest, null, { inactivityMs: 10_000, connectTimeoutMs: 2_000 })
        .then(() => "resolved" as const)
        .catch(() => "rejected" as const),
      delay(4_000).then(() => "timeout" as const),
    ]);
    expect(settled).toBe("rejected");
  }, 15_000);

  // ---- sha256 mismatch still rejects and removes .partial (unchanged contract). ----
  it("rejects on sha256 mismatch and removes the .partial", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from("the actual bytes"));
    });
    const dest = join(freshTmpDir(), "hashed.bin");
    await expect(
      downloadFile(url, dest, "0".repeat(64), { inactivityMs: 2_000, connectTimeoutMs: 2_000 }),
    ).rejects.toThrow(/sha256 mismatch/i);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  // ---- happy path with sha256 verification still works end-to-end. ----
  it("downloads and verifies a correct sha256, renaming .partial into place", async () => {
    const { createHash } = await import("node:crypto");
    const payload = Buffer.from("hello laqrumcode bootstrap download");
    const sha = createHash("sha256").update(payload).digest("hex");
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(payload);
    });
    const dest = join(freshTmpDir(), "ok.bin");
    const out = await downloadFile(url, dest, sha, { inactivityMs: 2_000, connectTimeoutMs: 2_000 });
    expect(out.sizeBytes).toBe(payload.length);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });
});
