/**
 * JSON-RPC client used by kongcode-mcp to talk to kongcode-daemon.
 *
 * Connects to the daemon's Unix socket (linux/mac) or TCP loopback (Windows
 * / explicit override), sends typed RPC requests, and resolves promises with
 * results. Keeps connection state internally; exposes a small surface for
 * the MCP layer above.
 *
 * Design notes:
 *  - Each request gets a monotonic id. Responses are matched by id, so
 *    pipelined requests are fine and don't block each other.
 *  - On connection drop, in-flight requests reject with DAEMON_RESTARTING
 *    and the next request triggers a reconnect. Caller is responsible for
 *    deciding whether to retry (the MCP wrapper will, with backoff).
 *  - Line-delimited JSON over the socket — partial-read safe.
 */

import { Socket, createConnection } from "node:net";
import {
  IpcErrorCode,
  PROTOCOL_VERSION,
  type IpcMethod,
  type MetaHandshakeResponse,
} from "../shared/ipc-types.js";
import { readDaemonToken } from "./daemon-spawn.js";

interface PendingRequest {
  id: number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error & { code?: number; data?: unknown }) => void;
  timer: NodeJS.Timeout | null;
}

export interface IpcClientOpts {
  /** Unix socket path. If null, uses tcpHost/tcpPort. */
  socketPath: string | null;
  tcpHost?: string;
  tcpPort?: number;
  /** Per-request timeout. Defaults to 30s — embedding queries can be slow. */
  defaultTimeoutMs?: number;
  /** Logger — wired by mcp-client/index.ts to its log facility. */
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
}

/** T5 (2026-06-10): operator knob for the per-request IPC timeout.
 *  On CPU-only / heavily-loaded machines, long embed batches (e.g.
 *  create_knowledge_gems with many gems) can legitimately exceed the 30s
 *  default; the client-side timeout then fires while the daemon write is
 *  still in flight, and the retry double-writes (the 0.7.115 gems
 *  double-write incident). Clamped to [1s, 10min]; invalid values are
 *  ignored. Explicit per-call / per-client timeouts always win. */
function envIpcTimeoutMs(): number | undefined {
  const raw = process.env.KONGCODE_IPC_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.max(Math.round(n), 1_000), 600_000);
}

/** Enriched Error subclass — carries the JSON-RPC error code so callers can
 *  branch on DAEMON_BOOTSTRAPPING vs DAEMON_RESTARTING vs HANDLER_ERROR. */
export class IpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = "IpcError";
  }
}

export class IpcClient {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private readonly defaultTimeoutMs: number;
  private readonly log: NonNullable<IpcClientOpts["log"]>;

