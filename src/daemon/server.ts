/**
 * JSON-RPC 2.0 server for the kongcode daemon.
 *
 * Wire format: line-delimited JSON over Unix socket (Linux, macOS) or TCP
 * loopback (Windows / explicit override). Each direction sends one JSON
 * object per line; receivers buffer until they see \n then parse.
 *
 * Why line-delimited and not length-prefixed: simpler parser, no streaming
 * state machine needed, robust to socket partial reads, and trivial to
 * inspect via `nc -U ~/.kongcode-daemon.sock` for live debugging. Trade-off
 * is that no payload may contain raw newlines — JSON.stringify already
 * escapes \n inside strings so this is a non-issue in practice.
 *
 * Concurrency: each client gets its own socket; per-client requests are
 * dispatched concurrently via Promise. Daemon-internal state (SurrealStore,
 * EmbeddingService) handles its own concurrency.
 */

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  IpcErrorCode,
  isKnownMethod,
  type IpcMethod,
  type ClientInfo,
} from "../shared/ipc-types.js";

/** Per-connection context passed to handlers — identity for the socket that
 *  made the call, plus a hook to register/update client identity from inside
 *  meta.handshake. Handlers that don't care about identity just ignore it. */
export interface HandlerContext {
  /** Register or update the calling socket's client identity. Called by
   *  meta.handshake when the client sends clientInfo in its params. */
  registerIdentity(info: ClientInfo): void;
  /** Identity already registered for this socket, or null. Read-only. */
  getIdentity(): ClientInfo | null;
}

/** Handler signature — every IPC method registers one of these. The dispatcher
 *  calls it with the parsed `params` object (already validated as JSON-RPC
 *  shape) and a per-call context. Returns whatever the handler resolves to. */
export type IpcHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

/** Standard JSON-RPC 2.0 request shape. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

/** Standard JSON-RPC 2.0 response shape — exactly one of result or error. */
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };

export interface DaemonServerOpts {
  /** Unix socket path or null for TCP-only mode. */
  socketPath: string | null;
  /** TCP loopback port or null for Unix-socket-only mode. Recommend always
   *  enabling — provides a Windows-friendly fallback even on Unix hosts. */
  tcpPort: number | null;
  /** Logger — daemon's main module wires this to its log facility. */
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, e?: unknown) => void };
  /** Called when the supersede flag is set and the last attached client
   *  disconnects. Daemon main wires this to graceful-shutdown logic so a
   *  newer-version client can flag the daemon for exit and have it actually
   *  exit at the natural disconnect boundary, without disrupting other
   *  still-attached older-version clients. */
  onSupersedeReady?: () => void;
  /** Idle-reaper: when clients.size === 0 for this many ms, fire onIdleReap.
   *  Set to 0 to disable. Default wired in daemon/index.ts (0.7.11+) is
   *  60s; users can override via KONGCODE_DAEMON_IDLE_TIMEOUT_MS env var.
   *  Without this, a daemon that loses its last client just sits forever
   *  holding BGE-M3 in RAM — the gap the user named when asking "what
   *  happened to the reaper that handled these sorts of things?" */
  idleTimeoutMs?: number;
  /** Called when the idle timer fires (clients.size === 0 for the configured
   *  duration). Daemon main wires this to the same drain-and-exit path
   *  used by meta.shutdown / onSupersedeReady. */
  onIdleReap?: () => void;
}

export class DaemonServer {
  private udsServer: Server | null = null;
  private tcpServer: Server | null = null;
  private handlers = new Map<IpcMethod, IpcHandler>();
  /** Per-attached-socket identity registry. Value is the ClientInfo the
   *  client sent in its meta.handshake, or null if the client hasn't
   *  identified itself yet (transient state during handshake) or is a
   *  pre-0.7.9 client that doesn't pass clientInfo. Set membership doubles
   *  as the active-clients count. */
  private clients = new Map<Socket, ClientInfo | null>();
  private rpcsServedTotal = 0;
  private rpcsInFlight = 0;
  private startedAt = Date.now();
  private pendingSupersede = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleSince: number | null = null;

