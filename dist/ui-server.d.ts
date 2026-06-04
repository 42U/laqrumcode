import type { GlobalPluginState } from "./engine/state.js";
/** Loopback-only UI port. Env override, else a UID-offset default that avoids
 *  cross-user collision (mirrors the managed-surreal port scheme) while staying
 *  clear of the 18765-range managed DB ports. */
export declare function uiPort(): number;
declare function dashboard(state: GlobalPluginState): Promise<unknown>;
declare function listMemories(state: GlobalPluginState, q: string, limit: number, offset: number): Promise<unknown>;
declare function listConcepts(state: GlobalPluginState, q: string, limit: number, offset: number): Promise<unknown>;
/** 1-hop concept neighborhood for the graph explorer. */
declare function graphNeighborhood(state: GlobalPluginState, id: string): Promise<unknown>;
declare function nodeDetail(state: GlobalPluginState, table: string, id: string): Promise<unknown>;
export { dashboard, listMemories, listConcepts, graphNeighborhood, nodeDetail };
/**
 * Start the loopback UI server. No-ops (logs once) when the frontend bundle is
 * absent, when KONGCODE_UI=0, or when the port is already bound by a sibling.
 */
export declare function startUiServer(state: GlobalPluginState, authToken: string): Promise<void>;
export declare function stopUiServer(): Promise<void>;
