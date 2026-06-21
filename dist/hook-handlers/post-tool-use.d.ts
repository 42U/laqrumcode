/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training and tracks artifact mutations.
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
/** Shared hardened extension-path extractor (R4/R16). Tokenizes on whitespace
 *  and wrapping punctuation, length-caps each token, then anchor-tests it. This
 *  is the single ReDoS-safe primitive reused by post-tool-use AND pre-compact so
 *  the fix cannot drift back into a vulnerable inline regex. Exported for
 *  pre-compact.ts (key-file extraction over joined transcript turns). */
export declare function extractExtPaths(text: string, observe: (path: string) => void): void;
export declare function handlePostToolUse(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
