import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { swallow } from "./errors.js";
import { log } from "./log.js";
export class EmbeddingService {
    config;
    resourceProfile;
    model = null;
    ctx = null;
    ready = false;
    cache = new Map();
    maxCacheSize = 512;
    initStartedAt = null;
    initFinishedAt = null;
    initError = null;
    consecutiveTimeouts = 0;
    maxConsecutiveTimeouts = 3;
    breakerOpenedAt = null;
    embedTimeoutMs;
    store = null;
    modelVersion = null;
    l2Hits = 0;
    l2Misses = 0;
    constructor(config, resourceProfile) {
        this.config = config;
        this.resourceProfile = resourceProfile;
        this.embedTimeoutMs = Number(process.env.KONGCODE_EMBED_TIMEOUT_MS) || 30_000;
    }
    setStore(store) {
        this.store = store;
        this.modelVersion = createHash("sha256").update(this.config.modelPath).digest("hex").slice(0, 16);
    }
    async initialize() {
        if (this.ready)
            return false;
        this.initStartedAt = Date.now();
        this.initError = null;
        try {
            if (!existsSync(this.config.modelPath)) {
                throw new Error(`Embedding model not found at: ${this.config.modelPath}\n  Download BGE-M3 GGUF or set EMBED_MODEL_PATH`);
            }
            const { getSharedLlama } = await import("./llama-loader.js");
            const llama = await getSharedLlama(this.resourceProfile);
            this.model = await llama.loadModel({ modelPath: this.config.modelPath });
            this.ctx = await this.model.createEmbeddingContext();
            this.ready = true;
            this.initFinishedAt = Date.now();
            return true;
        }
        catch (err) {
            this.initError = err instanceof Error ? err : new Error(String(err));
            this.initFinishedAt = Date.now();
            log.error(`[embeddings] initialize() failed: ${this.initError.message}`);
            throw this.initError;
        }
    }
    getDiagnostics() {
        const start = this.initStartedAt;
        const end = this.initFinishedAt;
        return {
            ready: this.ready,
            modelPath: this.config.modelPath,
            initStartedAt: start,
            initFinishedAt: end,
            initDurationMs: start != null && end != null ? end - start : null,
            initError: this.initError
                ? { message: this.initError.message, stack: this.initError.stack }
                : null,
            circuitBreakerOpen: this.consecutiveTimeouts >= this.maxConsecutiveTimeouts,
            consecutiveTimeouts: this.consecutiveTimeouts,
            resourceTier: this.resourceProfile?.tier ?? null,
            l2CacheEnabled: this.store !== null,
            l2Hits: this.l2Hits,
            l2Misses: this.l2Misses,
        };
    }
    textHash(text) {
        return createHash("sha256").update(text).digest("hex");
    }
    async l2Get(hash) {
        if (!this.store?.isAvailable() || !this.modelVersion)
            return null;
        try {
            const rows = await this.store.queryFirst(`SELECT embedding FROM embedding_cache WHERE text_hash = $hash AND model_version = $mv LIMIT 1`, { hash, mv: this.modelVersion });
            const vec = rows[0]?.embedding;
            if (Array.isArray(vec) && vec.length > 0 && vec.every(Number.isFinite)) {
                this.l2Hits++;
                return vec;
            }
        }
        catch (e) {
            swallow("embeddings:l2Get", e);
        }
        this.l2Misses++;
        return null;
    }
    l2Put(hash, vec) {
        if (!this.store?.isAvailable() || !this.modelVersion)
            return;
        this.store.queryExec(`UPSERT embedding_cache SET text_hash = $hash, embedding = $vec, model_version = $mv WHERE text_hash = $hash`, { hash, vec, mv: this.modelVersion }).catch(e => swallow("embeddings:l2Put", e));
    }
    async embed(text) {
        if (!this.ready || !this.ctx)
            throw new Error("Embeddings not initialized");
        if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
            if (!this.breakerOpenedAt)
                this.breakerOpenedAt = Date.now();
            if (Date.now() - this.breakerOpenedAt < 60_000) {
                throw new Error(`Embedding circuit breaker open: ${this.consecutiveTimeouts} consecutive timeouts`);
            }
            this.consecutiveTimeouts = 0;
            this.breakerOpenedAt = null;
        }
        const cached = this.cache.get(text);
        if (cached) {
            this.cache.delete(text);
            this.cache.set(text, cached);
            return cached;
        }
        const hash = this.textHash(text);
        const l2 = await this.l2Get(hash);
        if (l2) {
            if (this.cache.size >= this.maxCacheSize) {
                this.cache.delete(this.cache.keys().next().value);
            }
            this.cache.set(text, l2);
            return l2;
        }
        let timer;
        try {
            const result = await Promise.race([
                this.ctx.getEmbeddingFor(text),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`embed() timed out after ${this.embedTimeoutMs}ms`)), this.embedTimeoutMs);
                }),
            ]);
            this.consecutiveTimeouts = 0;
            const vec = Array.from(result.vector);
            if (this.cache.size >= this.maxCacheSize) {
                this.cache.delete(this.cache.keys().next().value);
            }
            this.cache.set(text, vec);
            this.l2Put(hash, vec);
            return vec;
        }
        catch (err) {
            if (err instanceof Error && err.message.includes("timed out")) {
                this.consecutiveTimeouts++;
                // Preserve the stack trace so post-mortem grep against the daemon
                // log shows which call path tripped the breaker — the prior
                // single-line message discarded `err.stack` entirely and made
                // "circuit breaker open" reports impossible to root-cause.
                log.error(`[embeddings] timeout #${this.consecutiveTimeouts}/${this.maxConsecutiveTimeouts}` +
                    (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts ? " — CIRCUIT BREAKER OPEN" : "") +
                    ` err=${err.stack ?? err.message}`);
            }
            throw err;
        }
        finally {
            // Clear the timer on every exit path (success, embedder error, or
            // timeout itself). The prior code only cleared on success — a fast
            // embedder error left a pending Timeout that kept the process alive
            // for `embedTimeoutMs` after each failed embed.
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    async embedBatch(texts) {
        if (texts.length === 0)
            return [];
        return Promise.all(texts.map(text => this.embed(text)));
    }
    isAvailable() {
        return this.ready;
    }
    async dispose() {
        try {
            await this.ctx?.dispose();
            await this.model?.dispose();
            this.ready = false;
            this.cache.clear();
        }
        catch (e) {
            swallow("embeddings:dispose", e);
        }
    }
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
export async function probeEmbeddingService(embeddings) {
    const e = embeddings;
    if (!e || typeof e.isAvailable !== "function") {
        return { status: "down", message: "embedding service not present" };
    }
    if (!e.isAvailable()) {
        const diag = typeof e.getDiagnostics === "function" ? e.getDiagnostics() : null;
        if (diag?.initError) {
            const firstLine = String(diag.initError.message ?? "").split("\n")[0].slice(0, 200);
            return { status: "down", message: `initialize() threw: ${firstLine}` };
        }
        if (diag?.initStartedAt != null && diag.initFinishedAt == null) {
            const ageS = Math.floor((Date.now() - diag.initStartedAt) / 1000);
            return {
                status: "down",
                message: `initialize() in progress (${ageS}s elapsed; native build may be running)`,
            };
        }
        if (diag?.initStartedAt == null) {
            return {
                status: "down",
                message: "initialize() never called (boot path may have skipped embedding init)",
            };
        }
        return { status: "down", message: "isAvailable=false (no diagnostics captured)" };
    }
    let probeTimer;
    try {
        const probe = e.embed("ping").then(v => v?.length ?? 0);
        const len = await Promise.race([
            probe,
            new Promise((_, rej) => {
                probeTimer = setTimeout(() => rej(new Error("probe timeout")), 1500);
            }),
        ]);
        if (typeof len === "number" && len > 0) {
            return { status: "ok", message: `BGE-M3 responsive, ${len}-dim` };
        }
        return { status: "degraded", message: "embed returned empty vector" };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "degraded", message: `embed probe failed: ${msg.slice(0, 120)}` };
    }
    finally {
        // Clear on every exit path so a fast-resolving embed doesn't leave a
        // 1.5s pending Timeout keeping the caller alive.
        if (probeTimer !== undefined)
            clearTimeout(probeTimer);
    }
}
