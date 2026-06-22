import type { EmbeddingConfig } from "./config.js";
import type { ResourceProfile } from "./resource-tier.js";
import type { SurrealStore } from "./surreal.js";
import { IpcErrorCode } from "../shared/ipc-types.js";
/** M2(a): thrown by embed() when the bounded embed FIFO is full (backpressure).
 *  Carries a JSON-RPC error `code` in the RETRYABLE family (DAEMON_RESTARTING,
 *  -32002) so the daemon dispatcher maps it to a retryable wire error instead
 *  of the blanket HANDLER_ERROR — which is NON-retryable and would fail the
 *  user's turn outright. With a retryable code the mcp-client backs off and
 *  re-tries (the embedder is transiently underwater, not broken), absorbing the
 *  burst rather than surfacing it as a turn failure. `retryable` is a redundant
 *  boolean for any caller that prefers to duck-type the intent without coupling
 *  to the IpcErrorCode enum. */
export declare class EmbedBusyError extends Error {
    readonly code = IpcErrorCode.DAEMON_RESTARTING;
    readonly retryable = true;
    constructor(message: string);
}
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
    /** C3 (embed-integrity): record a maintenance_runs row so memory_health goes
     *  RED when the embed boundary rejects a wrong-dimension vector. Mirrors the
     *  E1 runJob audit shape ({job, status:'error', error}) so memory-health.ts
     *  surfaces it with no edits there. Fire-and-forget + store-guarded: a failure
     *  to record the audit must never mask or block the rejection that triggered
     *  it, and we never touch content (this is a telemetry write). */
    private recordDimGuardFailure;
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
