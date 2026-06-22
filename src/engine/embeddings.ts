import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { EmbeddingConfig } from "./config.js";
import type { ResourceProfile } from "./resource-tier.js";
import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";
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
export class EmbedBusyError extends Error {
  readonly code = IpcErrorCode.DAEMON_RESTARTING;
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "EmbedBusyError";
  }
}

type LlamaEmbeddingContext = import("node-llama-cpp").LlamaEmbeddingContext;
type LlamaModel = import("node-llama-cpp").LlamaModel;

export interface EmbeddingDiagnostics {
  ready: boolean;
  modelPath: string;
  initStartedAt: number | null;
  initFinishedAt: number | null;
  initDurationMs: number | null;
  initError: { message: string; stack?: string } | null;
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

export class EmbeddingService {
  private model: LlamaModel | null = null;
  private ctx: LlamaEmbeddingContext | null = null;
  private ready = false;
  private cache = new Map<string, number[]>();
  private readonly maxCacheSize = 512;
  private initStartedAt: number | null = null;
  private initFinishedAt: number | null = null;
  private initError: Error | null = null;
  private consecutiveTimeouts = 0;
  private readonly maxConsecutiveTimeouts = 3;
  private breakerOpenedAt: number | null = null;
  private readonly embedTimeoutMs: number;
  private store: SurrealStore | null = null;
  private modelVersion: string | null = null;
  private l2Hits = 0;
  private l2Misses = 0;

  constructor(
    private readonly config: EmbeddingConfig,
    private readonly resourceProfile?: ResourceProfile,
  ) {
    this.embedTimeoutMs = Number(process.env.KONGCODE_EMBED_TIMEOUT_MS) || 30_000;
  }

  setStore(store: SurrealStore): void {
    this.store = store;
    this.modelVersion = createHash("sha256").update(this.config.modelPath).digest("hex").slice(0, 16);
  }

  async initialize(): Promise<boolean> {
    if (this.ready) return false;
    this.initStartedAt = Date.now();
    this.initError = null;
    try {
      if (!existsSync(this.config.modelPath)) {
        throw new Error(
          `Embedding model not found at: ${this.config.modelPath}\n  Download BGE-M3 GGUF or set EMBED_MODEL_PATH`,
        );
      }
      const { getSharedLlama } = await import("./llama-loader.js");
      const llama = await getSharedLlama(this.resourceProfile);
      this.model = await llama.loadModel({ modelPath: this.config.modelPath });
      this.ctx = await this.model.createEmbeddingContext();
      this.ready = true;
      this.initFinishedAt = Date.now();
      return true;
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      this.initFinishedAt = Date.now();
      log.error(`[embeddings] initialize() failed: ${this.initError.message}`);
      throw this.initError;
    }
  }

  getDiagnostics(): EmbeddingDiagnostics {
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
      embedQueueDepth: this.embedQueue.length,
      embedQueueDepthMax: this.queueDepthMax,
    };
  }

  private textHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  private async l2Get(hash: string): Promise<number[] | null> {
    if (!this.store?.isAvailable() || !this.modelVersion) return null;
    try {
      const rows = await this.store.queryFirst<{ embedding: number[] }>(
        `SELECT embedding FROM embedding_cache
           WHERE text_hash = $hash
             AND model_version = $mv
             AND pruned_at IS NONE
           LIMIT 1`,
        { hash, mv: this.modelVersion },
      );
      const vec = rows[0]?.embedding;
      // C3 (embed-integrity): the L2 cache (embedding_cache.embedding) is a loose
      // `array` column, not a fixed-width vector, so a wrong-dim vector written by
      // an OLDER daemon (a dist/ predating the computeAndSettle dim-guard) can
      // physically live here. Serving it back would re-poison vector search even
      // though the live compute path now rejects such vectors. Treat a wrong-dim
      // cache hit as a MISS so the caller recomputes (and the recompute is
      // re-validated by the guard). Exact-equality to the configured dim so a
      // valid 1024-dim vector is always served.
      if (
        Array.isArray(vec) &&
        vec.length === this.config.dimensions &&
        vec.every(Number.isFinite)
      ) {
        this.l2Hits++;
        return vec;
      }
    } catch (e) { swallow("embeddings:l2Get", e); }
    this.l2Misses++;
    return null;
  }

