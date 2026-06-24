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

import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, userInfo } from "node:os";
import {
  DAEMON_PID_FILE,
  DAEMON_SPAWN_LOCK,
  DEFAULT_DAEMON_TCP_PORT,
} from "../shared/ipc-types.js";
import { IpcClient } from "./ipc-client.js";

export interface DaemonSpawnOpts {
  socketPath?: string;
  cacheDir?: string;
  /** Path to dist/daemon/index.js — derived from this file's location if omitted. */
  daemonScriptPath?: string;
  /** Max time to wait for daemon to respond to meta.handshake. Cold first run
   *  takes 3-5 min for downloads; subsequent runs are <5s. */
  readyTimeoutMs?: number;
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
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

const DEFAULT_HOME = homedir();

/** Decide the client transport, symmetric with the daemon side
 *  (daemon/index.ts: `useUds = TRANSPORT !== "tcp" && platform !== "win32"`).
 *  Windows has no Unix sockets (the daemon binds TCP-only there), and the
 *  LAQRUMCODE_DAEMON_TRANSPORT=tcp opt-in forces TCP on every platform. Kept
 *  as a pure, testable function so the parity with the daemon is verifiable
 *  without spawning anything. */
export function resolveTransport(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = process.platform): "uds" | "tcp" {
  if (plat === "win32") return "tcp";
  if (env.LAQRUMCODE_DAEMON_TRANSPORT === "tcp") return "tcp";
  return "uds";
}

/** Per-user TCP-port window for the daemon's loopback IPC: the daemon binds
 *  PORT_OFFSET_BASE + (hash(osUserDiscriminator) % PORT_OFFSET_RANGE), i.e. the
 *  [28765, 32764] window described in the T3 note below. Same modulus shape as
 *  bootstrap.pickPort()'s managed-SurrealDB port so the derivations are auditable
 *  side by side. (The read-only UI port — ui-server.ts UI_PORT_BASE/uiPort() —
 *  starts ABOVE this window's ceiling, 32765, so the two never collide. U1.) */
// T3: anchor the per-user offset window in [28765, 32764] — the gap ABOVE the
// managed-SurrealDB window ([18765, 28764] = 18765 + uid%10000, fixed 18765 on
// win32) and BELOW the 32768 ephemeral-port floor. The pre-T3 window
// (DEFAULT_DAEMON_TCP_PORT 18764 + hash%10000 = [18764, 28763]) OVERLAPPED the
// SurrealDB port, so ~1/10000 usernames deterministically collided with 18765
// on Windows and wedged the daemon. The handshake token is the backstop for the
// (now non-SurrealDB-overlapping) ~1/4000 cross-user hash collision.
export const PORT_OFFSET_BASE = 28765;
export const PORT_OFFSET_RANGE = 4000;

/** The OS-user discriminator used to derive a per-user TCP port and token-file
 *  path. On POSIX the uid is the canonical, collision-free identity (mirrors
 *  bootstrap.pickPort()); on Windows there is no getuid(), so we fall back to
 *  the account username (os.userInfo().username) — distinct per Windows account
 *  and the closest portable stand-in for the SID without a native call. Returns
 *  null only when neither is resolvable (then callers use the flat default).
 *  MUST stay identical on the client and the daemon — both import this. */
export function osUserDiscriminator(): string | null {
  if (typeof process.getuid === "function") {
    try { return `uid:${process.getuid()}`; } catch { /* fall through */ }
  }
  try {
    const u = userInfo().username;
    if (u) return `user:${u}`;
  } catch { /* fall through */ }
  return null;
}

/** Tiny deterministic 32-bit string hash (FNV-1a). Not cryptographic — only
 *  used to scatter different OS users across the per-user port window. Stable
 *  across processes/platforms/Node versions (pure integer arithmetic), which is
 *  the property the client↔daemon parity depends on. Returns a non-negative int. */
export function stableHash32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // force unsigned 32-bit
}

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
export function resolveTcpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAQRUMCODE_DAEMON_PORT;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const who = osUserDiscriminator();
  if (who === null) return DEFAULT_DAEMON_TCP_PORT;
  return PORT_OFFSET_BASE + (stableHash32(who) % PORT_OFFSET_RANGE);
}

