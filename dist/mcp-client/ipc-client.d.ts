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
import { type IpcMethod, type MetaHandshakeResponse } from "../shared/ipc-types.js";
export interface IpcClientOpts {
    /** Unix socket path. If null, uses tcpHost/tcpPort. */
    socketPath: string | null;
    tcpHost?: string;
    tcpPort?: number;
    /** Per-request timeout. Defaults to 30s — embedding queries can be slow. */
    defaultTimeoutMs?: number;
    /** Logger — wired by mcp-client/index.ts to its log facility. */
    log?: {
        info: (m: string) => void;
        warn: (m: string) => void;
        error: (m: string, e?: unknown) => void;
    };
}
/** Enriched Error subclass — carries the JSON-RPC error code so callers can
 *  branch on DAEMON_BOOTSTRAPPING vs DAEMON_RESTARTING vs HANDLER_ERROR. */
export declare class IpcError extends Error {
    code: number;
    data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
export declare class IpcClient {
    private readonly opts;
    private socket;
    private buffer;
    private nextId;
    private pending;
    private connected;
    private connecting;
    private readonly defaultTimeoutMs;
    private readonly log;
    constructor(opts: IpcClientOpts);
    /** Establish (or re-establish) a connection. Idempotent — concurrent calls
     *  share the same in-flight connect promise. */
    connect(): Promise<void>;
    private doConnect;
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
    handshake(clientInfo?: {
        pid: number;
        version: string;
        sessionId: string;
    }, handshakeToken?: string): Promise<MetaHandshakeResponse>;
    /** Make an RPC call. Returns the daemon's `result` payload, or throws
     *  IpcError on JSON-RPC error / timeout / disconnect. */
    call<T = unknown>(method: IpcMethod | string, params: unknown, timeoutMs?: number): Promise<T>;
    close(): void;
    private onData;
    private processLine;
    private onClose;
}
