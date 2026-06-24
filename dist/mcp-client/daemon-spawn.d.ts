/**
 * Daemon-spawn helper used by laqrumcode-mcp on startup.
 *
 * Implements the "client starts daemon if missing" lifecycle:
 *   1. Probe socket → if alive, return URL.
 *   2. Probe PID file → if PID alive but socket dead, log warning, fall through
 *      to spawn (daemon was killed mid-life; pid file is stale).
 *   3. Spawn `node <daemon-binary>` detached + unref'd; wait for ready.
 *   4. Return socket path once daemon's meta.handshake responds.
 *
 * Uses a file lock at `<cacheDir>/daemon.lock` to prevent concurrent spawns
 * when multiple Claude Code sessions race on first daemon start.
 */
export interface DaemonSpawnOpts {
    socketPath?: string;
    cacheDir?: string;
    /** Path to dist/daemon/index.js — derived from this file's location if omitted. */
    daemonScriptPath?: string;
    /** Max time to wait for daemon to respond to meta.handshake. Cold first run
     *  takes 3-5 min for downloads; subsequent runs are <5s. */
    readyTimeoutMs?: number;
    log?: {
        info: (m: string) => void;
        warn: (m: string) => void;
        error: (m: string, e?: unknown) => void;
    };
}
/** Where the daemon is (or will be) reachable. Mirrors the daemon's own
 *  transport selection (daemon/index.ts): Unix-domain socket on linux/macOS,
 *  TCP loopback on Windows or when LAQRUMCODE_DAEMON_TRANSPORT=tcp. Exactly one
 *  of {socketPath} / {tcpHost,tcpPort} is the live transport, but socketPath
 *  is always populated for diagnostics/log continuity. */
export interface DaemonEndpoint {
    socketPath: string;
    /** Set only in TCP mode. When present, clients must connect over TCP and
     *  ignore socketPath as a transport (it's diagnostic only on Windows). */
    tcpHost?: string;
    tcpPort?: number;
    spawned: boolean;
}
/** Decide the client transport, symmetric with the daemon side
 *  (daemon/index.ts: `useUds = TRANSPORT !== "tcp" && platform !== "win32"`).
 *  Windows has no Unix sockets (the daemon binds TCP-only there), and the
 *  LAQRUMCODE_DAEMON_TRANSPORT=tcp opt-in forces TCP on every platform. Kept
 *  as a pure, testable function so the parity with the daemon is verifiable
 *  without spawning anything. */
export declare function resolveTransport(env?: NodeJS.ProcessEnv, plat?: NodeJS.Platform): "uds" | "tcp";
/** Per-user TCP-port window for the daemon's loopback IPC: the daemon binds
 *  PORT_OFFSET_BASE + (hash(osUserDiscriminator) % PORT_OFFSET_RANGE), i.e. the
 *  [28765, 32764] window described in the T3 note below. Same modulus shape as
 *  bootstrap.pickPort()'s managed-SurrealDB port so the derivations are auditable
 *  side by side. (The read-only UI port — ui-server.ts UI_PORT_BASE/uiPort() —
 *  starts ABOVE this window's ceiling, 32765, so the two never collide. U1.) */
export declare const PORT_OFFSET_BASE = 28765;
export declare const PORT_OFFSET_RANGE = 4000;
/** The OS-user discriminator used to derive a per-user TCP port and token-file
 *  path. On POSIX the uid is the canonical, collision-free identity (mirrors
 *  bootstrap.pickPort()); on Windows there is no getuid(), so we fall back to
 *  the account username (os.userInfo().username) — distinct per Windows account
 *  and the closest portable stand-in for the SID without a native call. Returns
 *  null only when neither is resolvable (then callers use the flat default).
 *  MUST stay identical on the client and the daemon — both import this. */
export declare function osUserDiscriminator(): string | null;
/** Tiny deterministic 32-bit string hash (FNV-1a). Not cryptographic — only
 *  used to scatter different OS users across the per-user port window. Stable
 *  across processes/platforms/Node versions (pure integer arithmetic), which is
 *  the property the client↔daemon parity depends on. Returns a non-negative int. */
export declare function stableHash32(s: string): number;
/** The TCP port the daemon binds. Must match daemon/index.ts exactly:
 *  - LAQRUMCODE_DAEMON_PORT if set and valid → used verbatim, NO per-user offset
 *    (explicit operator intent; mirrors pickPort's env-override-wins rule).
 *  - else PORT_OFFSET_BASE + (hash(osUserDiscriminator) % PORT_OFFSET_RANGE) — the [28765,32764] window (T3).
 *
 *  S6 (multi-OS-user Windows host): the prior flat default (18764 for every
 *  user) let a 2nd OS user's client fast-path-ping 127.0.0.1:18764 and ADOPT
 *  the 1st user's already-running daemon — reading their private graph. Deriving
 *  the port per-user (the same shape bootstrap.pickPort() already uses for the
 *  managed SurrealDB port) means different accounts land on different ports and
 *  never cross-adopt. The handshake token (resolveDaemonTokenPath) is the
 *  defense-in-depth backstop for the rare hash collision.
 *
 *  The daemon still binds a DETERMINISTIC port in production (the ephemeral
 *  tcpPort=0 path in server.ts is test-only), so no discovery file is needed —
 *  both sides derive the port from the same constant + env + user identity. */
export declare function resolveTcpPort(env?: NodeJS.ProcessEnv): number;
/** Per-user handshake-token file path. Co-located with the daemon pid file in
 *  the user's own home (homedir()), which is per-account on every OS — so two
 *  OS users never share it. The daemon writes a random secret here at 0600 on
 *  TCP-bind; the client reads it and echoes it in meta.handshake. Defense in
 *  depth: loopback TCP is reachable by ANY local user (unlike the 0600 Unix
 *  socket), so even if two users hash-collide onto the same port, the wrong
 *  user can't read this file and is rejected at handshake. MUST stay identical
 *  on both sides — both derive the path from homedir(). */
export declare function resolveDaemonTokenPath(home?: string): string;
/** Read the per-user handshake token, or null if the file is absent/unreadable
 *  (e.g. daemon not yet up, or — the breach case — a different OS user's file we
 *  have no permission to read). Trimmed; empty content is treated as null. */
export declare function readDaemonToken(home?: string): string | null;
/** Get a daemon endpoint — either the existing one if alive, or spawn a new
 *  one. Transport-aware: returns a TCP endpoint {tcpHost,tcpPort} on Windows
 *  or under LAQRUMCODE_DAEMON_TRANSPORT=tcp (matching the daemon's own bind
 *  decision), else a Unix-socket endpoint. */
export declare function ensureDaemon(opts?: DaemonSpawnOpts): Promise<DaemonEndpoint>;