  private l2Put(hash: string, vec: number[]): void {
    if (!this.store?.isAvailable() || !this.modelVersion) return;
    // K17-emb: also reset pruned_at/prune_reason. The idx_ec_text_hash UNIQUE
    // index means this UPSERT lands on the EXISTING row for a re-cached text,
    // and l2Get filters `pruned_at IS NONE`. Without clearing it, a row the
    // maintenance purge soft-tagged (>30d stale) stays permanently invisible
    // to l2Get even after we recompute and re-store its vector — every future
    // embed of that text misses L2 and burns the compute path forever.
    // created_at is intentionally left untouched so the row stays eligible for
    // the next purge cycle on its original timestamp (re-arm owned by maintenance.ts).
    this.store.queryExec(
      `UPSERT embedding_cache SET text_hash = $hash, embedding = $vec, model_version = $mv, pruned_at = NONE, prune_reason = NONE WHERE text_hash = $hash`,
      { hash, vec, mv: this.modelVersion },
    ).catch(e => swallow("embeddings:l2Put", e));
  }

  /** C3 (embed-integrity): record a maintenance_runs row so memory_health goes
   *  RED when the embed boundary rejects a wrong-dimension vector. Mirrors the
   *  E1 runJob audit shape ({job, status:'error', error}) so memory-health.ts
   *  surfaces it with no edits there. Fire-and-forget + store-guarded: a failure
   *  to record the audit must never mask or block the rejection that triggered
   *  it, and we never touch content (this is a telemetry write). */
  private recordDimGuardFailure(gotDim: number, expectedDim: number): void {
    if (!this.store?.isAvailable()) return;
    const data = {
      job: "embedDimGuard",
      status: "error",
      error: `embed produced ${gotDim}-dim vector, expected ${expectedDim} — poison vector rejected (not written); row left un-embedded for backfill`,
    };
    this.store
      .queryExec(`CREATE maintenance_runs CONTENT $data`, { data })
      .catch(e => swallow("embeddings:recordDimGuardFailure", e));
  }

  /** B17 (T5, 2026-06-10): llama serializes embedding computation internally,
   *  so N concurrent embed() calls (embedBatch, parallel hook traffic) used to
   *  start N timeout clocks at SUBMIT time while computing one at a time —
   *  item k "timed out" after waiting k×(compute time) in line, on CPU tiers
   *  ratcheting consecutiveTimeouts to the breaker threshold without a single
   *  slow computation. The explicit FIFO below makes the serialization visible
   *  and starts each item's clock at DEQUEUE, so the timeout measures compute,
   *  not queue depth. */
  private embedQueue: Array<{
    text: string;
    hash: string;
    enqueuedAt: number;
    resolve: (v: number[]) => void;
    reject: (e: Error) => void;
  }> = [];
  private queueDraining = false;
  private queueDepthMax = 0;
  /** K12 backpressure: hard cap on pending embed requests. llama serializes
   *  compute (one item at a time), so an unbounded push lets a burst of hook
   *  traffic / a wedged embedder grow the FIFO without limit — each entry
   *  pins its text + two closures, so the queue is the leak surface on a
   *  long-lived daemon. Past this depth embed() fast-fails with a retryable
   *  error instead of enqueueing. Override via KONGCODE_EMBED_QUEUE_MAX. */
  private readonly maxQueueDepth =
    Number(process.env.KONGCODE_EMBED_QUEUE_MAX) > 0
      ? Number(process.env.KONGCODE_EMBED_QUEUE_MAX)
      : 2048;

  async embed(text: string): Promise<number[]> {
    if (!this.ready || !this.ctx) throw new Error("Embeddings not initialized");
    // Cache hits bypass the breaker — the breaker protects the COMPUTE path;
    // refusing to serve a warm cache during an open window (the old behavior)
    // only amplified outages.
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
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(text, l2);
      return l2;
    }

