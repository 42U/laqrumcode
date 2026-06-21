import type { EmbeddingConfig } from "./config.js";
import type { ResourceProfile } from "./resource-tier.js";
import type { SurrealStore } from "./surreal.js";
export interface EmbeddingDiagnostics {
    ready: boolean;
    modelPath: string;
    initStartedAt: number | null;
    initFinishedAt: number | null;
    initDurationMs: number | null;
    initError: {
        message: string;
        stack?: string;
    } | null;
    circuitBreakerOpen: boolean;
    consecutiveTimeouts: number;
    resourceTier: string | null;
    l2CacheEnabled: boolean;
    l2Hits: number;
    l2Misses: number;
    /** B17: live FIFO depth + high-water mark — a large value with timeouts
     *  means the embedder is underwater (queue wait), not slow per-item. */
    embedQueueDepth: number;
    embedQueueDepthMax: number;
}
export declare class EmbeddingService {
    private readonly config;
    private readonly resourceProfile?;
    private model;
    private ctx;
    private ready;
    private cache;
    private readonly maxCacheSize;
    private initStartedAt;
    private initFinishedAt;
    private initError;
    private consecutiveTimeouts;
    private readonly maxConsecutiveTimeouts;
    private breakerOpenedAt;
    private readonly embedTimeoutMs;
    private store;
    private modelVersion;
    private l2Hits;
    private l2Misses;
    constructor(config: EmbeddingConfig, resourceProfile?: ResourceProfile | undefined);
    setStore(store: SurrealStore): void;
    initialize(): Promise<boolean>;
    getDiagnostics(): EmbeddingDiagnostics;
    private textHash;
    private l2Get;
    private l2Put;
    /** B17 (T5, 2026-06-10): llama serializes embedding computation internally,
     *  so N concurrent embed() calls (embedBatch, parallel hook traffic) used to
     *  start N timeout clocks at SUBMIT time while computing one at a time —
     *  item k "timed out" after waiting k×(compute time) in line, on CPU tiers
     *  ratcheting consecutiveTimeouts to the breaker threshold without a single
     *  slow computation. The explicit FIFO below makes the serialization visible
     *  and starts each item's clock at DEQUEUE, so the timeout measures compute,
     *  not queue depth. */
    private embedQueue;
    private queueDraining;
    private queueDepthMax;
    /** K12 backpressure: hard cap on pending embed requests. llama serializes
     *  compute (one item at a time), so an unbounded push lets a burst of hook
     *  traffic / a wedged embedder grow the FIFO without limit — each entry
     *  pins its text + two closures, so the queue is the leak surface on a
     *  long-lived daemon. Past this depth embed() fast-fails with a retryable
     *  error instead of enqueueing. Override via KONGCODE_EMBED_QUEUE_MAX. */
    private readonly maxQueueDepth;
    embed(text: string): Promise<number[]>;
    private drainEmbedQueue;
    private computeAndSettle;
    embedBatch(texts: string[]): Promise<number[][]>;
    isAvailable(): boolean;
    dispose(): Promise<void>;
}
/**
 * Runtime probe for the embedding service — distinguishes "down" (init failed
 * or never ran), "degraded" (live but returns empty / errors on a one-token
 * embed), and "ok" (live and returning real vectors). Used by introspect and
 * memory-health to surface the actual init failure when `isAvailable=false`
 * rather than just reporting the flag.
 *
 * The shape is intentionally minimal — callers map this into their richer
 * report shapes locally so the two consumers can keep their own field names.
 */
export declare function probeEmbeddingService(embeddings: unknown): Promise<{
    status: "ok" | "degraded" | "down";
    message: string;
}>;
