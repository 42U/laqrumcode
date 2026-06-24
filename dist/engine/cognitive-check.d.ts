/**
 * Cognitive Check — Periodic reasoning over retrieved context.
 *
 * Fires every few turns to evaluate what was retrieved, produce behavioral
 * directives for the next turn, and grade retrieval quality with LLM-judged
 * relevance scores that feed back into ACAN training.
 *
 * Ported from laqrumbrain — per-session state via WeakMap, takes SurrealStore param.
 */
import type { SessionState } from "./state.js";
export interface CognitiveDirective {
    type: "repeat" | "continuation" | "contradiction" | "noise" | "insight";
    target: string;
    instruction: string;
    priority: "high" | "medium" | "low";
}
export interface RetrievalGrade {
    id: string;
    relevant: boolean;
    reason: string;
    score: number;
    learned: boolean;
    resolved: boolean;
}
export interface UserPreference {
    observation: string;
    confidence: "high" | "medium";
}
export interface CognitiveCheckResult {
    directives: CognitiveDirective[];
    grades: RetrievalGrade[];
    sessionContinuity: "continuation" | "repeat" | "new_topic" | "tangent";
    preferences: UserPreference[];
}
export interface CognitiveCheckInput {
    sessionId: string;
    userQuery: string;
    responseText: string;
    retrievedNodes: {
        id: string;
        text: string;
        score: number;
        table: string;
    }[];
    recentTurns: {
        role: string;
        text: string;
    }[];
}
/** Returns true on turn 2, then every 5 turns (2, 7, 12, 17...). False if in-flight or retrieval skipped. */
export declare function shouldRunCheck(turnCount: number, session: SessionState): boolean;
export declare function getPendingDirectives(session: SessionState): CognitiveDirective[];
export declare function clearPendingDirectives(session: SessionState): void;
export declare function getSessionContinuity(session: SessionState): string;
export declare function getSuppressedNodeIds(session: SessionState): ReadonlySet<string>;
/**
 * Cognitive check is now handled by the subagent-driven pending_work pipeline
 * (commit_work_results tool). The in-line runCognitiveCheck() function was
 * left as an empty no-op shim through the 0.4.x ports; this comment is the
 * gravestone. Pending-work scheduling lives in the daemon/MCP layer — search
 * for `cognitive_check` work_type and `commit_work_results`. The hook in
 * context-engine.ts (afterTurn) was removed because the no-op shim was
 * misleading: it suggested in-line cognitive checks were still firing.
 */
export declare function parseCheckResponse(text: string): CognitiveCheckResult | null;
