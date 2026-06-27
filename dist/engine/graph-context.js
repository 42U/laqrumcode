/**
 * Graph-based context transformation for LaqrumCode.
 *
 * Core retrieval pipeline: vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format.
 */
import { getPendingDirectives, clearPendingDirectives, getSessionContinuity, getSuppressedNodeIds } from "./cognitive-check.js";
import { queryCausalContext } from "./causal.js";
import { findRelevantSkills, formatSkillContext } from "./skills.js";
import { retrieveReflections, formatReflectionContext } from "./reflection.js";
import { getCachedContext, setCachedContext, recordPrefetchHit, recordPrefetchMiss } from "./prefetch.js";
import { stageRetrieval, stageSkills, getHistoricalUtilityBatch, getLastTurnGroundingTrace } from "./retrieval-quality.js";
import { isACANActive, scoreWithACAN } from "./acan.js";
import { swallow } from "./errors.js";
import { clamp } from "./math.js";
import { log } from "./log.js";
// ── Cross-encoder reranker (bge-reranker-v2-m3) ──────────────────────────────
let _rankingCtx = null;
let _rerankerModelPath = null;
let _rerankerProfile = null;
let _rerankerInitializing = null;
const RERANK_TOP_N = 30;
const RERANK_BLEND_VECTOR = 0.6;
const RERANK_BLEND_CROSS = 0.4;
// Cross-encoder cost is ~linear in the (query+doc) TOKENS scored on CPU. The
// bge-reranker-v2-m3 relevance signal lives in the passage head, so we cap each
// doc to a SOTA reranker passage (~512 tokens) and bound the whole batch to a
// fixed token budget. This makes rerank wall-time a HARDWARE-INDEPENDENT bounded
// constant (work ∝ tokens, capped) — not a function of doc length or graph size,
// and not dependent on core count. Measured 2026-06-17 @ 4 cores: a single
// 24000-char (~6500-tok) doc cost ~21s and blew the 45s budget; token-capped, a
// full 30-doc batch is ~22s (≤~27s at the 8192-token ceiling), scaling down with
// cores. Truncation is by REAL tokens (not chars) so CJK/code can't overflow the
// model window. All env-tunable.
const RERANK_MAX_DOC_TOKENS = Number(process.env.LAQRUMCODE_RERANK_MAX_DOC_TOKENS) || 512;
const RERANK_QUERY_MAX_TOKENS = Number(process.env.LAQRUMCODE_RERANK_QUERY_MAX_TOKENS) || 512;
const RERANK_TOTAL_TOKEN_BUDGET = Number(process.env.LAQRUMCODE_RERANK_TOTAL_TOKEN_BUDGET) || 8192;
const RERANK_CHUNK_SIZE = Number(process.env.LAQRUMCODE_RERANK_CHUNK_SIZE) || 6;
// K40: when the cross-encoder disagrees with WMR on EVERY candidate, keep at
// most this many top-by-blended-score rather than returning an empty set.
const RERANK_ALL_DROPPED_KEEP = Number(process.env.LAQRUMCODE_RERANK_ALL_DROPPED_KEEP) || 5;
// ── Cross-encoder timeout + circuit breaker (K13) ────────────────────────────
// The bge-reranker rankAll() is a synchronous-ish CPU kernel that can wedge on
// pathological input or a half-initialized model context. Token-capping bounds
// the *expected* cost, but a wedged context still hangs the awaiting caller
// forever — and Stop awaits evaluateRetrieval which awaits the cross-encoder, so
// one stuck rankAll would freeze the turn boundary. We wrap every rankAll in a
// per-chunk deadline (mirrors the embeddings compute-timeout) plus a
// consecutive-timeout breaker (mirrors EmbeddingService.consecutiveTimeouts):
// after N consecutive deadline hits the cross-encoder is disabled for a cooldown
// and callers fall back to lexical / distribution-band scoring. All env-tunable.
const RERANK_TIMEOUT_MS = Number(process.env.LAQRUMCODE_RERANK_TIMEOUT_MS) || 10_000;
const RERANK_MAX_CONSECUTIVE_TIMEOUTS = Number(process.env.LAQRUMCODE_RERANK_MAX_TIMEOUTS) || 3;
const RERANK_BREAKER_COOLDOWN_MS = Number(process.env.LAQRUMCODE_RERANK_BREAKER_COOLDOWN_MS) || 60_000;
// K12-style backpressure ceiling for the rerank FIFO. node-llama-cpp serializes
// rankAll internally, so concurrent callers (rerankResults + the fanned-out
// crossEncoderScorePairs on the Stop path + the skills reranker callback) all
// queue here. Each pending entry pins two Token[][] closures, so an unbounded
// push is the leak surface on a long-lived per-host daemon. Past this depth we
// fast-fail with a retryable error instead of growing the queue. Env-tunable.
const RERANK_QUEUE_MAX = Number(process.env.LAQRUMCODE_RERANK_QUEUE_MAX) > 0
    ? Number(process.env.LAQRUMCODE_RERANK_QUEUE_MAX)
    : 512;
let _rerankConsecutiveTimeouts = 0;
let _rerankBreakerOpenedAt = null;
let _rerankQueue = [];
let _rerankQueueDraining = false;
/** True when the consecutive-timeout breaker is open and still inside its
 *  cooldown window — callers should skip the cross-encoder entirely and fall
 *  back. Re-closes (returns false) once the cooldown elapses so the next
 *  DEQUEUED item acts as the single half-open probe. */
function rerankBreakerOpen() {
    if (_rerankConsecutiveTimeouts < RERANK_MAX_CONSECUTIVE_TIMEOUTS)
        return false;
    if (_rerankBreakerOpenedAt == null)
        return false;
    return Date.now() - _rerankBreakerOpenedAt < RERANK_BREAKER_COOLDOWN_MS;
}
/** @internal test helper — reset breaker + queue state between cases. */
export function _resetRerankBreaker() {
    _rerankConsecutiveTimeouts = 0;
    _rerankBreakerOpenedAt = null;
    _rerankQueue = [];
    _rerankQueueDraining = false;
}
/** @internal test helper — inspect breaker state. */
export function _rerankBreakerState() {
    return {
        consecutiveTimeouts: _rerankConsecutiveTimeouts,
        open: rerankBreakerOpen(),
        queueDepth: _rerankQueue.length,
    };
}
/** @internal test helper — inject a fake ranking context so the FIFO/breaker
 *  path can be exercised without loading the 606MB bge-reranker model. Pass
 *  null to clear. Used by the R2 queue-depth regression test. */
export function _setRankingCtxForTest(ctx) {
    _rankingCtx = ctx;
}
/** Drain the rerank FIFO one item at a time. Single-flight via the
 *  _rerankQueueDraining guard (the only place compute is started), so two
 *  concurrent enqueues can't both compute or both act as half-open probes. */
async function drainRerankQueue() {
    if (_rerankQueueDraining)
        return;
    _rerankQueueDraining = true;
    try {
        while (_rerankQueue.length > 0) {
            const item = _rerankQueue.shift();
            if (_rerankConsecutiveTimeouts >= RERANK_MAX_CONSECUTIVE_TIMEOUTS) {
                if (_rerankBreakerOpenedAt == null)
                    _rerankBreakerOpenedAt = Date.now();
                if (Date.now() - _rerankBreakerOpenedAt < RERANK_BREAKER_COOLDOWN_MS) {
                    // Open: signal "fall back" (null), no compute, no timeout burned.
                    item.resolve(null);
                    continue;
                }
                // Cooldown elapsed → HALF-OPEN: this single dequeued item is the lone
                // probe. Serial dequeue means everything behind it waits; a failed
                // probe re-opens the breaker so they fall back fast.
            }
            await computeRankAndSettle(item);
        }
    }
    finally {
        _rerankQueueDraining = false;
    }
}
/** Compute one rankAll under a deadline clock started HERE (at dequeue), update
 *  the consecutive-timeout breaker, and settle the item's promise. */
