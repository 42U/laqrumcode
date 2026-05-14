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
import { createConnection } from "node:net";
import { PROTOCOL_VERSION, } from "../shared/ipc-types.js";
/** Enriched Error subclass — carries the JSON-RPC error code so callers can
 *  branch on DAEMON_BOOTSTRAPPING vs DAEMON_RESTARTING vs HANDLER_ERROR. */
export class IpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "IpcError";
    }
}
export class IpcClient {
    opts;
    socket = null;
    buffer = "";
    nextId = 1;
    pending = new Map();
    connected = false;
    connecting = null;
    defaultTimeoutMs;
    log;
    constructor(opts) {
        this.opts = opts;
        this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
        this.log = opts.log ?? {
            info: () => { }, warn: () => { }, error: () => { },
        };
    }
    /** Establish (or re-establish) a connection. Idempotent — concurrent calls
     *  share the same in-flight connect promise. */
    async connect() {
        if (this.connected && this.socket)
            return;
        if (this.connecting)
            return this.connecting;
        this.connecting = this.doConnect().finally(() => { this.connecting = null; });
        return this.connecting;
    }
    async doConnect() {
        return new Promise((resolve, reject) => {
            const sock = this.opts.socketPath
                ? createConnection({ path: this.opts.socketPath })
                : createConnection({ host: this.opts.tcpHost ?? "127.0.0.1", port: this.opts.tcpPort ?? 0 });
            const onError = (err) => {
                sock.removeListener("connect", onConnect);
                // Destroy the failed socket so it doesn't linger in Node's internal
                // registry holding a file descriptor — left attached, repeated
                // connect failures accumulate until ENFILE eventually fires.
                try {
                    sock.destroy();
                }
                catch { }
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
     *  Older daemons silently ignore the extra params field. */
    async handshake(clientInfo) {
        const params = clientInfo ? { clientInfo } : {};
        const resp = await this.call("meta.handshake", params);
        if (resp.protocolVersion !== PROTOCOL_VERSION) {
            throw new IpcError(-32004 /* IpcErrorCode.PROTOCOL_VERSION_MISMATCH */, `daemon protocol v${resp.protocolVersion} != client v${PROTOCOL_VERSION} — restart required`);
        }
        return resp;
    }
    /** Make an RPC call. Returns the daemon's `result` payload, or throws
     *  IpcError on JSON-RPC error / timeout / disconnect. */
    async call(method, params, timeoutMs) {
        if (!this.connected || !this.socket) {
            await this.connect();
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new IpcError(-32000, `RPC ${method} timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`));
            }, timeoutMs ?? this.defaultTimeoutMs);
            this.pending.set(id, {
                id,
                method,
                resolve: resolve,
                reject,
                timer,
            });
            const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
            try {
                this.socket.write(body + "\n");
            }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new IpcError(-32002 /* IpcErrorCode.DAEMON_RESTARTING */, `write failed: ${e.message}`));
            }
        });
    }
    close() {
        if (this.socket && !this.socket.destroyed) {
            try {
                this.socket.end();
            }
            catch { }
        }
        this.socket = null;
        this.connected = false;
        // Reject any pending requests — caller's promises shouldn't hang.
        for (const p of this.pending.values()) {
            if (p.timer)
                clearTimeout(p.timer);
            p.reject(new IpcError(-32002 /* IpcErrorCode.DAEMON_RESTARTING */, `client closed during ${p.method}`));
        }
        this.pending.clear();
    }
    // ── Internal: data + lifecycle handlers ─────────────────────────
    onData(chunk) {
        this.buffer += chunk.toString("utf8");
        // Mirror the server-side 8MB cap. A malformed or runaway daemon sending
        // an endless line without newline would otherwise grow client buffer
        // without bound, exhausting RAM in the long-lived MCP client process.
        if (this.buffer.length > 8 * 1024 * 1024) {
            this.log.warn("[ipc-client] daemon buffer exceeded 8 MB without newline, resetting connection");
            this.buffer = "";
            if (this.socket) {
                try {
                    this.socket.destroy();
                }
                catch { }
            }
            return;
        }
        let nl;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line)
                continue;
            this.processLine(line);
        }
    }
    processLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch (e) {
            this.log.warn(`[ipc-client] bad JSON from daemon: ${line.slice(0, 100)}`);
            return;
        }
        if (typeof msg.id !== "number")
            return; // notifications not used in this protocol
        const p = this.pending.get(msg.id);
        if (!p) {
            this.log.warn(`[ipc-client] response for unknown id=${msg.id}`);
            return;
        }
        this.pending.delete(msg.id);
        if (p.timer)
            clearTimeout(p.timer);
        if (msg.error) {
            p.reject(new IpcError(msg.error.code, msg.error.message, msg.error.data));
        }
        else {
            p.resolve(msg.result);
        }
    }
    onClose() {
        this.connected = false;
        this.socket = null;
        // Reject in-flight requests — daemon's gone, caller should reconnect
        // and retry rather than wait for responses that will never come.
        for (const p of this.pending.values()) {
            if (p.timer)
                clearTimeout(p.timer);
            p.reject(new IpcError(-32002 /* IpcErrorCode.DAEMON_RESTARTING */, `daemon closed connection during ${p.method}`));
        }
        this.pending.clear();
    }
}