  constructor(private readonly opts: IpcClientOpts) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? envIpcTimeoutMs() ?? 30_000;
    this.log = opts.log ?? {
      info: () => {}, warn: () => {}, error: () => {},
    };
  }

  /** Establish (or re-establish) a connection. Idempotent — concurrent calls
   *  share the same in-flight connect promise. */
  async connect(): Promise<void> {
    if (this.connected && this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // TCP mode requires a concrete port. Port 0 means "OS-assigned" on a
      // LISTEN socket but is invalid for an outbound connect — guard against a
      // misconfigured construction silently dialing port 0 and hanging.
      if (!this.opts.socketPath && !(Number.isInteger(this.opts.tcpPort) && (this.opts.tcpPort as number) > 0)) {
        reject(new IpcError(
          IpcErrorCode.DAEMON_RESTARTING,
          `IpcClient TCP mode requires a positive tcpPort (got ${String(this.opts.tcpPort)})`,
        ));
        return;
      }
      const sock = this.opts.socketPath
        ? createConnection({ path: this.opts.socketPath })
        : createConnection({ host: this.opts.tcpHost ?? "127.0.0.1", port: this.opts.tcpPort as number });
      const onError = (err: Error) => {
        sock.removeListener("connect", onConnect);
        // Destroy the failed socket so it doesn't linger in Node's internal
        // registry holding a file descriptor — left attached, repeated
        // connect failures accumulate until ENFILE eventually fires.
        try { sock.destroy(); } catch {}
        reject(err);
      };
      const onConnect = () => {
        sock.removeListener("error", onError);
        this.socket = sock;
        this.connected = true;
        sock.on("data", (c) => this.onData(c));
        sock.on("close", () => this.onClose());
        sock.on("error", (err) => this.log.warn(`[ipc-client] socket error: ${err.message}`));
        resolve();
      };
      sock.once("error", onError);
      sock.once("connect", onConnect);
    });
  }

  /** Verify protocol compatibility. Throws if the daemon's protocol version
   *  doesn't match ours — the calling layer should treat this as fatal,
   *  trigger daemon-restart, and retry.
   *
   *  Optionally register this client's identity with the daemon (0.7.9+).
   *  Older daemons silently ignore the extra params field.
   *
   *  S6: in TCP mode the caller passes `handshakeToken` — the per-user secret
   *  read from the daemon's 0600 token file. A daemon that bound TCP rejects a
   *  missing/mismatched token (a different OS user who hash-collided onto our
   *  port can't read the file, so they're turned away). UDS daemons ignore it
   *  (they're already filesystem-isolated at 0600), and the token is omitted
   *  there so the handshake shape is unchanged for the Unix-socket path. */
  async handshake(
    clientInfo?: { pid: number; version: string; sessionId: string },
    handshakeToken?: string,
  ): Promise<MetaHandshakeResponse> {
    const params: { clientInfo?: typeof clientInfo; handshake?: string } = {};
    if (clientInfo) params.clientInfo = clientInfo;
    // S6/T2: auto-attach the per-user handshake token whenever it is readable,
    // REGARDLESS of transport. A daemon that bound TCP mints + enforces the token
    // on EVERY connection (it has no per-connection UDS/TCP discriminator), so a
    // co-located UDS client (e.g. KONGCODE_DAEMON_PORT set on Linux, where the
    // daemon binds UDS+TCP) MUST also send its own 0600 token or it locks ITSELF
    // out — the T2 regression. Reading our own per-user token is safe + cheap; a
    // UDS-only daemon that minted no token ignores the param, and a cross-user
    // TCP attacker cannot read our 0600 file so is still rejected.
    const token = handshakeToken ?? readDaemonToken() ?? undefined;
    if (token) params.handshake = token;
    const resp = await this.call<MetaHandshakeResponse>("meta.handshake", params);
    if (resp.protocolVersion !== PROTOCOL_VERSION) {
      throw new IpcError(
        IpcErrorCode.PROTOCOL_VERSION_MISMATCH,
        `daemon protocol v${resp.protocolVersion} != client v${PROTOCOL_VERSION} — restart required`,
      );
    }
    return resp;
  }

  /** Make an RPC call. Returns the daemon's `result` payload, or throws
   *  IpcError on JSON-RPC error / timeout / disconnect. */
  async call<T = unknown>(method: IpcMethod | string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.connected || !this.socket) {
      await this.connect();
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcError(-32000, `RPC ${method} timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, {
        id,
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      try {
        this.socket!.write(body + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new IpcError(IpcErrorCode.DAEMON_RESTARTING, `write failed: ${(e as Error).message}`));
      }
    });
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.end(); } catch {}
    }
    this.socket = null;
    this.connected = false;
    // Reject any pending requests — caller's promises shouldn't hang.
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new IpcError(IpcErrorCode.DAEMON_RESTARTING, `client closed during ${p.method}`));
    }
    this.pending.clear();
  }

  // ── Internal: data + lifecycle handlers ─────────────────────────

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // Mirror the server-side 8MB cap. A malformed or runaway daemon sending
    // an endless line without newline would otherwise grow client buffer
    // without bound, exhausting RAM in the long-lived MCP client process.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.log.warn("[ipc-client] daemon buffer exceeded 8 MB without newline, resetting connection");
      this.buffer = "";
      if (this.socket) {
        try { this.socket.destroy(); } catch {}
      }
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.log.warn(`[ipc-client] bad JSON from daemon: ${line.slice(0, 100)}`);
      return;
    }
    if (typeof msg.id !== "number") return; // notifications not used in this protocol
    const p = this.pending.get(msg.id);
    if (!p) {
      this.log.warn(`[ipc-client] response for unknown id=${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new IpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.connected = false;
    this.socket = null;
    // Reject in-flight requests — daemon's gone, caller should reconnect
    // and retry rather than wait for responses that will never come.
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new IpcError(IpcErrorCode.DAEMON_RESTARTING, `daemon closed connection during ${p.method}`));
    }
    this.pending.clear();
  }
}
