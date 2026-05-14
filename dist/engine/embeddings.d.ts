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
    embed(text: string): Promise<number[]>;
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
