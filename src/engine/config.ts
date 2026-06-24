import { homedir } from "node:os";
import { join } from "node:path";

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
   *  Disabled via LAQRUMCODE_RERANKER_DISABLED=1 — the model file (~606MB) is
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
  /** Where downloaded artifacts (SurrealDB binary, model) live. Default ~/.laqrumcode/cache. Survives plugin updates. */
  cacheDir: string;
  /** Where the bootstrapped SurrealDB child process stores its surrealkv data. Default ~/.laqrumcode/data. */
  dataDir: string;
  /** Path to the SurrealDB binary. Default <cacheDir>/surreal-<version>/<binaryName>. */
  surrealBinPath: string | null;
}

export interface MemoryConfig {
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
export function parsePluginConfig(raw?: Record<string, unknown>): MemoryConfig {
  const surreal = (raw?.surreal ?? {}) as Record<string, unknown>;
  const embedding = (raw?.embedding ?? {}) as Record<string, unknown>;
  const thresholds = (raw?.thresholds ?? {}) as Record<string, unknown>;
  const paths = (raw?.paths ?? {}) as Record<string, unknown>;

  const cacheDir =
    (typeof paths.cacheDir === "string" && paths.cacheDir ? paths.cacheDir : null) ??
    (process.env.LAQRUMCODE_CACHE_DIR || null) ??
    join(homedir(), ".laqrumcode", "cache");
  const dataDir =
    (typeof paths.dataDir === "string" && paths.dataDir ? paths.dataDir : null) ??
    (process.env.LAQRUMCODE_DATA_DIR || null) ??
    join(homedir(), ".laqrumcode", "data");
  const surrealBinPath =
    (typeof paths.surrealBinPath === "string" && paths.surrealBinPath ? paths.surrealBinPath : null) ??
    (process.env.SURREAL_BIN_PATH || null);

  // Priority: plugin config > env vars > defaults
  // Use || (not ??) so empty strings from unresolved ${VAR} fall through to defaults
  const url =
    (typeof surreal.url === "string" && surreal.url ? surreal.url : null) ??
    (process.env.SURREAL_URL || null) ??
    "ws://localhost:8000/rpc";

  return {
    surreal: {
      url,
      get httpUrl() {
        const override = (typeof surreal.httpUrl === "string" && surreal.httpUrl ? surreal.httpUrl : null) ??
          (process.env.SURREAL_HTTP_URL || null);
        if (override) return override;
        return this.url
          .replace("ws://", "http://")
          .replace("wss://", "https://")
          .replace("/rpc", "/sql");
      },
      user: (typeof surreal.user === "string" && surreal.user ? surreal.user : null) ?? (process.env.SURREAL_USER || null) ?? "root",
      pass: (typeof surreal.pass === "string" && surreal.pass ? surreal.pass : null) ?? (process.env.SURREAL_PASS || null) ?? "root",
      ns: (typeof surreal.ns === "string" && surreal.ns ? surreal.ns : null) ?? (process.env.SURREAL_NS || null) ?? "laqrum",
      db: (typeof surreal.db === "string" && surreal.db ? surreal.db : null) ?? (process.env.SURREAL_DB || null) ?? "memory",
    },
    embedding: {
      modelPath:
        process.env.EMBED_MODEL_PATH ??
        (typeof embedding.modelPath === "string"
          ? embedding.modelPath
          : join(cacheDir, "models", "bge-m3-Q4_K_M.gguf")),
      dimensions:
        typeof embedding.dimensions === "number" ? embedding.dimensions : 1024,
    },
    reranker: (() => {
      const reranker = (raw?.reranker ?? {}) as Record<string, unknown>;
      const enabled = process.env.LAQRUMCODE_RERANKER_DISABLED !== "1";
      const modelPath =
        process.env.RERANKER_MODEL_PATH ??
        (typeof reranker.modelPath === "string"
          ? reranker.modelPath
          : join(cacheDir, "models", "bge-reranker-v2-m3-Q8_0.gguf"));
      return { enabled, modelPath };
    })(),
    thresholds: {
      daemonTokenThreshold:
        typeof thresholds.daemonTokenThreshold === "number" ? thresholds.daemonTokenThreshold : 4000,
      midSessionCleanupThreshold:
        typeof thresholds.midSessionCleanupThreshold === "number" ? thresholds.midSessionCleanupThreshold : 25_000,
      extractionTimeoutMs:
        typeof thresholds.extractionTimeoutMs === "number" ? thresholds.extractionTimeoutMs : 60_000,
      maxPendingThinking:
        typeof thresholds.maxPendingThinking === "number" ? thresholds.maxPendingThinking : 20,
      acanTrainingThreshold:
        typeof thresholds.acanTrainingThreshold === "number" ? thresholds.acanTrainingThreshold : 5000,
    },
    paths: {
      cacheDir,
      dataDir,
      surrealBinPath,
    },
  };
}
