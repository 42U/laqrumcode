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
import { createServer, } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { log } from "./engine/log.js";
let uiServer = null;
/** dist/ui/ at runtime (this module compiles to dist/ui-server.js). */
const UI_ASSET_DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const COOKIE = "kongcode_ui";
const MIME = {
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
/** U1: base of the read-only UI port window. MUST stay >= the daemon IPC window
 *  ceiling (daemon-spawn.ts PORT_OFFSET_BASE + PORT_OFFSET_RANGE = 28765+4000 =
 *  32765) so the UI never collides with the load-bearing IPC port. Pre-U1 this
 *  was 28900, which after T3 raised the IPC window to [28765,32764] overlapped
 *  it → ~1/4000 TCP-transport users got a working daemon whose UI silently
 *  failed to bind. 33000 sits just above that ceiling. It IS in the low-ephemeral
 *  range, which is acceptable ONLY because the UI binds 127.0.0.1 and is
 *  NON-FATAL on EADDRINUSE (ui-server.ts:438-446) — unlike the IPC port, which
 *  must stay below the 32768 ephemeral floor. Guarded by
 *  test/fix-u1-ui-daemon-port-disjoint.test.ts. */
export const UI_PORT_BASE = 33000;
/** Loopback-only UI port. Env override, else a UID-offset default that avoids
 *  cross-user collision (mirrors the managed-surreal port scheme), disjoint from
 *  both the managed-SurrealDB window [18765,28764] AND the daemon IPC window. */
export function uiPort() {
    const env = Number(process.env.KONGCODE_UI_PORT);
    if (Number.isFinite(env) && env > 0 && env < 65536)
        return Math.floor(env);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return UI_PORT_BASE + (uid % 10000);
}
// ── helpers ──────────────────────────────────────────────────────────────────
function constantTimeEq(a, b) {
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cookieToken(req) {
    const raw = req.headers.cookie;
    if (!raw)
        return null;
    for (const part of raw.split(";")) {
        const i = part.indexOf("=");
        if (i < 0)
            continue;
        if (part.slice(0, i).trim() === COOKIE)
            return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
}
function authed(req, token) {
    // Cookie (browser) or Authorization: Bearer (curl/tests) — same secret.
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const presented = bearer || cookieToken(req);
    return !!presented && constantTimeEq(presented, token);
}
function sendJson(res, status, body) {
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
function resolveAsset(urlPath) {
    const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/ui\/?/, "");
    const target = normalize(join(UI_ASSET_DIR, clean || "index.html"));
    // Must stay within UI_ASSET_DIR (normalize collapses ../).
    if (target !== UI_ASSET_DIR.replace(/\/$/, "") && !target.startsWith(UI_ASSET_DIR.endsWith(sep) ? UI_ASSET_DIR : UI_ASSET_DIR + sep)) {
        return null;
    }
    return target;
}
async function serveStatic(res, urlPath) {
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
    }
    catch {
        res.writeHead(500);
        res.end("Read error");
    }
}
// ── read-only data endpoints (wrap SurrealStore; never write) ────────────────
const NODE_DETAIL_TABLES = new Set(["concept", "memory", "core_memory"]);
// K35: this read-only UI shares the daemon's local DB with the per-turn hot
// path. `string::contains` over text/content is an unindexed full-table scan,
// and the offset previously allowed deep pagination (START up to 1e7), which
// makes SurrealDB walk+discard that many rows per request. Two guards:
//   - MIN_SEARCH_LEN: ignore 1-char substring filters (scan-heavy, useless) —
//     fall back to the unfiltered, created_at-indexed listing.
//   - MAX_UI_OFFSET: cap START so a crafted ?offset= can't force a giant scan.
// Both keep the existing { total, limit, offset, rows } response shape.
const MIN_SEARCH_LEN = 2;
const MAX_UI_OFFSET = 10000;
/** Normalize a UI search term: lowercased, but blanked when below the min
 *  length so the SQL takes the no-filter ($q = '') branch. */
function uiSearchTerm(q) {
    const ql = q.trim().toLowerCase();
    return ql.length >= MIN_SEARCH_LEN ? ql : "";
}
/** Strip the huge embedding vector before returning any row to the browser. */
function lite(row) {
    const { embedding, ...rest } = row;
    void embedding;
    return rest;
}
async function dashboard(state) {
    const tables = [
        "concept", "memory", "turn", "artifact", "skill",
        "core_memory", "retrieval_outcome", "pending_work", "session",
    ];
    const embeddable = ["concept", "memory", "turn", "artifact"];
    const counts = tables.map(t => `SELECT count() AS c FROM ${t} GROUP ALL`);
    const embedded = embeddable.map(t => `SELECT count() AS c FROM ${t} WHERE embedding != NONE GROUP ALL`);
    const results = await state.store.queryBatch([...counts, ...embedded]);
    const num = (r, i) => Array.isArray(r?.[i]) && r[i][0] ? Number(r[i][0].c) : 0;
    const tableCounts = {};
    tables.forEach((t, i) => { tableCounts[t] = num(results, i); });
    const coverage = {};
    embeddable.forEach((t, i) => {
        coverage[t] = { total: tableCounts[t] ?? 0, embedded: num(results, tables.length + i) };
    });
    return {
        table_counts: tableCounts,
        embedding_coverage: coverage,
        daemon: { uptime_s: Math.round(process.uptime()), pid: process.pid },
    };
}
async function listMemories(state, q, limit, offset) {
    const ql = uiSearchTerm(q);
    const [countRes, rowRes] = await state.store.queryBatch([
        `SELECT count() AS c FROM memory WHERE $q = '' OR string::contains(string::lowercase(text), $q) GROUP ALL`,
        `SELECT meta::id(id) AS id, text, category, importance, (status ?? 'active') AS status, access_count, created_at, source
       FROM memory WHERE $q = '' OR string::contains(string::lowercase(text), $q)
       ORDER BY created_at DESC LIMIT $limit START $offset`,
    ], { q: ql, limit, offset });
    const total = Array.isArray(countRes) && countRes[0] ? Number(countRes[0].c) : 0;
    return { total, limit, offset, rows: Array.isArray(rowRes) ? rowRes : [] };
}
async function listConcepts(state, q, limit, offset) {
    const ql = uiSearchTerm(q);
    const [countRes, rowRes] = await state.store.queryBatch([
        `SELECT count() AS c FROM concept WHERE $q = '' OR string::contains(string::lowercase(content), $q) GROUP ALL`,
        `SELECT meta::id(id) AS id, content, stability, confidence, access_count, created_at, source
       FROM concept WHERE $q = '' OR string::contains(string::lowercase(content), $q)
       ORDER BY created_at DESC LIMIT $limit START $offset`,
    ], { q: ql, limit, offset });
    const total = Array.isArray(countRes) && countRes[0] ? Number(countRes[0].c) : 0;
    return { total, limit, offset, rows: Array.isArray(rowRes) ? rowRes : [] };
}
/** 1-hop concept neighborhood for the graph explorer. */
async function graphNeighborhood(state, id) {
    // queryBatch (not queryMulti): queryMulti returns only the LAST flattened row,
    // which silently empties a multi-row SELECT. queryBatch returns one row array
    // per statement.
    const edgeRes = await state.store.queryBatch([
        `SELECT meta::tb(id) AS rel, meta::id(in) AS src, meta::id(out) AS dst
       FROM related_to, broader, narrower
       WHERE in = type::record('concept', $id) OR out = type::record('concept', $id)
       LIMIT 200`,
    ], { id });
    const edges = edgeRes[0] ?? [];
    const ids = new Set([id]);
    for (const e of edges) {
        ids.add(e.src);
        ids.add(e.dst);
    }
    const nodeRes = await state.store.queryBatch([
        `SELECT meta::id(id) AS id, content, stability FROM concept WHERE meta::id(id) IN $ids`,
    ], { ids: [...ids] });
    return { focus: id, nodes: nodeRes[0] ?? [], edges };
}
async function nodeDetail(state, table, id) {
    if (!NODE_DETAIL_TABLES.has(table))
        return null;
    const res = await state.store.queryBatch([
        `SELECT * FROM type::record($table, $id)`,
    ], { table, id });
    const row = res[0]?.[0] ?? null;
    return row ? lite(row) : null;
}
// ── v2 read-only views (GH #15): directives, soul, sessions, retrieval, query ─
// All use explicit column projection (never SELECT *) so embedding / query_embedding
// vectors and any future sensitive columns are never shipped to the browser.
/** Tier 0/1 core directives, active only. Small set — no pagination. */
async function listDirectives(state) {
    const res = await state.store.queryBatch([
        `SELECT meta::id(id) AS id, tier, category, priority, text, (active ?? true) AS active, created_at, updated_at
       FROM core_memory WHERE (active ?? true) = true
       ORDER BY tier ASC, priority DESC, created_at ASC`,
    ]);
    return { rows: res[0] ?? [] };
}
/** Self-authored identity: active identity_chunk rows + the distinct version
 *  history (soul evolution). Embedding is projected out. */
async function soulView(state) {
    const [chunkRes, verRes] = await state.store.queryBatch([
        `SELECT meta::id(id) AS id, source, chunk_index, text, importance, identity_version, (active ?? true) AS active
       FROM identity_chunk WHERE (active ?? true) = true
       ORDER BY source ASC, chunk_index ASC`,
        `SELECT identity_version, count() AS chunks FROM identity_chunk
       WHERE (active ?? true) = true AND identity_version != NONE
       GROUP BY identity_version`,
    ]);
    return { chunks: chunkRes ?? [], versions: verRes ?? [] };
}
async function listSessions(state, limit, offset) {
    const [countRes, rowRes] = await state.store.queryBatch([
        `SELECT count() AS c FROM session GROUP ALL`,
        `SELECT meta::id(id) AS id, kc_session_id, agent_id, started_at, ended_at, last_active,
            turn_count, total_input_tokens, total_output_tokens
       FROM session ORDER BY started_at DESC LIMIT $limit START $offset`,
    ], { limit, offset });
    const total = Array.isArray(countRes) && countRes[0] ? Number(countRes[0].c) : 0;
    return { total, limit, offset, rows: Array.isArray(rowRes) ? rowRes : [] };
}
/** retrieval_outcome rows (ACAN training feed). query_embedding is deliberately
 *  NOT selected — it is a per-row vector the browser must never receive. */
async function listRetrievalOutcomes(state, limit, offset) {
    const [countRes, rowRes] = await state.store.queryBatch([
        `SELECT count() AS c FROM retrieval_outcome GROUP ALL`,
        `SELECT meta::id(id) AS id, memory_table, memory_id, retrieval_score, utilization, recency,
            importance, access_count, was_neighbor, context_tokens, session_id, turn_id, created_at
       FROM retrieval_outcome ORDER BY created_at DESC LIMIT $limit START $offset`,
    ], { limit, offset });
    const total = Array.isArray(countRes) && countRes[0] ? Number(countRes[0].c) : 0;
    return { total, limit, offset, rows: Array.isArray(rowRes) ? rowRes : [] };
}
/** Read-only retrieval sandbox: mirrors the recall tool's pipeline
 *  (embed → vectorSearch → graphExpand) WITHOUT its consumers' side effects —
 *  no access-count bump, no ACAN staging (those live in graph-context.ts, not
 *  here). Returns scored primary hits + graph neighbors, embeddings stripped,
 *  text truncated. */
async function querySandbox(state, query, limit) {
    const { store, embeddings } = state;
    if (!query.trim())
        return { query, available: true, primary: [], neighbors: [] };
    if (!embeddings.isAvailable() || !store.isAvailable()) {
        return { query, available: false, primary: [], neighbors: [] };
    }
    const max = Math.min(Math.max(limit, 1), 15);
    const queryVec = await embeddings.embed(query);
    const limits = { turn: max, identity: 0, concept: max, memory: max, artifact: max };
    const results = await store.vectorSearch(queryVec, "ui-query-sandbox", limits);
    const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const primary = sorted.slice(0, max);
    const topIds = primary.slice(0, 8).map((r) => r.id);
    let neighbors = [];
    if (topIds.length > 0) {
        try {
            const expanded = await store.graphExpand(topIds, queryVec);
            const seen = new Set(results.map((r) => r.id));
            neighbors = expanded.filter((n) => !seen.has(n.id)).slice(0, 8);
        }
        catch { /* graph expansion is best-effort */ }
    }
    const shape = (r) => ({
        id: r.id, table: r.table ?? "?", role: r.role,
        score: typeof r.score === "number" ? r.score : null,
        timestamp: r.timestamp ?? null,
        text: (r.text ?? "").slice(0, 320),
    });
    return { query, available: true, primary: primary.map(shape), neighbors: neighbors.map(shape) };
}
// Exported for tests — test/ui-server.test.ts exercises the SQL against a live
// kong_test DB (the layer where the type::record + queryBatch bugs lived).
export { dashboard, listMemories, listConcepts, graphNeighborhood, nodeDetail, listDirectives, soulView, listSessions, listRetrievalOutcomes, querySandbox, };
async function handleApi(state, url, res) {
    const p = url.pathname;
    const int = (name, def, max) => {
        const v = Number(url.searchParams.get(name));
        return Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : def;
    };
    try {
        if (p === "/api/ui/dashboard")
            return sendJson(res, 200, await dashboard(state));
        if (p === "/api/ui/memories") {
            return sendJson(res, 200, await listMemories(state, url.searchParams.get("q") ?? "", int("limit", 50, 200), int("offset", 0, MAX_UI_OFFSET)));
        }
        if (p === "/api/ui/concepts") {
            return sendJson(res, 200, await listConcepts(state, url.searchParams.get("q") ?? "", int("limit", 50, 200), int("offset", 0, MAX_UI_OFFSET)));
        }
        if (p === "/api/ui/graph") {
            const id = url.searchParams.get("id");
            if (!id)
                return sendJson(res, 400, { error: "id required" });
            return sendJson(res, 200, await graphNeighborhood(state, id));
        }
        if (p === "/api/ui/directives")
            return sendJson(res, 200, await listDirectives(state));
        if (p === "/api/ui/soul")
            return sendJson(res, 200, await soulView(state));
        if (p === "/api/ui/sessions") {
            return sendJson(res, 200, await listSessions(state, int("limit", 50, 200), int("offset", 0, MAX_UI_OFFSET)));
        }
        if (p === "/api/ui/retrieval-outcomes") {
            return sendJson(res, 200, await listRetrievalOutcomes(state, int("limit", 50, 200), int("offset", 0, MAX_UI_OFFSET)));
        }
        if (p === "/api/ui/query") {
            return sendJson(res, 200, await querySandbox(state, url.searchParams.get("q") ?? "", int("limit", 8, 15)));
        }
        const m = /^\/api\/ui\/node\/([a-z_]+)\/(.+)$/.exec(p);
        if (m) {
            const detail = await nodeDetail(state, m[1], decodeURIComponent(m[2]));
            return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "not found" });
        }
        sendJson(res, 404, { error: "unknown endpoint" });
    }
    catch (e) {
        log.warn(`[ui-server] api error on ${p}: ${e.message}`);
        sendJson(res, 500, { error: "query failed" });
    }
}
// ── lifecycle ────────────────────────────────────────────────────────────────
/**
 * The request listener — exported so the HTTP security envelope (auth gate,
 * GET-only read-only enforcement, path-traversal rejection, /api routing) is
 * directly testable without binding the real UID-offset port. The URL base is
 * arbitrary: only pathname + search params are read.
 */