    // K12 backpressure: refuse past the ceiling rather than growing the FIFO
    // without bound. The caller gets a clear, retryable error; the alternative
    // (unbounded push) turns a slow/wedged embedder into an OOM on a
    // long-lived per-host daemon.
    if (this.embedQueue.length >= this.maxQueueDepth) {
      // M2(a): throw a RETRYABLE-coded error, not a plain Error. A plain Error
      // is wrapped by the dispatcher as HANDLER_ERROR (non-retryable) and fails
      // the user's turn; EmbedBusyError carries DAEMON_RESTARTING so the client
      // backs off and retries the transiently-underwater embedder instead.
      throw new EmbedBusyError(
        `Embedding queue full (${this.embedQueue.length}/${this.maxQueueDepth}) — embedder is underwater; retry shortly`,
      );
    }

    return new Promise<number[]>((resolve, reject) => {
      this.embedQueue.push({ text, hash, enqueuedAt: Date.now(), resolve, reject });
      if (this.embedQueue.length > this.queueDepthMax) this.queueDepthMax = this.embedQueue.length;
      void this.drainEmbedQueue();
    });
  }

  private async drainEmbedQueue(): Promise<void> {
    if (this.queueDraining) return;
    this.queueDraining = true;
    try {
      while (this.embedQueue.length > 0) {
        const item = this.embedQueue.shift()!;
        if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
          if (!this.breakerOpenedAt) this.breakerOpenedAt = Date.now();
          if (Date.now() - this.breakerOpenedAt < 60_000) {
            // Open: fail fast — no compute, no embedTimeoutMs burned per item.
            item.reject(
              new Error(`Embedding circuit breaker open: ${this.consecutiveTimeouts} consecutive timeouts`),
            );
            continue;
          }
          // Cooldown elapsed → HALF-OPEN: this item is the single probe. The
          // old code reset the counter here and let the whole backlog through;
          // a still-wedged embedder then burned a full timeout per item before
          // re-opening. Serial dequeue means everything behind the probe waits,
          // and a failed probe re-opens the breaker for them to fail fast.
        }
        await this.computeAndSettle(item);
      }
    } finally {
      this.queueDraining = false;
    }
  }

  private async computeAndSettle(item: {
    text: string;
    hash: string;
    enqueuedAt: number;
    resolve: (v: number[]) => void;
    reject: (e: Error) => void;
  }): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const probing = this.consecutiveTimeouts >= this.maxConsecutiveTimeouts;
    try {
      const result = await Promise.race([
        this.ctx!.getEmbeddingFor(item.text),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `embed() timed out after ${this.embedTimeoutMs}ms` +
                  ` (compute clock; spent ${startedAt - item.enqueuedAt}ms queued first)`,
                ),
              ),
            this.embedTimeoutMs,
          );
        }),
      ]);
      this.consecutiveTimeouts = 0;
      this.breakerOpenedAt = null;
      if (probing) log.warn("[embeddings] half-open probe succeeded — circuit breaker closed");
      const vec = Array.from(result.vector);
      // C3 (embed-integrity): the HNSW indexes are DIMENSION 1024 (schema.surql,
      // 10+ tables) and vector::similarity::cosine throws "vectors must be of the
      // same dimension" DB-wide if even ONE wrong-dim vector lands. A mis-set
      // EMBED_MODEL_PATH / a partial-or-corrupt GGUF / a model that silently
      // emits a different width can produce a non-1024 vector here. Validate the
      // width at the embed boundary BEFORE any write (in-mem cache, L2, resolve).
      // On mismatch: REJECT the poison vector — do NOT cache it, do NOT persist
      // it, do NOT resolve with it. Throwing routes the caller through the
      // EXISTING K5 degrade path (ingestTurn et al. store a null/IS NONE
      // embedding) so the maintenance embedding-backfill heals the row later
      // with a correctly-dimensioned vector — no auto-deletion of user data.
      // Exact-equality to the configured dim guarantees a VALID 1024-dim vector
      // is never rejected.
      const expectedDim = this.config.dimensions;
      if (vec.length !== expectedDim) {
        // Surface it: a maintenance_runs row job='embedDimGuard' status='error'
        // makes memory_health go RED automatically (best-effort, fire-and-forget;
        // a failure to RECORD must not mask the rejection below).
        this.recordDimGuardFailure(vec.length, expectedDim);
        throw new Error(
          `embed() produced a ${vec.length}-dim vector but the index/model dimension is ${expectedDim}` +
          ` — rejecting poison vector (check EMBED_MODEL_PATH / GGUF integrity). Row left un-embedded for backfill.`,
        );
      }
      if (this.cache.size >= this.maxCacheSize) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(item.text, vec);
      this.l2Put(item.hash, vec);
      item.resolve(vec);
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
          // Crossing the threshold (or a failed half-open probe) opens the
          // breaker from NOW — a fresh full cooldown, not the stale window.
          this.breakerOpenedAt = Date.now();
        }
        // Preserve the stack trace so post-mortem grep against the daemon
        // log shows which call path tripped the breaker — the prior
        // single-line message discarded `err.stack` entirely and made
        // "circuit breaker open" reports impossible to root-cause.
        log.error(
          `[embeddings] timeout #${this.consecutiveTimeouts}/${this.maxConsecutiveTimeouts}` +
          (probing ? " — HALF-OPEN PROBE FAILED, breaker re-opened" :
            this.consecutiveTimeouts >= this.maxConsecutiveTimeouts ? " — CIRCUIT BREAKER OPEN" : "") +
          ` err=${err.stack ?? err.message}`,
        );
      }
      item.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Clear the timer on every exit path (success, embedder error, or
      // timeout itself). The prior code only cleared on success — a fast
      // embedder error left a pending Timeout that kept the process alive
      // for `embedTimeoutMs` after each failed embed.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Safe to fan out: embed() enqueues into the serial FIFO above, so each
    // item's timeout clock starts when ITS computation starts.
    return Promise.all(texts.map(text => this.embed(text)));
  }

  isAvailable(): boolean {
    return this.ready;
  }

  async dispose(): Promise<void> {
    try {
      // Reject anything still waiting in the FIFO — a disposed context can
      // never serve them, and silent forever-pending promises leak callers.
      for (const item of this.embedQueue.splice(0)) {
        item.reject(new Error("Embeddings disposed"));
      }
      await this.ctx?.dispose();
      await this.model?.dispose();
      this.ready = false;
      this.cache.clear();
    } catch (e) {
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
export async function probeEmbeddingService(
  embeddings: unknown,
): Promise<{ status: "ok" | "degraded" | "down"; message: string }> {
  const e = embeddings as {
    isAvailable?: () => boolean;
    embed?: (s: string) => Promise<number[]>;
    getDiagnostics?: () => {
      ready: boolean;
      initStartedAt: number | null;
      initFinishedAt: number | null;
      initError: { message: string } | null;
    };
  } | null;

  if (!e || typeof e.isAvailable !== "function") {
    return { status: "down", message: "embedding service not present" };
  }
  if (!e.isAvailable()) {
    const diag = typeof e.getDiagnostics === "function" ? e.getDiagnostics() : null;
    if (diag?.initError) {
      const firstLine = String(diag.initError.message ?? "").split(/\r?\n/)[0].slice(0, 200);
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

  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = e.embed!("ping").then(v => v?.length ?? 0);
    const len = await Promise.race([
      probe,
      new Promise<number>((_, rej) => {
        probeTimer = setTimeout(() => rej(new Error("probe timeout")), 1500);
      }),
    ]);
    if (typeof len === "number" && len > 0) {
      return { status: "ok", message: `BGE-M3 responsive, ${len}-dim` };
    }
    return { status: "degraded", message: "embed returned empty vector" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "degraded", message: `embed probe failed: ${msg.slice(0, 120)}` };
  } finally {
    // Clear on every exit path so a fast-resolving embed doesn't leave a
    // 1.5s pending Timeout keeping the caller alive.
    if (probeTimer !== undefined) clearTimeout(probeTimer);
  }
}
