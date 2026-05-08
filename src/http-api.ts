/**
 * Internal HTTP API on Unix socket for hook communication.
 *
 * The MCP server is the long-lived daemon; hook scripts are ephemeral.
 * Hooks discover this server via the .kongcode.sock file and POST
 * Claude Code hook payloads. The server processes them using the
 * shared GlobalPluginState and returns hook response JSON.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { GlobalPluginState } from "./engine/state.js";
import { log } from "./engine/log.js";

let server: HttpServer | null = null;
let socketPath: string | null = null;
let portFilePath: string | null = null;
let authToken: string | null = null;
let authTokenPath: string | null = null;

/** Hook response format matching Claude Code's expected output.
 *
 * IMPORTANT: `additionalContext` must be inside `hookSpecificOutput` with a
 * matching `hookEventName` — Claude Code's Zod schema silently strips
 * unknown top-level keys. Top-level fields are only: continue,
 * suppressOutput, decision, reason, stopReason, systemMessage, hookSpecificOutput.
 *
 * PreToolUse blocking (0.7.47+) uses `hookSpecificOutput.permissionDecision`
 * and `permissionDecisionReason` — the documented modern contract. The older
 * top-level `decision: "approve" | "block"` is for Stop hooks.
 */
export interface HookResponse {
  continue?: boolean;
  suppressOutput?: boolean;
  /** Warning shown in UI — NOT sent to the model. */
  systemMessage?: string;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    /** PreToolUse only: gate the tool call. */
    permissionDecision?: "allow" | "deny" | "ask";
    /** PreToolUse only: reason text shown to the agent on deny. */
    permissionDecisionReason?: string;
    [key: string]: unknown;
  };
  /** For Stop hooks: approve or block the stop. */
  decision?: "approve" | "block";
  reason?: string;
}

/** Helper: wrap additionalContext in the hookSpecificOutput envelope Claude Code expects. */
export function makeHookOutput(eventName: string, additionalContext?: string, extra?: Record<string, unknown>): HookResponse {
  if (!additionalContext && !extra) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      ...(additionalContext ? { additionalContext } : {}),
      ...extra,
    },
  };
}

type HookHandler = (
  state: GlobalPluginState,
  payload: Record<string, unknown>,
) => Promise<HookResponse>;

// Hook handler registry — populated in later phases
const handlers = new Map<string, HookHandler>();

/** Register a hook handler for an event. */
export function registerHookHandler(event: string, handler: HookHandler): void {
  handlers.set(event, handler);
}

