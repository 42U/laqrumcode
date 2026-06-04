#!/usr/bin/env node
/**
 * Open the kongcode read-only web UI (GH #15) in the default browser.
 *
 * Reads the daemon's auth token (~/.kongcode/cache/auth-token, written by
 * src/http-api.ts) and opens http://127.0.0.1:<port>/ui/auth?token=… which sets
 * an HttpOnly cookie and redirects to the app — so the token is presented once
 * and never lingers in the URL bar afterwards.
 *
 * Port: KONGCODE_UI_PORT, else the UID-offset default (matches uiPort() in
 * src/ui-server.ts). Loopback only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { platform, homedir } from "node:os";

const tokenPath = join(homedir(), ".kongcode", "cache", "auth-token");
let token;
try {
  token = readFileSync(tokenPath, "utf8").trim();
} catch {
  console.error(`No auth token at ${tokenPath}.`);
  console.error("The kongcode daemon writes it on start — trigger the daemon with any kongcode MCP call (e.g. memory_health), then retry.");
  process.exit(1);
}
if (!token) {
  console.error(`Auth token at ${tokenPath} is empty — is the daemon healthy?`);
  process.exit(1);
}

const envPort = Number(process.env.KONGCODE_UI_PORT);
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const port = Number.isFinite(envPort) && envPort > 0 ? Math.floor(envPort) : 28900 + (uid % 10000);
const url = `http://127.0.0.1:${port}/ui/auth?token=${token}`;

console.log(`kongcode web UI → http://127.0.0.1:${port}/ui`);
console.log("Opening your browser…  (if it doesn't open, paste this URL):");
console.log(`  ${url}`);

const opener =
  platform() === "darwin" ? "open" :
  platform() === "win32" ? "cmd" :
  "xdg-open";
const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
try {
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
} catch (e) {
  console.error("Could not auto-open a browser:", e?.message ?? e);
  console.error("Open the URL above manually.");
}
