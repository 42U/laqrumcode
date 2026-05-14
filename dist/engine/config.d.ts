export interface SurrealConfig {
    url: string;
    httpUrl: string;
    user: string;
    pass: string;
    ns: string;
    db: string;
}
export interface EmbeddingConfig {
    modelPath: string;
    dimensions: number;
}
export interface RerankerConfig {
    /** When false, recall skips the cross-encoder rerank stage entirely.
     *  Disabled via KONGCODE_RERANKER_DISABLED=1 — the model file (~606MB) is
     *  not downloaded, recall falls back to WMR/ACAN scoring. */
    enabled: boolean;
    /** Path to the bge-reranker-v2-m3 GGUF file. Default
     *  <cacheDir>/models/bge-reranker-v2-m3-Q8_0.gguf, override via
     *  RERANKER_MODEL_PATH env var. */
    modelPath: string;
}
export interface ThresholdConfig {
    /** Tokens accumulated before daemon flushes extraction (default: 4000) */
    daemonTokenThreshold: number;
    /** Cumulative tokens before mid-session cleanup fires (default: 25000) */
    midSessionCleanupThreshold: number;
    /** Per-extraction timeout in ms (default: 60000) */
    extractionTimeoutMs: number;
    /** Max pending thinking blocks kept in memory (default: 20) */
    maxPendingThinking: number;
    /** Retrieval outcome samples needed before ACAN training (default: 5000) */
    acanTrainingThreshold: number;
}
export interface PathsConfig {
    /** Where downloaded artifacts (SurrealDB binary, model) live. Default ~/.kongcode/cache. Survives plugin updates. */
    cacheDir: string;
    /** Where the bootstrapped SurrealDB child process stores its surrealkv data. Default ~/.kongcode/data. */
    dataDir: string;
    /** Path to the SurrealDB binary. Default <cacheDir>/surreal-<version>/<binaryName>. */
    surrealBinPath: string | null;
}
export interface KongCodeConfig {
    surreal: SurrealConfig;
    embedding: EmbeddingConfig;
    reranker: RerankerConfig;
    thresholds: ThresholdConfig;
    paths: PathsConfig;
}
/**
 * Parse config from environment variables and optional JSON config,
 * with sensible defaults.
 */
export declare function parsePluginConfig(raw?: Record<string, unknown>): KongCodeConfig;
