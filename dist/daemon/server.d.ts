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
import { type Socket } from "node:net";
import { type IpcMethod, type ClientInfo } from "../shared/ipc-types.js";
/** Per-connection context passed to handlers — identity for the socket that
 *  made the call, plus a hook to register/update client identity from inside
 *  meta.handshake. Handlers that don't care about identity just ignore it. */
export interface HandlerContext {
    /** Register or update the calling socket's client identity. Called by
     *  meta.handshake when the client sends clientInfo in its params. */
    registerIdentity(info: ClientInfo): void;
    /** E2 (TCP auth bypass fix): mark the calling socket as authenticated.
     *  Called by the meta.handshake handler AFTER it has verified the per-user
     *  handshake token. Until a socket is authed, dispatchLine rejects every
     *  non-meta method (tool.* / hook.*) with UNAUTHORIZED — so a TCP client on
     *  the shared loopback port can't reach another OS user's graph by skipping
     *  the handshake and sending tool.recall as its first line. No-op (always
     *  allowed) when the daemon runs without handshake auth (UDS-only / no
     *  token), since the Unix socket's 0600 perms already isolate OS users. */
    markAuthed(): void;
}
/** Handler signature — every IPC method registers one of these. The dispatcher
 *  calls it with the parsed `params` object (already validated as JSON-RPC
 *  shape) and a per-call context. Returns whatever the handler resolves to. */