async function computeRankAndSettle(item) {
    let timer;
    const startedAt = Date.now();
    const probing = _rerankConsecutiveTimeouts >= RERANK_MAX_CONSECUTIVE_TIMEOUTS;
    try {
        const scores = await Promise.race([
            item.ctx.rankAll(item.query, item.docs),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`rankAll timed out after ${RERANK_TIMEOUT_MS}ms` +
                    ` (compute clock; spent ${startedAt - item.enqueuedAt}ms queued first)`)), RERANK_TIMEOUT_MS);
            }),
        ]);
        // Success closes the breaker.
        if (_rerankConsecutiveTimeouts > 0 || probing) {
            log.warn("[rerank] cross-encoder recovered — timeout breaker closed");
        }
        _rerankConsecutiveTimeouts = 0;
        _rerankBreakerOpenedAt = null;
        item.resolve(scores);
    }
    catch (e) {
        if (e instanceof Error && e.message.includes("timed out")) {
            _rerankConsecutiveTimeouts++;
            if (_rerankConsecutiveTimeouts >= RERANK_MAX_CONSECUTIVE_TIMEOUTS) {
                // Crossing the threshold (or a failed half-open probe) opens the
                // breaker from NOW — a fresh full cooldown, not the stale window.
                _rerankBreakerOpenedAt = Date.now();
                log.error(`[rerank] timeout #${_rerankConsecutiveTimeouts}/${RERANK_MAX_CONSECUTIVE_TIMEOUTS}` +
                    (probing ? " — HALF-OPEN PROBE FAILED, breaker re-opened" :
                        " — CROSS-ENCODER CIRCUIT BREAKER OPEN") +
                    ", falling back to lexical/distribution scoring");
            }
        }
        item.reject(e instanceof Error ? e : new Error(String(e)));
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** Enqueue a rankAll onto the single serial FIFO and await its turn. Throws on
 *  timeout (so the caller's try/catch falls back); resets the breaker on any
 *  successful return. Returns null only when the breaker is already open at
 *  DEQUEUE (caller should fall back without computing). The deadline clock for
 *  each item starts at dequeue, not here at submit. */
async function rankAllWithDeadline(ctx, query, docs) {
    // Fast-path the already-open breaker without enqueuing: avoids growing the
    // FIFO with work that would just resolve null at dequeue anyway.
    if (rerankBreakerOpen())
        return null;
    // Backpressure: refuse past the ceiling rather than growing the FIFO without
    // bound on a wedged cross-encoder.
    if (_rerankQueue.length >= RERANK_QUEUE_MAX) {
        throw new Error(`Rerank queue full (${_rerankQueue.length}/${RERANK_QUEUE_MAX}) — cross-encoder is underwater; retry shortly`);
    }
    return new Promise((resolve, reject) => {
        _rerankQueue.push({ ctx, query, docs, enqueuedAt: Date.now(), resolve, reject });
        void drainRerankQueue();
    });
}
/** Tokenize + cap to a fixed token budget, returning Token[] for rankAll. Passing
 *  tokens (not a char-truncated string) gives EXACT length control: a char cap
 *  can't bound tokens on CJK/code-dense text, which would overflow the model
 *  window and make rankAll throw. Bounded tokens = bounded, hardware-independent
 *  rerank cost. */
function capTokens(text, maxTokens) {
    if (!_rankingCtx)
        return [];
    const t = _rankingCtx.model.tokenize(text);
    return t.length > maxTokens ? t.slice(0, maxTokens) : t;
}
export function configureReranker(modelPath, profile) {
    _rerankerModelPath = modelPath;
    _rerankerProfile = profile ?? null;
}
async function ensureRerankerLoaded() {
    if (_rankingCtx)
        return true;
    if (!_rerankerModelPath)
        return false;
    if (_rerankerInitializing) {
        await _rerankerInitializing;
        return _rankingCtx !== null;
    }
    _rerankerInitializing = (async () => {
        try {
            const { getSharedLlama } = await import("./llama-loader.js");
            const llama = await getSharedLlama(_rerankerProfile ?? undefined);
            const model = await llama.loadModel({ modelPath: _rerankerModelPath });
            _rankingCtx = await model.createRankingContext();
            log.warn("[rerank] Cross-encoder reranker loaded (lazy).");
        }
        catch (e) {
            swallow.warn("graph-context:initReranker(lazy) failed — retrieval will work without reranking", e);
            _rankingCtx = null;
        }
        finally {
            _rerankerInitializing = null;
        }
    })();
    await _rerankerInitializing;
    return _rankingCtx !== null;
}
export async function initReranker(modelPath) {
    try {
        const { getSharedLlama } = await import("./llama-loader.js");
        const llama = await getSharedLlama();
        const model = await llama.loadModel({ modelPath });
        _rankingCtx = await model.createRankingContext();
        log.warn("[rerank] Cross-encoder reranker loaded.");
    }
    catch (e) {
        swallow.warn("graph-context:initReranker failed — retrieval will work without reranking", e);
        _rankingCtx = null;
    }
}
export async function disposeReranker() {
    if (_rankingCtx) {
        try {
            await _rankingCtx.dispose();
        }
        catch { /* ignore */ }
        _rankingCtx = null;
    }
}
export function isRerankerActive() { return _rankingCtx !== null; }
export async function crossEncoderScorePairs(anchor, docs) {
    if (!_rankingCtx || docs.length === 0)
        return null;
    // K13: skip compute entirely while the breaker is open so a wedged
    // cross-encoder can't hang evaluateRetrieval on the Stop path.
    if (rerankBreakerOpen())
        return null;
    try {
        const anchorTokens = capTokens(anchor, RERANK_QUERY_MAX_TOKENS);
        const docTokens = docs.map(d => capTokens(d, RERANK_MAX_DOC_TOKENS));
        const scores = new Array(docTokens.length);
        for (let start = 0; start < docTokens.length; start += RERANK_CHUNK_SIZE) {
            const end = Math.min(start + RERANK_CHUNK_SIZE, docTokens.length);
            const chunk = await rankAllWithDeadline(_rankingCtx, anchorTokens, docTokens.slice(start, end));
            if (chunk == null)
                return null; // breaker opened mid-batch
            for (let i = 0; i < chunk.length; i++)
                scores[start + i] = chunk[i];
            if (end < docTokens.length)
                await new Promise(r => setImmediate(r));
        }
        return scores;
    }
    catch {
        return null;
    }
}
export const BAND_LOAD_BEARING_MIN = 0.7;
export const BAND_SUPPORTING_MIN = 0.3;
export const BAND_DROP_BELOW = 0.15;
export function bandFor(crossScore) {
    if (crossScore >= BAND_LOAD_BEARING_MIN)
        return "load-bearing";
    if (crossScore >= BAND_SUPPORTING_MIN)
        return "supporting";
    return "background";
}
/** 0.7.35: distribution-derived bands when the cross-encoder is offline.
 *  Computes quartiles within the current batch and assigns top quartile to
 *  load-bearing, middle two to supporting, bottom quartile to background.
 *  Only used when no item has a `band` set (rerank skipped or model
 *  failed to load). The thresholds aren't calibrated, so the bands carry
 *  weaker semantics than the cross-encoder version — but they're still
 *  better than the noisy `(relevance: N%)` for giving the model a coarse
 *  anchor. Mutates items in place. */
export function applyDistributionBands(items) {
    if (items.length === 0)
        return;
    if (items.some(n => n.band !== undefined))
        return; // rerank already ran
    const scores = items.map(n => n.finalScore ?? 0).sort((a, b) => a - b);
    const q1 = scores[Math.floor(scores.length * 0.25)];
    const q3 = scores[Math.floor(scores.length * 0.75)];
    if (q1 === q3) {
        for (const n of items)
            n.band = "supporting";
        return;
    }
    for (const n of items) {
        const s = n.finalScore ?? 0;
        if (s >= q3)
            n.band = "load-bearing";
        else if (s >= q1)
            n.band = "supporting";
        else
            n.band = "background";
    }
}
/** Cross-encoder rerank stage. Takes the top-N candidates by WMR/ACAN score,
 *  rescores each (query, doc) pair via a single batched call to the bge-reranker
 *  model, blends the two signals 60/40 (WMR/cross), re-sorts the top-N, and
 *  decides what to do with the tail.
 *
 *  0.7.28: also stamps `crossScore` and `band` on each reranked candidate so
 *  the formatter can render salience tags ([load-bearing]/[supporting]/etc.)
 *  instead of the noisy relevance percentage. Drops candidates below
 *  BAND_DROP_BELOW (0.15) — the cross-encoder strongly disagreeing with WMR
 *  is a hard noise filter.
 *
 *  0.7.43: by default, tail items (positions past RERANK_TOP_N) are now
 *  DROPPED rather than stamped 'background' and shipped. The old behavior
 *  was leaking irrelevant graph-neighbor concepts into context (e.g., a
 *  4-week-old heartbeat-system concept from a different project surfacing
 *  in unrelated turns) because tail items never saw the cross-encoder yet
 *  arrived in the injection anyway. */
export async function rerankResults(deduped, queryText) {
    if (deduped.length <= 5)
        return deduped;
    const loaded = await ensureRerankerLoaded();
    if (!loaded || !_rankingCtx)
        return deduped;
    // K13: breaker open → skip the cross-encoder and band by distribution so the
    // formatter still gets salience anchors instead of raw relevance %.
    if (rerankBreakerOpen()) {
        applyDistributionBands(deduped);
        return deduped;
    }
    try {
        const topN = Math.min(RERANK_TOP_N, deduped.length);
        const candidates = deduped.slice(0, topN);
        const qTokens = capTokens(queryText, RERANK_QUERY_MAX_TOKENS);
        // Token-cap each doc and accumulate until the per-batch token budget is hit.
        // `candidates` are WMR/ACAN-sorted desc, so the budget keeps the HIGHEST-scored
        // ones; the rest (lowest-WMR within top-N, only in rare outlier-heavy batches)
        // bypass the cross-encoder and are dropped — same contract as the tail-drop.
        // This bounds total rerank work to a hardware-independent constant.
        const docTokens = [];
        let budget = RERANK_TOTAL_TOKEN_BUDGET;
        for (const c of candidates) {
            const dt = capTokens(c.text ?? "", RERANK_MAX_DOC_TOKENS);
            if (docTokens.length > 0 && dt.length > budget)
                break;
            budget -= dt.length;
            docTokens.push(dt);
        }
        const scored = candidates.slice(0, docTokens.length);
        const crossScores = new Array(docTokens.length);
        for (let start = 0; start < docTokens.length; start += RERANK_CHUNK_SIZE) {
            const end = Math.min(start + RERANK_CHUNK_SIZE, docTokens.length);
            // K13: each chunk under the deadline + breaker. null = breaker tripped
            // mid-batch; bail to the catch's WMR/distribution fallback below.
            const chunkScores = await rankAllWithDeadline(_rankingCtx, qTokens, docTokens.slice(start, end));
            if (chunkScores == null) {
                applyDistributionBands(deduped);
                return deduped;
            }
            for (let i = 0; i < chunkScores.length; i++) {
                crossScores[start + i] = chunkScores[i];
            }
            if (end < docTokens.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        for (let i = 0; i < scored.length; i++) {
            const cs = crossScores[i];
            scored[i].crossScore = cs;
            scored[i].band = bandFor(cs);
            scored[i].finalScore =
                RERANK_BLEND_VECTOR * scored[i].finalScore +
                    RERANK_BLEND_CROSS * cs;
        }
        // Drop hard-noise (cross-encoder strongly disagrees) before re-sorting.
        const survivors = scored.filter((c) => (c.crossScore ?? 0) >= BAND_DROP_BELOW);
        survivors.sort((a, b) => b.finalScore - a.finalScore);
        // K40: all-dropped floor. If the cross-encoder disagreed with WMR on EVERY
        // candidate (survivors empty) but we did score some, never zero out the
        // whole result set — that would strand the turn with no recalled_memory at
        // all. Keep the top-N by blended finalScore so the strongest items still
        // ship; they keep their bands so the formatter renders salience honestly.
        if (survivors.length === 0 && scored.length > 0) {
            const floored = [...scored].sort((a, b) => b.finalScore - a.finalScore);
            log.warn(`[rerank] cross-encoder dropped all ${scored.length} candidates below ` +
                `${BAND_DROP_BELOW}; keeping top ${Math.min(RERANK_ALL_DROPPED_KEEP, floored.length)} by blended score`);
            return floored.slice(0, RERANK_ALL_DROPPED_KEEP);
        }
        // Items not cross-scored (tail past top-N, or past the token budget) are
        // dropped: shipping un-reranked items injects noise the user can't account for.
        return survivors;
    }
    catch (e) {
        swallow.warn("graph-context:rerankResults failed — using WMR scores", e);
        return deduped;
    }
}
function isUser(msg) {
    return msg.role === "user";
}
function isAssistant(msg) {
    return msg.role === "assistant";
}
function isToolResult(msg) {
    return msg.role === "toolResult";
}
function msgContentBlocks(msg) {
    if (isUser(msg)) {
        return typeof msg.content === "string"
            ? [{ type: "text", text: msg.content }]
            : msg.content;
    }
    if (isAssistant(msg))
        return msg.content;
    if (isToolResult(msg))
        return msg.content;
    return [];
}
// ── Constants ──────────────────────────────────────────────────────────────────
// Token estimation ratios (aligned with Claude Code's roughTokenCountEstimation):
// - Prose/code: 4 bytes per token (claw-code default)
// - JSON (tool results, structured data): 2 bytes per token (denser single-char tokens)
// - Safety margin: 4/3 (33%) applied to aggregate estimates
const BYTES_PER_TOKEN = 4;
const BYTES_PER_TOKEN_JSON = 2;
const CHARS_PER_TOKEN = BYTES_PER_TOKEN; // backward compat alias for budget math
const TOKEN_SAFETY_MARGIN = 4 / 3;
const IMAGE_TOKEN_ESTIMATE = 2000; // claw-code: hardcoded for images/documents
const BUDGET_FRACTION = 0.325; // ~65k of 200k window (leaves ~135k for LLM generation + tool results)
const CONVERSATION_SHARE = 0.23; // ~15k for recent user/assistant exchanges
const RETRIEVAL_SHARE = 0.385; // ~25k for graph-curated context
const CORE_MEMORY_SHARE = 0.155; // ~10k for core memory/directives
const TOOL_HISTORY_SHARE = 0.23; // ~15k for recent tool results
const CORE_MEMORY_TTL = 300_000;
const MAX_ITEM_CHARS = 1000; // 0.7.45: aligned to disler/claude-code-hooks-mastery cap; ~250 tokens per item
const MIN_RELEVANCE_SCORE = 0.30; // Floor for graph-scored results after WMR/ACAN
const MIN_COSINE = 0.25; // Minimum cosine similarity to consider a result
// Deduplication thresholds
const DEDUP_COSINE_THRESHOLD = 0.88;
const DEDUP_JACCARD_THRESHOLD = 0.80;
// MMR (Maximal Marginal Relevance) diversification of the injected set. λ weights
// relevance vs. diversity in argmax(λ·finalScore − (1−λ)·maxCosineToPicked).
// 0.7 keeps relevance dominant (mild diversification).
const MMR_LAMBDA = 0.7;
// Recency decay
const RECENCY_DECAY_FAST = 0.99;
const RECENCY_DECAY_SLOW = 0.995;
const RECENCY_BOUNDARY_HOURS = 4;
// Utility pre-filtering
const UTILITY_PREFILTER_MIN_RETRIEVALS = 5;
const UTILITY_PREFILTER_MAX_UTIL = 0.05;
// Intent score floors
const INTENT_SCORE_FLOORS = {
    "simple-question": 0.12, "meta-session": 0.10, "code-read": 0.08,
    "code-write": 0.08, "code-debug": 0.08, "deep-explore": 0.06,
    "reference-prior": 0.05, "multi-step": 0.08, "continuation": 0.06,
    "unknown": 0.08,
};
const SCORE_FLOOR_DEFAULT = 0.08;
const INTENT_REMINDER_THRESHOLD = 10;
/** Split the context window into 4 budgets: conversation, retrieval, core memory, and tool history. @internal */
export function calcBudgets(contextWindow) {
    const total = contextWindow * BUDGET_FRACTION;
    const retrieval = Math.round(total * RETRIEVAL_SHARE);
    return {
        conversation: Math.round(total * CONVERSATION_SHARE),
        retrieval,
        core: Math.round(total * CORE_MEMORY_SHARE),
        toolHistory: Math.round(total * TOOL_HISTORY_SHARE),
        maxContextItems: Math.max(20, Math.round(retrieval / 300)),
    };
}
// ── Helper functions ───────────────────────────────────────────────────────────
function extractText(msg) {
    if (typeof msg.content === "string")
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    }
    return "";
}
function extractLastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "user") {
            const text = extractText(msg);
            if (text)
                return text;
        }
    }
    return null;
}
/** Estimate char-equivalent count for a single content block (claw-code: per-block-type estimation). */
function blockCharLen(c) {
    if (c.type === "text")
        return c.text?.length ?? 0;
    if (c.type === "thinking")
        return c.thinking?.length ?? 0;
    if (c.type === "toolCall") {
        // Tool name + serialized args — JSON is denser (2 bytes/token vs 4)
        // Scale JSON args to char-equivalent at prose ratio
        const argsJson = c.args ? JSON.stringify(c.args) : "";
        const argsCharEquiv = argsJson.length * (BYTES_PER_TOKEN / BYTES_PER_TOKEN_JSON);
        return (c.name?.length ?? 0) + argsCharEquiv;
    }
    if (c.type === "toolResult" && Array.isArray(c.content)) {
        let len = 0;
        for (const rc of c.content) {
            if (rc.type === "text") {
                // Detect JSON-heavy tool results and scale accordingly
                const text = rc.text ?? "";
                const isJson = text.length > 20 && (text[0] === "{" || text[0] === "[");
                len += isJson ? text.length * (BYTES_PER_TOKEN / BYTES_PER_TOKEN_JSON) : text.length;
            }
            else {
                // Images/documents: claw-code hardcodes 2000 tokens
                len += IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN;
            }
        }
        return len;
    }
    return IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN; // image, document, etc.
}
function estimateTokens(messages) {
    let chars = 0;
    for (const msg of messages) {
        for (const c of msgContentBlocks(msg))
            chars += blockCharLen(c);
        chars += 20; // per-message structural overhead (role token, framing, separators)
    }
    // Apply safety margin (claw-code: 4/3 multiplier on rough estimates)
    return Math.ceil((chars / CHARS_PER_TOKEN) * TOKEN_SAFETY_MARGIN);
}
function msgCharLen(msg) {
    let len = 0;
    for (const c of msgContentBlocks(msg))
        len += blockCharLen(c);
    return len;
}
/** Robust epoch-ms parser. Mirrors observability.ts's parseDatetimeMs:
 *  rejects null/undefined, accepts already-numeric ms, and otherwise feeds
 *  the value through `new Date()` (with a String() fallback for SurrealDB
 *  DateTime objects whose `toString()` emits RFC 3339 but which don't
 *  auto-coerce on `new Date(obj)` across driver versions). Returns null on
 *  any value that produces a non-finite time, so downstream math::pow /
 *  division never has to defend against NaN. */