  constructor(private readonly opts: DaemonServerOpts) {}

  /** Register a handler for an IPC method. The dispatcher rejects calls to
   *  methods that aren't both in IPC_METHODS (compile-time) AND registered
   *  here (runtime) — covers the case where the constants list outpaces
   *  actual implementations during incremental rollout. */
  register(method: IpcMethod, handler: IpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Start listening. Throws if the socket can't be bound (e.g. another
   *  daemon already running on the same path — caller should detect via
   *  the spawn lock + PID file probe before calling listen()). */
  async listen(): Promise<void> {
    if (this.opts.socketPath) {
      // Stale socket from a previous crashed daemon would prevent bind.
      // Caller (daemon main) should already have verified no live daemon
      // owns the socket via PID file + ping; safe to remove if present.
      if (existsSync(this.opts.socketPath)) {
        try { unlinkSync(this.opts.socketPath); } catch {}
      }
      this.udsServer = createServer((sock) => this.onConnection(sock));
      await new Promise<void>((resolve, reject) => {
        this.udsServer!.once("error", reject);
        this.udsServer!.listen(this.opts.socketPath!, () => {
          this.udsServer!.removeListener("error", reject);
          resolve();
        });
      });
      this.opts.log.info(`[daemon] listening on Unix socket ${this.opts.socketPath}`);
    }
    if (this.opts.tcpPort !== null && this.opts.tcpPort !== undefined) {
      this.tcpServer = createServer((sock) => this.onConnection(sock));
      await new Promise<void>((resolve, reject) => {
        this.tcpServer!.once("error", reject);
        // Bind 127.0.0.1 only — never expose the daemon to the network.
        // tcpPort=0 lets the OS pick an available ephemeral port, which is
        // robust against win32 CI sandboxed runners that randomly restrict
        // permissions on individual ports inside the IANA dynamic range
        // (49152-65535). Read the assigned port via getTcpPort() after
        // listen() resolves.
        this.tcpServer!.listen(this.opts.tcpPort!, "127.0.0.1", () => {
          this.tcpServer!.removeListener("error", reject);
          resolve();
        });
      });
      const addr = this.tcpServer!.address();
      const actualPort = (addr && typeof addr === "object") ? addr.port : this.opts.tcpPort;
      this.opts.log.info(`[daemon] listening on TCP 127.0.0.1:${actualPort}`);
    }
    // Daemon just started listening with zero clients. Start the idle timer
    // immediately — covers the case where mcp-client crashed before
    // handshaking, leaving an orphaned daemon nobody will ever talk to.
    // First connect cancels the timer.
    this.armIdleTimer();
  }