export type IpcHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;
export interface DaemonServerOpts {
    /** Unix socket path or null for TCP-only mode. */
    socketPath: string | null;
    /** TCP loopback port or null for Unix-socket-only mode. Recommend always
     *  enabling — provides a Windows-friendly fallback even on Unix hosts. */
    tcpPort: number | null;
    /** Logger — daemon's main module wires this to its log facility. */
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string, e?: unknown) => void;
    };
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
    /** E2 (TCP auth bypass fix): when true, every socket starts UNauthenticated
     *  and dispatchLine rejects all non-meta methods (tool.* / hook.*) until the
     *  socket completes meta.handshake (which calls ctx.markAuthed() after
     *  verifying the per-user token). Daemon main sets this true exactly when it
     *  binds TCP and mints a handshake token. When false/omitted (UDS-only / no
     *  token), all sockets are implicitly authed — the Unix socket's 0600 perms
     *  already isolate OS users, so no per-socket gate is needed and the existing
     *  handshake-optional Unix-socket path is unchanged. */
    requireHandshakeAuth?: boolean;
}
export declare class DaemonServer {
    private readonly opts;
    private udsServer;
    private tcpServer;
    private handlers;
    /** Per-attached-socket identity registry. Value is the ClientInfo the
     *  client sent in its meta.handshake, or null if the client hasn't
     *  identified itself yet (transient state during handshake) or is a
     *  pre-0.7.9 client that doesn't pass clientInfo (@deprecated fallback —
     *  retain for backward compat but no longer expected in practice). Set
     *  membership doubles as the active-clients count. */
    private clients;
    /** E2: sockets that have completed meta.handshake (token verified). Only
     *  consulted when opts.requireHandshakeAuth is true. A socket is added here
     *  by ctx.markAuthed() from the meta.handshake handler AFTER the token check
     *  passes, and removed on socket close/error alongside the clients entry. A
     *  separate set (rather than overloading the ClientInfo|null value) keeps the
     *  anonymous-vs-identified distinction intact while tracking auth orthogonally:
     *  a socket can be authed (token OK) yet still anonymous (no clientInfo sent). */
    private authedSockets;
    private rpcsServedTotal;
    private rpcsInFlight;
    private startedAt;
    private pendingSupersede;
    private idleTimer;
    private idleSince;
    /** Periodic phantom-client reaper. Agent E flagged that pruneDeadClients
     *  previously ran ONLY from read paths (getStats, armIdleTimer, etc.) — so
     *  on an idle daemon with no reads firing, a phantom map entry can persist
     *  indefinitely and block armIdleTimer's clients.size==0 check. This
     *  interval guarantees the prune fires regardless of inbound traffic. */
    private pruneTimer;
    /** How often to sweep phantom clients off the map. 60s is a reasonable
     *  trade-off: long enough to be free on a fully idle daemon, short enough
     *  that a stuck phantom doesn't keep the daemon alive for many minutes
     *  past the last real disconnect. */
    private static readonly PRUNE_INTERVAL_MS;
    /** K12 backpressure: global ceiling on concurrently-executing RPCs. Past
     *  this, NON-meta calls (tool.* / hook.*) are rejected with a retryable busy
     *  error instead of piling onto the store/embedder — which on a single-host
     *  daemon would deepen the embed FIFO and worsen, not absorb, the overload.
     *  meta.* (handshake/health/shutdown/supersede) is always exempt so
     *  lifecycle never wedges under load. Override via KONGCODE_DAEMON_MAX_INFLIGHT. */
    private readonly maxInFlight;
    constructor(opts: DaemonServerOpts);
    /** Register a handler for an IPC method. The dispatcher rejects calls to
     *  methods that aren't both in IPC_METHODS (compile-time) AND registered
     *  here (runtime) — covers the case where the constants list outpaces
     *  actual implementations during incremental rollout. */
    register(method: IpcMethod, handler: IpcHandler): void;
    /** Start listening. Throws if the socket can't be bound (e.g. another
     *  daemon already running on the same path — caller should detect via
     *  the spawn lock + PID file probe before calling listen()). */
    listen(): Promise<void>;
    /** Start the periodic phantom-client reaper. Idempotent — replaces any
     *  existing timer. Called from listen() and safe to call again from tests
     *  if they want to reset the cadence. */
    private startPruneTimer;
    /** Stop the periodic phantom-client reaper. Safe to call repeatedly. */
    private stopPruneTimer;
    /** Start (or restart) the idle reaper. No-op if idleTimeoutMs is unset/0
     *  or a timer is already armed. */
    private armIdleTimer;
    /** Cancel the idle timer (a client just connected, or daemon is shutting
     *  down). Safe to call repeatedly. */
    private disarmIdleTimer;
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
    private pruneDeadClients;
    /** Max time close() waits for in-flight RPCs to settle before forcibly
     *  ending sockets. Kept under daemon/index.ts's 8s shutdown watchdog so the
     *  drain finishes (or is abandoned) before the watchdog hard-exits. Override
     *  via KONGCODE_DAEMON_DRAIN_TIMEOUT_MS (tests use a small value). */
    private drainTimeoutMs;
    /** Drain in-flight requests, close listeners, close client sockets, exit.
     *  Caller (daemon main) is responsible for closing SurrealStore and
     *  saving any pending state before this is called.
     *
     *  K11: order matters. The old code ended client sockets and cleared the
     *  client map IMMEDIATELY, then closed the listeners — so a handler still
     *  awaiting the store mid-RPC had its response socket torn out from under it
     *  (client saw a truncated/closed connection, not a result), and the caller
     *  then disposed the store/embeddings while that handler was still using
     *  them. Correct sequence: (1) stop accepting NEW connections by closing the
     *  listeners, (2) await rpcsInFlight===0 with a bounded timeout, (3) reply
     *  with a JSON-RPC error to anything still pending at timeout, THEN (4) end
     *  client sockets. Store/embeddings stay alive (the caller disposes them
     *  AFTER close() resolves) until in-flight handlers finish. */
    close(): Promise<void>;
    /** Poll until rpcsInFlight hits 0 or the timeout elapses. Short poll
     *  interval keeps shutdown snappy when handlers finish quickly; the bound
     *  guarantees we never wait forever on a wedged handler. */
    private awaitInFlightDrain;
    /** Stats surfaced via meta.health for ops visibility. */
    getStats(): {
        activeClients: number;
        activeSessions: number;
        rpcsServedTotal: number;
        rpcsInFlight: number;
        startedAt: number;
        protocolVersion: number;
        pendingSupersede: boolean;
        clients: ClientInfo[];
        idleSince: number | null;
        idleTimeoutMs: number;
    };
    /** Number of currently-attached client sockets. Used by meta.requestSupersede
     *  to report whether the daemon is "orphaned" (zero attached). */
    get attachedClientCount(): number;
    /** R13: the set of Claude Code session ids whose client socket is currently
     *  attached. The stale-session reaper uses this to skip reaping any session
     *  whose client is still connected (a live socket means the session is not
     *  idle, regardless of how old its turnStartMs looks — e.g. a long agentic
     *  turn). Prunes phantom (destroyed-but-not-closed) sockets first so a
     *  stuck Map entry can't keep a session pinned forever. Anonymous clients
     *  (null ClientInfo, pre-handshake or pre-0.7.9) contribute no id — they're
     *  not yet associated with a session, so they can't protect one from reaping. */
    attachedSessionIds(): Set<string>;
    /** OS-assigned TCP port after listen(). Returns the configured port if
     *  tcpPort was specified non-zero, the OS-picked port if tcpPort=0, or
     *  null if TCP isn't enabled. Tests use tcpPort=0 to dodge win32 CI
     *  ephemeral-port permission flakes. */
    getTcpPort(): number | null;
    /**
     * Test-only: verify the periodic prune timer is wired up after listen().
     * Production callers should never read this — pruneDeadClients runs from
     * the interval, from getStats, and from armIdleTimer; the timer handle
     * itself is an implementation detail.
     * @internal
     */
    _testHasPruneTimer(): boolean;
    /**
     * Test-only: synchronously fire one round of prune logic identical to
     * what the periodic timer does (prune + maybe-arm-idle). Lets tests
     * exercise the same code path as the interval without waiting 60s.
     * @internal
     */
    _testRunPrune(): number;
    /**
     * Test-only: inject a phantom client entry. Used to simulate the
     * Map-entry-without-close-event edge case (Agent E gap #2) where Node's
     * 'close' handler never fires for a destroyed peer. Production code
     * never calls this — the registration happens organically in onConnection.
     * @internal
     */
    _testInjectPhantomClient(): Socket;
    /** Mark daemon for supersede: it will exit when the last attached client
     *  disconnects. Idempotent. Safe to call from a handler thread. */
    markPendingSupersede(): void;
    isPendingSupersede(): boolean;
    /** When supersede is flagged AND the last client just disconnected, fire
     *  the registered callback so daemon main can shut down cleanly. The
     *  callback is invoked exactly once per supersede cycle. */
    private supersedeFired;
    private checkSupersedeReady;
    private onConnection;
    private dispatchLine;
    private sendResponse;
}
