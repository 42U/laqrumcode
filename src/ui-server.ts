/**
 * Read-only local web UI server (GH #15, v1).
 *
 * The daemon's primary HTTP API (src/http-api.ts) listens on a Unix socket a
 * browser cannot reach, so the UI gets its own dedicated loopback TCP listener.
 * It serves the built Preact app at /ui and a small READ-ONLY JSON API at
 * /api/ui/* that wraps SurrealStore reads — it never mutates the graph and
 * never binds anything but 127.0.0.1.
 *
 * Auth reuses the same secret as the hook API (src/http-api.ts authToken),
 * presented by the browser as an HttpOnly cookie set once via
 * /ui/auth?token=<token> (so the token never lingers in browser history).
 *
 * The server is inert until the frontend is built: if dist/ui/index.html is
 * absent it logs once and skips binding. Start is EADDRINUSE-tolerant so the
 * per-session mcp-client relay no-ops when the long-lived daemon already owns
 * the port.
 */
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { GlobalPluginState } from "./engine/state.js";
import { log } from "./engine/log.js";

let uiServer: HttpServer | null = null;

/** dist/ui/ at runtime (this module compiles to dist/ui-server.js). */
const UI_ASSET_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const COOKIE = "kongcode_ui";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Loopback-only UI port. Env override, else a UID-offset default that avoids
 *  cross-user collision (mirrors the managed-surreal port scheme) while staying
 *  clear of the 18765-range managed DB ports. */
