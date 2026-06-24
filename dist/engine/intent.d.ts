/**
 * Zero-shot intent classification via BGE-M3 embeddings.
 * No LLM call — embed user input, cosine similarity against prototypes.
 * ~25ms total (16ms embed + 5ms cosine + heuristics).
 *
 * Ported from laqrumbrain — takes EmbeddingService instead of module-level embed.
 */
import type { EmbeddingService } from "./embeddings.js";
export type IntentCategory = "simple-question" | "code-read" | "code-write" | "code-debug" | "deep-explore" | "reference-prior" | "meta-session" | "multi-step" | "continuation" | "unknown";
export interface IntentResult {
    category: IntentCategory;
    confidence: number;
    scores: {
        category: IntentCategory;
        score: number;
    }[];
}
export type ComplexityLevel = "trivial" | "simple" | "moderate" | "complex" | "deep";
export type ThinkingLevel = "none" | "low" | "medium" | "high";
export interface ComplexityEstimate {
    level: ComplexityLevel;
    estimatedToolCalls: number;
    suggestedThinking: ThinkingLevel;
}
export declare function classifyIntent(text: string, embeddings: EmbeddingService): Promise<IntentResult>;
export declare function estimateComplexity(text: string, intent: IntentResult): ComplexityEstimate;
