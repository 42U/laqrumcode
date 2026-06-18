/**
 * MCP tools for subagent-driven background processing.
 *
 * fetch_pending_work — Claims the next pending item and returns
 *   instructions + data for the subagent to process.
 * commit_work_results — Accepts the subagent's extraction output
 *   and persists it to SurrealDB via existing write functions.
 *
 * These tools replace the Anthropic SDK direct calls. The LLM
 * reasoning now happens in the subagent (Opus) itself, not in
 * a separate API call from the MCP server.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { type SurrealStore } from "../engine/surreal.js";
/**
 * Count pending_work rows that would ACTUALLY yield work if drained — the
 * "actionable" count behind the SessionStart / UserPromptSubmit "DRAIN NOW"
 * banners and the auto-drain spawn decision.
 *
 * The raw `status='pending' AND active` count over-reports: session-end
 * ALWAYS enqueues causal_graduate + soul_evolve/soul_generate regardless of
 * eligibility (session-end.ts), and 4 of 5 builders self-complete to empty
 * when ineligible (see buildWorkPayload below). Counting those raw produced
 * the "DRAIN NOW, N items" banner for a queue that drains to nothing — the
 * recurring empty-drain report (2026-06-18). This runs the SAME global
 * eligibility probes the builders use, so a type is only counted when it
 * would produce a real payload.
 *
 * MUST stay in sync with buildWorkPayload's self-completion conditions.
 * Internal queue-hygiene metrics (observability.ts buildup/aging, the
 * http-api health cache) deliberately keep the RAW count — they measure
 * queue depth / 7-day purge risk, not actionability.
 */
export declare function countActionablePendingWork(store: SurrealStore): Promise<number>;
export declare function handleFetchPendingWork(state: GlobalPluginState, _session: SessionState, _args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
export declare function handleCommitWorkResults(state: GlobalPluginState, _session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
export declare function isJunkExtractionText(s: unknown): boolean;
export declare function handleCreateKnowledgeGems(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
interface ExtractedSkill {
    name: string;
    description: string;
    preconditions?: string;
    steps: {
        tool: string;
        description: string;
    }[];
    postconditions?: string;
}
declare function parseSkillResult(results: unknown): ExtractedSkill | null;
declare function parseCausalGraduationResult(results: unknown): ExtractedSkill[];
declare function parseSoulResult(results: unknown): Record<string, any> | null;
export declare const __test__: {
    parseSkillResult: typeof parseSkillResult;
    parseCausalGraduationResult: typeof parseCausalGraduationResult;
    parseSoulResult: typeof parseSoulResult;
};
export {};
