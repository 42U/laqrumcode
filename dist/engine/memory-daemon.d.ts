/**
 * Memory Daemon — extraction logic for incremental knowledge extraction.
 *
 * Contains the prompt building, transcript formatting, and DB write logic
 * used by the daemon manager to extract 9 knowledge types from conversation
 * turns: causal chains, monologue traces, resolved memories, concepts,
 * corrections, preferences, artifacts, decisions, skills.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */
import type { TurnData, PriorExtractions } from "./daemon-types.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
export declare function buildSystemPrompt(hasThinking: boolean, hasRetrievedMemories: boolean, prior: PriorExtractions): string;
export declare function buildCoalescedPrompt(hasThinking: boolean, hasRetrievedMemories: boolean, prior: PriorExtractions, includeHandoff: boolean, includeReflection: boolean): string;
export declare function buildTranscript(turns: TurnData[]): string;
export interface ExtractionCounts {
    causal: number;
    monologue: number;
    resolved: number;
    concept: number;
    correction: number;
    preference: number;
    artifact: number;
    decision: number;
    skill: number;
}
export declare function writeExtractionResults(result: Record<string, any>, sessionId: string, store: SurrealStore, embeddings: EmbeddingService, priorState: PriorExtractions, taskId?: string, projectId?: string, turns?: TurnData[]): Promise<ExtractionCounts>;