export function uiPort(): number {
  const env = Number(process.env.KONGCODE_UI_PORT);
  if (Number.isFinite(env) && env > 0 && env < 65536) return Math.floor(env);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return 28900 + (uid % 10000);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function authed(req: IncomingMessage, token: string): boolean {
  // Cookie (browser) or Authorization: Bearer (curl/tests) — same secret.
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const presented = bearer || cookieToken(req);
  return !!presented && constantTimeEq(presented, token);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    // The UI is same-origin; deny embedding + sniffing defensively.
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(buf);
}

/** Resolve a URL path under the asset dir, rejecting traversal. Returns null on escape. */
function resolveAsset(urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/ui\/?/, "");
  const target = normalize(join(UI_ASSET_DIR, clean || "index.html"));
  // Must stay within UI_ASSET_DIR (normalize collapses ../).
  if (target !== UI_ASSET_DIR.replace(/\/$/, "") && !target.startsWith(UI_ASSET_DIR.endsWith(sep) ? UI_ASSET_DIR : UI_ASSET_DIR + sep)) {
    return null;
  }
  return target;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  let file = resolveAsset(urlPath);
  if (!file) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  // SPA fallback: unknown non-asset routes serve index.html.
  if (!existsSync(file)) {
    if (extname(file)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    file = join(UI_ASSET_DIR, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "content-length": data.length,
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Read error");
  }
}

// ── read-only data endpoints (wrap SurrealStore; never write) ────────────────

const NODE_DETAIL_TABLES = new Set(["concept", "memory", "core_memory"]);

/** Strip the huge embedding vector before returning any row to the browser. */
function lite<T extends Record<string, unknown>>(row: T): Omit<T, "embedding"> {
  const { embedding, ...rest } = row;
  void embedding;
  return rest;
}

async function dashboard(state: GlobalPluginState): Promise<unknown> {
  const tables = [
    "concept", "memory", "turn", "artifact", "skill",
    "core_memory", "retrieval_outcome", "pending_work", "session",
  ];
  const embeddable = ["concept", "memory", "turn", "artifact"];
  const counts: string[] = tables.map(t => `SELECT count() AS c FROM ${t} GROUP ALL`);
  const embedded: string[] = embeddable.map(t => `SELECT count() AS c FROM ${t} WHERE embedding != NONE GROUP ALL`);
  const results = await state.store.queryBatch<{ c: number }>([...counts, ...embedded]);
  const num = (r: { c: number }[][] | undefined, i: number): number =>
    Array.isArray(r?.[i]) && r![i][0] ? Number(r![i][0].c) : 0;
  const tableCounts: Record<string, number> = {};
  tables.forEach((t, i) => { tableCounts[t] = num(results, i); });
  const coverage: Record<string, { total: number; embedded: number }> = {};
  embeddable.forEach((t, i) => {
    coverage[t] = { total: tableCounts[t] ?? 0, embedded: num(results, tables.length + i) };
  });
  return {
    table_counts: tableCounts,
    embedding_coverage: coverage,
    daemon: { uptime_s: Math.round(process.uptime()), pid: process.pid },
  };
}

async function listMemories(state: GlobalPluginState, q: string, limit: number, offset: number): Promise<unknown> {
  const ql = q.toLowerCase();
  const [countRes, rowRes] = await state.store.queryBatch<unknown>([
    `SELECT count() AS c FROM memory WHERE $q = '' OR string::contains(string::lowercase(text), $q) GROUP ALL`,
    `SELECT meta::id(id) AS id, text, category, importance, (status ?? 'active') AS status, access_count, created_at, source
       FROM memory WHERE $q = '' OR string::contains(string::lowercase(text), $q)
       ORDER BY created_at DESC LIMIT $limit START $offset`,
  ], { q: ql, limit, offset });
  const total = Array.isArray(countRes) && countRes[0] ? Number((countRes[0] as { c: number }).c) : 0;
  return { total, limit, offset, rows: Array.isArray(rowRes) ? rowRes : [] };
}

async function listConcepts(state: GlobalPluginState, q: string, limit: number, offset: number): Promise<unknown> {
  const ql = q.toLowerCase();
  const [countRes, rowRes] = await state.store.queryBatch<unknown>([
    `SELECT count() AS c FROM concept WHERE $q = '' OR string::contains(string::lowercase(content), $q) GROUP ALL`,
    `SELECT meta::id(id) AS id, content, stability, confidence, access_count, created_at, source
       FROM concept WHERE $q = '' OR string::contains(string::lowercase(content), $q)
       ORDER BY created_at DESC LIMIT $limit START $offset`,
  ], { q: ql, limit, offset });
  const total = Array.isArray(countRes) && countRes[0] ? Number((countRes[0] as { c: number }).c) : 0;
  return { total, limit, offset, rows: Array.isArray(rowRes) ? rowRes : [] };
}

/** 1-hop concept neighborhood for the graph explorer. */
async function graphNeighborhood(state: GlobalPluginState, id: string): Promise<unknown> {
  // queryBatch (not queryMulti): queryMulti returns only the LAST flattened row,
  // which silently empties a multi-row SELECT. queryBatch returns one row array
  // per statement.
  const edgeRes = await state.store.queryBatch<{ rel: string; src: string; dst: string }>([
    `SELECT meta::tb(id) AS rel, meta::id(in) AS src, meta::id(out) AS dst
       FROM related_to, broader, narrower
       WHERE in = type::record('concept', $id) OR out = type::record('concept', $id)
       LIMIT 200`,
  ], { id });
  const edges = edgeRes[0] ?? [];
  const ids = new Set<string>([id]);
  for (const e of edges) { ids.add(e.src); ids.add(e.dst); }
  const nodeRes = await state.store.queryBatch<{ id: string; content: string; stability: number }>([
    `SELECT meta::id(id) AS id, content, stability FROM concept WHERE meta::id(id) IN $ids`,
  ], { ids: [...ids] });
  return { focus: id, nodes: nodeRes[0] ?? [], edges };
}

async function nodeDetail(state: GlobalPluginState, table: string, id: string): Promise<unknown> {
  if (!NODE_DETAIL_TABLES.has(table)) return null;
  const res = await state.store.queryBatch<Record<string, unknown>>([
    `SELECT * FROM type::record($table, $id)`,
  ], { table, id });
  const row = res[0]?.[0] ?? null;
  return row ? lite(row) : null;
}

// Exported for tests — test/ui-server.test.ts exercises the SQL against a live
// kong_test DB (the layer where the type::record + queryBatch bugs lived).
export { dashboard, listMemories, listConcepts, graphNeighborhood, nodeDetail };

async function handleApi(state: GlobalPluginState, url: URL, res: ServerResponse): Promise<void> {
  const p = url.pathname;
  const int = (name: string, def: number, max: number): number => {
    const v = Number(url.searchParams.get(name));
    return Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : def;
  };
  try {
    if (p === "/api/ui/dashboard") return sendJson(res, 200, await dashboard(state));
    if (p === "/api/ui/memories") {
      return sendJson(res, 200, await listMemories(state, url.searchParams.get("q") ?? "", int("limit", 50, 200), int("offset", 0, 1e7)));
    }
    if (p === "/api/ui/concepts") {
      return sendJson(res, 200, await listConcepts(state, url.searchParams.get("q") ?? "", int("limit", 50, 200), int("offset", 0, 1e7)));
    }
    if (p === "/api/ui/graph") {
      const id = url.searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "id required" });
      return sendJson(res, 200, await graphNeighborhood(state, id));
    }
    const m = /^\/api\/ui\/node\/([a-z_]+)\/(.+)$/.exec(p);
    if (m) {
      const detail = await nodeDetail(state, m[1], decodeURIComponent(m[2]));
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "not found" });
    }
    sendJson(res, 404, { error: "unknown endpoint" });
  } catch (e) {
    log.warn(`[ui-server] api error on ${p}: ${(e as Error).message}`);
    sendJson(res, 500, { error: "query failed" });
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start the loopback UI server. No-ops (logs once) when the frontend bundle is
 * absent, when KONGCODE_UI=0, or when the port is already bound by a sibling.
 */
export async function startUiServer(state: GlobalPluginState, authToken: string): Promise<void> {
  if (process.env.KONGCODE_UI === "0") return;
  if (uiServer) return;
  if (!existsSync(join(UI_ASSET_DIR, "index.html"))) {
    log.info("[ui-server] no built UI assets (dist/ui/index.html) — UI disabled; run `npm run build` to enable");
    return;
  }
  const port = uiPort();
  const srv = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    // Public: the one-time cookie-mint endpoint.
    if (url.pathname === "/ui/auth") {
      const token = url.searchParams.get("token") || "";
      if (!constantTimeEq(token, authToken)) {
        res.writeHead(401); res.end("bad token"); return;
      }
      res.writeHead(302, {
        "set-cookie": `${COOKIE}=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        location: "/ui/",
      });
      res.end(); return;
    }
    // Everything else requires the cookie/bearer.
    if (!authed(req, authToken)) {
      if (url.pathname.startsWith("/api/")) { sendJson(res, 401, { error: "unauthorized" }); return; }
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized — open kongcode via `node scripts/open-ui.mjs`."); return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end("read-only"); return; }
    if (url.pathname.startsWith("/api/ui/")) { void handleApi(state, url, res); return; }
    if (url.pathname === "/ui" || url.pathname.startsWith("/ui/")) { void serveStatic(res, url.pathname); return; }
    if (url.pathname === "/") { res.writeHead(302, { location: "/ui/" }); res.end(); return; }
    res.writeHead(404); res.end("Not found");
  });
  await new Promise<void>((resolve) => {
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.info(`[ui-server] port ${port} already bound (sibling owns the UI) — skipping`);
      } else {
        log.warn(`[ui-server] failed to bind ${port}: ${err.message}`);
      }
      resolve(); // never fatal to daemon startup
    });
    srv.listen(port, "127.0.0.1", () => {
      uiServer = srv;
      log.info(`[ui-server] read-only web UI on http://127.0.0.1:${port}/ui`);
      resolve();
    });
  });
}

export async function stopUiServer(): Promise<void> {
  if (!uiServer) return;
  await new Promise<void>((resolve) => uiServer!.close(() => resolve()));
  uiServer = null;
}
