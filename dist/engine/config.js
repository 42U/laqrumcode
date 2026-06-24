import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Parse config from environment variables and optional JSON config,
 * with sensible defaults.
 */
export function parsePluginConfig(raw) {
    const surreal = (raw?.surreal ?? {});
    const embedding = (raw?.embedding ?? {});
    const thresholds = (raw?.thresholds ?? {});
    const paths = (raw?.paths ?? {});
    const cacheDir = (typeof paths.cacheDir === "string" && paths.cacheDir ? paths.cacheDir : null) ??
        (process.env.LAQRUMCODE_CACHE_DIR || null) ??
        join(homedir(), ".laqrumcode", "cache");
    const dataDir = (typeof paths.dataDir === "string" && paths.dataDir ? paths.dataDir : null) ??
        (process.env.LAQRUMCODE_DATA_DIR || null) ??
        join(homedir(), ".laqrumcode", "data");
    const surrealBinPath = (typeof paths.surrealBinPath === "string" && paths.surrealBinPath ? paths.surrealBinPath : null) ??
        (process.env.SURREAL_BIN_PATH || null);
    // Priority: plugin config > env vars > defaults
    // Use || (not ??) so empty strings from unresolved ${VAR} fall through to defaults
    const url = (typeof surreal.url === "string" && surreal.url ? surreal.url : null) ??
        (process.env.SURREAL_URL || null) ??
        "ws://localhost:8000/rpc";
    return {
        surreal: {
            url,
            get httpUrl() {
                const override = (typeof surreal.httpUrl === "string" && surreal.httpUrl ? surreal.httpUrl : null) ??
                    (process.env.SURREAL_HTTP_URL || null);
                if (override)
                    return override;
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
            modelPath: process.env.EMBED_MODEL_PATH ??
                (typeof embedding.modelPath === "string"
                    ? embedding.modelPath
                    : join(cacheDir, "models", "bge-m3-Q4_K_M.gguf")),
            dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : 1024,
        },
        reranker: (() => {
            const reranker = (raw?.reranker ?? {});
            const enabled = process.env.LAQRUMCODE_RERANKER_DISABLED !== "1";
            const modelPath = process.env.RERANKER_MODEL_PATH ??
                (typeof reranker.modelPath === "string"
                    ? reranker.modelPath
                    : join(cacheDir, "models", "bge-reranker-v2-m3-Q8_0.gguf"));
            return { enabled, modelPath };
        })(),
        thresholds: {
            daemonTokenThreshold: typeof thresholds.daemonTokenThreshold === "number" ? thresholds.daemonTokenThreshold : 4000,
            midSessionCleanupThreshold: typeof thresholds.midSessionCleanupThreshold === "number" ? thresholds.midSessionCleanupThreshold : 25_000,
            extractionTimeoutMs: typeof thresholds.extractionTimeoutMs === "number" ? thresholds.extractionTimeoutMs : 60_000,
            maxPendingThinking: typeof thresholds.maxPendingThinking === "number" ? thresholds.maxPendingThinking : 20,
            acanTrainingThreshold: typeof thresholds.acanTrainingThreshold === "number" ? thresholds.acanTrainingThreshold : 5000,
        },
        paths: {
            cacheDir,
            dataDir,
            surrealBinPath,
        },
    };
}
