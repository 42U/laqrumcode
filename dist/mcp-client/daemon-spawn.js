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
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { IpcClient } from "./ipc-client.js";
const DEFAULT_HOME = homedir();
/** Try to acquire an exclusive file lock to prevent concurrent daemon spawns.
 *  POSIX-only via O_EXCL — Windows clients run sequentially via Claude Code's
 *  plugin loader so the race window is small enough to ignore. Returns the fd
 *  to release later, or null if lock was already held (someone else spawning). */
function tryAcquireSpawnLock(lockPath) {
    try {
        return openSync(lockPath, "wx", 0o644);
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
        try {
            const holderPid = Number(readFileSync(lockPath, "utf-8").trim());
            if (!isPidAlive(holderPid)) {
                unlinkSync(lockPath);
                try {
                    return openSync(lockPath, "wx", 0o644);
                }
                catch { }
            }
        }
        catch { }
        return null;
    }
}
function releaseSpawnLock(fd, lockPath) {
    try {
        closeSync(fd);
    }
    catch { }
    try {
        unlinkSync(lockPath);
    }
    catch { }
}
function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
/** Read the daemon.pid file and return either the parsed JSON marker or a
 *  synthesized one for legacy bare-PID files. Returns null if unparseable. */
function readDaemonPidMarker(pidFile) {
    let raw;
    try {
        raw = readFileSync(pidFile, "utf-8").trim();
    }
    catch {
        return null;
    }
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.marker === "kongcode-daemon" && Number.isFinite(parsed.pid)) {
            return {
                marker: "kongcode-daemon",
                pid: parsed.pid,
                startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0,
                daemonVersion: typeof parsed.daemonVersion === "string" ? parsed.daemonVersion : "?",
            };
        }
        return null;
    }
    catch {
        // Legacy bare-PID format.
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
            return { marker: "kongcode-daemon", pid: n, startedAt: 0, daemonVersion: "?" };
        }
        return null;
    }
}
/** Same /proc/<pid>/cmdline check as the daemon itself uses — distinguishes
 *  a real daemon from a recycled PID. Returns null on non-Linux (can't
 *  verify; callers should treat as 'maybe valid'). */
function daemonCmdlineMatches(pid) {
    if (platform() !== "linux")
        return null;
    try {
        const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!raw)
            return false;
        const joined = raw.replace(/\0/g, " ").toLowerCase();
        if (!joined.includes("node"))
            return false;
        if (joined.includes("kongcode-daemon"))
            return true;
        if (joined.includes("daemon/index.js") || joined.includes("daemon/index.cjs"))
            return true;
        if (joined.includes("kongcode") && joined.includes("daemon"))
            return true;
        return false;
    }
    catch {
        return false;
    }
}
async function pingSocket(socketPath, timeoutMs = 1500) {
    const c = new IpcClient({ socketPath, defaultTimeoutMs: timeoutMs });
    try {
        await c.connect();
        await c.call("meta.health", {}, timeoutMs);
        c.close();
        return true;
    }
    catch {
        c.close();
        return false;
    }
}
async function pollSocketReady(socketPath, deadline, log) {
    while (Date.now() < deadline) {
        if (existsSync(socketPath)) {
            if (await pingSocket(socketPath, 1500))
                return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    log.warn(`[daemon-spawn] daemon never became ready within deadline`);
    return false;
}
/** Resolve the daemon script path from this file's compiled location. Mirrors
 *  bootstrap's resolvePluginDir trick — works whether running from dist/ or
 *  via direct node invocation. */
function resolveDaemonScript() {
    try {
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        // mcp-client/daemon-spawn.js → ../daemon/index.js
        return join(moduleDir, "..", "daemon", "index.js");
    }
    catch {
        // SEA fallback — daemon binary lives at <pluginDir>/bin/kongcode-daemon-<platform>
        return join(dirname(process.execPath), "..", "..", "dist", "daemon", "index.js");
    }
}
/** Get a daemon URL — either the existing one if alive, or spawn a new one. */
export async function ensureDaemon(opts = {}) {
    const log = opts.log ?? { info: () => { }, warn: () => { }, error: () => { } };
    // Resolve all paths absolutely. The shared/ipc-types constants may use
    // relative paths or $HOME placeholders depending on how they're defined;
    // we rebuild from cacheDir + DEFAULT_HOME to be format-agnostic.
    const socketPath = opts.socketPath ?? join(DEFAULT_HOME, ".kongcode-daemon.sock");
    const cacheDir = opts.cacheDir ?? join(DEFAULT_HOME, ".kongcode", "cache");
    const pidFile = join(cacheDir, "daemon.pid");
    const lockPath = join(cacheDir, "daemon.spawn.lock");
    const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000; // 5 min cold first run
    // Fast path: socket exists and pings successfully.
    if (existsSync(socketPath) && (await pingSocket(socketPath))) {
        return { socketPath, spawned: false };
    }
    // PID file probe with identity verification. If a live kongcode daemon
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
                log.info(`[daemon-spawn] live kongcode daemon detected at pid=${marker.pid} v${marker.daemonVersion} — waiting for socket instead of spawning`);
                const deadline = Date.now() + readyTimeoutMs;
                const ok = await pollSocketReady(socketPath, deadline, log);
                if (ok)
                    return { socketPath, spawned: false };
                log.warn(`[daemon-spawn] daemon pid=${marker.pid} alive but socket never became ready — proceeding to spawn fresh`);
            }
            else {
                log.warn(`[daemon-spawn] daemon.pid claims pid=${marker.pid} but cmdline doesn't match kongcode daemon (recycled PID) — proceeding to spawn fresh`);
            }
        }
    }
    // Acquire spawn lock; if held by another client racing us, wait for them
    // to finish (poll socket up to readyTimeoutMs).
    await mkdir(cacheDir, { recursive: true });
    let lockFd = tryAcquireSpawnLock(lockPath);
    if (lockFd === null) {
        log.info(`[daemon-spawn] another client holds spawn lock — waiting for daemon ready`);
        const deadline = Date.now() + readyTimeoutMs;
        const ok = await pollSocketReady(socketPath, deadline, log);
        if (ok)
            return { socketPath, spawned: false };
        // Lock holder died without spawning — remove stale lock and try again
        try {
            unlinkSync(lockPath);
        }
        catch { }
        lockFd = tryAcquireSpawnLock(lockPath);
        if (lockFd === null)
            throw new Error("daemon spawn lock contention — give up");
    }
    // Write our PID into the lock file for diagnostics
    try {
        writeSync(lockFd, String(process.pid));
    }
    catch { }
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
        const logFd = openSync(logFilePath, "a"); // append, create if missing
        log.info(`[daemon-spawn] spawning daemon from ${scriptPath} (logs → ${logFilePath})`);
        const child = spawn(process.execPath, [scriptPath], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: process.env,
        });
        child.unref();
        closeSync(logFd);
        log.info(`[daemon-spawn] daemon spawned pid=${child.pid} — waiting for ready`);
        const deadline = Date.now() + readyTimeoutMs;
        const ok = await pollSocketReady(socketPath, deadline, log);
        if (!ok) {
            throw new Error(`daemon failed to become ready within ${readyTimeoutMs}ms`);
        }
        return { socketPath, spawned: true };
    }
    finally {
        if (lockFd !== null)
            releaseSpawnLock(lockFd, lockPath);
    }
}