/** Per-user handshake-token file path. Co-located with the daemon pid file in
 *  the user's own home (homedir()), which is per-account on every OS — so two
 *  OS users never share it. The daemon writes a random secret here at 0600 on
 *  TCP-bind; the client reads it and echoes it in meta.handshake. Defense in
 *  depth: loopback TCP is reachable by ANY local user (unlike the 0600 Unix
 *  socket), so even if two users hash-collide onto the same port, the wrong
 *  user can't read this file and is rejected at handshake. MUST stay identical
 *  on both sides — both derive the path from homedir(). */
export function resolveDaemonTokenPath(home: string = homedir()): string {
  return join(home, ".laqrumcode-daemon.token");
}

/** Read the per-user handshake token, or null if the file is absent/unreadable
 *  (e.g. daemon not yet up, or — the breach case — a different OS user's file we
 *  have no permission to read). Trimmed; empty content is treated as null. */
export function readDaemonToken(home: string = homedir()): string | null {
  try {
    const t = readFileSync(resolveDaemonTokenPath(home), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Try to acquire an exclusive file lock to prevent concurrent daemon spawns.
 *  POSIX-only via O_EXCL — Windows clients run sequentially via Claude Code's
 *  plugin loader so the race window is small enough to ignore. Returns the fd
 *  to release later, or null if lock was already held (someone else spawning). */
function tryAcquireSpawnLock(lockPath: string): number | null {
  try {
    return openSync(lockPath, "wx", 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      const holderPid = Number(readFileSync(lockPath, "utf-8").trim());
      if (!isPidAlive(holderPid)) {
        unlinkSync(lockPath);
        try { return openSync(lockPath, "wx", 0o644); } catch {}
      }
    } catch {}
    return null;
  }
}

function releaseSpawnLock(fd: number, lockPath: string): void {
  try { closeSync(fd); } catch {}
  try { unlinkSync(lockPath); } catch {}
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** New daemon.pid format (0.7.65+) — JSON marker that identifies a real
 *  laqrumcode daemon. Legacy pre-0.7.65 daemons wrote bare PID strings; we
 *  read both transparently. */
interface DaemonPidMarker {
  marker: "laqrumcode-daemon";
  pid: number;
  startedAt: number;
  daemonVersion: string;
}

/** Read the daemon.pid file and return either the parsed JSON marker or a
 *  synthesized one for legacy bare-PID files. Returns null if unparseable. */
function readDaemonPidMarker(pidFile: string): DaemonPidMarker | null {
  let raw: string;
  try { raw = readFileSync(pidFile, "utf-8").trim(); } catch { return null; }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonPidMarker>;
    if (parsed && parsed.marker === "laqrumcode-daemon" && Number.isFinite(parsed.pid)) {
      return {
        marker: "laqrumcode-daemon",
        pid: parsed.pid as number,
        startedAt: Number.isFinite(parsed.startedAt) ? (parsed.startedAt as number) : 0,
        daemonVersion: typeof parsed.daemonVersion === "string" ? parsed.daemonVersion : "?",
      };
    }
    return null;
  } catch {
    // Legacy bare-PID format.
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return { marker: "laqrumcode-daemon", pid: n, startedAt: 0, daemonVersion: "?" };
    }
    return null;
  }
}

/** Same /proc/<pid>/cmdline check as the daemon itself uses — distinguishes
 *  a real daemon from a recycled PID. Returns null on non-Linux (can't
 *  verify; callers should treat as 'maybe valid'). */
function daemonCmdlineMatches(pid: number): boolean | null {
  if (platform() !== "linux") return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!raw) return false;
    const joined = raw.replace(/\0/g, " ").toLowerCase();
    if (!joined.includes("node")) return false;
    if (joined.includes("laqrumcode-daemon")) return true;
    if (joined.includes("daemon/index.js") || joined.includes("daemon/index.cjs")) return true;
    if (joined.includes("laqrumcode") && joined.includes("daemon")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Probe target — either a Unix socket path or a TCP loopback endpoint.
 *  `spawned` is irrelevant here so we use a narrower shape than DaemonEndpoint. */
type ProbeTarget =
  | { socketPath: string; tcpHost?: undefined; tcpPort?: undefined }
  | { socketPath: string; tcpHost: string; tcpPort: number };

/** Attempt a real RPC against the daemon over the resolved transport. A
 *  successful meta.health means the daemon is up AND past bootstrap enough to
 *  serve — works identically over UDS and TCP (same dispatcher, same wire
 *  format). In TCP mode this doubles as the readiness probe: a closed port
 *  rejects the connect fast. */
async function pingDaemon(target: ProbeTarget, timeoutMs = 1500): Promise<boolean> {
  const c = target.tcpPort !== undefined
    ? new IpcClient({ socketPath: null, tcpHost: target.tcpHost, tcpPort: target.tcpPort, defaultTimeoutMs: timeoutMs })
    : new IpcClient({ socketPath: target.socketPath, defaultTimeoutMs: timeoutMs });
  try {
    await c.connect();
    await c.call("meta.health", {}, timeoutMs);
    c.close();
    return true;
  } catch {
    c.close();
    return false;
  }
}

async function pollSocketReady(target: ProbeTarget, deadline: number, log: NonNullable<DaemonSpawnOpts["log"]>): Promise<boolean> {
  const tcpMode = target.tcpPort !== undefined;
  while (Date.now() < deadline) {
    // UDS: gate on the socket file existing before paying for a connect
    // attempt (cheap existsSync vs an ECONNREFUSED round-trip). TCP: there is
    // no socket file (daemon binds a port), so skip the existsSync gate
    // entirely and let the connect attempt itself be the readiness signal.
    if (tcpMode || existsSync(target.socketPath)) {
      if (await pingDaemon(target, 1500)) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn(`[daemon-spawn] daemon never became ready within deadline`);
  return false;
}

/** Resolve the daemon script path from this file's compiled location. Mirrors
 *  bootstrap's resolvePluginDir trick — works whether running from dist/ or
 *  via direct node invocation. */
function resolveDaemonScript(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // mcp-client/daemon-spawn.js → ../daemon/index.js
    return join(moduleDir, "..", "daemon", "index.js");
  } catch {
    // SEA fallback — daemon binary lives at <pluginDir>/bin/laqrumcode-daemon-<platform>
    return join(dirname(process.execPath), "..", "..", "dist", "daemon", "index.js");
  }
}

/** Get a daemon endpoint — either the existing one if alive, or spawn a new
 *  one. Transport-aware: returns a TCP endpoint {tcpHost,tcpPort} on Windows
 *  or under LAQRUMCODE_DAEMON_TRANSPORT=tcp (matching the daemon's own bind
 *  decision), else a Unix-socket endpoint. */
export async function ensureDaemon(opts: DaemonSpawnOpts = {}): Promise<DaemonEndpoint> {
  const log = opts.log ?? { info: () => {}, warn: () => {}, error: () => {} };
  // Resolve all paths absolutely. The shared/ipc-types constants may use
  // relative paths or $HOME placeholders depending on how they're defined;
  // we rebuild from cacheDir + DEFAULT_HOME to be format-agnostic.
  const socketPath = opts.socketPath ?? join(DEFAULT_HOME, ".laqrumcode-daemon.sock");
  const cacheDir = opts.cacheDir ?? join(DEFAULT_HOME, ".laqrumcode", "cache");
  const pidFile = join(cacheDir, "daemon.pid");
  const lockPath = join(cacheDir, "daemon.spawn.lock");
  const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000; // 5 min cold first run

  // Resolve transport ONCE, symmetric with the daemon. In TCP mode every
  // readiness probe and the returned endpoint must use {tcpHost,tcpPort};
  // existsSync(socketPath) is meaningless there (no socket file exists).
  const transport = resolveTransport();
  const tcpHost = "127.0.0.1";
  const tcpPort = resolveTcpPort();
  const tcpMode = transport === "tcp";
  const probe: ProbeTarget = tcpMode
    ? { socketPath, tcpHost, tcpPort }
    : { socketPath };
  // Stamp the resolved transport onto every endpoint we return so callers
  // (index.ts) construct IpcClient with the matching connect params.
  const endpoint = (spawned: boolean): DaemonEndpoint =>
    tcpMode ? { socketPath, tcpHost, tcpPort, spawned } : { socketPath, spawned };

  // Fast path: daemon already reachable. UDS gates on the socket file first;
  // TCP just attempts the connect (no file to stat).
  if ((tcpMode || existsSync(socketPath)) && (await pingDaemon(probe))) {
    if (tcpMode) log.info(`[daemon-spawn] reached existing daemon over TCP ${tcpHost}:${tcpPort}`);
    return endpoint(false);
  }

  // PID file probe with identity verification. If a live laqrumcode daemon
  // owns the singleton lock but isn't serving its socket yet (still
  // bootstrapping, or transient stall), wait for it instead of spawning a
  // second daemon. A second daemon would double-run startDrainScheduler
  // and double-process pending_work — exactly the duplicate-row class of
  // bug this fix targets. Only spawn if the lock is unowned OR the holder
  // is dead OR the PID was recycled by a non-daemon process.
  if (existsSync(pidFile)) {
    const marker = readDaemonPidMarker(pidFile);
    if (marker && isPidAlive(marker.pid)) {
      const cmdline = daemonCmdlineMatches(marker.pid);
      // cmdline === false → recycled PID, fall through to spawn.
      // cmdline === true → confirmed daemon, wait for its socket.
      // cmdline === null → non-Linux, can't verify; conservative: wait too.
      if (cmdline !== false) {
        log.info(`[daemon-spawn] live laqrumcode daemon detected at pid=${marker.pid} v${marker.daemonVersion} — waiting for ${tcpMode ? `TCP ${tcpHost}:${tcpPort}` : "socket"} instead of spawning`);
        const deadline = Date.now() + readyTimeoutMs;
        const ok = await pollSocketReady(probe, deadline, log);
        if (ok) return endpoint(false);
        log.warn(`[daemon-spawn] daemon pid=${marker.pid} alive but ${tcpMode ? "TCP endpoint" : "socket"} never became ready — proceeding to spawn fresh`);
      } else {
        log.warn(`[daemon-spawn] daemon.pid claims pid=${marker.pid} but cmdline doesn't match laqrumcode daemon (recycled PID) — proceeding to spawn fresh`);
      }
    }
  }

  // Acquire spawn lock; if held by another client racing us, wait for them
  // to finish (poll socket up to readyTimeoutMs).
  await mkdir(cacheDir, { recursive: true });
  let lockFd: number | null = tryAcquireSpawnLock(lockPath);
  if (lockFd === null) {
    log.info(`[daemon-spawn] another client holds spawn lock — waiting for daemon ready`);
    const deadline = Date.now() + readyTimeoutMs;
    const ok = await pollSocketReady(probe, deadline, log);
    if (ok) return endpoint(false);
    // Lock holder died without spawning — remove stale lock and try again
    try { unlinkSync(lockPath); } catch {}
    lockFd = tryAcquireSpawnLock(lockPath);
    if (lockFd === null) throw new Error("daemon spawn lock contention — give up");
  }

  // Write our PID into the lock file for diagnostics
  try { writeSync(lockFd, String(process.pid)); } catch {}

  try {
    const scriptPath = opts.daemonScriptPath ?? resolveDaemonScript();
    if (!existsSync(scriptPath)) {
      throw new Error(`daemon script not found at ${scriptPath} — check plugin install`);
    }
    // Redirect daemon stdout/stderr to a log file so startup errors are visible.
    // 'ignore' would hide any throw during initializeStack(), making debugging
    // (the kind of bug 0.6.7's first integration test hit — silent 5-min hang)
    // nearly impossible. The fd path: stdin ignored, stdout+stderr to logFile.
    const logFilePath = join(cacheDir, "daemon.log");
    const { openSync } = await import("node:fs");
    // H1: rotate the daemon.log a single generation if it's over the size cap
    // BEFORE opening for append, so a daemon that never restarts for weeks does
    // not grow it without bound. Crash-safe: a rotate failure is swallowed inside
    // rotateLogIfOversized and we still open the (possibly oversized) log — a
    // rotation problem must never block daemon startup.
    try {
      const { rotateLogIfOversized } = await import("../engine/log.js");
      rotateLogIfOversized(logFilePath);
    } catch { /* import/rotate failure must not block spawn */ }
    const logFd = openSync(logFilePath, "a"); // append, create if missing
    log.info(`[daemon-spawn] spawning daemon from ${scriptPath} (logs → ${logFilePath})`);
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    closeSync(logFd);
    log.info(`[daemon-spawn] daemon spawned pid=${child.pid} — waiting for ${tcpMode ? `TCP ${tcpHost}:${tcpPort}` : "ready"}`);

    const deadline = Date.now() + readyTimeoutMs;
    const ok = await pollSocketReady(probe, deadline, log);
    if (!ok) {
      throw new Error(`daemon failed to become ready within ${readyTimeoutMs}ms`);
    }
    return endpoint(true);
  } finally {
    if (lockFd !== null) releaseSpawnLock(lockFd, lockPath);
  }
}