function parseDatetimeMs(v) {
    if (v == null)
        return null;
    if (typeof v === "number")
        return Number.isFinite(v) ? v : null;
    try {
        let t = new Date(v).getTime();
        if (!Number.isFinite(t))
            t = new Date(String(v)).getTime();
        return Number.isFinite(t) ? t : null;
    }
    catch {
        return null;
    }
}
function recencyScore(timestamp) {
    if (!timestamp)
        return 0.3;
    const ms = parseDatetimeMs(timestamp);
    if (ms == null)
        return 0.3;
    const hoursElapsed = (Date.now() - ms) / (1000 * 60 * 60);
    if (!Number.isFinite(hoursElapsed))
        return 0.3;
    if (hoursElapsed <= RECENCY_BOUNDARY_HOURS) {
        return Math.pow(RECENCY_DECAY_FAST, hoursElapsed);
    }
    const fastPart = Math.pow(RECENCY_DECAY_FAST, RECENCY_BOUNDARY_HOURS);
    return fastPart * Math.pow(RECENCY_DECAY_SLOW, hoursElapsed - RECENCY_BOUNDARY_HOURS);
}
export function formatRelativeTime(ts) {
    const parsed = parseDatetimeMs(ts);
    // If unparseable, surface "unknown" rather than poisoning the UI with NaN
    // strings. Callers were trusting this to always produce a useful label.
    if (parsed == null)
        return "unknown";
    const ms = Date.now() - parsed;
    const mins = Math.floor(ms / 60000);
    if (mins < 1)
        return "just now";
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7)
        return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5)
        return `${weeks}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
}
function accessBoost(accessCount) {
    return Math.log1p(accessCount ?? 0);
}
/** The exact 6-element ACAN aux-feature vector — [recency, importance, access,
 *  neighborBonus, provenUtility, reflectionBoost] — as the ACAN inference path
 *  computes it. Captured per scored item (in BOTH the ACAN and WMR paths) and
 *  persisted to retrieval_outcome.aux_features so ACAN trains on the identical
 *  features it scores with (acan.ts), eliminating the train/inference skew. It
 *  is emitted on the WMR fallback too, so aux_features rows keep accumulating
 *  while ACAN is inactive (e.g. across a weights-version retrain) — otherwise
 *  ACAN could never gather the data to reactivate. */
function acanAuxVector(r, neighborIds, utilityMap, reflectedSessions) {
    return [
        recencyScore(r.timestamp),
        (r.importance ?? 0.5) / 10,
        Math.min(accessBoost(r.accessCount), 1),
        neighborIds.has(r.id) ? 1.0 : 0,
        utilityMap.get(r.id) ?? 0,
        r.sessionId ? (reflectedSessions.has(r.sessionId) ? 1.0 : 0) : 0,
    ];
}
/** 0.7.121: fold un-synced access_stats deltas into candidates' accessCount
 *  before WMR scoring. Rows carry week-stale counts since bumps moved to the
 *  side table (SurrealStore.bumpAccessCounts — the vlog write-amplification
 *  fix); this point-read merge restores exact freshness for scoring. */
async function mergeAccessDeltas(store, rows) {
    try {
        if (rows.length === 0)
            return;
        const deltas = await store.fetchAccessDeltas(rows.map(r => String(r.id)));
        if (deltas.size === 0)
            return;
        for (const r of rows) {
            const d = deltas.get(String(r.id));
            if (d)
                r.accessCount = (r.accessCount ?? 0) + d;
        }
    }
    catch (e) {
        swallow("graph-context:accessDeltas", e);
    }
}
/** Dot-product cosine similarity between two equal-length vectors. Returns 0 if either has zero magnitude. */
export function cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
}
// ── Rules suffix (tool budget injection) ───────────────────────────────────────
function buildRulesSuffix(session) {
    const remaining = session.toolLimit === Infinity
        ? "unlimited" : String(Math.max(0, session.toolLimit - session.toolCallCount));
    const urgency = session.toolLimit !== Infinity && (session.toolLimit - session.toolCallCount) <= 3
        ? "\n⚠ WRAP UP or check in with user." : "";
    // After first exposure, send only the budget line (claw-code: don't re-send static content)
    if (session.injectedSections.has("rules_full")) {
        return ("\n<rules_reminder>" +
            `\nBudget: ${session.toolCallCount} used, ${remaining} remaining.${urgency}` +
            "\nCombine steps. If context already answers it, zero calls." +
            "\n</rules_reminder>");
    }
    // First time — compact rules (no verbose examples)
    session.injectedSections.add("rules_full");
    return ("\n<rules_reminder>" +
        `\nBudget: ${session.toolCallCount} used, ${remaining} remaining.${urgency}` +
        "\nClassify: LOOKUP(≤3) | EDIT(≤4) | REFACTOR(≤8). Announce type + plan before tools." +
        "\nCombine: grep+grep in 1 call, edit+test in 1 bash. Read multiple files in 1 call." +
        "\nSkip: if <recalled_memory> already answers it, zero calls needed." +
        "\nBe dense: lead with answer, no filler, no repeating context back." +
        "\n</rules_reminder>");
}
function injectRulesSuffix(messages, session) {
    const suffix = buildRulesSuffix(session);
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (isUser(msg)) {
            const clone = [...messages];
            if (typeof msg.content === "string") {
                clone[i] = { ...msg, content: msg.content + suffix };
            }
            else if (Array.isArray(msg.content)) {
                const content = [...msg.content, { type: "text", text: suffix }];
                clone[i] = { ...msg, content };
            }
            return clone;
        }
        if (isToolResult(msg)) {
            const clone = [...messages];
            const content = Array.isArray(msg.content) ? [...msg.content] : msg.content;
            if (Array.isArray(content)) {
                content.push({ type: "text", text: suffix });
            }
            clone[i] = { ...msg, content };
            return clone;
        }
    }
    return messages;
}
// ── Contextual query vector ────────────────────────────────────────────────────
const EXPANSION_STOP = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
    "it", "its", "this", "that", "these", "those", "i", "you", "we", "they", "he", "she",
    "my", "your", "our", "their", "what", "which", "who", "how", "when", "where", "why",
    "not", "no", "and", "or", "but", "if", "so", "any", "all", "some", "more", "just", "also",
    "very", "too", "much", "many", "yes", "yeah", "yep", "sure", "okay", "lets", "let",
    "please", "thanks", "thank", "go", "going", "ahead", "right", "well", "now", "then",
    "look", "into", "take", "done", "want", "need", "make", "get", "got", "like",
    "really", "actually", "think", "know", "see", "tell", "give", "keep", "come", "back",
]);
export function expandVagueQuery(query, session) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    const contentWords = words.filter(w => !EXPANSION_STOP.has(w));
    if (contentWords.length >= 3)
        return query;
    const context = session?.lastAssistantText;
    if (!context)
        return query;
    // Extract key terms from the last assistant response (~first 500 chars)
    const snippet = context.slice(0, 500);
    const contextWords = snippet
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length >= 4 && !EXPANSION_STOP.has(w));
    const seen = new Set();
    const terms = [];
    for (const w of contextWords) {
        const clean = w.replace(/[^a-z0-9-_.]/g, "");
        if (clean.length < 4 || seen.has(clean))
            continue;
        seen.add(clean);
        terms.push(clean);
        if (terms.length >= 10)
            break;
    }
    if (terms.length === 0)
        return query;
    return `${terms.join(" ")} ${query}`;
}
async function buildContextualQueryVec(queryText, _messages, embeddings, session) {
    const expanded = expandVagueQuery(queryText, session);
    // When expanded, bypass the ingest cache — raw embedding doesn't capture
    // the session context we added
    if (expanded !== queryText) {
        return embeddings.embed(expanded);
    }
    if (session?.lastUserEmbedding) {
        return session.lastUserEmbedding;
    }
    return embeddings.embed(queryText);
}
// ── Scoring ────────────────────────────────────────────────────────────────────
async function scoreResults(results, neighborIds, queryEmbedding, store, currentIntent) {
    const eligibleIds = results
        .filter((r) => r.table === "memory" || r.table === "concept")
        .map((r) => r.id);
    // Parallelize independent DB lookups (utility cache + reflection sessions)
    const [cacheEntries, reflectedSessions] = await Promise.all([
        store.getUtilityCacheEntries(eligibleIds),
        store.getReflectionSessionIds(),
    ]);
    const preFiltered = results.filter((r) => {
        const entry = cacheEntries.get(r.id);
        if (!entry)
            return true;
        if (entry.retrieval_count < UTILITY_PREFILTER_MIN_RETRIEVALS)
            return true;
        return entry.avg_utilization >= UTILITY_PREFILTER_MAX_UTIL;
    });
    let utilityMap = new Map();
    for (const [id, entry] of cacheEntries) {
        utilityMap.set(id, entry.avg_utilization);
    }
    if (utilityMap.size === 0 && eligibleIds.length > 0) {
        // K22: getHistoricalUtilityBatch needs the store (without it the fn
        // returns an empty map and this fallback is dead), and memory_id is a
        // TYPE string column — eligibleIds may be RecordId Things, so stringify
        // before the `WHERE memory_id IN $ids` bind or nothing ever matches.
        utilityMap = await getHistoricalUtilityBatch(eligibleIds.map(String), store);
    }
    const floor = INTENT_SCORE_FLOORS[currentIntent] ?? SCORE_FLOOR_DEFAULT;
    // ACAN path
    if (isACANActive() && queryEmbedding && preFiltered.length > 0 && preFiltered.every((r) => r.embedding)) {
        // Derive the candidate aux features AND the persisted aux vector from the
        // same source so ACAN scores and trains on identical values (parity).
        const auxVecs = preFiltered.map((r) => acanAuxVector(r, neighborIds, utilityMap, reflectedSessions));
        const candidates = preFiltered.map((r, i) => ({
            embedding: r.embedding,
            recency: auxVecs[i][0],
            importance: auxVecs[i][1],
            access: auxVecs[i][2],
            neighborBonus: auxVecs[i][3],
            provenUtility: auxVecs[i][4],
            reflectionBoost: auxVecs[i][5],
        }));
        try {
            const scores = scoreWithACAN(queryEmbedding, candidates);
            if (scores.length === preFiltered.length && scores.every((s) => isFinite(s))) {
                return preFiltered
                    .map((r, i) => ({ ...r, finalScore: scores[i], fromNeighbor: neighborIds.has(r.id), acanFeatures: auxVecs[i] }))
                    .filter((r) => r.finalScore >= floor)
                    .sort((a, b) => b.finalScore - a.finalScore);
            }
        }
        catch (e) {
            swallow.warn("graph-context:ACAN fallthrough", e);
        }
    }
    // WMR fallback
    return preFiltered
        .map((r) => {
        const cosine = r.score ?? 0;
        const recency = recencyScore(r.timestamp);
        const importance = (r.importance ?? 0.5) / 10;
        const access = Math.min(accessBoost(r.accessCount), 1);
        const neighborBonus = neighborIds.has(r.id) ? 1.0 : 0;
        const utilityRaw = utilityMap.get(r.id);
        const provenUtility = utilityRaw ?? 0.35;
        const utilityPenalty = utilityRaw !== undefined
            ? utilityRaw < 0.05 ? 0.15 : utilityRaw < 0.15 ? 0.06 : 0
            : 0;
        const reflectionBoost = r.sessionId ? (reflectedSessions.has(r.sessionId) ? 1.0 : 0) : 0;
        const finalScore = 0.35 * cosine + 0.18 * recency + 0.07 * importance +
            0.02 * access + 0.10 * neighborBonus + 0.18 * provenUtility +
            0.10 * reflectionBoost - utilityPenalty;
        return { ...r, finalScore, fromNeighbor: neighborIds.has(r.id), acanFeatures: acanAuxVector(r, neighborIds, utilityMap, reflectedSessions) };
    })
        .filter((r) => r.finalScore >= floor)
        .sort((a, b) => b.finalScore - a.finalScore);
}
// ── Deduplication ──────────────────────────────────────────────────────────────
export function deduplicateResults(ranked) {
    // Pre-compute word sets to avoid re-splitting in O(n^2) inner loop
    const wordSets = ranked.map(r => new Set((r.text ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 2)));
    const kept = [];
    const keptIndexes = [];
    for (let i = 0; i < ranked.length; i++) {
        const item = ranked[i];
        let isDup = false;
        for (const ki of keptIndexes) {
            const existing = ranked[ki];
            if (item.embedding?.length && existing.embedding?.length
                && item.embedding.length === existing.embedding.length) {
                if (cosineSimilarity(item.embedding, existing.embedding) > DEDUP_COSINE_THRESHOLD) {
                    isDup = true;
                    break;
                }
                continue;
            }
            const words = wordSets[i];
            const eWords = wordSets[ki];
            let intersection = 0;
            for (const w of words) {
                if (eWords.has(w))
                    intersection++;
            }
            const union = words.size + eWords.size - intersection;
            if (union > 0 && intersection / union > DEDUP_JACCARD_THRESHOLD) {
                isDup = true;
                break;
            }
        }
        if (!isDup) {
            kept.push(item);
            keptIndexes.push(i);
        }
    }
    return kept;
}
// ── MMR diversification ────────────────────────────────────────────────────────
// Greedy Maximal Marginal Relevance over the selection-eligible items: at each
// step pick argmax(λ·finalScore − (1−λ)·maxCosineToAlreadyPicked), so a redundant
// concept-family can't crowd out coverage in the injected set. Only reorders items
// at/above MIN_RELEVANCE_SCORE (keeping takeWithConstraints' floor-break correct);
// below-floor items keep their original order, appended after. Items without an
// embedding incur no diversity penalty. Input is already small (<= rerank top-N).
export function mmrReorder(ranked, lambda = MMR_LAMBDA) {
    const eligible = ranked.filter((r) => (r.finalScore ?? 0) >= MIN_RELEVANCE_SCORE);
    if (eligible.length <= 2)
        return ranked;
    const rest = ranked.filter((r) => (r.finalScore ?? 0) < MIN_RELEVANCE_SCORE);
    const pool = [...eligible];
    const picked = [];
    while (pool.length > 0) {
        let bestIdx = 0;
        let bestMmr = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const cand = pool[i];
            const rel = cand.finalScore ?? 0;
            let maxSim = 0;
            if (cand.embedding?.length) {
                for (const p of picked) {
                    if (p.embedding && p.embedding.length === cand.embedding.length) {
                        const sim = cosineSimilarity(cand.embedding, p.embedding);
                        if (sim > maxSim)
                            maxSim = sim;
                    }
                }
            }
            const mmr = lambda * rel - (1 - lambda) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }
        picked.push(pool[bestIdx]);
        pool.splice(bestIdx, 1);
    }
    return [...picked, ...rest];
}
// ── Token-budget constrained selection ─────────────────────────────────────────
function takeWithConstraints(ranked, budgetTokens, maxItems) {
    const budgetChars = budgetTokens * CHARS_PER_TOKEN;
    let used = 0;
    const selected = [];
    for (const r of ranked) {
        if (selected.length >= maxItems)
            break;
        if ((r.finalScore ?? 0) < MIN_RELEVANCE_SCORE && selected.length > 0)
            break;
        const len = Math.min(r.text?.length ?? 0, MAX_ITEM_CHARS); // Cap per-item size for budget accounting
        if (used + len > budgetChars && selected.length > 0)
            break;
        selected.push(r);
        used += len;
    }
    return selected;
}
// ── Core memory ────────────────────────────────────────────────────────────────
function getTier0BudgetChars(budgets) {
    return Math.round(budgets.core * 0.55 * CHARS_PER_TOKEN);
}
function getTier1BudgetChars(budgets) {
    return Math.round(budgets.core * 0.45 * CHARS_PER_TOKEN);
}
const MAX_CORE_MEMORY_CHARS = 800; // Per-item cap (claw-code: MAX_INSTRUCTION_FILE_CHARS)
function applyCoreBudget(entries, budgetChars) {
    let used = 0;
    const result = [];
    for (const e of entries) {
        // Cap individual entries so one large directive doesn't starve others
        const text = e.text.length > MAX_CORE_MEMORY_CHARS
            ? e.text.slice(0, MAX_CORE_MEMORY_CHARS) + "..."
            : e.text;
        const len = text.length + 6;
        if (used + len > budgetChars)
            continue;
        result.push(text !== e.text ? { ...e, text } : e);
        used += len;
    }
    return result;
}
function formatTierSection(entries, label) {
    if (entries.length === 0)
        return "";
    const grouped = {};
    for (const e of entries) {
        (grouped[e.category] ??= []).push(e.text);
    }
    const lines = [];
    for (const [cat, texts] of Object.entries(grouped)) {
        lines.push(`  [${cat}]`);
        for (const t of texts)
            lines.push(`  - ${t}`);
    }
    return `${label}:\n${lines.join("\n")}`;
}
/**
 * Build static system prompt section for API prefix caching.
 * Content here goes into systemPromptAddition where it benefits from
 * cache-read rates (10% cost) on subsequent API calls in the agentic loop.
 * (claw-code pattern: __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ — prompt.rs:37-140)
 */
function buildSystemPromptSection(session, tier0Entries) {
    const parts = [];
    // Graph pillar IDs (compact — the model doesn't need architecture descriptions)
    const pillarLines = [];
    if (session.agentId)
        pillarLines.push(`Agent: ${session.agentId}`);
    if (session.projectId)
        pillarLines.push(`Project: ${session.projectId}`);
    if (session.taskId)
        pillarLines.push(`Task: ${session.taskId}`);
    if (pillarLines.length > 0) {
        parts.push(`GRAPH PILLARS: ${pillarLines.join(" | ")}`);
    }
    // Token-density rules are in buildRulesSuffix (injected per-turn) — no duplication here
    // Tier 0 core directives (semi-static, changes rarely)
    const t0Section = formatTierSection(tier0Entries, "CORE DIRECTIVES (always loaded, never evicted)");
    if (t0Section)
        parts.push(t0Section);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
}
// ── Guaranteed recent turns from previous sessions ─────────────────────────────
async function ensureRecentTurns(contextNodes, session, store, count = 5) {
    try {
        if (session._cachedPrevTurns === undefined) {
            session._cachedPrevTurns = session._prevTurnsPrefetch
                ? await session._prevTurnsPrefetch
                : await store.getPreviousSessionTurns(session.sessionId, count);
            session._prevTurnsPrefetch = undefined;
        }
        const recentTurns = session._cachedPrevTurns;
        if (recentTurns.length === 0)
            return contextNodes;
        const existingTexts = new Set(contextNodes.map(n => (n.text ?? "").slice(0, 100)));
        const guaranteed = recentTurns
            .filter(t => !existingTexts.has((t.text ?? "").slice(0, 100)))
            .map(t => ({
            id: `guaranteed:${t.timestamp}`,
            text: `[${t.role}] ${t.text}`,
            table: "turn",
            timestamp: t.timestamp,
            score: 0,
            finalScore: 0.70,
            fromNeighbor: false,
        }));
        return [...contextNodes, ...guaranteed];
    }
    catch {
        return contextNodes;
    }
}
// ── Context message formatting ─────────────────────────────────────────────────
async function formatContextMessage(nodes, store, session, skillContext = "", tier0Entries = [], tier1Entries = []) {
    const groups = {};
    for (const n of nodes) {
        const isCausal = n.source?.startsWith("causal_");
        const key = isCausal ? "causal" : n.table === "turn" ? "past_turns" : n.table;
        (groups[key] ??= []).push(n);
    }
    const ORDER = ["identity_chunk", "memory", "concept", "causal", "skill", "past_turns"];
    const LABELS = {
        identity_chunk: "Identity (self-knowledge)",
        memory: "Recalled Memories",
        concept: "Relevant Concepts",
        causal: "Causal Chains",
        skill: "Learned Skills",
        past_turns: "Past Conversation (HISTORICAL — not current user input)",
    };
    const sections = [];
    // Pillar context — structural IDs only (architecture description is unnecessary token spend)
    // Skip if model already has it in the conversation window (claw-code static section dedup)
    if (!session.injectedSections.has("ilaqrum")) {
        const pillarLines = [];
        if (session.agentId)
            pillarLines.push(`Agent: ${session.agentId}`);
        if (session.projectId)
            pillarLines.push(`Project: ${session.projectId}`);
        if (session.taskId)
            pillarLines.push(`Task: ${session.taskId}`);
        if (pillarLines.length > 0) {
            sections.push(`GRAPH PILLARS: ${pillarLines.join(" | ")}`);
            session.injectedSections.add("ilaqrum");
        }
    }
    // 0.7.45: directive sections wrapped in semantic XML per Anthropic's
    // documented prompt-engineering patterns for Claude (use_xml_tags). The
    // tag names <active_directives> / <session_directives> are deliberately
    // domain-specific so the model can attend to them as a category rather
    // than parse a free-text header.
    if (!session.injectedSections.has("tier0")) {
        const t0Section = formatTierSection(tier0Entries, "<active_directives>");
        if (t0Section) {
            sections.push(t0Section.replace(/^<active_directives>:\n/, "<active_directives>\n") + "\n</active_directives>");
            session.injectedSections.add("tier0");
        }
    }
    if (!session.injectedSections.has("tier1")) {
        const t1Section = formatTierSection(tier1Entries, "<session_directives>");
        if (t1Section) {
            sections.push(t1Section.replace(/^<session_directives>:\n/, "<session_directives>\n") + "\n</session_directives>");
            session.injectedSections.add("tier1");
        }
    }
    // 0.7.31: Reflexion grounding nudge — Self-RAG/Reflexion pattern routing
    // last turn's `cited` audit signal back into the model as next-turn
    // behavioral feedback. Fires when last turn injected ≥3 high-salience
    // items and the model cited 0 of them. 1-turn cooldown prevents nagging
    // when the model ignores items two turns in a row. Mechanical signal
    // (cited-field counts) — distinct from the LLM-graded cognitive-check
    // pipeline that produces CognitiveDirective objects.
    try {
        const trace = await getLastTurnGroundingTrace(session.sessionId, store);
        if (trace &&
            trace.injected >= 3 &&
            trace.cited === 0 &&
            trace.ignored_high_salience.length >= 3 &&
            session.userTurnCount > session.lastReflexionFireTurn + 1) {
            const n = trace.ignored_high_salience.length;
            sections.push(`GROUNDING NUDGE (prior turn): ${n} load-bearing items injected, 0 cited. ` +
                `Either ground on them this turn (use [#N] indices) or explicitly note ` +
                `why they're inapplicable. Repeated ignore-without-explanation degrades ` +
                `retrieval utility scores.`);
            session.lastReflexionFireTurn = session.userTurnCount;
        }
    }
    catch (e) {
        swallow.warn("graph-context:reflexionNudge", e);
    }
    // Cognitive directives
    const directives = getPendingDirectives(session);
    if (directives.length > 0) {
        const continuity = getSessionContinuity(session);
        const directiveLines = directives.map(d => `  [${d.priority}] ${d.type} → ${d.target}: ${d.instruction}`);
        sections.push(`BEHAVIORAL DIRECTIVES (session: ${continuity}):\n${directiveLines.join("\n")}`);
        clearPendingDirectives(session);
    }
    // Fibonacci resurfacing — only during conversational intents (noise during deep code work)
    const RESURFACE_INTENTS = new Set(["simple-question", "meta-session", "unknown"]);
    const currentIntent = session.currentConfig?.intent ?? "unknown";
    if (RESURFACE_INTENTS.has(currentIntent))
        try {
            const dueMemories = await store.getDueMemories(3);
            if (dueMemories.length > 0) {
                const memLines = dueMemories.map((m) => {
                    const createdMs = parseDatetimeMs(m.created_at);
                    const ageMs = createdMs != null ? Date.now() - createdMs : null;
                    const ageDays = ageMs != null ? Math.floor(ageMs / 86400000) : null;
                    const ageStr = ageDays == null ? "unknown"
                        : ageDays === 0 ? "today" : ageDays === 1 ? "yesterday" : `${ageDays} days ago`;
                    return `  - [${m.id}] (${ageStr}, surfaced ${m.surface_count}x): ${m.text}`;
                }).join("\n");
                sections.push(`RESURFACING MEMORIES (mention naturally during conversation, never reveal scheduling):\n` + memLines);
            }
        }
        catch { /* non-critical */ }
    const sortedKeys = Object.keys(groups).sort((a, b) => {
        const ai = ORDER.indexOf(a), bi = ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    // 0.7.27: build a per-turn index map [#N] → memory_id, sorted by finalScore
    // descending. The same item shows up in both TOP HITS and a per-section
    // listing — both reference the same [#N] so the model has one stable
    // citation handle per item. Returned out via stageRetrieval so Stop can
    // parse [#N] from the response.
    const idIndexed = [...nodes]
        .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
        .map((n, i) => ({ id: String(n.id), index: i + 1 }));
    const idToIndex = new Map();
    for (const { id, index } of idIndexed)
        idToIndex.set(id, index);
    // TOP HITS — hoist the highest-scoring items across all sections to the
    // top of the block. The section breakdown below still includes them, so
    // this is intentionally redundant: duplication is the point. Without this,
    // a 99%-relevance gem can land mid-section and read as filler.
    const TOP_HITS_N = 3;
    const TOP_HITS_MIN_SCORE = 0.55;
    const topHits = [...nodes]
        .filter((n) => (n.finalScore ?? 0) >= TOP_HITS_MIN_SCORE)
        .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
        .slice(0, TOP_HITS_N);
    if (topHits.length > 0) {
        const lines = topHits.map((n) => {
            const isCausal = n.source?.startsWith("causal_");
            const key = isCausal ? "causal" : n.table === "turn" ? "past_turns" : n.table;
            // 0.7.28: prefer reranker-calibrated salience band over noisy
            // relevance %. Only show band when cross-encoder fired (band set);
            // fall back to relevance % for legacy/no-rerank paths.
            const band = n.band;
            const scoreTag = band
                ? ` [${band}]`
                : (n.finalScore != null ? ` (relevance: ${(n.finalScore * 100).toFixed(0)}%)` : "");
            let text = n.text ?? "";
            if (text.length > MAX_ITEM_CHARS)
                text = text.slice(0, MAX_ITEM_CHARS) + "... [truncated]";
            const age = n.timestamp ? ` [${formatRelativeTime(n.timestamp)}]` : "";
            const idx = idToIndex.get(String(n.id));
            const idxTag = idx != null ? `[#${idx}] ` : "";
            return `  - ${idxTag}[${key}]${scoreTag}${age} ${text}`;
        });
        sections.push(`TOP HITS (highest relevance — read these first, ground your response on them before any tool call):\n${lines.join("\n")}`);
    }
    for (const key of sortedKeys) {
        const items = groups[key];
        items.sort((a, b) => {
            const sa = a.finalScore ?? 0;
            const sb = b.finalScore ?? 0;
            if (sb !== sa)
                return sb - sa;
            const ta = a.timestamp ? parseDatetimeMs(a.timestamp) ?? 0 : 0;
            const tb = b.timestamp ? parseDatetimeMs(b.timestamp) ?? 0 : 0;
            return tb - ta;
        });
        const label = LABELS[key] ?? key;
        const formatted = items.map((n) => {
            // 0.7.28: same band-vs-relevance logic as TOP HITS for consistency.
            const band = n.band;
            const scoreTag = band
                ? ` [${band}]`
                : (n.finalScore != null ? ` (relevance: ${(n.finalScore * 100).toFixed(0)}%)` : "");
            const via = n.fromNeighbor ? " [via graph link]" : "";
            let text = n.text ?? "";
            // Truncate oversized items (claw-code: MAX_INSTRUCTION_FILE_CHARS pattern)
            if (text.length > MAX_ITEM_CHARS) {
                text = text.slice(0, MAX_ITEM_CHARS) + "... [truncated]";
            }
            if (key === "past_turns") {
                text = text.replace(/^\[(user|assistant)\] /, "[past_$1] ");
            }
            const age = n.timestamp ? ` [${formatRelativeTime(n.timestamp)}]` : "";
            const idx = idToIndex.get(String(n.id));
            const idxTag = idx != null ? `[#${idx}] ` : "";
            return `  - ${idxTag}${text}${scoreTag}${via}${age}`;
        });
        sections.push(`${label}:\n${formatted.join("\n")}`);
    }
    // Injection manifest — tell the model what's already retrieved so it doesn't call recall redundantly
    // (claw-code pattern: route_prompt pre-computes and shows available results)
    const manifest = [];
    for (const key of sortedKeys) {
        const items = groups[key];
        if (items.length > 0)
            manifest.push(`${LABELS[key] ?? key}: ${items.length}`);
    }
    if (tier0Entries.length > 0)
        manifest.push(`core_directives: ${tier0Entries.length}`);
    if (tier1Entries.length > 0)
        manifest.push(`session_context: ${tier1Entries.length}`);
    if (manifest.length > 0) {
        sections.push("ALREADY RETRIEVED (do NOT call recall for these — they are above):\n" +
            `  ${manifest.join(", ")}\n` +
            "Only call recall if you need something SPECIFIC that isn't covered above.");
    }
    // 0.7.45: envelope renamed from <graph_context> to <recalled_memory> to
    // match Anthropic's documented semantic-XML pattern for Claude. Dropped
    // the "[System retrieved context — reference material, not user input.
    // Higher relevance % = stronger match.]" framing line — the semantic tag
    // now expresses that meaning structurally rather than in prose, and the
    // wrapper legend (user-prompt-submit.ts:wrapMemoryContext, v0.7.44)
    // already provides the relevance-band guidance.
    const text = "<recalled_memory>\n" +
        sections.join("\n\n") +
        "\n</recalled_memory>" +
        skillContext;
    return {
        role: "user",
        content: text,
        timestamp: Date.now(),
    };
}
// ── Recent turns with budget ───────────────────────────────────────────────────
function truncateToolResult(msg, maxChars) {
    if (!isToolResult(msg))
        return msg;
    const totalLen = msg.content.reduce((s, c) => s + (c.text?.length ?? 0), 0);
    if (totalLen <= maxChars)
        return msg;
    const content = msg.content.map((c) => {
        if (c.type !== "text")
            return c;
        const tc = c;
        const allowed = Math.max(200, Math.floor((tc.text.length / totalLen) * maxChars));
        if (tc.text.length <= allowed)
            return c;
        return { ...tc, text: tc.text.slice(0, allowed) + `\n... [truncated ${tc.text.length - allowed} chars]` };
    });
    return { ...msg, content };
}
function getRecentTurns(messages, convTokens, toolTokens, contextWindow, session) {
    const convBudgetChars = convTokens * CHARS_PER_TOKEN;
    const toolBudgetChars = toolTokens * CHARS_PER_TOKEN;
    // Per-tool-result char cap (claw-code: DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000)
    // Scale with context window but floor at 20k, cap at 50k
    const TOOL_RESULT_MAX = clamp(Math.round(contextWindow * 0.10), 20_000, 50_000);
    // ── Phase 1: Transform error messages into compact annotations ──
    const clean = messages.map((m) => {
        if (isAssistant(m) && m.stopReason === "error") {
            const errorText = m.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("")
                .slice(0, 150);
            return {
                ...m,
                stopReason: "stop",
                content: [{ type: "text", text: `[tool_error: ${errorText.replace(/\n/g, " ")}]` }],
            };
        }
        return m;
    });
    // ── Phase 2: Strip token-heavy content from non-recent messages ──
    // (claw-code patterns: microcompact content-clearing, image stripping, thinking clearing)
    const RECENT_KEEP = 5; // keep last N groups fully intact
    const msgCount = clean.length;
    // Find recency boundary: messages in the last RECENT_KEEP groups stay intact
    // We need to identify which messages are "old" vs "recent"
    // Count groups from the end to find the boundary index
    let recentBoundary = msgCount;
    {
        let groupsSeen = 0;
        for (let k = clean.length - 1; k >= 0 && groupsSeen < RECENT_KEEP; k--) {
            recentBoundary = k;
            const msg = clean[k];
            // Each user message or standalone assistant message starts a new group
            if (isUser(msg) || (isAssistant(msg) && !msg.content.some((c) => c.type === "toolCall"))) {
                groupsSeen++;
            }
            else if (isAssistant(msg) && msg.content.some((c) => c.type === "toolCall")) {
                groupsSeen++;
                // Skip past associated tool results (they're part of this group)
            }
        }
    }
    // Apply stripping to messages before the recency boundary
    for (let k = 0; k < recentBoundary; k++) {
        const msg = clean[k];
        if (!msg.content || !Array.isArray(msg.content))
            continue;
        // Collapse old assistant filler text (agentic loop: "I'll now read..." / "Let me check...")
        // Keep tool calls intact but shrink prose to 1-line summary
        if (isAssistant(clean[k]) && msg.content.some((c) => c.type === "toolCall")) {
            msg.content = msg.content.map((c) => {
                if (c.type === "text" && c.text && c.text.length > 120) {
                    // Keep first line as summary (usually the intent statement)
                    const firstLine = c.text.split(/\r?\n/)[0].slice(0, 120);
                    return { ...c, text: firstLine };
                }
                if (c.type === "thinking") {
                    return { type: "text", text: "[thinking]" };
                }
                return c; // preserve toolCall blocks
            });
            continue; // skip generic stripping for this message
        }
        msg.content = msg.content.map((c) => {
            // Strip thinking blocks → [thinking] marker (often 1-5k tokens each)
            if (c.type === "thinking") {
                return { type: "text", text: "[thinking]" };
            }
            // Strip images → [image] marker (2000 tokens each)
            if (c.type === "image" || c.type === "image_url" || (c.type === "source" && c.media_type?.startsWith("image/"))) {
                return { type: "text", text: "[image]" };
            }
            // Content-clear old tool results → stub (claw-code: microcompact pattern)
            if (c.type === "toolResult" && Array.isArray(c.content)) {
                const stub = c.content.map((rc) => {
                    if (rc.type === "text" && rc.text && rc.text.length > 200) {
                        return { ...rc, text: `[Old tool result cleared — ${rc.text.length} chars]` };
                    }
                    if (rc.type === "image" || rc.type === "image_url") {
                        return { type: "text", text: "[image]" };
                    }
                    return rc;
                });
                return { ...c, content: stub };
            }
            // For tool result messages (top-level), clear oversized text blocks
            if (c.type === "text" && isToolResult(clean[k]) && c.text && c.text.length > 200) {
                return { ...c, text: `[Old tool result cleared — ${c.text.length} chars]` };
            }
            return c;
        });
    }
    // ── Phase 3: Group messages into structural units ──
    const groups = [];
    let i = 0;
    while (i < clean.length) {
        const msg = clean[i];
        if (isAssistant(msg) && msg.content.some((c) => c.type === "toolCall")) {
            const group = [clean[i]];
            let j = i + 1;
            while (j < clean.length && isToolResult(clean[j])) {
                group.push(truncateToolResult(clean[j], TOOL_RESULT_MAX));
                j++;
            }
            groups.push(group);
            i = j;
        }
        else {
            groups.push([clean[i]]);
            i++;
        }
    }
    // Pin originating user message
    let pinnedGroup = null;
    let pinnedGroupIdx = -1;
    for (let g = 0; g < groups.length; g++) {
        if (isUser(groups[g][0])) {
            pinnedGroup = groups[g];
            pinnedGroupIdx = g;
            break;
        }
    }
    // Measure pinned group against both budgets
    let pinnedConv = 0;
    let pinnedTool = 0;
    if (pinnedGroup) {
        for (const m of pinnedGroup) {
            if (isToolResult(m))
                pinnedTool += msgCharLen(m);
            else
                pinnedConv += msgCharLen(m);
        }
    }
    // Take groups from end within split budgets
    const remainingConv = convBudgetChars - pinnedConv;
    const remainingTool = toolBudgetChars - pinnedTool;
    let convUsed = 0;
    let toolUsed = 0;
    const selectedGroups = [];
    for (let g = groups.length - 1; g >= 0; g--) {
        if (g === pinnedGroupIdx)
            continue;
        let groupConv = 0;
        let groupTool = 0;
        for (const m of groups[g]) {
            if (isToolResult(m))
                groupTool += msgCharLen(m);
            else
                groupConv += msgCharLen(m);
        }
        // Stop if either budget would overflow (but always include at least one group)
        if (selectedGroups.length > 0) {
            if (convUsed + groupConv > remainingConv)
                break;
            if (groupTool > 0 && toolUsed + groupTool > remainingTool)
                break;
        }
        selectedGroups.unshift(groups[g]);
        convUsed += groupConv;
        toolUsed += groupTool;
    }
    if (pinnedGroup && pinnedGroupIdx !== -1) {
        const alreadyIncluded = selectedGroups.some((g) => g === groups[pinnedGroupIdx]);
        if (!alreadyIncluded) {
            selectedGroups.unshift(pinnedGroup);
        }
    }
    // Detect if old messages (containing previous context injection) were dropped from the window.
    // If so, clear injectedSections so static content gets re-injected next turn.
    if (session && messages.length > 0 && groups.length > 0) {
        const firstOriginal = groups[0];
        const firstSelected = selectedGroups[0];
        if (firstOriginal !== firstSelected) {
            // Preserve tier0 flag — it lives in the system prompt (prefix-cached)
            // and doesn't need re-injection into the user message. Clearing it
            // caused tier-0 to appear in BOTH system prompt AND active_directives
            // after every window compaction.
            const hadTier0 = session.injectedSections.has("tier0");
            session.injectedSections.clear();
            if (hadTier0)
                session.injectedSections.add("tier0");
        }
    }
    return selectedGroups.flat();
}
// ── graphTransformContext error-rate tracking ──
// Sliding window of recent call outcomes for observability alerting.
const _recentCalls = [];
const WINDOW_MS = 10 * 60_000; // 10 minutes
export function recordTransformOutcome(ok) {
    const now = Date.now();
    _recentCalls.push({ ts: now, ok });
    // Trim entries older than the window
    while (_recentCalls.length > 0 && _recentCalls[0].ts < now - WINDOW_MS) {
        _recentCalls.shift();
    }
}
export function resetTransformErrorRate() { _recentCalls.length = 0; }
export function getTransformErrorRate() {
    const now = Date.now();
    const recent = _recentCalls.filter(c => c.ts >= now - WINDOW_MS);
    const failures = recent.filter(c => !c.ok).length;
    return { total: recent.length, failures, rate: recent.length > 0 ? failures / recent.length : 0 };
}
/** Transform deadline: env override, else a CPU-aware default. The original
 *  fixed 15s was tuned for GPU-era embed+rerank latency; the 2026-06-04
 *  switch of the daemon to CPU-only mode tripped it constantly (daemon.log:
 *  "graphTransformContext timed out" spam → raw-message fallback on every
 *  affected prompt). LAQRUMCODE_NO_GPU=1 is set by gpu-pin.ts at daemon startup
 *  when CPU mode is configured, so the default self-adjusts. Exported for
 *  tests. Resolved per call (not at import) so it sees the post-pin env. */
export function resolveTransformTimeoutMs(env = process.env) {
    const override = Number(env.LAQRUMCODE_TRANSFORM_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0)
        return Math.floor(override);
    return env.LAQRUMCODE_NO_GPU === "1" ? 45_000 : 15_000;
}
function formatStageTrace(trace, startedAt, diedAt) {
    if (trace.marks.length === 0)
        return "no stages reached";
    const parts = [];
    for (let i = 0; i < trace.marks.length; i++) {
        const m = trace.marks[i];
        const end = i + 1 < trace.marks.length ? trace.marks[i + 1].at : diedAt;
        parts.push(`${m.stage}@+${m.at - startedAt}ms(${end - m.at}ms)`);
    }
    return `${parts.join(" → ")} [died in: ${trace.marks[trace.marks.length - 1].stage}]`;
}
export async function graphTransformContext(params) {
    const { messages, session, store, embeddings, signal } = params;
    const contextWindow = params.contextWindow ?? 200000;
    const budgets = calcBudgets(contextWindow);
    // Build static system prompt section for API prefix caching.
    // Done here (wrapper) so it attaches to any inner return path.
    // (claw-code pattern: static sections above __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__)
    let systemPromptSection;
    let tier0ForSys = [];
    try {
        tier0ForSys = store.isAvailable()
            ? applyCoreBudget(await store.getAllCoreMemory(0), getTier0BudgetChars(budgets))
            : [];
        systemPromptSection = buildSystemPromptSection(session, tier0ForSys);
        // Mark sections as injected so formatContextMessage() skips them (prevents duplication)
        if (systemPromptSection) {
            if (systemPromptSection.includes("GRAPH PILLARS"))
                session.injectedSections.add("ilaqrum");
            if (systemPromptSection.includes("CORE DIRECTIVES"))
                session.injectedSections.add("tier0");
        }
    }
    catch { /* non-critical — tier0 will still appear in user message */ }
    // Never throw — return raw messages on any failure
    let transformTimer;
    const TRANSFORM_TIMEOUT_MS = resolveTransformTimeoutMs();
    const transformStartedAt = Date.now();
    const stageTrace = { marks: [] };
    try {
        const result = await Promise.race([
            graphTransformInner(messages, session, store, embeddings, contextWindow, budgets, signal, tier0ForSys, stageTrace),
            new Promise((_, reject) => {
                transformTimer = setTimeout(() => reject(new Error("graphTransformContext timed out")), TRANSFORM_TIMEOUT_MS);
            }),
        ]);
        recordTransformOutcome(true);
        result.systemPromptSection = systemPromptSection;
        return result;
    }
    catch (err) {
        recordTransformOutcome(false);
        const diedAt = Date.now();
        log.error(`graphTransformContext fatal error after ${diedAt - transformStartedAt}ms ` +
            `(timeout=${TRANSFORM_TIMEOUT_MS}ms), returning raw messages. ` +
            `Stage timings: ${formatStageTrace(stageTrace, transformStartedAt, diedAt)}:`, err);
        return {
            messages,
            stats: {
                fullHistoryTokens: estimateTokens(messages),
                sentTokens: estimateTokens(messages),
                savedTokens: 0,
                reductionPct: 0,
                graphNodes: 0,
                neighborNodes: 0,
                recentTurns: messages.length,
                mode: "passthrough",
                prefetchHit: false,
            },
            systemPromptSection,
        };
    }
    finally {
        // Clear so a fast-resolving graphTransformInner doesn't leave a 15s
        // pending Timeout per transform call — the daemon handles every user
        // prompt through this path, so the leak compounds quickly.
        if (transformTimer !== undefined)
            clearTimeout(transformTimer);
    }
}
async function graphTransformInner(messages, session, store, embeddings, contextWindow, budgets, signal, 
/** Tier 0 entries already fetched by wrapper — avoids double DB fetch. */
tier0FromWrapper = [], 
/** B17 stage trace owned by the wrapper — marks stage STARTS. */
stageTrace) {
    const mark = (stage) => { stageTrace?.marks.push({ stage, at: Date.now() }); };
    // K6-gc: honor the deadline AbortSignal. The wrapper's Promise.race rejects
    // on timeout and returns raw messages, but the inner pipeline kept running —
    // a leaked, post-deadline computation that still burned CPU and (worse) wrote
    // a stale entry into the prefetch cache after the caller had moved on. We
    // check the signal at each stage boundary and throw, which the inner try/catch
    // (or the wrapper) turns into the same recency-only/passthrough fallback the
    // timeout already returned. Cheap stages aren't gated; the expensive rerank
    // and the cache WRITE are gated explicitly below.
    const checkAbort = () => {
        if (signal?.aborted)
            throw new Error("graphTransformInner aborted (deadline exceeded)");
    };
    function makeStats(sent, graphNodes, neighborNodes, recentTurnCount, mode, prefetchHit = false) {
        const fullHistoryTokens = estimateTokens(messages);
        const sentTokens = estimateTokens(sent);
        return {
            fullHistoryTokens, sentTokens,
            savedTokens: Math.max(0, fullHistoryTokens - sentTokens),
            reductionPct: fullHistoryTokens > 0 ? (Math.max(0, fullHistoryTokens - sentTokens) / fullHistoryTokens) * 100 : 0,
            graphNodes, neighborNodes, recentTurns: recentTurnCount, mode, prefetchHit,
        };
    }
    // Derive retrieval config from session's current adaptive config
    const config = session.currentConfig;
    const skipRetrieval = config?.skipRetrieval ?? false;
    // Skip retrieval fast path — avoid DB queries entirely when model already has core memory
    // (claw-code pattern: simple_mode skips the load, not load-then-discard)
    if (skipRetrieval)
        mark("skip-retrieval");
    if (skipRetrieval) {
        const recentTurns = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
        // If model already saw core memory, just return recent turns + compressed rules. Zero DB queries.
        if (session.injectedSections.has("tier0")) {
            return { messages: injectRulesSuffix(recentTurns, session), stats: makeStats(recentTurns, 0, 0, recentTurns.length, "passthrough") };
        }
        // First turn or after compaction cleared injectedSections — load and inject
        let tier0 = [];
        let tier1 = [];
        try {
            [tier0, tier1] = await Promise.all([
                store.getAllCoreMemory(0),
                store.getAllCoreMemory(1),
            ]);
            tier0 = applyCoreBudget(tier0, getTier0BudgetChars(budgets));
            tier1 = applyCoreBudget(tier1, getTier1BudgetChars(budgets));
        }
        catch (e) {
            log.warn("Core memory load failed:", e);
        }
        if (tier0.length > 0 || tier1.length > 0) {
            const coreContext = await formatContextMessage([], store, session, "", tier0, tier1);
            const result = [coreContext, ...recentTurns];
            return { messages: injectRulesSuffix(result, session), stats: makeStats(result, 0, 0, recentTurns.length, "passthrough") };
        }
        return { messages: injectRulesSuffix(recentTurns, session), stats: makeStats(recentTurns, 0, 0, recentTurns.length, "passthrough") };
    }
    // Load tiered core memory (full retrieval path)
    mark("core-memory");
    let tier0 = [];
    let tier1 = [];
    try {
        // Tier 0 already fetched by wrapper (avoids double DB query)
        tier0 = tier0FromWrapper.length > 0
            ? tier0FromWrapper
            : applyCoreBudget(await store.getAllCoreMemory(0), getTier0BudgetChars(budgets));
        tier1 = applyCoreBudget(await store.getAllCoreMemory(1), getTier1BudgetChars(budgets));
    }
    catch (e) {
        swallow.warn("graph-context:coreMemoryLoad", e);
    }
    // Graceful degradation
    const embeddingsUp = embeddings.isAvailable();
    const surrealUp = store.isAvailable();
    if (!embeddingsUp || !surrealUp) {
        const recentTurns = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
        if (tier0.length > 0 || tier1.length > 0) {
            const coreContext = await formatContextMessage([], store, session, "", tier0, tier1);
            const result = [coreContext, ...recentTurns];
            return { messages: injectRulesSuffix(result, session), stats: makeStats(result, 0, 0, recentTurns.length, "recency-only") };
        }
        return { messages: injectRulesSuffix(recentTurns, session), stats: makeStats(recentTurns, 0, 0, recentTurns.length, "recency-only") };
    }
    const queryText = extractLastUserText(messages);
    if (!queryText) {
        return { messages: injectRulesSuffix(messages, session), stats: makeStats(messages, 0, 0, messages.length, "passthrough") };
    }
    const currentIntent = config?.intent ?? "unknown";
    const baseLimits = config?.vectorSearchLimits ?? {
        turn: 25, identity: 10, concept: 35, memory: 20, artifact: 10,
    };
    // Scale search limits with context window — larger windows can use more results
    const cwScale = clamp(contextWindow / 200_000, 0.5, 2.0);
    const vectorSearchLimits = {
        turn: Math.round((baseLimits.turn ?? 25) * cwScale),
        identity: baseLimits.identity, // always load full identity
        concept: Math.round((baseLimits.concept ?? 20) * cwScale),
        memory: Math.round((baseLimits.memory ?? 20) * cwScale),
        artifact: Math.round((baseLimits.artifact ?? 10) * cwScale),
        monologue: Math.round(8 * cwScale),
    };
    let tokenBudget = Math.min(config?.tokenBudget ?? 6000, budgets.retrieval);
    try {
        mark("query-vec");
        const queryVec = await buildContextualQueryVec(queryText, messages, embeddings, session);
        session.lastQueryVec = queryVec; // Stash for redundant recall detection
        // Prefetch cache check — scope to (sessionId, projectId) so session B
        // never receives session A's project-filtered hits.
        const cached = getCachedContext(queryVec, session.sessionId, session.projectId || undefined);
        if (cached && cached.results.length > 0) {
            recordPrefetchHit();
            const suppressed = getSuppressedNodeIds(session);
            const filteredCached = cached.results.filter(r => !suppressed.has(r.id));
            mark("prefetch-rank");
            await mergeAccessDeltas(store, filteredCached);
            const ranked = await scoreResults(filteredCached, new Set(), queryVec, store, currentIntent);
            const deduped = deduplicateResults(ranked);
            checkAbort(); // K6-gc: don't burn the CPU-bound cross-encoder post-deadline
            const reranked = await rerankResults(deduped, queryText);
            applyDistributionBands(reranked);
            const diversified = mmrReorder(reranked);
            let contextNodes = takeWithConstraints(diversified, tokenBudget, budgets.maxContextItems);
            contextNodes = await ensureRecentTurns(contextNodes, session, store);
            if (contextNodes.length > 0) {
                // K6-gc / R10: bump + stage only if the caller hasn't abandoned us on
                // the deadline. The rerankResults() above is the CPU-bound stage that
                // can overrun the deadline; a post-deadline completion here would bump
                // access counts (polluting the ACAN signal) and seed Stop's
                // evaluateRetrieval indexMap with a result the assembler discarded.
                // Same `!signal?.aborted` guard as the main path + the cache write.
                if (!signal?.aborted) {
                    if (contextNodes.filter((n) => n.table === "concept" || n.table === "memory").length > 0) {
                        store.bumpAccessCounts(contextNodes.filter((n) => n.table === "concept" || n.table === "memory").map((n) => n.id)).catch(e => swallow.warn("graph-context:bumpAccess", e));
                    }
                    // 0.7.27: build the [#N] → memory_id map from the final ordered list
                    // and hand it to stageRetrieval so Stop's evaluateRetrieval can parse
                    // [#N] citations out of the assistant response.
                    const stageIndexMap = new Map();
                    [...contextNodes]
                        .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
                        .forEach((n, i) => stageIndexMap.set(i + 1, String(n.id)));
                    stageRetrieval(session.sessionId, contextNodes, queryVec, stageIndexMap);
                }
                const skillCtx = cached.skills.length > 0 ? formatSkillContext(cached.skills) : "";
                if (cached.skills.length > 0)
                    stageSkills(session.sessionId, cached.skills.map(s => ({ id: s.id, text: `${s.name}: ${s.description}` })));
                const reflCtx = cached.reflections.length > 0 ? formatReflectionContext(cached.reflections) : "";
                const injectedContext = await formatContextMessage(contextNodes, store, session, skillCtx + reflCtx, tier0, tier1);
                const recentTurns = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
                const result = [injectedContext, ...recentTurns];
                return { messages: injectRulesSuffix(result, session), stats: makeStats(result, contextNodes.length, 0, recentTurns.length, "graph", true) };
            }
        }
        // Vector search + tag-boosted retrieval (cache miss path, run in parallel)
        recordPrefetchMiss();
        mark("vector-search");
        let [vectorResultsRaw, tagResults] = await Promise.all([
            store.vectorSearch(queryVec, session.sessionId, vectorSearchLimits, isACANActive(), session.projectId || undefined),
            store.tagBoostedConcepts(queryText, queryVec, 10).catch(e => { swallow.warn("graph-context:tagBoost", e); return []; }),
        ]);
        // 0.7.46: cross-project fallback. The scoped pass above hard-filters
        // by (project_id IS NONE OR project_id = $pid OR scope = 'global'). A
        // misassigned project_id (v0.7.36 centroid heuristic can mistag) makes
        // a row invisible at any cosine. When the scoped pass surfaces nothing,
        // retry without the filter so high-relevance hits still reach injection.
        if (vectorResultsRaw.length === 0 && session.projectId) {
            log.warn(`[graph-context] project-scoped retrieval empty for session=${session.sessionId} project=${session.projectId} — falling back to cross-project search`);
            vectorResultsRaw = await store.vectorSearch(queryVec, session.sessionId, vectorSearchLimits, isACANActive(), undefined);
        }
        // Filter out the user's just-stored turn(s): vector search would otherwise
        // rank the just-typed prompt's embedding ~60% to itself and echo back as
        // "Past Conversation," wasting tokens. 5-second cutoff excludes only the
        // very recent stores; legitimate older context still surfaces.
        const recentCutoffMs = Date.now() - 5_000;
        const vectorResults = vectorResultsRaw.filter((r) => {
            if (r.table !== "turn")
                return true;
            const ts = parseDatetimeMs(r.timestamp) ?? 0;
            return ts > 0 && ts < recentCutoffMs;
        });
        // Merge: dedupe tag results against vector results, then combine
        const vectorIds = new Set(vectorResults.map(r => r.id));
        const uniqueTagResults = tagResults.filter(r => !vectorIds.has(r.id));
        const results = [...vectorResults, ...uniqueTagResults];
        // Graph neighbor expansion
        const topIds = results
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, 20)
            .map((r) => r.id);
        const DEEP_INTENTS = new Set(["code-debug", "deep-explore", "multi-step", "reference-prior"]);
        const graphHops = DEEP_INTENTS.has(currentIntent) ? 2 : 1;
        // Graph expand + causal traversal run in parallel (both depend only on topIds)
        // 0.7.34: collapsed 3 nested Set rebuilds (existingIds, neighborIds,
        // allExisting) into a single accumulator that grows as results land.
        // Each filter pass uses the same Set; new ids are added in-place via
        // the for-of loops. Behavior identical, fewer allocations.
        let neighborResults = [];
        let causalResults = [];
        const seen = new Set(results.map((r) => r.id));
        const neighborIds = new Set();
        // Fire graph expansion, causal traversal, skills, and reflections in parallel.
        // Skills + reflections only need queryVec — no dependency on graph results.
        const SKILL_INTENTS = new Set(["code-write", "code-debug", "multi-step", "code-read"]);
        mark("graph-expand");
        const [expandResult, causalResult, skillsFound, reflectionsFound] = await Promise.all([
            topIds.length > 0
                ? store.graphExpand(topIds, queryVec, graphHops).catch(e => { swallow.error("graph-context:graphExpand", e); return []; })
                : Promise.resolve([]),
            topIds.length > 0 && queryVec
                ? queryCausalContext(topIds, queryVec, 2, 0.4, store).catch(e => { swallow("graph-context:causal", e); return []; })
                : Promise.resolve([]),
            SKILL_INTENTS.has(currentIntent)
                ? findRelevantSkills(queryVec, 5, store, { queryText, rerank: crossEncoderScorePairs }).catch(e => { swallow("graph-context:skills", e); return []; })
                : Promise.resolve([]),
            retrieveReflections(queryVec, 5, store, session.projectId || undefined)
                .catch(e => { swallow("graph-context:reflections", e); return []; }),
        ]);
        for (const n of expandResult) {
            if (!seen.has(n.id)) {
                neighborResults.push(n);
                neighborIds.add(n.id);
                seen.add(n.id);
            }
        }
        for (const c of causalResult) {
            if (!seen.has(c.id)) {
                causalResults.push(c);
                neighborIds.add(c.id);
                seen.add(c.id);
            }
        }
        // Combine, filter, score
        const suppressed = getSuppressedNodeIds(session);
        const allResults = [...results, ...neighborResults, ...causalResults]
            .filter(r => !suppressed.has(r.id))
            .filter(r => r.table === "turn" && r.sessionId === session.sessionId
            ? true
            : (r.score ?? 0) >= MIN_COSINE);
        mark("score-rerank");
        await mergeAccessDeltas(store, allResults);
        const ranked = await scoreResults(allResults, neighborIds, queryVec, store, currentIntent);
        const deduped = deduplicateResults(ranked);
        checkAbort(); // K6-gc: don't burn the CPU-bound cross-encoder post-deadline
        const reranked = await rerankResults(deduped, queryText);
        applyDistributionBands(reranked);
        let contextNodes = takeWithConstraints(reranked, tokenBudget, budgets.maxContextItems);
        mark("recent-turns");
        contextNodes = await ensureRecentTurns(contextNodes, session, store);
        if (contextNodes.length === 0) {
            const result = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
            return { messages: injectRulesSuffix(result, session), stats: makeStats(result, 0, 0, result.length, "graph") };
        }
        // K6-gc / R10: bump access counts + stage retrieval ONLY if the caller
        // hasn't abandoned us on the deadline. A post-deadline completion that
        // bumped access counts would pollute the ACAN access signal and over-credit
        // items the assembler already discarded; staging would seed Stop's
        // evaluateRetrieval / indexMap with a result the user never saw. Gated with
        // the same `!signal?.aborted` idiom as the prefetch-cache write below.
        if (!signal?.aborted) {
            // Bump access counts
            const retrievedIds = contextNodes
                .filter((n) => n.table === "concept" || n.table === "memory")
                .map((n) => n.id);
            if (retrievedIds.length > 0) {
                store.bumpAccessCounts(retrievedIds).catch(e => swallow.warn("graph-context:bumpAccess", e));
            }
            // 0.7.27: build the [#N] → memory_id map from the final ordered list and
            // hand it to stageRetrieval so Stop's evaluateRetrieval can parse [#N]
            // citations out of the assistant response.
            const stageIndexMap = new Map();
            [...contextNodes]
                .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
                .forEach((n, i) => stageIndexMap.set(i + 1, String(n.id)));
            stageRetrieval(session.sessionId, contextNodes, queryVec, stageIndexMap);
        }
        // Format skill + reflection context (arrays already retrieved in parallel above)
        let skillContext = "";
        if (skillsFound.length > 0) {
            skillContext = formatSkillContext(skillsFound);
            stageSkills(session.sessionId, skillsFound.map(s => ({ id: s.id, text: `${s.name}: ${s.description}` })));
        }
        let reflectionContext = "";
        if (reflectionsFound.length > 0)
            reflectionContext = formatReflectionContext(reflectionsFound);
        // Write full pipeline results back to prefetch cache for subsequent similar
        // queries. K6-gc: skip the write if the caller already abandoned us on the
        // deadline — caching a result the assembler discarded would serve a stale,
        // late-completing entry to the NEXT turn under a cache hit.
        if (!signal?.aborted) {
            setCachedContext(queryVec, contextNodes, skillsFound, reflectionsFound, session.sessionId, session.projectId || undefined);
        }
        mark("format-context");
        const injectedContext = await formatContextMessage(contextNodes, store, session, skillContext + reflectionContext, tier0, tier1);
        const recentTurns = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
        const result = [injectedContext, ...recentTurns];
        return {
            messages: injectRulesSuffix(result, session),
            stats: makeStats(result, contextNodes.filter((n) => !n.fromNeighbor).length, contextNodes.filter((n) => n.fromNeighbor).length, recentTurns.length, "graph"),
        };
    }
    catch (err) {
        log.error("Graph context error, falling back:", err);
        const result = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
        return { messages: injectRulesSuffix(result, session), stats: makeStats(result, 0, 0, result.length, "recency-only") };
    }
}
