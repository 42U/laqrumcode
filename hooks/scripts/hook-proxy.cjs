#!/usr/bin/env node
/**
 * Cross-platform kongcode hook proxy.
 *
 * Replacement for hook-proxy.sh that works on Windows without Git Bash.
 * Forwards Claude Code hook events to the MCP server's internal HTTP API
 * via Unix socket on POSIX, or TCP on Windows (the MCP exposes both).
 *
 * Usage: node hook-proxy.js <event-name>
 *   reads hook payload JSON from stdin, returns hook response JSON on stdout.
 *   fails open (returns "{}") if the MCP server is unreachable, so Claude
 *   Code's pipeline never gets blocked by a broken kongcode install.
 *
 * Discovery (mirrors hook-proxy.sh):
 *   1. Per-PID Unix sockets at $HOME/.kongcode-<pid>.sock — newest-first by
 *      mtime, skip stale (PID dead). POSIX-only.
 *   2. Legacy shared Unix socket at $HOME/.kongcode.sock. POSIX-only.
 *   3. TCP port read from $HOME/.kongcode-port. Cross-platform.
 *
 * Why Node and not bash: hooks.json invokes "bash ..." which fails silently
 * on Windows without Git Bash, leaving sessions/agents/projects/tasks empty.
 * Node is already a kongcode hard prereq (the MCP server runs on it), so
 * routing hooks through Node is the lowest-friction cross-platform fix.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

const HOOK_EVENT = process.argv[2];
if (!HOOK_EVENT) {
  process.stderr.write("hook-proxy: missing event name\n");
  process.exit(1);
}

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const TIMEOUT_MS = 15_000; // matches hooks.json UserPromptSubmit timeout (15s)
const CACHE_DIR = path.join(HOME, ".kongcode", "cache");
const DAEMON_SOCKET = path.join(HOME, ".kongcode-daemon.sock");
const AUTH_TOKEN_PATH = path.join(CACHE_DIR, "auth-token");

function readAuthToken() {
  try { return fs.readFileSync(AUTH_TOKEN_PATH, "utf8").trim(); } catch { return null; }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
    // Don't hang forever if stdin is somehow not closed — Claude Code always
    // closes it after writing the payload, but defensive timeout is cheap.
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), 1_000);
  });
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch (e) {
    // EPERM means the PID exists but we don't own it — still alive for our
    // purposes. ESRCH means the PID doesn't exist.
    return e.code === "EPERM";
  }
}

/** Find a per-PID kongcode socket whose owning process is still alive.
 *  Returns the socket path or null. POSIX only — Windows treats Unix
 *  sockets as files but Node's HTTP client over UDS works on Windows 10+
 *  via named pipes or AF_UNIX, which we don't rely on here. */
