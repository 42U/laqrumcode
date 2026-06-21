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
import { type IncomingMessage, type ServerResponse } from "node:http";
import type { GlobalPluginState } from "./engine/state.js";
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
export declare const UI_PORT_BASE = 33000;
/** Loopback-only UI port. Env override, else a UID-offset default that avoids
 *  cross-user collision (mirrors the managed-surreal port scheme), disjoint from
 *  both the managed-SurrealDB window [18765,28764] AND the daemon IPC window. */
export declare function uiPort(): number;
declare function dashboard(state: GlobalPluginState): Promise<unknown>;
declare function listMemories(state: GlobalPluginState, q: string, limit: number, offset: number): Promise<unknown>;
declare function listConcepts(state: GlobalPluginState, q: string, limit: number, offset: number): Promise<unknown>;
/** 1-hop concept neighborhood for the graph explorer. */
declare function graphNeighborhood(state: GlobalPluginState, id: string): Promise<unknown>;
declare function nodeDetail(state: GlobalPluginState, table: string, id: string): Promise<unknown>;
/** Tier 0/1 core directives, active only. Small set — no pagination. */
declare function listDirectives(state: GlobalPluginState): Promise<unknown>;
/** Self-authored identity: active identity_chunk rows + the distinct version
 *  history (soul evolution). Embedding is projected out. */
declare function soulView(state: GlobalPluginState): Promise<unknown>;
declare function listSessions(state: GlobalPluginState, limit: number, offset: number): Promise<unknown>;
/** retrieval_outcome rows (ACAN training feed). query_embedding is deliberately
 *  NOT selected — it is a per-row vector the browser must never receive. */
declare function listRetrievalOutcomes(state: GlobalPluginState, limit: number, offset: number): Promise<unknown>;
/** Read-only retrieval sandbox: mirrors the recall tool's pipeline
 *  (embed → vectorSearch → graphExpand) WITHOUT its consumers' side effects —
 *  no access-count bump, no ACAN staging (those live in graph-context.ts, not
 *  here). Returns scored primary hits + graph neighbors, embeddings stripped,
 *  text truncated. */
declare function querySandbox(state: GlobalPluginState, query: string, limit: number): Promise<unknown>;
export { dashboard, listMemories, listConcepts, graphNeighborhood, nodeDetail, listDirectives, soulView, listSessions, listRetrievalOutcomes, querySandbox, };
/**
 * The request listener — exported so the HTTP security envelope (auth gate,
 * GET-only read-only enforcement, path-traversal rejection, /api routing) is
 * directly testable without binding the real UID-offset port. The URL base is
 * arbitrary: only pathname + search params are read.
 */
export declare function uiRequestHandler(state: GlobalPluginState, authToken: string): (req: IncomingMessage, res: ServerResponse) => void;
/**
 * Start the loopback UI server. No-ops (logs once) when the frontend bundle is
 * absent, when KONGCODE_UI=0, or when the port is already bound by a sibling.
 */
export declare function startUiServer(state: GlobalPluginState, authToken: string): Promise<void>;
export declare function stopUiServer(): Promise<void>;
