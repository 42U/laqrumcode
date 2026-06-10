/**
 * Graph-based context transformation for KongCode.
 *
 * Core retrieval pipeline: vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format.
 */
import type { AgentMessage } from "./types.js";
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import type { SessionState } from "./state.js";
import type { ResourceProfile } from "./resource-tier.js";
export declare function configureReranker(modelPath: string, profile?: ResourceProfile): void;
export declare function initReranker(modelPath: string): Promise<void>;
export declare function disposeReranker(): Promise<void>;
export declare function isRerankerActive(): boolean;
export declare function crossEncoderScorePairs(anchor: string, docs: string[]): Promise<number[] | null>;
/** 0.7.28: classify a cross-encoder sigmoid score [0,1] into a salience band.
 *  Per GroGU (arxiv 2601.23129), raw scores are weakly predictive of LLM
 *  grounding utility, but cross-encoder calibrated probabilities at >0.7
 *  are reliable signal. Bands give the model a coarse anchor that survives
 *  embedder swaps and per-query distribution variance. */
export type SalienceBand = "load-bearing" | "supporting" | "background";
export declare const BAND_LOAD_BEARING_MIN = 0.7;
export declare const BAND_SUPPORTING_MIN = 0.3;
export declare const BAND_DROP_BELOW = 0.15;
export declare function bandFor(crossScore: number): SalienceBand;
/** 0.7.35: distribution-derived bands when the cross-encoder is offline.
 *  Computes quartiles within the current batch and assigns top quartile to
 *  load-bearing, middle two to supporting, bottom quartile to background.
 *  Only used when no item has a `band` set (rerank skipped or model
 *  failed to load). The thresholds aren't calibrated, so the bands carry
 *  weaker semantics than the cross-encoder version — but they're still
 *  better than the noisy `(relevance: N%)` for giving the model a coarse
 *  anchor. Mutates items in place. */
export declare function applyDistributionBands<T extends {
    finalScore?: number;
    band?: SalienceBand;
}>(items: T[]): void;
/** @internal Exported for testing. */
export interface Budgets {
    conversation: number;
    retrieval: number;
    core: number;
    toolHistory: number;
    maxContextItems: number;
}
/** Split the context window into 4 budgets: conversation, retrieval, core memory, and tool history. @internal */
export declare function calcBudgets(contextWindow: number): Budgets;
export interface ContextStats {
    fullHistoryTokens: number;
    sentTokens: number;
    savedTokens: number;
    reductionPct: number;
    graphNodes: number;
    neighborNodes: number;
    recentTurns: number;
    mode: "graph" | "recency-only" | "passthrough";
    prefetchHit: boolean;
}
export declare function formatRelativeTime(ts: string): string;
/** Dot-product cosine similarity between two equal-length vectors. Returns 0 if either has zero magnitude. */
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function expandVagueQuery(query: string, session?: SessionState): string;
export interface GraphTransformParams {
    messages: AgentMessage[];
    session: SessionState;
    store: SurrealStore;
    embeddings: EmbeddingService;
    contextWindow?: number;
    signal?: AbortSignal;
}
export interface GraphTransformResult {
    messages: AgentMessage[];
    stats: ContextStats;
    /** Static content for the system prompt — benefits from API prefix caching (10% cost). */
    systemPromptSection?: string;
}
export declare function recordTransformOutcome(ok: boolean): void;
export declare function resetTransformErrorRate(): void;
export declare function getTransformErrorRate(): {
    total: number;
    failures: number;
    rate: number;
};
/** Transform deadline: env override, else a CPU-aware default. The original
 *  fixed 15s was tuned for GPU-era embed+rerank latency; the 2026-06-04
 *  switch of the daemon to CPU-only mode tripped it constantly (daemon.log:
 *  "graphTransformContext timed out" spam → raw-message fallback on every
 *  affected prompt). KONGCODE_NO_GPU=1 is set by gpu-pin.ts at daemon startup
 *  when CPU mode is configured, so the default self-adjusts. Exported for
 *  tests. Resolved per call (not at import) so it sees the post-pin env. */
export declare function resolveTransformTimeoutMs(env?: NodeJS.ProcessEnv): number;
export declare function graphTransformContext(params: GraphTransformParams): Promise<GraphTransformResult>;
