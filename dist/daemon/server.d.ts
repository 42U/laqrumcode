/**
 * JSON-RPC 2.0 server for the laqrumcode daemon.
 *
 * Wire format: line-delimited JSON over Unix socket (Linux, macOS) or TCP
 * loopback (Windows / explicit override). Each direction sends one JSON
 * object per line; receivers buffer until they see \n then parse.
 *
 * Why line-delimited and not length-prefixed: simpler parser, no streaming
 * state machine needed, robust to socket partial reads, and trivial to
 * inspect via `nc -U ~/.laqrumcode-daemon.sock` for live debugging. Trade-off
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
    /** E8: bounded grace window for the supersede path. onSupersedeReady alone
     *  only fires at the LAST-client-disconnect boundary — so on a busy
     *  single-host install whose client count never reaches zero, a daemon
     *  flagged superseded by a newer client keeps running OLD dist/ code
     *  indefinitely after `npm upgrade`. This is the upper bound: once the
     *  supersede flag is set, the daemon waits at most this long for clients to
     *  drain to zero on their own (the graceful onSupersedeReady path); if they
     *  haven't, onSupersedeDeadline fires so daemon main can drain in-flight
     *  RPCs and exit ANYWAY, letting a fresh daemon (new dist) spawn on the next
     *  client connect. Set 0/undefined to disable the bound (legacy
     *  wait-for-last-disconnect-only behavior). Default wired in daemon/index.ts. */
    supersedeGraceMs?: number;
    /** E8: fired once when the supersede grace window (supersedeGraceMs) elapses
     *  and clients are STILL attached. Daemon main wires this to the same
     *  drain-and-exit path as onSupersedeReady / onIdleReap. Never fires if the
     *  graceful onSupersedeReady path already fired first (last client
     *  disconnected inside the window) — the two are mutually exclusive per
     *  supersede cycle. */
    onSupersedeDeadline?: () => void;
    /** Idle-reaper: when clients.size === 0 for this many ms, fire onIdleReap.
     *  Set to 0 to disable. Default wired in daemon/index.ts (0.7.11+) is
     *  60s; users can override via LAQRUMCODE_DAEMON_IDLE_TIMEOUT_MS env var.
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
    /** E10: token presented when probing an EADDRINUSE occupant on the TCP listen
     *  path. meta.health needs no auth so the probe works without it, but if a
     *  future health gate is added this lets the probe still identify a sibling
     *  laqrumcode daemon. Daemon main passes the current per-user token-file
     *  contents (readDaemonToken). Optional — null/undefined means "probe
     *  unauthenticated", which is sufficient to classify the occupant. */
    probeToken?: string | null;
    /** E10: how long the EADDRINUSE occupant probe waits for a meta.health reply
     *  before giving up and classifying the occupant as foreign/unresponsive.
     *  Small by design — a live local laqrumcode daemon answers meta.health in
     *  single-digit ms. Default 1500ms; tests override to keep the suite fast. */
    probeTimeoutMs?: number;
}
/** E10: thrown by listen() when the TCP port is already bound (EADDRINUSE) and
 *  the daemon couldn't take it over. `kind` makes the failure DISTINGUISHABLE —
 *  callers (and tests) can tell a sibling laqrumcode daemon already owning the
 *  port ("laqrumcode-daemon") from an unrelated foreign process squatting it
 *  ("foreign"), instead of seeing a generic Error('listen EADDRINUSE'). This is
 *  the asymmetry E10 fixes: the UDS path already unlinks a stale socket and
 *  re-binds; the TCP path used to just rethrow the raw bind error with no
 *  diagnosis of WHO holds the port. */