function findUnixSocket() {
  if (process.platform === "win32") return null;
  let entries;
  try {
    entries = fs.readdirSync(HOME, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.name.startsWith(".kongcode-") && e.name.endsWith(".sock"))
    .map((e) => {
      const full = path.join(HOME, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      const pidStr = e.name.slice(".kongcode-".length, -".sock".length);
      const pid = Number(pidStr);
      return { path: full, mtime, pid };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    if (isPidAlive(c.pid)) return c.path;
  }
  // Legacy shared socket fallback (pre-0.3.0 MCPs)
  const legacy = path.join(HOME, ".kongcode.sock");
  try { if (fs.statSync(legacy).isSocket()) return legacy; } catch {}
  return null;
}

/** Read the TCP port the MCP wrote on startup. Cross-platform. */
function readPort() {
  try {
    const raw = fs.readFileSync(path.join(HOME, ".kongcode-port"), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

function postJson({ socketPath, port, eventName, body }) {
  return new Promise((resolve) => {
    const token = readAuthToken();
    const hdrs = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (token) hdrs["Authorization"] = `Bearer ${token}`;
    const opts = socketPath
      ? { socketPath, path: `/hook/${eventName}`, method: "POST", headers: hdrs }
      : { host: "127.0.0.1", port, path: `/hook/${eventName}`, method: "POST", headers: hdrs };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => resolve(""));
    });
    req.on("error", () => resolve("")); // fail-open: empty body, parent treats as {}
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(""); });
    req.write(body);
    req.end();
  });
}

/** Spawn the daemon in the background if no socket/port is reachable.
 *  Fire-and-forget — this hook call returns a warning; the NEXT hook call
 *  will find the daemon alive. Checks the daemon PID file to avoid racing
 *  with the MCP client's ensureDaemon() or another hook-proxy invocation. */
function trySpawnDaemon() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

  // If a daemon PID file exists and that PID is alive, the daemon is either
  // running (socket not yet created) or being spawned by the MCP client.
  const pidFile = path.join(CACHE_DIR, "daemon.pid");
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (isPidAlive(pid)) return; // daemon or spawner is alive, don't double-spawn
  } catch {}

  // Also check the MCP client's spawn lock — if held by a live process,
  // the MCP client is mid-spawn and will create the daemon.
  const lockPath = path.join(CACHE_DIR, "daemon.spawn.lock");
  try {
    const holderPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (isPidAlive(holderPid)) return;
  } catch {}

  // Find daemon script relative to plugin root
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");
  const daemonScript = path.join(pluginRoot, "dist", "daemon", "index.js");
  if (!fs.existsSync(daemonScript)) return;

  const logFile = path.join(CACHE_DIR, "daemon.log");
  let logFd;
  try { logFd = fs.openSync(logFile, "a"); } catch { logFd = "ignore"; }

  try {
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    process.stderr.write(`hook-proxy: spawned daemon pid=${child.pid}\n`);
  } catch (e) {
    process.stderr.write(`hook-proxy: daemon spawn failed: ${e.message}\n`);
  }

  if (typeof logFd === "number") try { fs.closeSync(logFd); } catch {}
}

const EVENT_NAME_MAP = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  "stop": "Stop",
  "pre-compact": "PreCompact",
  "post-compact": "PostCompact",
  "session-end": "SessionEnd",
  "subagent-stop": "SubagentStop",
  "task-created": "TaskCreated",
};

/** Events whose hookSpecificOutput schema supports additionalContext.
 *  PreToolUse only supports permissionDecision/permissionDecisionReason.
 *  Stop only supports top-level decision/reason (too aggressive for a
 *  daemon-down warning). SessionEnd/SubagentStop have no context fields. */
const CONTEXT_EVENTS = new Set([
  "session-start", "user-prompt-submit", "post-tool-use",
  "pre-compact", "post-compact",
]);

/** Build a hook response that warns the agent the daemon is down.
 *  Only UserPromptSubmit and PostToolUse support additionalContext in
 *  hookSpecificOutput — other events (Stop, PreToolUse, etc.) get empty
 *  responses to avoid schema validation errors. */
function daemonDownResponse(eventName) {
  if (!CONTEXT_EVENTS.has(eventName)) return "{}";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EVENT_NAME_MAP[eventName] || eventName,
      additionalContext:
        "[KongCode] Remember your tier0 directives are important to the user and make you more helpful. " +
        "WARNING: kongcode daemon is unreachable — hooks, memory injection, and gates are inactive this turn. " +
        "The daemon has been respawned and should be available on the next turn. " +
        "If this persists, tell the user. " +
        "And remember to save knowledge gems along the way.",
    },
  });
}

(async () => {
  const payload = await readStdin();
  const sock = findUnixSocket();
  const port = sock ? null : readPort();
  if (!sock && !port) {
    trySpawnDaemon();
    process.stdout.write(daemonDownResponse(HOOK_EVENT));
    return;
  }
  const out = await postJson({
    socketPath: sock,
    port,
    eventName: HOOK_EVENT,
    body: payload || "{}",
  });
  if (!out) {
    // Socket/port existed but daemon didn't respond — also try respawn
    trySpawnDaemon();
    process.stdout.write(daemonDownResponse(HOOK_EVENT));
    return;
  }
  process.stdout.write(out);
})();
