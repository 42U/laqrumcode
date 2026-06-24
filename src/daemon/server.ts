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

import { createServer, connect as netConnect, Socket as NetSocket, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync, chmodSync } from "node:fs";
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

/** E2: JSON-RPC error code for a non-meta call on a socket that has not
 *  completed the handshake when handshake auth is required (TCP transport).
 *  Aliased to IpcErrorCode.UNAUTHORIZED (-32006) — single source of truth; the
 *  mcp-client retry path treats this code as "reconnect + re-handshake + retry"
 *  so a bare TCP reconnect that drops the authed socket self-heals. */
const RPC_UNAUTHORIZED = IpcErrorCode.UNAUTHORIZED;

/** E2-META-DOS: the ONLY methods admitted on an unauthenticated socket when
 *  handshake auth is required (TCP transport). An explicit allow-set, NOT a
 *  `startsWith("meta.")` prefix — the other meta methods do no token check of
 *  their own (meta.shutdown schedules gracefulCleanup; meta.requestSupersede
 *  arms the E8 grace-exit), so a prefix exemption would let an unauthed
 *  cross-OS-user kill or supersede the daemon (an availability DoS) as their
 *  first line. Both members are legitimately pre-auth:
 *    - meta.handshake ESTABLISHES auth (verifies the 0600 per-user token, then
 *      calls ctx.markAuthed); gating it would make TCP auth impossible.
 *    - meta.health is the probeTcpOccupant liveness path (server.ts ~441) used
 *      to tell a laqrumcode daemon from a foreign squatter on an in-use port,
 *      before any client could have handshook; it returns only liveness/stats,
 *      no graph data.
 *  Every OTHER meta.* (meta.shutdown, meta.requestSupersede, and any future
 *  meta method) then falls under the same token gate as tool.* / hook.*. Typed
 *  as IpcMethod so a renamed/removed method is a compile error here. */
const PRE_AUTH_METHODS: ReadonlySet<IpcMethod> = new Set<IpcMethod>([
  "meta.handshake",
  "meta.health",
]);

/** M2(a): the JSON-RPC error codes the mcp-client actually retries on
 *  (src/mcp-client/index.ts ~271: DAEMON_RESTARTING / DAEMON_BOOTSTRAPPING /
 *  UNAUTHORIZED). When a handler throws an error carrying one of these as its
 *  `.code` (e.g. EmbedBusyError → DAEMON_RESTARTING on embed-queue-full), the
 *  dispatcher passes the code through instead of flattening it to the
 *  non-retryable HANDLER_ERROR — so transient backpressure becomes a
 *  back-off-and-retry on the client, not a failed user turn. const enum members
 *  are inlined at compile time, so this is a plain number Set. */
const RETRYABLE_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  IpcErrorCode.DAEMON_RESTARTING,
  IpcErrorCode.DAEMON_BOOTSTRAPPING,
  IpcErrorCode.UNAUTHORIZED,
]);

/** True when `code` is a number in the client-retryable family. Tolerant of
 *  unknown input (handlers throw arbitrary values) — only an exact numeric
 *  match passes, so a stray string/undefined `.code` falls through to
 *  HANDLER_ERROR. */