export declare class TcpPortInUseError extends Error {
    readonly kind: "laqrumcode-daemon" | "foreign";
    readonly port: number;
    constructor(kind: "laqrumcode-daemon" | "foreign", port: number, message: string);
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
    /** E8: upper-bound timer armed by markPendingSupersede. When it fires (and
     *  the supersede path hasn't already completed via last-client-disconnect),
     *  onSupersedeDeadline runs so the daemon exits even with clients attached,
     *  freeing the endpoint for a fresh-dist daemon. Cleared on graceful
     *  supersede completion and in close(). Unref'd so it never keeps the loop
     *  alive on its own. */
    private supersedeGraceTimer;
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
     *  lifecycle never wedges under load. Override via LAQRUMCODE_DAEMON_MAX_INFLIGHT. */
    private readonly maxInFlight;
    /** M2(b): per-connection in-flight RPC counts. The K12 global ceiling
     *  (maxInFlight) is whole-daemon and UNFAIR — one heavy session firing a
     *  burst of tool calls can occupy the global budget and starve every OTHER
     *  session's userPromptSubmit. This sub-cap bounds how many concurrent
     *  non-meta RPCs a SINGLE socket may hold so one client can't monopolize the
     *  daemon; a socket past its own cap gets the same retryable busy code while
     *  other sockets keep flowing. Entries are created lazily on first non-meta
     *  RPC and pruned to zero in decInFlightForSocket. */
    private perSocketInFlight;
    /** M2(b): the per-connection sub-cap. A quarter of the global ceiling by
     *  default (256/4 = 64) — generous enough that a normal session never trips
     *  it (hooks + tool calls are nowhere near 64 concurrent), tight enough that
     *  a single runaway socket can occupy at most ~25% of the daemon before it
     *  starts shedding its OWN excess. Always ≥1 so the cap can never wedge a
     *  socket out entirely. meta.* is exempt (lifecycle must never be starved).
     *  Override via LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET. */
    private readonly maxInFlightPerSocket;
    /** H5: hard ceiling on concurrently-OPEN client sockets (server.maxConnections).
     *  Without it, nothing bounds accepted connections: a fork-bomb of mcp-clients
     *  (or a leak that never closes sockets) exhausts the daemon's file descriptors
     *  (EMFILE) and the per-host daemon stops serving EVERY session. 512 is far
     *  above any realistic single-host client count (a handful of Claude Code
     *  windows) yet leaves headroom under the default 1024 fd soft limit for the
     *  daemon's own DB/embedder/log fds. Past this, Node stops accepting and
     *  queues at the kernel backlog until sockets free up. Override via
     *  LAQRUMCODE_DAEMON_MAX_CONNECTIONS. */
    private readonly maxConnections;
    /** H5: explicit listen() backlog (kernel SYN/accept queue depth). Node's
     *  default (511) is fine, but pinning it makes the ceiling explicit and
     *  tunable for constrained hosts. Override via LAQRUMCODE_DAEMON_BACKLOG. */
    private readonly listenBacklog;
    /** H5: how long to pause accepting after an EMFILE/ENFILE (fd exhaustion)
     *  accept error before resuming, instead of crash-looping on a tight accept
     *  retry. Short enough to recover quickly once fds free, long enough to stop
     *  burning CPU re-hitting the same limit. Override via
     *  LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS. */
    private readonly acceptPauseMs;
    /** H5: timers that resume accepting after an fd-exhaustion pause — tracked so
     *  close() can clear them (unref'd so they never keep the loop alive). One per
     *  server that paused. */
    private acceptResumeTimers;
    constructor(opts: DaemonServerOpts);
    /** M2(b): current in-flight non-meta RPC count for a socket (0 if none). */
    private inFlightForSocket;
    /** M2(b): increment a socket's in-flight count (called when a non-meta RPC is
     *  admitted past both caps). */
    private incInFlightForSocket;
    /** M2(b): decrement a socket's in-flight count in the dispatch finally. Only
     *  decrements when an entry exists — meta.* calls never incremented, so a
     *  meta.* finally is a no-op. Drops the map entry at zero so the map can't
     *  accrete dead sockets (close/error handlers also delete it; this keeps it
     *  tidy between those events). */
    private decInFlightForSocket;
    /** H5: apply the connection ceiling and an accept-error policy to a freshly
     *  created server. Two pieces:
     *
     *  (1) maxConnections — Node stops accepting new sockets past this count
     *      (queued at the kernel backlog) so a runaway client count can't exhaust
     *      the daemon's file descriptors and take down EVERY session on the host.
     *
     *  (2) a PERSISTENT 'error' handler for accept-time fd exhaustion
     *      (EMFILE/ENFILE). Node emits these on the SERVER (not a socket) when
     *      accept() fails for lack of fds. The default behavior throws — an
     *      uncaught server 'error' would crash the daemon, and a process that
     *      respawns into the same fd-starved state just crash-loops. Instead we
     *      pause accepting (server.close-less: we can't easily un-accept, but we
     *      can stop the tight retry) by briefly suspending and then resuming via
     *      a timer once fds have had a chance to free. This is the
     *      "degrade, don't crash" boundary for the accept path, mirroring the
     *      fail-open philosophy of the hook boundary.
     *
     *  NOTE: this 'error' listener is attached for the SERVER's whole lifetime and
     *  is distinct from the one-shot bind-error listener listen() uses to detect
     *  EADDRINUSE — that one is removed the moment listen succeeds, leaving this
     *  one as the steady-state accept-error handler. */
    private applyConnectionPolicy;
    /** H5: re-arm a server's listener on the same endpoint after an
     *  EMFILE/ENFILE accept pause. Re-binds UDS (re-unlinking a stale socket
     *  file) or TCP (loopback, same port). Best-effort and never throws into the
     *  caller — failures are logged; a daemon that truly can't re-listen is left
     *  to the idle reaper / external supervisor. */
    private relistenAfterPause;
    /** Register a handler for an IPC method. The dispatcher rejects calls to
     *  methods that aren't both in IPC_METHODS (compile-time) AND registered
     *  here (runtime) — covers the case where the constants list outpaces
     *  actual implementations during incremental rollout. */
    register(method: IpcMethod, handler: IpcHandler): void;
    /** E10: probe whoever holds an in-use TCP port by opening a short-lived
     *  connection and asking meta.health (which needs no auth — the token gate is
     *  only on meta.handshake and non-meta methods, so any laqrumcode daemon
     *  answers it). A well-formed JSON-RPC health reply ⇒ the occupant IS a
     *  laqrumcode daemon (this OS user's sibling, or — on a hash-collided shared
     *  loopback port — another user's; either way a real daemon, not a squatter).
     *  No reply / connection refused / unparseable bytes ⇒ a FOREIGN process.
     *  This is what lets listen() throw a DISTINGUISHABLE TcpPortInUseError
     *  instead of a generic bind failure. Best-effort and bounded; never throws —
     *  returns "laqrumcode-daemon" | "foreign". Presents probeToken if we have one
     *  for forward-compat with a future authed health endpoint. */
    private probeTcpOccupant;
    /** Start listening. Throws if the socket can't be bound (e.g. another
     *  daemon already running on the same path — caller should detect via
     *  the spawn lock + PID file probe before calling listen()).
     *
     *  E10: the TCP path catches EADDRINUSE explicitly and probes the occupant
     *  (probeTcpOccupant) so the failure is DISTINGUISHABLE — a sibling laqrumcode
     *  daemon vs a foreign squatter — rather than a generic raw bind error. */
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
     *  via LAQRUMCODE_DAEMON_DRAIN_TIMEOUT_MS (tests use a small value). */
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
     * Test-only (H5): the configured connection ceiling, per-socket in-flight
     * sub-cap, and accept backlog — so a test can assert they're set without
     * reaching into private fields.
     * @internal
     */
    _testLimits(): {
        maxConnections: number;
        maxInFlightPerSocket: number;
        backlog: number;
    };
    /**
     * Test-only (H5): the live `maxConnections` actually applied to the bound
     * server object(s). Returns the UDS server's value when present, else the
     * TCP server's, else null (not listening). Proves applyConnectionPolicy ran.
     * @internal
     */
    _testLiveMaxConnections(): number | null;
    /**
     * Test-only (H5): synthetically emit an EMFILE accept error on the live
     * server to exercise the persistent fd-exhaustion handler WITHOUT actually
     * exhausting file descriptors. Returns true if the daemon survived (the
     * 'error' listener swallowed it — an unhandled 'error' on an EventEmitter
     * throws, so a true here proves the handler is attached) and a resume timer
     * was scheduled. The caller should follow with close() to clear the timer.
     * @internal
     */
    _testEmitAcceptError(code?: "EMFILE" | "ENFILE"): boolean;
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
     *  disconnects. Idempotent. Safe to call from a handler thread.
     *
     *  E8: also arms a BOUNDED grace timer (opts.supersedeGraceMs). The
     *  graceful path (onSupersedeReady at last-client-disconnect) is preferred —
     *  it never disrupts a still-attached older sibling session — but on a busy
     *  single-host install whose client count never reaches zero it would wait
     *  forever, leaving the daemon running stale dist/ code after `npm upgrade`.
     *  The grace timer is the upper bound: if clients haven't drained to zero by
     *  the time it fires, onSupersedeDeadline runs and the daemon exits anyway
     *  (after draining in-flight RPCs in daemon main's cleanup) so a fresh-dist
     *  daemon can spawn. Idempotent: a second markPendingSupersede call does NOT
     *  re-arm or extend the window — the deadline is anchored to the FIRST flag. */
    markPendingSupersede(): void;
    isPendingSupersede(): boolean;
    /** Cancel the supersede grace timer (graceful path completed, or daemon is
     *  shutting down). Safe to call repeatedly. */
    private disarmSupersedeGraceTimer;
    /** When supersede is flagged AND the last client just disconnected, fire
     *  the registered callback so daemon main can shut down cleanly. The
     *  callback is invoked exactly once per supersede cycle — supersedeFired is
     *  shared with the E8 grace-timer path so only ONE of {onSupersedeReady,
     *  onSupersedeDeadline} ever runs. */
    private supersedeFired;
    private checkSupersedeReady;
    private onConnection;
    private dispatchLine;
    private sendResponse;
}