  /** Start (or restart) the idle reaper. No-op if idleTimeoutMs is unset/0
   *  or a timer is already armed. */
  private armIdleTimer(): void {
    if (this.idleTimer) return;
    const ms = this.opts.idleTimeoutMs ?? 0;
    if (ms <= 0) return;
    // Prune phantoms before checking — otherwise a stale Map entry blocks
    // the timer from arming and the daemon stays alive indefinitely.
    this.pruneDeadClients();
    if (this.clients.size > 0) return;
    this.idleSince = Date.now();
    this.opts.log.info(`[daemon] idle timer armed: will reap in ${Math.round(ms / 1000)}s if no client connects`);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Re-check at fire time — race-safe against a connect that just landed.
      if (this.clients.size === 0 && this.opts.onIdleReap) {
        this.opts.log.info(`[daemon] idle reaper firing: zero clients for ${ms}ms, exiting`);
        try { this.opts.onIdleReap(); } catch (e) {
          this.opts.log.warn(`[daemon] onIdleReap callback threw: ${(e as Error).message}`);
        }
      }
    }, ms);
    // Don't keep the daemon alive just for this timer.
    this.idleTimer.unref?.();
  }

  /** Cancel the idle timer (a client just connected, or daemon is shutting
   *  down). Safe to call repeatedly. */
  private disarmIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.idleSince = null;
    }
  }

  /** Defensive: prune Map entries whose underlying socket is destroyed but
   *  whose 'close'/'error' event never reached our handler. Empirically this
   *  happens for short-lived probe connections (nc, debugging tools) and
   *  some peer-SIGKILL paths — Node.js doesn't always fire 'close' for
   *  unix-socket peers that disappear abruptly. The existing close+error
   *  handlers DO maintain the Map correctly under normal disconnects; this
   *  is a belt-and-suspenders pass for the edge cases.
   *
   *  Called from getStats() (so meta.health reports accurate counts) and
   *  before checkSupersedeReady / armIdleTimer make lifecycle decisions.
   *  No new timer needed — runs lazily on read paths. */
  private pruneDeadClients(): number {
    let pruned = 0;
    for (const [sock, info] of this.clients) {
      if (sock.destroyed || !sock.writable) {
        this.clients.delete(sock);
        pruned++;
        if (info) {
          this.opts.log.info(`[daemon] pruned phantom client: pid=${info.pid} v${info.version} session=${info.sessionId} (close event never fired)`);
        } else {
          this.opts.log.info(`[daemon] pruned phantom anonymous client (close event never fired)`);
        }
      }
    }
    return pruned;
  }

  /** Drain in-flight requests, close listeners, close client sockets, exit.
   *  Caller (daemon main) is responsible for closing SurrealStore and
   *  saving any pending state before this is called. */
  async close(): Promise<void> {
    this.disarmIdleTimer();
    for (const sock of this.clients.keys()) {
      try { sock.end(); } catch {}
    }
    this.clients.clear();
    if (this.udsServer) {
      await new Promise<void>((resolve) => this.udsServer!.close(() => resolve()));
      if (this.opts.socketPath && existsSync(this.opts.socketPath)) {
        try { unlinkSync(this.opts.socketPath); } catch {}
      }
    }
    if (this.tcpServer) {
      await new Promise<void>((resolve) => this.tcpServer!.close(() => resolve()));
    }
  }

  /** Stats surfaced via meta.health for ops visibility. */
  getStats() {
    // Defensive prune so meta.health reports accurate activeClients even
    // when a 'close' event was missed (see pruneDeadClients comment).
    this.pruneDeadClients();
    const clients: ClientInfo[] = [];
    for (const info of this.clients.values()) {
      if (info) clients.push(info);
    }
    return {
      activeClients: this.clients.size,
      activeSessions: 0, // populated once handlers track session registry
      rpcsServedTotal: this.rpcsServedTotal,
      rpcsInFlight: this.rpcsInFlight,
      startedAt: this.startedAt,
      protocolVersion: PROTOCOL_VERSION,
      pendingSupersede: this.pendingSupersede,
      clients,
      idleSince: this.idleSince,
      idleTimeoutMs: this.opts.idleTimeoutMs ?? 0,
    };
  }

  /** Number of currently-attached client sockets. Used by meta.requestSupersede
   *  to report whether the daemon is "orphaned" (zero attached). */
  get attachedClientCount(): number {
    return this.clients.size;
  }

  /** OS-assigned TCP port after listen(). Returns the configured port if
   *  tcpPort was specified non-zero, the OS-picked port if tcpPort=0, or
   *  null if TCP isn't enabled. Tests use tcpPort=0 to dodge win32 CI
   *  ephemeral-port permission flakes. */
  getTcpPort(): number | null {
    if (!this.tcpServer) return null;
    const addr = this.tcpServer.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.opts.tcpPort;
  }

  /** Mark daemon for supersede: it will exit when the last attached client
   *  disconnects. Idempotent. Safe to call from a handler thread. */
  markPendingSupersede(): void {
    this.pendingSupersede = true;
  }

  isPendingSupersede(): boolean {
    return this.pendingSupersede;
  }

  /** When supersede is flagged AND the last client just disconnected, fire
   *  the registered callback so daemon main can shut down cleanly. The
   *  callback is invoked exactly once per supersede cycle. */
  private supersedeFired = false;
  private checkSupersedeReady(): void {
    // Prune phantoms before checking — otherwise stale Map entries block
    // supersede from firing and the daemon wedges indefinitely.
    this.pruneDeadClients();
    if (
      this.pendingSupersede &&
      !this.supersedeFired &&
      this.clients.size === 0 &&
      this.opts.onSupersedeReady
    ) {
      this.supersedeFired = true;
      this.opts.log.info("[daemon] last client disconnected with supersede flag set — exiting for code refresh");
      try { this.opts.onSupersedeReady(); } catch (e) {
        this.opts.log.warn(`[daemon] onSupersedeReady callback threw: ${(e as Error).message}`);
      }
    }
  }

  // ── Per-connection handling ─────────────────────────────────────

  private onConnection(sock: Socket): void {
    // Register socket immediately with null identity. Identity gets populated
    // when (and if) the client calls meta.handshake with clientInfo. This
    // lets us count anonymous clients toward activeClients while still
    // distinguishing them in the per-client registry.
    this.clients.set(sock, null);
    // A live client cancels any pending idle reap.
    this.disarmIdleTimer();
    let buffer = "";

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 8 * 1024 * 1024) {
        this.opts.log.warn("[daemon] client buffer exceeded 8 MB, dropping connection");
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        this.dispatchLine(sock, line).catch((e) => {
          this.opts.log.error("[daemon] dispatch error:", e);
        });
      }
    });

    sock.on("close", () => {
      const info = this.clients.get(sock);
      this.clients.delete(sock);
      if (info) {
        this.opts.log.info(`[daemon] client disconnected: pid=${info.pid} v${info.version} session=${info.sessionId}`);
      }
      this.checkSupersedeReady();
      // If that was the last client, start the idle reaper. Supersede check
      // above runs first because supersede is "exit immediately"; idle is
      // "exit after a grace period" — supersede always wins when both apply.
      if (this.clients.size === 0) this.armIdleTimer();
    });

    sock.on("error", (err) => {
      // ECONNRESET when client disappears mid-request — common, not worth
      // logging at error level.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ECONNRESET" && code !== "EPIPE") {
        this.opts.log.warn(`[daemon] client socket error: ${err.message}`);
      }
      this.clients.delete(sock);
      this.checkSupersedeReady();
      if (this.clients.size === 0) this.armIdleTimer();
    });
  }

  private async dispatchLine(sock: Socket, line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch (e) {
      // Parse error — JSON-RPC says respond with id:null since we couldn't
      // identify the originating request.
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error", data: (e as Error).message },
      });
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }
    if (!isKnownMethod(req.method)) {
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
      return;
    }
    const handler = this.handlers.get(req.method);
    if (!handler) {
      // Method is in IPC_METHODS but not yet registered — happens during
      // incremental rollout when constants land before implementations.
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: IpcErrorCode.HANDLER_ERROR,
          message: `Method registered in protocol but no handler bound: ${req.method}`,
        },
      });
      return;
    }
    this.rpcsInFlight++;
    const ctx: HandlerContext = {
      registerIdentity: (info) => {
        const stamped: ClientInfo = { ...info, attachedAt: info.attachedAt ?? Date.now() };
        this.clients.set(sock, stamped);
        this.opts.log.info(`[daemon] client connected: pid=${stamped.pid} v${stamped.version} session=${stamped.sessionId}`);
      },
      getIdentity: () => this.clients.get(sock) ?? null,
    };
    try {
      const result = await handler(req.params, ctx);
      this.rpcsServedTotal++;
      this.sendResponse(sock, { jsonrpc: "2.0", id: req.id, result });
    } catch (e) {
      const err = e as Error;
      this.opts.log.warn(`[daemon] handler ${req.method} threw: ${err.message}`);
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: IpcErrorCode.HANDLER_ERROR, message: err.message, data: err.stack },
      });
    } finally {
      this.rpcsInFlight--;
    }
  }

  private sendResponse(sock: Socket, resp: JsonRpcResponse): void {
    if (sock.destroyed || !sock.writable) return;
    try {
      sock.write(JSON.stringify(resp) + "\n");
    } catch (e) {
      this.opts.log.warn(`[daemon] send response failed: ${(e as Error).message}`);
    }
  }
}