function isRetryableErrorCode(code: unknown): boolean {
  return typeof code === "number" && RETRYABLE_ERROR_CODES.has(code);
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
export class TcpPortInUseError extends Error {
  constructor(
    public readonly kind: "laqrumcode-daemon" | "foreign",
    public readonly port: number,
    message: string,
  ) {
    super(message);
    this.name = "TcpPortInUseError";
  }
}

export class DaemonServer {
  private udsServer: Server | null = null;
  private tcpServer: Server | null = null;
  private handlers = new Map<IpcMethod, IpcHandler>();
  /** Per-attached-socket identity registry. Value is the ClientInfo the
   *  client sent in its meta.handshake, or null if the client hasn't
   *  identified itself yet (transient state during handshake) or is a
   *  pre-0.7.9 client that doesn't pass clientInfo (@deprecated fallback —
   *  retain for backward compat but no longer expected in practice). Set
   *  membership doubles as the active-clients count. */
  private clients = new Map<Socket, ClientInfo | null>();
  /** E2: sockets that have completed meta.handshake (token verified). Only
   *  consulted when opts.requireHandshakeAuth is true. A socket is added here
   *  by ctx.markAuthed() from the meta.handshake handler AFTER the token check
   *  passes, and removed on socket close/error alongside the clients entry. A
   *  separate set (rather than overloading the ClientInfo|null value) keeps the
   *  anonymous-vs-identified distinction intact while tracking auth orthogonally:
   *  a socket can be authed (token OK) yet still anonymous (no clientInfo sent). */
  private authedSockets = new Set<Socket>();
  private rpcsServedTotal = 0;
  private rpcsInFlight = 0;
  private startedAt = Date.now();
  private pendingSupersede = false;
  /** E8: upper-bound timer armed by markPendingSupersede. When it fires (and
   *  the supersede path hasn't already completed via last-client-disconnect),
   *  onSupersedeDeadline runs so the daemon exits even with clients attached,
   *  freeing the endpoint for a fresh-dist daemon. Cleared on graceful
   *  supersede completion and in close(). Unref'd so it never keeps the loop
   *  alive on its own. */
  private supersedeGraceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleSince: number | null = null;
  /** Periodic phantom-client reaper. Agent E flagged that pruneDeadClients
   *  previously ran ONLY from read paths (getStats, armIdleTimer, etc.) — so
   *  on an idle daemon with no reads firing, a phantom map entry can persist
   *  indefinitely and block armIdleTimer's clients.size==0 check. This
   *  interval guarantees the prune fires regardless of inbound traffic. */
  private pruneTimer: NodeJS.Timeout | null = null;
  /** How often to sweep phantom clients off the map. 60s is a reasonable
   *  trade-off: long enough to be free on a fully idle daemon, short enough
   *  that a stuck phantom doesn't keep the daemon alive for many minutes
   *  past the last real disconnect. */
  private static readonly PRUNE_INTERVAL_MS = 60_000;
  /** K12 backpressure: global ceiling on concurrently-executing RPCs. Past
   *  this, NON-meta calls (tool.* / hook.*) are rejected with a retryable busy
   *  error instead of piling onto the store/embedder — which on a single-host
   *  daemon would deepen the embed FIFO and worsen, not absorb, the overload.
   *  meta.* (handshake/health/shutdown/supersede) is always exempt so
   *  lifecycle never wedges under load. Override via LAQRUMCODE_DAEMON_MAX_INFLIGHT. */
  private readonly maxInFlight =
    Number(process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT) > 0
      ? Number(process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT)
      : 256;

  /** M2(b): per-connection in-flight RPC counts. The K12 global ceiling
   *  (maxInFlight) is whole-daemon and UNFAIR — one heavy session firing a
   *  burst of tool calls can occupy the global budget and starve every OTHER
   *  session's userPromptSubmit. This sub-cap bounds how many concurrent
   *  non-meta RPCs a SINGLE socket may hold so one client can't monopolize the
   *  daemon; a socket past its own cap gets the same retryable busy code while
   *  other sockets keep flowing. Entries are created lazily on first non-meta
   *  RPC and pruned to zero in decInFlightForSocket. */
  private perSocketInFlight = new Map<Socket, number>();
  /** M2(b): the per-connection sub-cap. A quarter of the global ceiling by
   *  default (256/4 = 64) — generous enough that a normal session never trips
   *  it (hooks + tool calls are nowhere near 64 concurrent), tight enough that
   *  a single runaway socket can occupy at most ~25% of the daemon before it
   *  starts shedding its OWN excess. Always ≥1 so the cap can never wedge a
   *  socket out entirely. meta.* is exempt (lifecycle must never be starved).
   *  Override via LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET. */
  private readonly maxInFlightPerSocket = (() => {
    const explicit = Number(process.env.LAQRUMCODE_DAEMON_MAX_INFLIGHT_PER_SOCKET);
    if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.round(explicit));
    return Math.max(1, Math.floor(this.maxInFlight / 4));
  })();

  /** H5: hard ceiling on concurrently-OPEN client sockets (server.maxConnections).
   *  Without it, nothing bounds accepted connections: a fork-bomb of mcp-clients
   *  (or a leak that never closes sockets) exhausts the daemon's file descriptors
   *  (EMFILE) and the per-host daemon stops serving EVERY session. 512 is far
   *  above any realistic single-host client count (a handful of Claude Code
   *  windows) yet leaves headroom under the default 1024 fd soft limit for the
   *  daemon's own DB/embedder/log fds. Past this, Node stops accepting and
   *  queues at the kernel backlog until sockets free up. Override via
   *  LAQRUMCODE_DAEMON_MAX_CONNECTIONS. */
  private readonly maxConnections =
    Number(process.env.LAQRUMCODE_DAEMON_MAX_CONNECTIONS) > 0
      ? Number(process.env.LAQRUMCODE_DAEMON_MAX_CONNECTIONS)
      : 512;

  /** H5: explicit listen() backlog (kernel SYN/accept queue depth). Node's
   *  default (511) is fine, but pinning it makes the ceiling explicit and
   *  tunable for constrained hosts. Override via LAQRUMCODE_DAEMON_BACKLOG. */
  private readonly listenBacklog =
    Number(process.env.LAQRUMCODE_DAEMON_BACKLOG) > 0
      ? Number(process.env.LAQRUMCODE_DAEMON_BACKLOG)
      : 511;

  /** H5: how long to pause accepting after an EMFILE/ENFILE (fd exhaustion)
   *  accept error before resuming, instead of crash-looping on a tight accept
   *  retry. Short enough to recover quickly once fds free, long enough to stop
   *  burning CPU re-hitting the same limit. Override via
   *  LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS. */
  private readonly acceptPauseMs =
    Number(process.env.LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS) > 0
      ? Number(process.env.LAQRUMCODE_DAEMON_ACCEPT_PAUSE_MS)
      : 1_000;

  /** H5: timers that resume accepting after an fd-exhaustion pause — tracked so
   *  close() can clear them (unref'd so they never keep the loop alive). One per
   *  server that paused. */
  private acceptResumeTimers = new Set<NodeJS.Timeout>();

  constructor(private readonly opts: DaemonServerOpts) {}

  /** M2(b): current in-flight non-meta RPC count for a socket (0 if none). */
  private inFlightForSocket(sock: Socket): number {
    return this.perSocketInFlight.get(sock) ?? 0;
  }

  /** M2(b): increment a socket's in-flight count (called when a non-meta RPC is
   *  admitted past both caps). */
  private incInFlightForSocket(sock: Socket): void {
    this.perSocketInFlight.set(sock, this.inFlightForSocket(sock) + 1);
  }

  /** M2(b): decrement a socket's in-flight count in the dispatch finally. Only
   *  decrements when an entry exists — meta.* calls never incremented, so a
   *  meta.* finally is a no-op. Drops the map entry at zero so the map can't
   *  accrete dead sockets (close/error handlers also delete it; this keeps it
   *  tidy between those events). */
  private decInFlightForSocket(sock: Socket): void {
    const n = this.perSocketInFlight.get(sock);
    if (n === undefined) return;
    if (n <= 1) this.perSocketInFlight.delete(sock);
    else this.perSocketInFlight.set(sock, n - 1);
  }

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
  private applyConnectionPolicy(server: Server, label: string): void {
    server.maxConnections = this.maxConnections;
    server.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code;
      if (code === "EMFILE" || code === "ENFILE") {
        // fd exhaustion at accept(). Stop accepting briefly instead of letting
        // the error crash the daemon (and crash-loop on respawn into the same
        // starved state). maxConnections should normally keep us clear of this;
        // arriving here means the daemon's own fds (DB/embedder/logs) plus
        // sockets crossed the OS limit. Pause → resume gives fds time to free.
        let resumed = false;
        try { server.close(); } catch { /* may already be closing */ }
        this.opts.log.error(`[daemon] ${label} accept error ${code} (fd exhaustion) — pausing accept for ${this.acceptPauseMs}ms instead of crashing`);
        const timer = setTimeout(() => {
          this.acceptResumeTimers.delete(timer);
          if (resumed) return;
          resumed = true;
          // Re-listen on the same endpoint. Best-effort: if re-listen fails
          // (still starved, or endpoint taken) we log and leave it — the idle
          // reaper / supervisor handles a truly wedged daemon. We do NOT rethrow
          // from here (it would be an uncaught async throw).
          try {
            this.relistenAfterPause(server, label);
          } catch (e) {
            this.opts.log.error(`[daemon] ${label} re-listen after accept pause failed: ${(e as Error).message}`);
          }
        }, this.acceptPauseMs);
        timer.unref?.();
        this.acceptResumeTimers.add(timer);
        return;
      }
      // Any other steady-state server error: log it. Don't rethrow — an uncaught
      // server 'error' crashes the daemon, and the per-host singleton must
      // survive transient listener hiccups to keep serving other sessions.
      this.opts.log.error(`[daemon] ${label} server error: ${err.message}`);
    });
  }

  /** H5: re-arm a server's listener on the same endpoint after an
   *  EMFILE/ENFILE accept pause. Re-binds UDS (re-unlinking a stale socket
   *  file) or TCP (loopback, same port). Best-effort and never throws into the
   *  caller — failures are logged; a daemon that truly can't re-listen is left
   *  to the idle reaper / external supervisor. */
  private relistenAfterPause(server: Server, label: string): void {
    if (server.listening) return; // already accepting again
    const onErr = (e: NodeJS.ErrnoException) => {
      this.opts.log.error(`[daemon] ${label} re-listen error after accept pause: ${e.message}`);
    };
    server.once("error", onErr);
    if (server === this.udsServer && this.opts.socketPath) {
      if (existsSync(this.opts.socketPath)) {
        try { unlinkSync(this.opts.socketPath); } catch { /* ignore */ }
      }
      server.listen(this.opts.socketPath, this.listenBacklog, () => {
        server.removeListener("error", onErr);
        try { chmodSync(this.opts.socketPath!, 0o600); } catch { /* ignore */ }
        this.opts.log.info(`[daemon] ${label} resumed accepting after fd-exhaustion pause`);
      });
    } else if (server === this.tcpServer && this.opts.tcpPort != null) {
      server.listen(this.opts.tcpPort, "127.0.0.1", this.listenBacklog, () => {
        server.removeListener("error", onErr);
        this.opts.log.info(`[daemon] ${label} resumed accepting after fd-exhaustion pause`);
      });
    }
  }

  /** Register a handler for an IPC method. The dispatcher rejects calls to
   *  methods that aren't both in IPC_METHODS (compile-time) AND registered
   *  here (runtime) — covers the case where the constants list outpaces
   *  actual implementations during incremental rollout. */
  register(method: IpcMethod, handler: IpcHandler): void {
    this.handlers.set(method, handler);
  }

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
  private async probeTcpOccupant(port: number): Promise<"laqrumcode-daemon" | "foreign"> {
    const timeoutMs = this.opts.probeTimeoutMs ?? 1_500;
    return new Promise<"laqrumcode-daemon" | "foreign">((resolve) => {
      let settled = false;
      const done = (verdict: "laqrumcode-daemon" | "foreign") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch {}
        resolve(verdict);
      };
      const timer = setTimeout(() => done("foreign"), timeoutMs);
      timer.unref?.();
      const sock = netConnect({ host: "127.0.0.1", port });
      let buffer = "";
      sock.on("connect", () => {
        const req: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method: "meta.health", params: {} };
        if (this.opts.probeToken) (req.params as Record<string, unknown>).handshake = this.opts.probeToken;
        try { sock.write(JSON.stringify(req) + "\n"); } catch { done("foreign"); }
      });
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl === -1) {
          if (buffer.length > 64 * 1024) done("foreign"); // never a laqrumcode health line
          return;
        }
        try {
          const resp = JSON.parse(buffer.slice(0, nl)) as { jsonrpc?: string; result?: { ok?: boolean }; error?: unknown };
          // A laqrumcode daemon answers meta.health with jsonrpc:"2.0" and either
          // a result (ok:true + stats) or a structured JSON-RPC error. Either is
          // proof it speaks our protocol — a foreign squatter cannot produce
          // this shape. We don't require result.ok specifically because a daemon
          // mid-bootstrap could in principle error; the protocol marker is enough.
          if (resp && resp.jsonrpc === "2.0" && (resp.result !== undefined || resp.error !== undefined)) {
            done("laqrumcode-daemon");
          } else {
            done("foreign");
          }
        } catch {
          done("foreign");
        }
      });
      // ECONNREFUSED (port freed between EADDRINUSE and probe), reset, etc. ⇒
      // not a reachable laqrumcode daemon. Treat as foreign so the caller surfaces
      // a clear "couldn't bind and couldn't confirm a laqrumcode daemon" message
      // rather than silently adopting.
      sock.on("error", () => done("foreign"));
      sock.on("close", () => done("foreign"));
    });
  }

  /** Start listening. Throws if the socket can't be bound (e.g. another
   *  daemon already running on the same path — caller should detect via
   *  the spawn lock + PID file probe before calling listen()).
   *
   *  E10: the TCP path catches EADDRINUSE explicitly and probes the occupant
   *  (probeTcpOccupant) so the failure is DISTINGUISHABLE — a sibling laqrumcode
   *  daemon vs a foreign squatter — rather than a generic raw bind error. */
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
        // H5: pass an explicit backlog (kernel accept-queue depth) instead of
        // relying on Node's default — makes the ceiling explicit + tunable.
        this.udsServer!.listen(this.opts.socketPath!, this.listenBacklog, () => {
          this.udsServer!.removeListener("error", reject);
          resolve();
        });
      });
      try { chmodSync(this.opts.socketPath!, 0o600); } catch {}
      // H5: install the steady-state connection ceiling + EMFILE/ENFILE accept
      // policy AFTER bind, so the persistent 'error' listener never intercepts
      // the one-shot bind-error reject above.
      this.applyConnectionPolicy(this.udsServer, "UDS");
      this.opts.log.info(`[daemon] listening on Unix socket ${this.opts.socketPath} (maxConnections=${this.maxConnections}, backlog=${this.listenBacklog})`);
    }
    if (this.opts.tcpPort !== null && this.opts.tcpPort !== undefined) {
      this.tcpServer = createServer((sock) => this.onConnection(sock));
      try {
        await new Promise<void>((resolve, reject) => {
          // Capture the bind error (incl. EADDRINUSE) so the catch below can
          // probe the occupant instead of letting a raw Error('listen
          // EADDRINUSE') bubble with no diagnosis of WHO holds the port.
          this.tcpServer!.once("error", reject);
          // Bind 127.0.0.1 only — never expose the daemon to the network.
          // tcpPort=0 lets the OS pick an available ephemeral port, which is
          // robust against win32 CI sandboxed runners that randomly restrict
          // permissions on individual ports inside the IANA dynamic range
          // (49152-65535). Read the assigned port via getTcpPort() after
          // listen() resolves.
          this.tcpServer!.listen(this.opts.tcpPort!, "127.0.0.1", this.listenBacklog, () => {
            this.tcpServer!.removeListener("error", reject);
            resolve();
          });
        });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") throw e; // unrelated bind failure — surface as-is
        // E10: the port is taken. Mirror the UDS path's stale-handling intent
        // (which unlinks a dead socket and re-binds): figure out WHO holds the
        // port and fail with a distinguishable diagnostic. The spawn lock +
        // PID-file probe in daemon main should normally have detected a live
        // sibling and made the client REUSE it before we ever reached listen();
        // arriving here means that guard was bypassed (lock stolen as
        // "stale" while the daemon was actually alive, a race, or a foreign
        // process grabbing the per-user port).
        const port = this.opts.tcpPort!;
        // The half-bound server object can't be reused — drop it before the
        // throw so close() doesn't later try to tear down a server that never
        // listened.
        try { this.tcpServer!.close(); } catch {}
        this.tcpServer = null;
        const occupant = await this.probeTcpOccupant(port);
        if (occupant === "laqrumcode-daemon") {
          // A real laqrumcode daemon already owns the port. We can't (and must
          // not) double-bind — the singleton invariant means that daemon should
          // serve this user. The spawn lock should have caused adoption
          // upstream; surface a clear, ACTIONABLE error distinct from a generic
          // bind failure so the operator/log shows the singleton collision.
          throw new TcpPortInUseError(
            "laqrumcode-daemon",
            port,
            `TCP 127.0.0.1:${port} is already served by another laqrumcode daemon (singleton already running for this user). ` +
              `This daemon will not start a second instance; the existing daemon should be reused. ` +
              `If it is actually stale, stop it (or remove ${"~/.laqrumcode-daemon.pid"}) and retry.`,
          );
        }
        // Foreign squatter — a non-laqrumcode process holds the per-user port.
        throw new TcpPortInUseError(
          "foreign",
          port,
          `TCP 127.0.0.1:${port} is in use by a FOREIGN (non-laqrumcode) process — it did not answer a meta.health probe. ` +
            `laqrumcode cannot bind its daemon endpoint. Free the port, or set LAQRUMCODE_DAEMON_PORT to an unused port.`,
        );
      }
      // H5: install the steady-state connection ceiling + EMFILE/ENFILE accept
      // policy AFTER the bind succeeded (and after the EADDRINUSE catch above),
      // so the persistent 'error' listener never intercepts a bind-time error
      // that the one-shot reject / EADDRINUSE handling must see.
      this.applyConnectionPolicy(this.tcpServer!, "TCP");
      const addr = this.tcpServer!.address();
      const actualPort = (addr && typeof addr === "object") ? addr.port : this.opts.tcpPort;
      this.opts.log.info(`[daemon] listening on TCP 127.0.0.1:${actualPort} (maxConnections=${this.maxConnections}, backlog=${this.listenBacklog})`);
    }
    // Daemon just started listening with zero clients. Start the idle timer
    // immediately — covers the case where mcp-client crashed before
    // handshaking, leaving an orphaned daemon nobody will ever talk to.
    // First connect cancels the timer.
    this.armIdleTimer();
    // Start the periodic phantom-client prune. Without this, an idle daemon
    // that never sees a read may carry a stuck Map entry for a destroyed
    // socket forever — armIdleTimer's clients.size==0 gate never trips,
    // and the daemon holds BGE-M3 + SurrealDB process in RAM indefinitely.
    this.startPruneTimer();
  }

  /** Start the periodic phantom-client reaper. Idempotent — replaces any
   *  existing timer. Called from listen() and safe to call again from tests
   *  if they want to reset the cadence. */
  private startPruneTimer(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(() => {
      const pruned = this.pruneDeadClients();
      // If pruning just dropped the daemon to zero attached clients (e.g. the
      // close event never fired for the last real client), kick the idle
      // reaper so the daemon doesn't sit holding memory for nobody. Only
      // re-arm if no idle timer is currently active.
      if (pruned > 0 && this.clients.size === 0) this.armIdleTimer();
    }, DaemonServer.PRUNE_INTERVAL_MS);
    // Don't let the prune cadence keep the event loop alive on its own.
    // Without unref, the daemon couldn't exit cleanly on its natural idle
    // reap path because Node would keep running the loop just for this timer.
    this.pruneTimer.unref?.();
  }

  /** Stop the periodic phantom-client reaper. Safe to call repeatedly. */
  private stopPruneTimer(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
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
        this.authedSockets.delete(sock); // E2: drop auth state with the socket
        this.perSocketInFlight.delete(sock); // M2(b): drop in-flight count with the socket
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

  /** Max time close() waits for in-flight RPCs to settle before forcibly
   *  ending sockets. Kept under daemon/index.ts's 8s shutdown watchdog so the
   *  drain finishes (or is abandoned) before the watchdog hard-exits. Override
   *  via LAQRUMCODE_DAEMON_DRAIN_TIMEOUT_MS (tests use a small value). */
  private drainTimeoutMs(): number {
    const env = Number(process.env.LAQRUMCODE_DAEMON_DRAIN_TIMEOUT_MS);
    return Number.isFinite(env) && env >= 0 ? env : 5_000;
  }

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
  async close(): Promise<void> {
    this.disarmIdleTimer();
    this.stopPruneTimer();
    // E8: cancel the supersede grace timer — once close() is running the daemon
    // is already exiting, so the upper-bound deadline must not fire a second
    // exit path mid-shutdown.
    this.disarmSupersedeGraceTimer();
    // H5: cancel any pending accept-resume timers — a daemon that's shutting
    // down must not re-listen on its endpoint after an fd-exhaustion pause.
    for (const t of this.acceptResumeTimers) clearTimeout(t);
    this.acceptResumeTimers.clear();

    // (1) Stop accepting NEW connections first. Existing sockets stay open so
    // in-flight handlers can still write their responses. Server.close()
    // resolves its callback only once all existing connections have ended, so
    // we kick it off here (capturing the resolution promise) but drive the
    // actual socket teardown ourselves after the drain — otherwise close()
    // would block on connections we haven't ended yet.
    const udsClosed = this.udsServer
      ? new Promise<void>((resolve) => this.udsServer!.close(() => resolve()))
      : Promise.resolve();
    const tcpClosed = this.tcpServer
      ? new Promise<void>((resolve) => this.tcpServer!.close(() => resolve()))
      : Promise.resolve();

    // (2) Drain: wait for in-flight RPCs to finish, bounded so a wedged
    // handler can't hang shutdown past the watchdog.
    await this.awaitInFlightDrain(this.drainTimeoutMs());

    // (3) Anything still pending at the deadline: send a JSON-RPC error so the
    // client gets a definitive failure instead of a silently-dropped request.
    if (this.rpcsInFlight > 0) {
      this.opts.log.warn(`[daemon] close: ${this.rpcsInFlight} RPC(s) still in-flight at drain deadline — sending shutdown errors`);
      for (const sock of this.clients.keys()) {
        this.sendResponse(sock, {
          jsonrpc: "2.0",
          id: null,
          error: { code: IpcErrorCode.DAEMON_RESTARTING, message: "daemon shutting down — retry after reconnect" },
        });
      }
    }

    // (4) Now end client sockets — this lets the listener close() callbacks
    // above resolve once the sockets finish closing.
    for (const sock of this.clients.keys()) {
      try { sock.end(); } catch {}
    }
    this.clients.clear();
    this.authedSockets.clear(); // E2: clear auth state on full shutdown
    this.perSocketInFlight.clear(); // M2(b): clear per-socket in-flight counts on full shutdown
    await udsClosed;
    if (this.udsServer && this.opts.socketPath && existsSync(this.opts.socketPath)) {
      try { unlinkSync(this.opts.socketPath); } catch {}
    }
    await tcpClosed;
  }

  /** Poll until rpcsInFlight hits 0 or the timeout elapses. Short poll
   *  interval keeps shutdown snappy when handlers finish quickly; the bound
   *  guarantees we never wait forever on a wedged handler. */
  private async awaitInFlightDrain(timeoutMs: number): Promise<void> {
    if (this.rpcsInFlight <= 0) return;
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 25;
    while (this.rpcsInFlight > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
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

  /** R13: the set of Claude Code session ids whose client socket is currently
   *  attached. The stale-session reaper uses this to skip reaping any session
   *  whose client is still connected (a live socket means the session is not
   *  idle, regardless of how old its turnStartMs looks — e.g. a long agentic
   *  turn). Prunes phantom (destroyed-but-not-closed) sockets first so a
   *  stuck Map entry can't keep a session pinned forever. Anonymous clients
   *  (null ClientInfo, pre-handshake or pre-0.7.9) contribute no id — they're
   *  not yet associated with a session, so they can't protect one from reaping. */
  attachedSessionIds(): Set<string> {
    this.pruneDeadClients();
    const ids = new Set<string>();
    for (const info of this.clients.values()) {
      if (info?.sessionId) ids.add(info.sessionId);
    }
    return ids;
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

  /**
   * Test-only: verify the periodic prune timer is wired up after listen().
   * Production callers should never read this — pruneDeadClients runs from
   * the interval, from getStats, and from armIdleTimer; the timer handle
   * itself is an implementation detail.
   * @internal
   */
  _testHasPruneTimer(): boolean {
    return this.pruneTimer !== null;
  }

  /**
   * Test-only (H5): the configured connection ceiling, per-socket in-flight
   * sub-cap, and accept backlog — so a test can assert they're set without
   * reaching into private fields.
   * @internal
   */
  _testLimits(): { maxConnections: number; maxInFlightPerSocket: number; backlog: number } {
    return {
      maxConnections: this.maxConnections,
      maxInFlightPerSocket: this.maxInFlightPerSocket,
      backlog: this.listenBacklog,
    };
  }

  /**
   * Test-only (H5): the live `maxConnections` actually applied to the bound
   * server object(s). Returns the UDS server's value when present, else the
   * TCP server's, else null (not listening). Proves applyConnectionPolicy ran.
   * @internal
   */
  _testLiveMaxConnections(): number | null {
    if (this.udsServer) return this.udsServer.maxConnections;
    if (this.tcpServer) return this.tcpServer.maxConnections;
    return null;
  }

  /**
   * Test-only (H5): synthetically emit an EMFILE accept error on the live
   * server to exercise the persistent fd-exhaustion handler WITHOUT actually
   * exhausting file descriptors. Returns true if the daemon survived (the
   * 'error' listener swallowed it — an unhandled 'error' on an EventEmitter
   * throws, so a true here proves the handler is attached) and a resume timer
   * was scheduled. The caller should follow with close() to clear the timer.
   * @internal
   */
  _testEmitAcceptError(code: "EMFILE" | "ENFILE" = "EMFILE"): boolean {
    const server = this.tcpServer ?? this.udsServer;
    if (!server) return false;
    const before = this.acceptResumeTimers.size;
    const err = Object.assign(new Error(`accept ${code}`), { code });
    // If no 'error' listener were attached this would throw (Node's default
    // for an unhandled 'error' event) and fail the test — which is exactly the
    // pre-fix behavior we're guarding against.
    server.emit("error", err);
    return this.acceptResumeTimers.size > before;
  }

  /**
   * Test-only: synchronously fire one round of prune logic identical to
   * what the periodic timer does (prune + maybe-arm-idle). Lets tests
   * exercise the same code path as the interval without waiting 60s.
   * @internal
   */
  _testRunPrune(): number {
    const pruned = this.pruneDeadClients();
    if (pruned > 0 && this.clients.size === 0) this.armIdleTimer();
    return pruned;
  }

  /**
   * Test-only: inject a phantom client entry. Used to simulate the
   * Map-entry-without-close-event edge case (Agent E gap #2) where Node's
   * 'close' handler never fires for a destroyed peer. Production code
   * never calls this — the registration happens organically in onConnection.
   * @internal
   */
  _testInjectPhantomClient(): Socket {
    // Create a real Socket and destroy it immediately. The pruneDeadClients
    // check looks at sock.destroyed || !sock.writable so a freshly-destroyed
    // socket qualifies as a phantom even though it never went through
    // onConnection. This matches what Agent E flagged: a Map entry whose
    // close event never reaches our handler.
    const phantom = new NetSocket();
    phantom.destroy();
    this.clients.set(phantom, null);
    return phantom;
  }

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
  markPendingSupersede(): void {
    if (this.pendingSupersede) return; // already flagged — don't re-arm the grace timer
    this.pendingSupersede = true;
    const graceMs = this.opts.supersedeGraceMs ?? 0;
    if (graceMs > 0 && this.opts.onSupersedeDeadline && !this.supersedeGraceTimer) {
      this.opts.log.info(`[daemon] supersede flagged — graceful exit on last-client-disconnect, bounded by a ${Math.round(graceMs / 1000)}s grace window`);
      this.supersedeGraceTimer = setTimeout(() => {
        this.supersedeGraceTimer = null;
        // Re-check at fire time: the graceful path may have already exited the
        // daemon between arming and firing. supersedeFired is the single guard
        // shared with checkSupersedeReady, so we never double-fire the exit.
        if (this.supersedeFired) return;
        this.pruneDeadClients();
        this.supersedeFired = true;
        this.opts.log.info(`[daemon] supersede grace window (${graceMs}ms) elapsed with ${this.clients.size} client(s) still attached — draining and exiting for code refresh`);
        try { this.opts.onSupersedeDeadline!(); } catch (e) {
          this.opts.log.warn(`[daemon] onSupersedeDeadline callback threw: ${(e as Error).message}`);
        }
      }, graceMs);
      this.supersedeGraceTimer.unref?.();
    }
  }

  isPendingSupersede(): boolean {
    return this.pendingSupersede;
  }

  /** Cancel the supersede grace timer (graceful path completed, or daemon is
   *  shutting down). Safe to call repeatedly. */
  private disarmSupersedeGraceTimer(): void {
    if (this.supersedeGraceTimer) {
      clearTimeout(this.supersedeGraceTimer);
      this.supersedeGraceTimer = null;
    }
  }

  /** When supersede is flagged AND the last client just disconnected, fire
   *  the registered callback so daemon main can shut down cleanly. The
   *  callback is invoked exactly once per supersede cycle — supersedeFired is
   *  shared with the E8 grace-timer path so only ONE of {onSupersedeReady,
   *  onSupersedeDeadline} ever runs. */
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
      // E8: graceful path won the race — cancel the upper-bound grace timer so
      // onSupersedeDeadline can't also fire later.
      this.disarmSupersedeGraceTimer();
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
      this.authedSockets.delete(sock); // E2: drop auth state with the socket
      this.perSocketInFlight.delete(sock); // M2(b): drop in-flight count with the socket
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
      this.authedSockets.delete(sock); // E2: drop auth state with the socket
      this.perSocketInFlight.delete(sock); // M2(b): drop in-flight count with the socket
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
    // E2 (TCP auth bypass fix): when handshake auth is required (TCP transport
    // with a per-user token), a socket must complete meta.handshake — which
    // verifies the 0600 per-user token and then calls ctx.markAuthed() — BEFORE
    // it may invoke any other method. Reject everything outside an explicit
    // pre-auth allow-set on an unauthed socket with UNAUTHORIZED.
    //
    // E2-META-DOS (HIGH): the allow-set is EXACTLY {meta.handshake, meta.health}
    // — NOT every method that happens to start with "meta.". An earlier blanket
    // `!req.method.startsWith("meta.")` exemption let the OTHER meta methods
    // through pre-auth: meta.shutdown does no token check (it just schedules
    // gracefulCleanup) and meta.requestSupersede does no token check (it just
    // arms the E8 grace-exit), so a hash-collided cross-OS-user on the shared
    // loopback port could send meta.shutdown as their FIRST line and kill this
    // user's daemon — an availability DoS. (Graph access stays blocked either
    // way: tool.* never matched the prefix.) Only handshake (which ESTABLISHES
    // auth) and health (the probeTcpOccupant liveness path at server.ts:441,
    // which must answer before any client could possibly have handshook) are
    // legitimately pre-auth. Every other meta.* now falls under the same token
    // gate as tool.* / hook.*.
    //
    // The check is a no-op when requireHandshakeAuth is false (UDS-only / no
    // token): the Unix socket's 0600 perms already isolate OS users, so all
    // sockets — including meta.shutdown — are allowed. Mirrors the K12
    // backpressure gate's placement (after isKnownMethod, before handler
    // dispatch); note the BACKPRESSURE gates below keep the broad meta.*
    // exemption on purpose (lifecycle ops must never be shed under load), which
    // is a different concern from auth.
    if (
      this.opts.requireHandshakeAuth &&
      !PRE_AUTH_METHODS.has(req.method) &&
      !this.authedSockets.has(sock)
    ) {
      this.opts.log.warn(`[daemon] REJECTED ${req.method} on unauthenticated socket — handshake required first (possible cross-OS-user access attempt on shared loopback port)`);
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: RPC_UNAUTHORIZED,
          message: "unauthorized — complete meta.handshake before calling this method",
        },
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
    // K12 backpressure: reject non-meta calls past the global in-flight
    // ceiling with a retryable busy error. meta.* is exempt — a client must
    // always be able to handshake/health-check/shut down the daemon even when
    // it's saturated with tool/hook work. The client treats DAEMON_RESTARTING
    // as a backoff-and-retry signal (same family it already retries on).
    if (this.rpcsInFlight >= this.maxInFlight && !req.method.startsWith("meta.")) {
      this.opts.log.warn(`[daemon] in-flight ceiling hit (${this.rpcsInFlight}/${this.maxInFlight}) — rejecting ${req.method} as busy`);
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: IpcErrorCode.DAEMON_RESTARTING,
          message: `daemon busy (${this.rpcsInFlight} in-flight) — retry shortly`,
        },
      });
      return;
    }
    // M2(b): per-connection fairness sub-cap. The global K12 ceiling above is
    // whole-daemon and lets ONE heavy session occupy the budget and starve
    // others. This rejects a non-meta call when THIS socket already holds its
    // own in-flight quota — with the SAME retryable code, so the offending
    // client backs off while every other socket keeps flowing well under the
    // global cap. meta.* exempt for the same reason the global gate exempts it:
    // lifecycle (handshake/health/shutdown) must never be shed under load.
    if (
      !req.method.startsWith("meta.") &&
      this.inFlightForSocket(sock) >= this.maxInFlightPerSocket
    ) {
      this.opts.log.warn(`[daemon] per-socket in-flight cap hit (${this.inFlightForSocket(sock)}/${this.maxInFlightPerSocket}) — rejecting ${req.method} as busy (one session can't starve others)`);
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: IpcErrorCode.DAEMON_RESTARTING,
          message: `connection busy (${this.inFlightForSocket(sock)} in-flight on this session) — retry shortly`,
        },
      });
      return;
    }
    this.rpcsInFlight++;
    // M2(b): only non-meta RPCs count against the per-socket sub-cap (meta.*
    // is exempt above, so it must not increment either — otherwise a meta.*
    // finally would decrement a count it never raised). Mirrors the gate's
    // meta.* exemption.
    if (!req.method.startsWith("meta.")) this.incInFlightForSocket(sock);
    const ctx: HandlerContext = {
      registerIdentity: (info) => {
        const stamped: ClientInfo = { ...info, attachedAt: info.attachedAt ?? Date.now() };
        this.clients.set(sock, stamped);
        this.opts.log.info(`[daemon] client connected: pid=${stamped.pid} v${stamped.version} session=${stamped.sessionId}`);
      },
      // E2: the meta.handshake handler calls this AFTER verifying the per-user
      // token, marking THIS socket as allowed to invoke non-meta methods.
      markAuthed: () => {
        this.authedSockets.add(sock);
      },
    };
    try {
      const result = await handler(req.params, ctx);
      this.rpcsServedTotal++;
      this.sendResponse(sock, { jsonrpc: "2.0", id: req.id, result });
    } catch (e) {
      const err = e as Error & { code?: unknown };
      // M2(a): a handler may throw an error that already carries a JSON-RPC
      // error code in the RETRYABLE family — notably EmbedBusyError
      // (DAEMON_RESTARTING) when the embed FIFO is full (backpressure). Honor
      // that code so the client backs off and RETRIES, instead of blanket-
      // wrapping every throw as HANDLER_ERROR (non-retryable), which would fail
      // the user's turn on a transient embed-queue overflow. Only the retryable
      // codes the client actually re-tries are passed through; anything else
      // (a genuine handler bug) stays HANDLER_ERROR so it surfaces to the user.
      const passthroughCode = isRetryableErrorCode(err.code) ? (err.code as number) : null;
      if (passthroughCode !== null) {
        this.opts.log.warn(`[daemon] handler ${req.method} threw retryable (${passthroughCode}): ${err.message}`);
      } else {
        this.opts.log.warn(`[daemon] handler ${req.method} threw: ${err.message}`);
      }
      this.sendResponse(sock, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: passthroughCode ?? IpcErrorCode.HANDLER_ERROR, message: err.message },
      });
    } finally {
      this.rpcsInFlight--;
      this.decInFlightForSocket(sock);
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