export function uiRequestHandler(state, authToken) {
    return (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        // Public: the one-time cookie-mint endpoint.
        if (url.pathname === "/ui/auth") {
            const token = url.searchParams.get("token") || "";
            if (!constantTimeEq(token, authToken)) {
                res.writeHead(401);
                res.end("bad token");
                return;
            }
            res.writeHead(302, {
                "set-cookie": `${COOKIE}=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
                location: "/ui/",
            });
            res.end();
            return;
        }
        // Everything else requires the cookie/bearer.
        if (!authed(req, authToken)) {
            if (url.pathname.startsWith("/api/")) {
                sendJson(res, 401, { error: "unauthorized" });
                return;
            }
            res.writeHead(401, { "content-type": "text/plain" });
            res.end("Unauthorized — open kongcode via `node scripts/open-ui.mjs`.");
            return;
        }
        if (req.method !== "GET") {
            res.writeHead(405);
            res.end("read-only");
            return;
        }
        if (url.pathname.startsWith("/api/ui/")) {
            void handleApi(state, url, res);
            return;
        }
        if (url.pathname === "/ui" || url.pathname.startsWith("/ui/")) {
            void serveStatic(res, url.pathname);
            return;
        }
        if (url.pathname === "/") {
            res.writeHead(302, { location: "/ui/" });
            res.end();
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    };
}
/**
 * Start the loopback UI server. No-ops (logs once) when the frontend bundle is
 * absent, when KONGCODE_UI=0, or when the port is already bound by a sibling.
 */
export async function startUiServer(state, authToken) {
    if (process.env.KONGCODE_UI === "0")
        return;
    if (uiServer)
        return;
    if (!existsSync(join(UI_ASSET_DIR, "index.html"))) {
        log.info("[ui-server] no built UI assets (dist/ui/index.html) — UI disabled; run `npm run build` to enable");
        return;
    }
    const port = uiPort();
    const srv = createServer(uiRequestHandler(state, authToken));
    await new Promise((resolve) => {
        srv.once("error", (err) => {
            if (err.code === "EADDRINUSE") {
                log.info(`[ui-server] port ${port} already bound (sibling owns the UI) — skipping`);
            }
            else {
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
export async function stopUiServer() {
    if (!uiServer)
        return;
    await new Promise((resolve) => uiServer.close(() => resolve()));
    uiServer = null;
}
