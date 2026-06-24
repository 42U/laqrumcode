/**
 * ISMAR-GENT Orchestration Layer
 *
 * Pre/post processing pipeline between user input and agent.prompt().
 * Classifies intent, adapts agent configuration, records metrics.
 * Target: <25ms for non-trivial prompts, <1ms for simple ones.
 *
 * Ported from laqrumbrain — takes EmbeddingService + SurrealStore as params
 * instead of module-level singletons. Per-session state via SessionState.
 */
import type { IntentResult, ComplexityEstimate, ThinkingLevel } from "./intent.js";
import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore } from "./surreal.js";
import type { SessionState } from "./state.js";
export { type ThinkingLevel, type IntentCategory } from "./intent.js";
export interface AdaptiveConfig {
    thinkingLevel: ThinkingLevel;
    toolLimit: number;
    tokenBudget: number;
    retrievalShare?: number;
    skipRetrieval?: boolean;
    intent?: string;
    vectorSearchLimits: {
        turn: number;
        identity: number;
        concept: number;
        memory: number;
        artifact: number;
    };
}
export interface PreflightResult {
    intent: IntentResult;
    complexity: ComplexityEstimate;
    config: AdaptiveConfig;
    preflightMs: number;
    fastPath: boolean;
}
interface SteeringCandidate {
    type: "runaway" | "budget_warning" | "scope_drift";
    toolCall: number;
    detail: string;
}
export declare const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig;
export declare function preflight(input: string, session: SessionState, embeddings: EmbeddingService, retrievalBudgetTokens?: number, store?: SurrealStore): Promise<PreflightResult>;
/** Record a tool call for steering analysis. */
export declare function recordToolCall(session: SessionState, name: string, args?: string): void;
/** Record metrics to SurrealDB (non-blocking).
 *
 *  Sections that may be added here in the future (token recording, ACAN
 *  sample write, retrieval grade write) each get their own try/catch so a
 *  failure in one section doesn't silently swallow the whole metrics
 *  pipeline — the previous single-blanket catch would have hidden a metrics
 *  CREATE failure behind any earlier section's error. */
export declare function postflight(input: string, result: PreflightResult, actualToolCalls: number, actualTokensIn: number, actualTokensOut: number, turnDurationMs: number, session: SessionState, store: SurrealStore): Promise<void>;
export declare function getLastPreflightConfig(session: SessionState): AdaptiveConfig;
export declare function getSteeringCandidates(session: SessionState): SteeringCandidate[];
