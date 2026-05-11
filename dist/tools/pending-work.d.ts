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
