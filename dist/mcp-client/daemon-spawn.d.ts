/**
 * Daemon-spawn helper used by kongcode-mcp on startup.
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
 *  TCP loopback on Windows or when KONGCODE_DAEMON_TRANSPORT=tcp. Exactly one
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
 *  KONGCODE_DAEMON_TRANSPORT=tcp opt-in forces TCP on every platform. Kept
 *  as a pure, testable function so the parity with the daemon is verifiable
 *  without spawning anything. */
export declare function resolveTransport(env?: NodeJS.ProcessEnv, plat?: NodeJS.Platform): "uds" | "tcp";
/** The TCP port the daemon binds. Must match daemon/index.ts exactly:
 *  KONGCODE_DAEMON_PORT if set and valid, else the fixed DEFAULT_DAEMON_TCP_PORT.
 *  The daemon binds a DETERMINISTIC port in production (the ephemeral tcpPort=0
 *  path in server.ts is test-only), so no discovery file is needed — both sides
 *  derive the port from the same constant + env var. */
export declare function resolveTcpPort(env?: NodeJS.ProcessEnv): number;
/** Get a daemon endpoint — either the existing one if alive, or spawn a new
 *  one. Transport-aware: returns a TCP endpoint {tcpHost,tcpPort} on Windows
 *  or under KONGCODE_DAEMON_TRANSPORT=tcp (matching the daemon's own bind
 *  decision), else a Unix-socket endpoint. */
export declare function ensureDaemon(opts?: DaemonSpawnOpts): Promise<DaemonEndpoint>;
