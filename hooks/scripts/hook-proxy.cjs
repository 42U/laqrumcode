#!/usr/bin/env node
/**
 * Cross-platform laqrumcode hook proxy.
 *
 * Replacement for hook-proxy.sh that works on Windows without Git Bash.
 * Forwards Claude Code hook events to the MCP server's internal HTTP API
 * via Unix socket on POSIX, or TCP on Windows (the MCP exposes both).
 *
 * Usage: node hook-proxy.js <event-name>
 *   reads hook payload JSON from stdin, returns hook response JSON on stdout.
 *   fails open (returns "{}") if the MCP server is unreachable, so Claude
 *   Code's pipeline never gets blocked by a broken laqrumcode install.
 *
 * Discovery (mirrors hook-proxy.sh):
 *   1. Per-PID Unix sockets at $HOME/.laqrumcode-<pid>.sock — newest-first by
 *      mtime, skip stale (PID dead). POSIX-only.
 *   2. Legacy shared Unix socket at $HOME/.laqrumcode.sock. POSIX-only.
 *   3. TCP port read from $HOME/.laqrumcode-port. Cross-platform.
 *
 * Why Node and not bash: hooks.json invokes "bash ..." which fails silently
 * on Windows without Git Bash, leaving sessions/agents/projects/tasks empty.
 * Node is already a laqrumcode hard prereq (the MCP server runs on it), so
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
// Per-event response budgets (W2-01, 2026-06-10). Invariant: each value sits
// BELOW its hooks.json budget (so the proxy fails open instead of being
// SIGKILLed) and ABOVE the daemon's inner deadline for that event — the
// UserPromptSubmit transform may legitimately run to 45s in CPU mode
// (graph-context.ts resolveTransformTimeoutMs), so: 45s transform < 55s proxy
// < 60s hooks.json. The old flat 15s abandoned slow-but-healthy transforms,
// discarded the daemon's work, and (worse) mis-diagnosed slow as down.
const EVENT_TIMEOUTS_MS = {
  "user-prompt-submit": 55_000,
  "pre-compact": 55_000,
  "session-start": 25_000,
  "post-compact": 25_000,
  // 0.7.119: session-end is a fire-and-forget enqueue racing app exit — a
  // long wait there just widens the harness's "Hook cancelled" window. If
  // the daemon can't take the enqueue in 3s, deferred cleanup queues the
  // identical work at the next session-start.
  "session-end": 3_000,
};
const TIMEOUT_MS = EVENT_TIMEOUTS_MS[HOOK_EVENT] ?? 8_000;
const CACHE_DIR = path.join(HOME, ".laqrumcode", "cache");
const AUTH_TOKEN_PATH = path.join(CACHE_DIR, "auth-token");

function readAuthToken() {
  try { return fs.readFileSync(AUTH_TOKEN_PATH, "utf8").trim(); } catch { return null; }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      if (timer) clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", reject);
    timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), 3_000);
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

/** Find a per-PID laqrumcode socket whose owning process is still alive.
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
    .filter((e) => e.name.startsWith(".laqrumcode-") && e.name.endsWith(".sock"))
    .map((e) => {
      const full = path.join(HOME, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      const pidStr = e.name.slice(".laqrumcode-".length, -".sock".length);
      const pid = Number(pidStr);
      return { path: full, mtime, pid };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    if (isPidAlive(c.pid)) return c.path;
  }
  // Legacy shared socket fallback (pre-0.3.0 MCPs)
  const legacy = path.join(HOME, ".laqrumcode.sock");
  try { if (fs.statSync(legacy).isSocket()) return legacy; } catch {}
  return null;
}

/** Read the TCP port the MCP wrote on startup. Cross-platform. */
function readPort() {
  try {
    const raw = fs.readFileSync(path.join(HOME, ".laqrumcode-port"), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

function postJson({ socketPath, port, eventName, body }) {
  // Resolves { out, fail } where fail distinguishes the failure class:
  //   "connect" → socket refused/missing → the daemon is genuinely down
  //   "timeout" → the daemon accepted but is SLOW (e.g. a CPU-mode transform)
  // W2-01 (2026-06-10): the old single "" return conflated the two, so a
  // merely-slow daemon was diagnosed as down — a false "daemon unreachable"
  // warning was injected into the agent's context AND a doomed extra daemon
  // was forked, on every slow turn.
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
      res.on("end", () => resolve({ out: Buffer.concat(chunks).toString("utf8"), fail: null }));
      res.on("error", () => resolve({ out: "", fail: "connect" }));
    });
    req.on("error", () => resolve({ out: "", fail: "connect" })); // refused/missing socket
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ out: "", fail: "timeout" }); });
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
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    // daemon.pid has been a JSON marker since 0.7.65
    // ({"marker":"laqrumcode-daemon","pid":N,...}). Number(JSON) is NaN, which
    // made this guard dead for ~50 releases — every unreachable-socket hook
    // event forked a doomed daemon. Parse JSON-or-bare (mirrors
    // readDaemonPidMarker in src/mcp-client/daemon-spawn.ts).
    let pid = Number(raw);
    if (!Number.isFinite(pid)) {
      try { pid = Number(JSON.parse(raw).pid); } catch {}
    }
    if (isPidAlive(pid)) return; // daemon or spawner is alive, don't double-spawn
  } catch {}

  // Also check the MCP client's spawn lock — if held by a live process,
  // the MCP client is mid-spawn and will create the daemon.
  const lockPath = path.join(CACHE_DIR, "daemon.spawn.lock");
  try {
    const holderPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (isPidAlive(holderPid)) return;
  } catch {}

  // Spawn-attempt cooldown (W2-02, 2026-06-10): even with the pid-marker
  // parse fixed, a persistently boot-crashing daemon would be re-forked on
  // every hook event (several per turn). One attempt per 30s, cross-process
  // via a timestamp file — the auto-drain cooldown precedent.
  const attemptFile = path.join(CACHE_DIR, "daemon-spawn-attempt");
  try {
    const last = Number(fs.readFileSync(attemptFile, "utf8").trim());
    if (Number.isFinite(last) && Date.now() - last < 30_000) return;
  } catch {}
  try { fs.writeFileSync(attemptFile, String(Date.now())); } catch {}

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
        "[LaqrumCode] Remember your tier0 directives are important to the user and make you more helpful. " +
        "WARNING: laqrumcode daemon is unreachable — hooks, memory injection, and gates are inactive this turn. " +
        "The daemon has been respawned and should be available on the next turn. " +
        "If this persists, tell the user. " +
        "And remember to save knowledge gems along the way.",
    },
  });
}