async function handleRequest(
  state: GlobalPluginState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Hook endpoints: POST /hook/<event-name>
  if (req.method === "POST" && req.url?.startsWith("/hook/")) {
    if (authToken) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (bearer !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    const event = req.url.slice("/hook/".length);

    // Read body (capped at 8 MB to prevent OOM from malicious payloads)
    const chunks: Buffer[] = [];
    let bodyLen = 0;
    const MAX_BODY = 8 * 1024 * 1024;
    for await (const chunk of req) {
      bodyLen += (chunk as Buffer).length;
      if (bodyLen > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      // Empty or invalid JSON — use empty payload
    }

    // Find handler
    const handler = handlers.get(event);
    if (!handler) {
      // No handler registered — pass through (allow)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    try {
      const response = await handler(state, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      log.error(`Hook handler error [${event}]:`, err);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}"); // Fail open
    }
    return;
  }

  // Unknown route
  res.writeHead(404);
  res.end("Not found");
}

/**
 * Remove `.kongcode-<pid>.sock` files in `dir` whose PID is no longer alive.
 * Skips ownPid and any PID that exists but we can't signal (EPERM).
 *
 * Also reaps live sibling MCPs by sending SIGTERM to their PIDs (default on).
 * The hook proxy routes to whichever per-PID socket has the newest mtime, so
 * older MCPs become unreachable after a Claude Code restart and just sit
 * holding memory until killed manually. Reaping closes that loop.
 *
 * Set `KONGCODE_KEEP_SIBLINGS=1` to opt out — required when running multiple
 * Claude Code windows simultaneously, since each window has its own MCP and
 * killing siblings would orphan the others. Single-window users (the common
 * case) want default-on behavior so no zombies linger.
 */
export function sweepStaleSockets(dir: string, ownPid: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const keepSiblings = process.env.KONGCODE_KEEP_SIBLINGS === "1";
  let removedFiles = 0;
  let reapedLive = 0;
  for (const name of entries) {
    const m = /^\.kongcode-(\d+)\.sock$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid === ownPid) continue;
    let alive = true;
    let foreign = false;
    try {
      process.kill(pid, 0);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      alive = code !== "ESRCH";
      foreign = code === "EPERM";
    }
    if (alive && !foreign && !keepSiblings) {
      try {
        process.kill(pid, "SIGTERM");
        reapedLive++;
        // Sibling will unlink its own socket on graceful shutdown; remove
        // here too in case SIGTERM handling is slow or absent.
        try { unlinkSync(`${dir}/${name}`); removedFiles++; } catch { /* ignore */ }
      } catch { /* ignore — race or perms */ }
      continue;
    }
    if (alive) continue;
    try {
      unlinkSync(`${dir}/${name}`);
      removedFiles++;
    } catch { /* ignore */ }
  }
  if (removedFiles > 0) log.info(`Swept ${removedFiles} stale kongcode socket file(s)`);
  if (reapedLive > 0) log.info(`Reaped ${reapedLive} sibling MCP process(es) (set KONGCODE_KEEP_SIBLINGS=1 to opt out)`);
}

/**
 * Start the internal HTTP API.
 * Listens on a Unix socket (preferred) or localhost:0 (fallback).
 */
export async function startHttpApi(
  state: GlobalPluginState,
  sock?: string,
  projectDir?: string,
): Promise<void> {
  const cacheDir = join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".kongcode", "cache");
  try {
    authToken = randomBytes(24).toString("hex");
    authTokenPath = join(cacheDir, "auth-token");
    writeFileSync(authTokenPath, authToken, { mode: 0o600 });
    log.info("[http-api] auth token written to", authTokenPath);
  } catch (err) {
    log.warn("[http-api] failed to write auth token, running unauthenticated:", err);
    authToken = null;
  }

  server = createServer((req, res) => {
    handleRequest(state, req, res).catch(err => {
      log.error("HTTP API error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal error");
      }
    });
  });

  if (sock) {
    // Sweep sibling sockets whose owning MCP process is dead. Uses
    // ESRCH-only detection so a foreign-owned (EPERM) PID is left alone.
    sweepStaleSockets(dirname(sock), process.pid);
    // Clean up our own stale socket file from a prior crash with same PID
    if (existsSync(sock)) {
      try { unlinkSync(sock); } catch { /* ignore */ }
    }
    socketPath = sock;
    try {
      await new Promise<void>((resolve, reject) => {
        server!.listen(sock, () => {
          log.info(`HTTP API listening on Unix socket: ${sock}`);
          resolve();
        });
        server!.on("error", reject);
      });
      return;
    } catch (err) {
      log.warn(`Unix socket failed, falling back to TCP:`, err);
      socketPath = null;
    }
  }

  // Fallback: random port — write port file so hook proxy can discover us
  await new Promise<void>((resolve, reject) => {
    server!.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") {
        log.info(`HTTP API listening on port ${addr.port}`);
        const dir = projectDir || process.cwd();
        portFilePath = `${dir}/.kongcode-port`;
        try {
          writeFileSync(portFilePath, String(addr.port));
          log.info(`Port file written: ${portFilePath}`);
        } catch (e) {
          log.warn(`Failed to write port file:`, e);
        }
      }
      resolve();
    });
    server!.on("error", reject);
  });
}

/** Stop the internal HTTP API and clean up socket/port files. */
export async function stopHttpApi(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (socketPath && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    socketPath = null;
  }
  if (portFilePath && existsSync(portFilePath)) {
    try { unlinkSync(portFilePath); } catch { /* ignore */ }
    portFilePath = null;
  }
  if (authTokenPath && existsSync(authTokenPath)) {
    try { unlinkSync(authTokenPath); } catch { /* ignore */ }
    authTokenPath = null;
    authToken = null;
  }
}