(async () => {
  const payload = await readStdin();
  let body = payload || "{}";
  // Drain-session tag (2026-06-09 spawn-storm fix): auto-drain subprocesses are
  // spawned with LAQRUMCODE_DRAIN_SESSION=1 (buildDrainEnv). The hook payload's
  // session_id is Claude Code's own transcript id, which the daemon cannot
  // correlate with the spawn — so stamp the flag into the payload here, where
  // the child's env is visible. handleSessionEnd uses it to skip the drain
  // re-trigger (pre-fix, each failed drain's own SessionEnd respawned the next
  // one every ~25s, burning the full daily budget). Fail-open on parse errors.
  if (process.env.LAQRUMCODE_DRAIN_SESSION === "1") {
    try {
      const obj = JSON.parse(body);
      obj.laqrumcode_drain_session = true;
      body = JSON.stringify(obj);
    } catch { /* malformed stdin — pass through unchanged */ }
  }
  const sock = findUnixSocket();
  const port = sock ? null : readPort();
  if (!sock && !port) {
    trySpawnDaemon();
    process.stdout.write(daemonDownResponse(HOOK_EVENT));
    return;
  }
  const { out, fail } = await postJson({
    socketPath: sock,
    port,
    eventName: HOOK_EVENT,
    body,
  });
  if (!out) {
    if (fail === "timeout") {
      // Slow ≠ down (W2-01): the daemon is alive but exceeded this event's
      // budget. Fail open WITHOUT respawning and WITHOUT the daemon-down
      // warning — both were false alarms that compounded the slowness.
      process.stdout.write("{}");
      return;
    }
    // Connect-class failure — the daemon is genuinely unreachable.
    trySpawnDaemon();
    process.stdout.write(daemonDownResponse(HOOK_EVENT));
    return;
  }
  process.stdout.write(out);
})();
