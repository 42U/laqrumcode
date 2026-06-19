/**
 * Graph-based context transformation for KongCode.
 *
 * Core retrieval pipeline: vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format.
 */

import type {
  AgentMessage, UserMessage, AssistantMessage, ToolResultMessage,
  TextContent, ThinkingContent, ToolCall, ImageContent,
} from "./types.js";
import type { SurrealStore, VectorSearchResult, CoreMemoryEntry } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
import type { SessionState } from "./state.js";
import { getPendingDirectives, clearPendingDirectives, getSessionContinuity, getSuppressedNodeIds } from "./cognitive-check.js";
import { queryCausalContext } from "./causal.js";
import { findRelevantSkills, formatSkillContext } from "./skills.js";
import { retrieveReflections, formatReflectionContext } from "./reflection.js";
import { getCachedContext, setCachedContext, recordPrefetchHit, recordPrefetchMiss } from "./prefetch.js";
import { stageRetrieval, stageSkills, getHistoricalUtilityBatch, getLastTurnGroundingTrace } from "./retrieval-quality.js";
import { isACANActive, scoreWithACAN, type ACANCandidate } from "./acan.js";
import { swallow } from "./errors.js";
import { clamp } from "./math.js";
import { log } from "./log.js";
import type { LlamaRankingContext, Token } from "node-llama-cpp";
import type { ResourceProfile } from "./resource-tier.js";

// ── Cross-encoder reranker (bge-reranker-v2-m3) ──────────────────────────────
let _rankingCtx: LlamaRankingContext | null = null;
let _rerankerModelPath: string | null = null;
let _rerankerProfile: ResourceProfile | null = null;
let _rerankerInitializing: Promise<void> | null = null;
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
const RERANK_MAX_DOC_TOKENS = Number(process.env.KONGCODE_RERANK_MAX_DOC_TOKENS) || 512;
const RERANK_QUERY_MAX_TOKENS = Number(process.env.KONGCODE_RERANK_QUERY_MAX_TOKENS) || 512;
const RERANK_TOTAL_TOKEN_BUDGET = Number(process.env.KONGCODE_RERANK_TOTAL_TOKEN_BUDGET) || 8192;
const RERANK_CHUNK_SIZE = Number(process.env.KONGCODE_RERANK_CHUNK_SIZE) || 6;

/** Tokenize + cap to a fixed token budget, returning Token[] for rankAll. Passing
 *  tokens (not a char-truncated string) gives EXACT length control: a char cap
 *  can't bound tokens on CJK/code-dense text, which would overflow the model
 *  window and make rankAll throw. Bounded tokens = bounded, hardware-independent
 *  rerank cost. */
function capTokens(text: string, maxTokens: number): Token[] {
  if (!_rankingCtx) return [];
  const t = _rankingCtx.model.tokenize(text);
  return t.length > maxTokens ? t.slice(0, maxTokens) : t;
}

export function configureReranker(modelPath: string, profile?: ResourceProfile): void {
  _rerankerModelPath = modelPath;
  _rerankerProfile = profile ?? null;
}

async function ensureRerankerLoaded(): Promise<boolean> {
  if (_rankingCtx) return true;
  if (!_rerankerModelPath) return false;
  if (_rerankerInitializing) { await _rerankerInitializing; return _rankingCtx !== null; }
  _rerankerInitializing = (async () => {
    try {
      const { getSharedLlama } = await import("./llama-loader.js");
      const llama = await getSharedLlama(_rerankerProfile ?? undefined);
      const model = await llama.loadModel({ modelPath: _rerankerModelPath! });
      _rankingCtx = await model.createRankingContext();
      log.warn("[rerank] Cross-encoder reranker loaded (lazy).");
    } catch (e) {
      swallow.warn("graph-context:initReranker(lazy) failed — retrieval will work without reranking", e);
      _rankingCtx = null;
    } finally {
      _rerankerInitializing = null;
    }
  })();
  await _rerankerInitializing;
  return _rankingCtx !== null;
}

export async function initReranker(modelPath: string): Promise<void> {
  try {
    const { getSharedLlama } = await import("./llama-loader.js");
    const llama = await getSharedLlama();
    const model = await llama.loadModel({ modelPath });
    _rankingCtx = await model.createRankingContext();
    log.warn("[rerank] Cross-encoder reranker loaded.");
  } catch (e) {
    swallow.warn("graph-context:initReranker failed — retrieval will work without reranking", e);
    _rankingCtx = null;
  }
}

export async function disposeReranker(): Promise<void> {
  if (_rankingCtx) {
    try { await _rankingCtx.dispose(); } catch { /* ignore */ }
    _rankingCtx = null;
  }
}

export function isRerankerActive(): boolean { return _rankingCtx !== null; }

export async function crossEncoderScorePairs(
  anchor: string,
  docs: string[],
): Promise<number[] | null> {
  if (!_rankingCtx || docs.length === 0) return null;
  try {
    const anchorTokens = capTokens(anchor, RERANK_QUERY_MAX_TOKENS);
    const docTokens = docs.map(d => capTokens(d, RERANK_MAX_DOC_TOKENS));
    const scores: number[] = new Array(docTokens.length);
    for (let start = 0; start < docTokens.length; start += RERANK_CHUNK_SIZE) {
      const end = Math.min(start + RERANK_CHUNK_SIZE, docTokens.length);
      const chunk = await _rankingCtx.rankAll(anchorTokens, docTokens.slice(start, end));
      for (let i = 0; i < chunk.length; i++) scores[start + i] = chunk[i];
      if (end < docTokens.length) await new Promise<void>(r => setImmediate(r));
    }
    return scores;
  } catch {
    return null;
  }
}

/** 0.7.28: classify a cross-encoder sigmoid score [0,1] into a salience band.
 *  Per GroGU (arxiv 2601.23129), raw scores are weakly predictive of LLM
 *  grounding utility, but cross-encoder calibrated probabilities at >0.7
 *  are reliable signal. Bands give the model a coarse anchor that survives
 *  embedder swaps and per-query distribution variance. */
export type SalienceBand = "load-bearing" | "supporting" | "background";
export const BAND_LOAD_BEARING_MIN = 0.7;
export const BAND_SUPPORTING_MIN = 0.3;
export const BAND_DROP_BELOW = 0.15;

export function bandFor(crossScore: number): SalienceBand {
  if (crossScore >= BAND_LOAD_BEARING_MIN) return "load-bearing";
  if (crossScore >= BAND_SUPPORTING_MIN) return "supporting";
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
export function applyDistributionBands<T extends { finalScore?: number; band?: SalienceBand }>(items: T[]): void {
  if (items.length === 0) return;
  if (items.some(n => n.band !== undefined)) return; // rerank already ran
  const scores = items.map(n => n.finalScore ?? 0).sort((a, b) => a - b);
  const q1 = scores[Math.floor(scores.length * 0.25)];
  const q3 = scores[Math.floor(scores.length * 0.75)];
  if (q1 === q3) {
    for (const n of items) n.band = "supporting";
    return;
  }
  for (const n of items) {
    const s = n.finalScore ?? 0;
    if (s >= q3) n.band = "load-bearing";
    else if (s >= q1) n.band = "supporting";
    else n.band = "background";
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
async function rerankResults<T extends { id: string; text?: string; finalScore: number; crossScore?: number; band?: SalienceBand }>(
  deduped: T[],
  queryText: string,
): Promise<T[]> {
  if (deduped.length <= 5) return deduped;
  const loaded = await ensureRerankerLoaded();
  if (!loaded || !_rankingCtx) return deduped;
  try {
    const topN = Math.min(RERANK_TOP_N, deduped.length);
    const candidates = deduped.slice(0, topN);
    const qTokens = capTokens(queryText, RERANK_QUERY_MAX_TOKENS);
    // Token-cap each doc and accumulate until the per-batch token budget is hit.
    // `candidates` are WMR/ACAN-sorted desc, so the budget keeps the HIGHEST-scored
    // ones; the rest (lowest-WMR within top-N, only in rare outlier-heavy batches)
    // bypass the cross-encoder and are dropped — same contract as the tail-drop.
    // This bounds total rerank work to a hardware-independent constant.
    const docTokens: Token[][] = [];
    let budget = RERANK_TOTAL_TOKEN_BUDGET;
    for (const c of candidates) {
      const dt = capTokens(c.text ?? "", RERANK_MAX_DOC_TOKENS);
      if (docTokens.length > 0 && dt.length > budget) break;
      budget -= dt.length;
      docTokens.push(dt);
    }
    const scored = candidates.slice(0, docTokens.length);
    const crossScores: number[] = new Array(docTokens.length);
    for (let start = 0; start < docTokens.length; start += RERANK_CHUNK_SIZE) {
      const end = Math.min(start + RERANK_CHUNK_SIZE, docTokens.length);
      const chunkScores = await _rankingCtx.rankAll(qTokens, docTokens.slice(start, end));
      for (let i = 0; i < chunkScores.length; i++) {
        crossScores[start + i] = chunkScores[i];
      }
      if (end < docTokens.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
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
    // Items not cross-scored (tail past top-N, or past the token budget) are
    // dropped: shipping un-reranked items injects noise the user can't account for.
    return survivors;
  } catch (e) {
    swallow.warn("graph-context:rerankResults failed — using WMR scores", e);
    return deduped;
  }
}

// ── Message type guards ────────────────────────────────────────────────────────

type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

/**
 * Loose content block type for message stripping — covers the full range of
 * block shapes that may appear in pi-ai messages beyond the typed union
 * (e.g., toolResult blocks with nested content, image_url, source).
 */
type AnyContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  media_type?: string;
  content?: AnyContentBlock[];
  [key: string]: unknown;
};

/** Mutable view of a message for in-place content stripping. */
type MutableMessage = { role: string; content: AnyContentBlock[] | string };

function isUser(msg: AgentMessage): msg is UserMessage {
  return (msg as UserMessage).role === "user";
}
function isAssistant(msg: AgentMessage): msg is AssistantMessage {
  return (msg as AssistantMessage).role === "assistant";
}
function isToolResult(msg: AgentMessage): msg is ToolResultMessage {
  return (msg as ToolResultMessage).role === "toolResult";
}
function msgContentBlocks(msg: AgentMessage): ContentBlock[] {
  if (isUser(msg)) {
    return typeof msg.content === "string"
      ? [{ type: "text", text: msg.content } as TextContent]
      : msg.content as ContentBlock[];
  }
  if (isAssistant(msg)) return msg.content;
  if (isToolResult(msg)) return msg.content as ContentBlock[];
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
const BUDGET_FRACTION = 0.325;       // ~65k of 200k window (leaves ~135k for LLM generation + tool results)
const CONVERSATION_SHARE = 0.23;     // ~15k for recent user/assistant exchanges
const RETRIEVAL_SHARE = 0.385;       // ~25k for graph-curated context
const CORE_MEMORY_SHARE = 0.155;     // ~10k for core memory/directives
const TOOL_HISTORY_SHARE = 0.23;     // ~15k for recent tool results
const CORE_MEMORY_TTL = 300_000;
const MAX_ITEM_CHARS = 1000; // 0.7.45: aligned to disler/claude-code-hooks-mastery cap; ~250 tokens per item
const MIN_RELEVANCE_SCORE = 0.30; // Floor for graph-scored results after WMR/ACAN
const MIN_COSINE = 0.25; // Minimum cosine similarity to consider a result

// Deduplication thresholds
const DEDUP_COSINE_THRESHOLD = 0.88;
const DEDUP_JACCARD_THRESHOLD = 0.80;

// Recency decay
const RECENCY_DECAY_FAST = 0.99;
const RECENCY_DECAY_SLOW = 0.995;
const RECENCY_BOUNDARY_HOURS = 4;

// Utility pre-filtering
const UTILITY_PREFILTER_MIN_RETRIEVALS = 5;
const UTILITY_PREFILTER_MAX_UTIL = 0.05;

// Intent score floors
const INTENT_SCORE_FLOORS: Record<string, number> = {
  "simple-question": 0.12, "meta-session": 0.10, "code-read": 0.08,
  "code-write": 0.08, "code-debug": 0.08, "deep-explore": 0.06,
  "reference-prior": 0.05, "multi-step": 0.08, "continuation": 0.06,
  "unknown": 0.08,
};
const SCORE_FLOOR_DEFAULT = 0.08;
const INTENT_REMINDER_THRESHOLD = 10;

// ── Budget calculation ─────────────────────────────────────────────────────────

/** @internal Exported for testing. */
export interface Budgets {
  conversation: number;
  retrieval: number;
  core: number;
  toolHistory: number;
  maxContextItems: number;
}

/** Split the context window into 4 budgets: conversation, retrieval, core memory, and tool history. @internal */
export function calcBudgets(contextWindow: number): Budgets {
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

// ── Context stats ──────────────────────────────────────────────────────────────

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

// ── Scoring types ──────────────────────────────────────────────────────────────

interface ScoredResult extends VectorSearchResult {
  finalScore: number;
  fromNeighbor?: boolean;
}

// ── Helper functions ───────────────────────────────────────────────────────────

function extractText(msg: UserMessage | AssistantMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as ContentBlock[])
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function extractLastUserText(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as UserMessage;
    if (msg.role === "user") {
      const text = extractText(msg);
      if (text) return text;
    }
  }
  return null;
}

/** Estimate char-equivalent count for a single content block (claw-code: per-block-type estimation). */
function blockCharLen(c: any): number {
  if (c.type === "text") return c.text?.length ?? 0;
  if (c.type === "thinking") return c.thinking?.length ?? 0;
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
      } else {
        // Images/documents: claw-code hardcodes 2000 tokens
        len += IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN;
      }
    }
    return len;
  }
  return IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN; // image, document, etc.
}

function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const c of msgContentBlocks(msg)) chars += blockCharLen(c);
    chars += 20; // per-message structural overhead (role token, framing, separators)
  }
  // Apply safety margin (claw-code: 4/3 multiplier on rough estimates)
  return Math.ceil((chars / CHARS_PER_TOKEN) * TOKEN_SAFETY_MARGIN);
}

function msgCharLen(msg: AgentMessage): number {
  let len = 0;
  for (const c of msgContentBlocks(msg)) len += blockCharLen(c);
  return len;
}

/** Robust epoch-ms parser. Mirrors observability.ts's parseDatetimeMs:
 *  rejects null/undefined, accepts already-numeric ms, and otherwise feeds
 *  the value through `new Date()` (with a String() fallback for SurrealDB
 *  DateTime objects whose `toString()` emits RFC 3339 but which don't
 *  auto-coerce on `new Date(obj)` across driver versions). Returns null on
 *  any value that produces a non-finite time, so downstream math::pow /
 *  division never has to defend against NaN. */
function parseDatetimeMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  try {
    let t = new Date(v as any).getTime();
    if (!Number.isFinite(t)) t = new Date(String(v)).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function recencyScore(timestamp: string | undefined): number {
  if (!timestamp) return 0.3;
  const ms = parseDatetimeMs(timestamp);
  if (ms == null) return 0.3;
  const hoursElapsed = (Date.now() - ms) / (1000 * 60 * 60);
  if (!Number.isFinite(hoursElapsed)) return 0.3;
  if (hoursElapsed <= RECENCY_BOUNDARY_HOURS) {
    return Math.pow(RECENCY_DECAY_FAST, hoursElapsed);
  }
  const fastPart = Math.pow(RECENCY_DECAY_FAST, RECENCY_BOUNDARY_HOURS);
  return fastPart * Math.pow(RECENCY_DECAY_SLOW, hoursElapsed - RECENCY_BOUNDARY_HOURS);
}

export function formatRelativeTime(ts: string): string {
  const parsed = parseDatetimeMs(ts);
  // If unparseable, surface "unknown" rather than poisoning the UI with NaN
  // strings. Callers were trusting this to always produce a useful label.
  if (parsed == null) return "unknown";
  const ms = Date.now() - parsed;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function accessBoost(accessCount: number | undefined): number {
  return Math.log1p(accessCount ?? 0);
}

/** 0.7.121: fold un-synced access_stats deltas into candidates' accessCount
 *  before WMR scoring. Rows carry week-stale counts since bumps moved to the
 *  side table (SurrealStore.bumpAccessCounts — the vlog write-amplification
 *  fix); this point-read merge restores exact freshness for scoring. */
async function mergeAccessDeltas(store: SurrealStore, rows: Array<{ id: string; accessCount?: number }>): Promise<void> {
  try {
    if (rows.length === 0) return;
    const deltas = await store.fetchAccessDeltas(rows.map(r => String(r.id)));
    if (deltas.size === 0) return;
    for (const r of rows) {
      const d = deltas.get(String(r.id));
      if (d) r.accessCount = (r.accessCount ?? 0) + d;
    }
  } catch (e) { swallow("graph-context:accessDeltas", e); }
}

/** Dot-product cosine similarity between two equal-length vectors. Returns 0 if either has zero magnitude. */
export function cosineSimilarity(a: number[], b: number[]): number {
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

function buildRulesSuffix(session: SessionState): string {
  const remaining = session.toolLimit === Infinity
    ? "unlimited" : String(Math.max(0, session.toolLimit - session.toolCallCount));
  const urgency = session.toolLimit !== Infinity && (session.toolLimit - session.toolCallCount) <= 3
    ? "\n⚠ WRAP UP or check in with user." : "";

  // After first exposure, send only the budget line (claw-code: don't re-send static content)
  if (session.injectedSections.has("rules_full")) {
    return (
      "\n<rules_reminder>" +
      `\nBudget: ${session.toolCallCount} used, ${remaining} remaining.${urgency}` +
      "\nCombine steps. If context already answers it, zero calls." +
      "\n</rules_reminder>"
    );
  }

  // First time — compact rules (no verbose examples)
  session.injectedSections.add("rules_full");
  return (
    "\n<rules_reminder>" +
    `\nBudget: ${session.toolCallCount} used, ${remaining} remaining.${urgency}` +
    "\nClassify: LOOKUP(≤3) | EDIT(≤4) | REFACTOR(≤8). Announce type + plan before tools." +
    "\nCombine: grep+grep in 1 call, edit+test in 1 bash. Read multiple files in 1 call." +
    "\nSkip: if <recalled_memory> already answers it, zero calls needed." +
    "\nBe dense: lead with answer, no filler, no repeating context back." +
    "\n</rules_reminder>"
  );
}

function injectRulesSuffix(messages: AgentMessage[], session: SessionState): AgentMessage[] {
  const suffix = buildRulesSuffix(session);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isUser(msg)) {
      const clone = [...messages];
      if (typeof msg.content === "string") {
        clone[i] = { ...msg, content: msg.content + suffix } as UserMessage;
      } else if (Array.isArray(msg.content)) {
        const content = [...msg.content, { type: "text", text: suffix }];
        clone[i] = { ...msg, content } as UserMessage;
      }
      return clone;
    }
    if (isToolResult(msg)) {
      const clone = [...messages];
      const content = Array.isArray(msg.content) ? [...msg.content] : msg.content;
      if (Array.isArray(content)) {
        content.push({ type: "text", text: suffix } as TextContent);
      }
      clone[i] = { ...msg, content } as ToolResultMessage;
      return clone;
    }
  }
  return messages;
}

// ── Contextual query vector ────────────────────────────────────────────────────

const EXPANSION_STOP = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","can","shall",
  "to","of","in","for","on","with","at","by","from","as","into","about",
  "it","its","this","that","these","those","i","you","we","they","he","she",
  "my","your","our","their","what","which","who","how","when","where","why",
  "not","no","and","or","but","if","so","any","all","some","more","just","also",
  "very","too","much","many","yes","yeah","yep","sure","okay","lets","let",
  "please","thanks","thank","go","going","ahead","right","well","now","then",
  "look","into","take","done","want","need","make","get","got","like",
  "really","actually","think","know","see","tell","give","keep","come","back",
]);

export function expandVagueQuery(query: string, session?: SessionState): string {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  const contentWords = words.filter(w => !EXPANSION_STOP.has(w));

  if (contentWords.length >= 3) return query;

  const context = session?.lastAssistantText;
  if (!context) return query;

  // Extract key terms from the last assistant response (~first 500 chars)
  const snippet = context.slice(0, 500);
  const contextWords = snippet
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 4 && !EXPANSION_STOP.has(w));

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of contextWords) {
    const clean = w.replace(/[^a-z0-9-_.]/g, "");
    if (clean.length < 4 || seen.has(clean)) continue;
    seen.add(clean);
    terms.push(clean);
    if (terms.length >= 10) break;
  }

  if (terms.length === 0) return query;
  return `${terms.join(" ")} ${query}`;
}

async function buildContextualQueryVec(
  queryText: string,
  _messages: AgentMessage[],
  embeddings: EmbeddingService,
  session?: SessionState,
): Promise<number[]> {
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

async function scoreResults(
  results: VectorSearchResult[],
  neighborIds: Set<string>,
  queryEmbedding: number[] | undefined,
  store: SurrealStore,
  currentIntent: string,
): Promise<ScoredResult[]> {
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
    if (!entry) return true;
    if (entry.retrieval_count < UTILITY_PREFILTER_MIN_RETRIEVALS) return true;
    return entry.avg_utilization >= UTILITY_PREFILTER_MAX_UTIL;
  });

  let utilityMap = new Map<string, number>();
  for (const [id, entry] of cacheEntries) {
    utilityMap.set(id, entry.avg_utilization);
  }
  if (utilityMap.size === 0 && eligibleIds.length > 0) {
    utilityMap = await getHistoricalUtilityBatch(eligibleIds);
  }
  const floor = INTENT_SCORE_FLOORS[currentIntent] ?? SCORE_FLOOR_DEFAULT;

  // ACAN path
  if (isACANActive() && queryEmbedding && preFiltered.length > 0 && preFiltered.every((r) => r.embedding)) {
    const candidates: ACANCandidate[] = preFiltered.map((r) => ({
      embedding: r.embedding!,
      recency: recencyScore(r.timestamp),
      importance: (r.importance ?? 0.5) / 10,
      access: Math.min(accessBoost(r.accessCount), 1),
      neighborBonus: neighborIds.has(r.id) ? 1.0 : 0,
      provenUtility: utilityMap.get(r.id) ?? 0,
      reflectionBoost: r.sessionId ? (reflectedSessions.has(r.sessionId) ? 1.0 : 0) : 0,
    }));
    try {
      const scores = scoreWithACAN(queryEmbedding, candidates);
      if (scores.length === preFiltered.length && scores.every((s) => isFinite(s))) {
        return preFiltered
          .map((r, i) => ({ ...r, finalScore: scores[i], fromNeighbor: neighborIds.has(r.id) }))
          .filter((r) => r.finalScore >= floor)
          .sort((a, b) => b.finalScore - a.finalScore);
      }
    } catch (e) { swallow.warn("graph-context:ACAN fallthrough", e); }
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

      const finalScore =
        0.35 * cosine + 0.18 * recency + 0.07 * importance +
        0.02 * access + 0.10 * neighborBonus + 0.18 * provenUtility +
        0.10 * reflectionBoost - utilityPenalty;

      return { ...r, finalScore, fromNeighbor: neighborIds.has(r.id) };
    })
    .filter((r) => r.finalScore >= floor)
    .sort((a, b) => b.finalScore - a.finalScore);
}

// ── Deduplication ──────────────────────────────────────────────────────────────

function deduplicateResults(ranked: ScoredResult[]): ScoredResult[] {
  // Pre-compute word sets to avoid re-splitting in O(n^2) inner loop
  const wordSets = ranked.map(r =>
    new Set((r.text ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 2)),
  );
  const kept: ScoredResult[] = [];
  const keptIndexes: number[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    let isDup = false;
    for (const ki of keptIndexes) {
      const existing = ranked[ki];
      if (item.embedding?.length && existing.embedding?.length
          && item.embedding.length === existing.embedding.length) {
        if (cosineSimilarity(item.embedding, existing.embedding) > DEDUP_COSINE_THRESHOLD) { isDup = true; break; }
        continue;
      }
      const words = wordSets[i];
      const eWords = wordSets[ki];
      let intersection = 0;
      for (const w of words) { if (eWords.has(w)) intersection++; }
      const union = words.size + eWords.size - intersection;
      if (union > 0 && intersection / union > DEDUP_JACCARD_THRESHOLD) { isDup = true; break; }
    }
    if (!isDup) { kept.push(item); keptIndexes.push(i); }
  }
  return kept;
}

// ── Token-budget constrained selection ─────────────────────────────────────────

function takeWithConstraints(ranked: ScoredResult[], budgetTokens: number, maxItems: number): ScoredResult[] {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  let used = 0;
  const selected: ScoredResult[] = [];
  for (const r of ranked) {
    if (selected.length >= maxItems) break;
    if ((r.finalScore ?? 0) < MIN_RELEVANCE_SCORE && selected.length > 0) break;
    const len = Math.min(r.text?.length ?? 0, MAX_ITEM_CHARS); // Cap per-item size for budget accounting
    if (used + len > budgetChars && selected.length > 0) break;
    selected.push(r);
    used += len;
  }
  return selected;
}

// ── Core memory ────────────────────────────────────────────────────────────────

function getTier0BudgetChars(budgets: Budgets): number {
  return Math.round(budgets.core * 0.55 * CHARS_PER_TOKEN);
}
function getTier1BudgetChars(budgets: Budgets): number {
  return Math.round(budgets.core * 0.45 * CHARS_PER_TOKEN);
}

const MAX_CORE_MEMORY_CHARS = 800; // Per-item cap (claw-code: MAX_INSTRUCTION_FILE_CHARS)

function applyCoreBudget(entries: CoreMemoryEntry[], budgetChars: number): CoreMemoryEntry[] {
  let used = 0;
  const result: CoreMemoryEntry[] = [];
  for (const e of entries) {
    // Cap individual entries so one large directive doesn't starve others
    const text = e.text.length > MAX_CORE_MEMORY_CHARS
      ? e.text.slice(0, MAX_CORE_MEMORY_CHARS) + "..."
      : e.text;
    const len = text.length + 6;
    if (used + len > budgetChars) continue;
    result.push(text !== e.text ? { ...e, text } : e);
    used += len;
  }
  return result;
}

function formatTierSection(entries: CoreMemoryEntry[], label: string): string {
  if (entries.length === 0) return "";
  const grouped: Record<string, string[]> = {};
  for (const e of entries) {
    (grouped[e.category] ??= []).push(e.text);
  }
  const lines: string[] = [];
  for (const [cat, texts] of Object.entries(grouped)) {
    lines.push(`  [${cat}]`);
    for (const t of texts) lines.push(`  - ${t}`);
  }
  return `${label}:\n${lines.join("\n")}`;
}

/**
 * Build static system prompt section for API prefix caching.
 * Content here goes into systemPromptAddition where it benefits from
 * cache-read rates (10% cost) on subsequent API calls in the agentic loop.
 * (claw-code pattern: __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ — prompt.rs:37-140)
 */
function buildSystemPromptSection(session: SessionState, tier0Entries: CoreMemoryEntry[]): string | undefined {
  const parts: string[] = [];

  // Graph pillar IDs (compact — the model doesn't need architecture descriptions)
  const pillarLines: string[] = [];
  if (session.agentId) pillarLines.push(`Agent: ${session.agentId}`);
  if (session.projectId) pillarLines.push(`Project: ${session.projectId}`);
  if (session.taskId) pillarLines.push(`Task: ${session.taskId}`);
  if (pillarLines.length > 0) {
    parts.push(`GRAPH PILLARS: ${pillarLines.join(" | ")}`);
  }

  // Token-density rules are in buildRulesSuffix (injected per-turn) — no duplication here

  // Tier 0 core directives (semi-static, changes rarely)
  const t0Section = formatTierSection(tier0Entries, "CORE DIRECTIVES (always loaded, never evicted)");
  if (t0Section) parts.push(t0Section);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// ── Guaranteed recent turns from previous sessions ─────────────────────────────

async function ensureRecentTurns(
  contextNodes: ScoredResult[],
  session: SessionState,
  store: SurrealStore,
  count = 5,
): Promise<ScoredResult[]> {
  try {
    if (session._cachedPrevTurns === undefined) {
      session._cachedPrevTurns = session._prevTurnsPrefetch
        ? await session._prevTurnsPrefetch
        : await store.getPreviousSessionTurns(session.sessionId, count);
      session._prevTurnsPrefetch = undefined;
    }
    const recentTurns = session._cachedPrevTurns;
    if (recentTurns.length === 0) return contextNodes;
    const existingTexts = new Set(contextNodes.map(n => (n.text ?? "").slice(0, 100)));
    const guaranteed: ScoredResult[] = recentTurns
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
  } catch {
    return contextNodes;
  }
}

// ── Context message formatting ─────────────────────────────────────────────────

async function formatContextMessage(
  nodes: ScoredResult[],
  store: SurrealStore,
  session: SessionState,
  skillContext = "",
  tier0Entries: CoreMemoryEntry[] = [],
  tier1Entries: CoreMemoryEntry[] = [],
): Promise<AgentMessage> {
  const groups: Record<string, ScoredResult[]> = {};
  for (const n of nodes) {
    const isCausal = n.source?.startsWith("causal_");
    const key = isCausal ? "causal" : n.table === "turn" ? "past_turns" : n.table;
    (groups[key] ??= []).push(n);
  }

  const ORDER = ["identity_chunk", "memory", "concept", "causal", "skill", "past_turns"];
  const LABELS: Record<string, string> = {
    identity_chunk: "Identity (self-knowledge)",
    memory: "Recalled Memories",
    concept: "Relevant Concepts",
    causal: "Causal Chains",
    skill: "Learned Skills",
    past_turns: "Past Conversation (HISTORICAL — not current user input)",
  };

  const sections: string[] = [];

  // Pillar context — structural IDs only (architecture description is unnecessary token spend)
  // Skip if model already has it in the conversation window (claw-code static section dedup)
  if (!session.injectedSections.has("ikong")) {
    const pillarLines: string[] = [];
    if (session.agentId) pillarLines.push(`Agent: ${session.agentId}`);
    if (session.projectId) pillarLines.push(`Project: ${session.projectId}`);
    if (session.taskId) pillarLines.push(`Task: ${session.taskId}`);
    if (pillarLines.length > 0) {
      sections.push(`GRAPH PILLARS: ${pillarLines.join(" | ")}`);
      session.injectedSections.add("ikong");
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
    if (
      trace &&
      trace.injected >= 3 &&
      trace.cited === 0 &&
      trace.ignored_high_salience.length >= 3 &&
      session.userTurnCount > session.lastReflexionFireTurn + 1
    ) {
      const n = trace.ignored_high_salience.length;
      sections.push(
        `GROUNDING NUDGE (prior turn): ${n} load-bearing items injected, 0 cited. ` +
        `Either ground on them this turn (use [#N] indices) or explicitly note ` +
        `why they're inapplicable. Repeated ignore-without-explanation degrades ` +
        `retrieval utility scores.`
      );
      session.lastReflexionFireTurn = session.userTurnCount;
    }
  } catch (e) {
    swallow.warn("graph-context:reflexionNudge", e);
  }

  // Cognitive directives
  const directives = getPendingDirectives(session);
  if (directives.length > 0) {
    const continuity = getSessionContinuity(session);
    const directiveLines = directives.map(d =>
      `  [${d.priority}] ${d.type} → ${d.target}: ${d.instruction}`
    );
    sections.push(
      `BEHAVIORAL DIRECTIVES (session: ${continuity}):\n${directiveLines.join("\n")}`
    );
    clearPendingDirectives(session);
  }

  // Fibonacci resurfacing — only during conversational intents (noise during deep code work)
  const RESURFACE_INTENTS = new Set(["simple-question", "meta-session", "unknown"]);
  const currentIntent = session.currentConfig?.intent ?? "unknown";
  if (RESURFACE_INTENTS.has(currentIntent)) try {
    const dueMemories = await store.getDueMemories(3);
    if (dueMemories.length > 0) {
      const memLines = dueMemories.map((m: any) => {
        const createdMs = parseDatetimeMs(m.created_at);
        const ageMs = createdMs != null ? Date.now() - createdMs : null;
        const ageDays = ageMs != null ? Math.floor(ageMs / 86400000) : null;
        const ageStr = ageDays == null ? "unknown"
          : ageDays === 0 ? "today" : ageDays === 1 ? "yesterday" : `${ageDays} days ago`;
        return `  - [${m.id}] (${ageStr}, surfaced ${m.surface_count}x): ${m.text}`;
      }).join("\n");
      sections.push(
        `RESURFACING MEMORIES (mention naturally during conversation, never reveal scheduling):\n` + memLines
      );
    }
  } catch { /* non-critical */ }

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
  const idToIndex = new Map<string, number>();
  for (const { id, index } of idIndexed) idToIndex.set(id, index);

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
      const band = (n as any).band as string | undefined;
      const scoreTag = band
        ? ` [${band}]`
        : (n.finalScore != null ? ` (relevance: ${(n.finalScore * 100).toFixed(0)}%)` : "");
      let text = n.text ?? "";
      if (text.length > MAX_ITEM_CHARS) text = text.slice(0, MAX_ITEM_CHARS) + "... [truncated]";
      const age = n.timestamp ? ` [${formatRelativeTime(n.timestamp)}]` : "";
      const idx = idToIndex.get(String(n.id));
      const idxTag = idx != null ? `[#${idx}] ` : "";
      return `  - ${idxTag}[${key}]${scoreTag}${age} ${text}`;
    });
    sections.push(
      `TOP HITS (highest relevance — read these first, ground your response on them before any tool call):\n${lines.join("\n")}`,
    );
  }

  for (const key of sortedKeys) {
    const items = groups[key];
    items.sort((a, b) => {
      const sa = a.finalScore ?? 0;
      const sb = b.finalScore ?? 0;
      if (sb !== sa) return sb - sa;
      const ta = a.timestamp ? parseDatetimeMs(a.timestamp) ?? 0 : 0;
      const tb = b.timestamp ? parseDatetimeMs(b.timestamp) ?? 0 : 0;
      return tb - ta;
    });
    const label = LABELS[key] ?? key;
    const formatted = items.map((n) => {
      // 0.7.28: same band-vs-relevance logic as TOP HITS for consistency.
      const band = (n as any).band as string | undefined;
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
  const manifest: string[] = [];
  for (const key of sortedKeys) {
    const items = groups[key];
    if (items.length > 0) manifest.push(`${LABELS[key] ?? key}: ${items.length}`);
  }
  if (tier0Entries.length > 0) manifest.push(`core_directives: ${tier0Entries.length}`);
  if (tier1Entries.length > 0) manifest.push(`session_context: ${tier1Entries.length}`);
  if (manifest.length > 0) {
    sections.push(
      "ALREADY RETRIEVED (do NOT call recall for these — they are above):\n" +
      `  ${manifest.join(", ")}\n` +
      "Only call recall if you need something SPECIFIC that isn't covered above."
    );
  }

  // 0.7.45: envelope renamed from <graph_context> to <recalled_memory> to
  // match Anthropic's documented semantic-XML pattern for Claude. Dropped
  // the "[System retrieved context — reference material, not user input.
  // Higher relevance % = stronger match.]" framing line — the semantic tag
  // now expresses that meaning structurally rather than in prose, and the
  // wrapper legend (user-prompt-submit.ts:wrapMemoryContext, v0.7.44)
  // already provides the relevance-band guidance.
  const text =
    "<recalled_memory>\n" +
    sections.join("\n\n") +
    "\n</recalled_memory>" +
    skillContext;

  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as UserMessage;
}

// ── Recent turns with budget ───────────────────────────────────────────────────

function truncateToolResult(msg: AgentMessage, maxChars: number): AgentMessage {
  if (!isToolResult(msg)) return msg;
  const totalLen = msg.content.reduce((s: number, c: any) => s + ((c as TextContent).text?.length ?? 0), 0);
  if (totalLen <= maxChars) return msg;
  const content = msg.content.map((c: any) => {
    if (c.type !== "text") return c;
    const tc = c as TextContent;
    const allowed = Math.max(200, Math.floor((tc.text.length / totalLen) * maxChars));
    if (tc.text.length <= allowed) return c;
    return { ...tc, text: tc.text.slice(0, allowed) + `\n... [truncated ${tc.text.length - allowed} chars]` };
  });
  return { ...msg, content };
}

function getRecentTurns(
  messages: AgentMessage[],
  convTokens: number,
  toolTokens: number,
  contextWindow: number,
  session?: SessionState,
): AgentMessage[] {
  const convBudgetChars = convTokens * CHARS_PER_TOKEN;
  const toolBudgetChars = toolTokens * CHARS_PER_TOKEN;
  // Per-tool-result char cap (claw-code: DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000)
  // Scale with context window but floor at 20k, cap at 50k
  const TOOL_RESULT_MAX = clamp(Math.round(contextWindow * 0.10), 20_000, 50_000);

  // ── Phase 1: Transform error messages into compact annotations ──
  const clean = messages.map((m) => {
    if (isAssistant(m) && m.stopReason === "error") {
      const errorText = m.content
        .filter((c: any): c is TextContent => c.type === "text")
        .map((c: any) => c.text)
        .join("")
        .slice(0, 150);
      return {
        ...m,
        stopReason: "stop" as const,
        content: [{ type: "text" as const, text: `[tool_error: ${errorText.replace(/\n/g, " ")}]` }],
      } as AgentMessage;
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
      if (isUser(msg) || (isAssistant(msg) && !msg.content.some((c: ContentBlock) => c.type === "toolCall"))) {
        groupsSeen++;
      } else if (isAssistant(msg) && msg.content.some((c: ContentBlock) => c.type === "toolCall")) {
        groupsSeen++;
        // Skip past associated tool results (they're part of this group)
      }
    }
  }

  // Apply stripping to messages before the recency boundary
  for (let k = 0; k < recentBoundary; k++) {
    const msg = clean[k] as MutableMessage;
    if (!msg.content || !Array.isArray(msg.content)) continue;

    // Collapse old assistant filler text (agentic loop: "I'll now read..." / "Let me check...")
    // Keep tool calls intact but shrink prose to 1-line summary
    if (isAssistant(clean[k]) && msg.content.some((c: AnyContentBlock) => c.type === "toolCall")) {
      msg.content = msg.content.map((c: AnyContentBlock) => {
        if (c.type === "text" && c.text && c.text.length > 120) {
          // Keep first line as summary (usually the intent statement)
          const firstLine = c.text.split(/\r?\n/)[0].slice(0, 120);
          return { ...c, text: firstLine };
        }
        if (c.type === "thinking") {
          return { type: "text" as const, text: "[thinking]" };
        }
        return c; // preserve toolCall blocks
      });
      continue; // skip generic stripping for this message
    }

    msg.content = msg.content.map((c: AnyContentBlock) => {
      // Strip thinking blocks → [thinking] marker (often 1-5k tokens each)
      if (c.type === "thinking") {
        return { type: "text" as const, text: "[thinking]" };
      }
      // Strip images → [image] marker (2000 tokens each)
      if (c.type === "image" || c.type === "image_url" || (c.type === "source" && c.media_type?.startsWith("image/"))) {
        return { type: "text" as const, text: "[image]" };
      }
      // Content-clear old tool results → stub (claw-code: microcompact pattern)
      if (c.type === "toolResult" && Array.isArray(c.content)) {
        const stub = c.content.map((rc: AnyContentBlock) => {
          if (rc.type === "text" && rc.text && rc.text.length > 200) {
            return { ...rc, text: `[Old tool result cleared — ${rc.text.length} chars]` };
          }
          if (rc.type === "image" || rc.type === "image_url") {
            return { type: "text" as const, text: "[image]" };
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
  const groups: AgentMessage[][] = [];
  let i = 0;
  while (i < clean.length) {
    const msg = clean[i];
    if (isAssistant(msg) && msg.content.some((c: ContentBlock) => c.type === "toolCall")) {
      const group: AgentMessage[] = [clean[i]];
      let j = i + 1;
      while (j < clean.length && isToolResult(clean[j])) {
        group.push(truncateToolResult(clean[j], TOOL_RESULT_MAX));
        j++;
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([clean[i]]);
      i++;
    }
  }

  // Pin originating user message
  let pinnedGroup: AgentMessage[] | null = null;
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
      if (isToolResult(m)) pinnedTool += msgCharLen(m);
      else pinnedConv += msgCharLen(m);
    }
  }

  // Take groups from end within split budgets
  const remainingConv = convBudgetChars - pinnedConv;
  const remainingTool = toolBudgetChars - pinnedTool;
  let convUsed = 0;
  let toolUsed = 0;
  const selectedGroups: AgentMessage[][] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (g === pinnedGroupIdx) continue;
    let groupConv = 0;
    let groupTool = 0;
    for (const m of groups[g]) {
      if (isToolResult(m)) groupTool += msgCharLen(m);
      else groupConv += msgCharLen(m);
    }
    // Stop if either budget would overflow (but always include at least one group)
    if (selectedGroups.length > 0) {
      if (convUsed + groupConv > remainingConv) break;
      if (groupTool > 0 && toolUsed + groupTool > remainingTool) break;
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
      if (hadTier0) session.injectedSections.add("tier0");
    }
  }

  return selectedGroups.flat();
}

// ── Main entry point ───────────────────────────────────────────────────────────

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

// ── graphTransformContext error-rate tracking ──
// Sliding window of recent call outcomes for observability alerting.
const _recentCalls: { ts: number; ok: boolean }[] = [];
const WINDOW_MS = 10 * 60_000; // 10 minutes

export function recordTransformOutcome(ok: boolean): void {
  const now = Date.now();
  _recentCalls.push({ ts: now, ok });
  // Trim entries older than the window
  while (_recentCalls.length > 0 && _recentCalls[0].ts < now - WINDOW_MS) {
    _recentCalls.shift();
  }
}

export function resetTransformErrorRate(): void { _recentCalls.length = 0; }

export function getTransformErrorRate(): { total: number; failures: number; rate: number } {
  const now = Date.now();
  const recent = _recentCalls.filter(c => c.ts >= now - WINDOW_MS);
  const failures = recent.filter(c => !c.ok).length;
  return { total: recent.length, failures, rate: recent.length > 0 ? failures / recent.length : 0 };
}

/** Transform deadline: env override, else a CPU-aware default. The original
 *  fixed 15s was tuned for GPU-era embed+rerank latency; the 2026-06-04
 *  switch of the daemon to CPU-only mode tripped it constantly (daemon.log:
 *  "graphTransformContext timed out" spam → raw-message fallback on every
 *  affected prompt). KONGCODE_NO_GPU=1 is set by gpu-pin.ts at daemon startup
 *  when CPU mode is configured, so the default self-adjusts. Exported for
 *  tests. Resolved per call (not at import) so it sees the post-pin env. */
export function resolveTransformTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.KONGCODE_TRANSFORM_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return env.KONGCODE_NO_GPU === "1" ? 45_000 : 15_000;
}

/**
 * Main entry point for graph-based context assembly. Retrieves, scores, deduplicates,
 * and budget-trims graph nodes, then splices them into the conversation message array.
 */
/** B17 (T5, 2026-06-10): per-call stage trace. When the transform blows its
 *  deadline the timeout error used to carry zero information about WHERE the
 *  45s went (live incident: "fatal error after 45001ms" with nothing else).
 *  Inner marks each stage START; the wrapper formats elapsed-per-stage into
 *  the failure log, so the stage in progress at death is the one after the
 *  last mark. */
interface TransformStageTrace {
  marks: Array<{ stage: string; at: number }>;
}

function formatStageTrace(trace: TransformStageTrace, startedAt: number, diedAt: number): string {
  if (trace.marks.length === 0) return "no stages reached";
  const parts: string[] = [];
  for (let i = 0; i < trace.marks.length; i++) {
    const m = trace.marks[i];
    const end = i + 1 < trace.marks.length ? trace.marks[i + 1].at : diedAt;
    parts.push(`${m.stage}@+${m.at - startedAt}ms(${end - m.at}ms)`);
  }
  return `${parts.join(" → ")} [died in: ${trace.marks[trace.marks.length - 1].stage}]`;
}

export async function graphTransformContext(
  params: GraphTransformParams,
): Promise<GraphTransformResult> {
  const { messages, session, store, embeddings, signal } = params;
  const contextWindow = params.contextWindow ?? 200000;
  const budgets = calcBudgets(contextWindow);

  // Build static system prompt section for API prefix caching.
  // Done here (wrapper) so it attaches to any inner return path.
  // (claw-code pattern: static sections above __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__)
  let systemPromptSection: string | undefined;
  let tier0ForSys: CoreMemoryEntry[] = [];
  try {
    tier0ForSys = store.isAvailable()
      ? applyCoreBudget(await store.getAllCoreMemory(0), getTier0BudgetChars(budgets))
      : [];
    systemPromptSection = buildSystemPromptSection(session, tier0ForSys);
    // Mark sections as injected so formatContextMessage() skips them (prevents duplication)
    if (systemPromptSection) {
      if (systemPromptSection.includes("GRAPH PILLARS")) session.injectedSections.add("ikong");
      if (systemPromptSection.includes("CORE DIRECTIVES")) session.injectedSections.add("tier0");
    }
  } catch { /* non-critical — tier0 will still appear in user message */ }

  // Never throw — return raw messages on any failure
  let transformTimer: ReturnType<typeof setTimeout> | undefined;
  const TRANSFORM_TIMEOUT_MS = resolveTransformTimeoutMs();
  const transformStartedAt = Date.now();
  const stageTrace: TransformStageTrace = { marks: [] };
  try {
    const result = await Promise.race([
      graphTransformInner(messages, session, store, embeddings, contextWindow, budgets, signal, tier0ForSys, stageTrace),
      new Promise<never>((_, reject) => {
        transformTimer = setTimeout(() => reject(new Error("graphTransformContext timed out")), TRANSFORM_TIMEOUT_MS);
      }),
    ]);
    recordTransformOutcome(true);
    result.systemPromptSection = systemPromptSection;
    return result;
  } catch (err) {
    recordTransformOutcome(false);
    const diedAt = Date.now();
    log.error(
      `graphTransformContext fatal error after ${diedAt - transformStartedAt}ms ` +
      `(timeout=${TRANSFORM_TIMEOUT_MS}ms), returning raw messages. ` +
      `Stage timings: ${formatStageTrace(stageTrace, transformStartedAt, diedAt)}:`,
      err,
    );
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
  } finally {
    // Clear so a fast-resolving graphTransformInner doesn't leave a 15s
    // pending Timeout per transform call — the daemon handles every user
    // prompt through this path, so the leak compounds quickly.
    if (transformTimer !== undefined) clearTimeout(transformTimer);
  }
}

async function graphTransformInner(
  messages: AgentMessage[],
  session: SessionState,
  store: SurrealStore,
  embeddings: EmbeddingService,
  contextWindow: number,
  budgets: Budgets,
  _signal?: AbortSignal,
  /** Tier 0 entries already fetched by wrapper — avoids double DB fetch. */
  tier0FromWrapper: CoreMemoryEntry[] = [],
  /** B17 stage trace owned by the wrapper — marks stage STARTS. */
  stageTrace?: TransformStageTrace,
): Promise<GraphTransformResult> {
  const mark = (stage: string): void => { stageTrace?.marks.push({ stage, at: Date.now() }); };
  function makeStats(
    sent: AgentMessage[], graphNodes: number, neighborNodes: number,
    recentTurnCount: number, mode: ContextStats["mode"], prefetchHit = false,
  ): ContextStats {
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
  if (skipRetrieval) mark("skip-retrieval");
  if (skipRetrieval) {
    const recentTurns = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
    // If model already saw core memory, just return recent turns + compressed rules. Zero DB queries.
    if (session.injectedSections.has("tier0")) {
      return { messages: injectRulesSuffix(recentTurns, session), stats: makeStats(recentTurns, 0, 0, recentTurns.length, "passthrough") };
    }
    // First turn or after compaction cleared injectedSections — load and inject
    let tier0: CoreMemoryEntry[] = [];
    let tier1: CoreMemoryEntry[] = [];
    try {
      [tier0, tier1] = await Promise.all([
        store.getAllCoreMemory(0),
        store.getAllCoreMemory(1),
      ]);
      tier0 = applyCoreBudget(tier0, getTier0BudgetChars(budgets));
      tier1 = applyCoreBudget(tier1, getTier1BudgetChars(budgets));
    } catch (e) {
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
  let tier0: CoreMemoryEntry[] = [];
  let tier1: CoreMemoryEntry[] = [];
  try {
    // Tier 0 already fetched by wrapper (avoids double DB query)
    tier0 = tier0FromWrapper.length > 0
      ? tier0FromWrapper
      : applyCoreBudget(await store.getAllCoreMemory(0), getTier0BudgetChars(budgets));
    tier1 = applyCoreBudget(await store.getAllCoreMemory(1), getTier1BudgetChars(budgets));
  } catch (e) {
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
    identity: baseLimits.identity,  // always load full identity
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
      const reranked = await rerankResults(deduped, queryText);
      applyDistributionBands(reranked);
      let contextNodes = takeWithConstraints(reranked, tokenBudget, budgets.maxContextItems);
      contextNodes = await ensureRecentTurns(contextNodes, session, store);

      if (contextNodes.length > 0) {
        if (contextNodes.filter((n) => n.table === "concept" || n.table === "memory").length > 0) {
          store.bumpAccessCounts(
            contextNodes.filter((n) => n.table === "concept" || n.table === "memory").map((n) => n.id),
          ).catch(e => swallow.warn("graph-context:bumpAccess", e));
        }
        // 0.7.27: build the [#N] → memory_id map from the final ordered list and
    // hand it to stageRetrieval so Stop's evaluateRetrieval can parse [#N]
    // citations out of the assistant response.
    {
      const stageIndexMap = new Map<number, string>();
      [...contextNodes]
        .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
        .forEach((n, i) => stageIndexMap.set(i + 1, String(n.id)));
      stageRetrieval(session.sessionId, contextNodes, queryVec, stageIndexMap);
    }

        const skillCtx = cached.skills.length > 0 ? formatSkillContext(cached.skills) : "";
        if (cached.skills.length > 0) stageSkills(session.sessionId, cached.skills.map(s => ({ id: s.id, text: `${s.name}: ${s.description}` })));
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
      store.tagBoostedConcepts(queryText, queryVec, 10).catch(e => { swallow.warn("graph-context:tagBoost", e); return [] as VectorSearchResult[]; }),
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
      if (r.table !== "turn") return true;
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
    let neighborResults: VectorSearchResult[] = [];
    let causalResults: VectorSearchResult[] = [];
    const seen = new Set<string>(results.map((r) => r.id));
    const neighborIds = new Set<string>();

    // Fire graph expansion, causal traversal, skills, and reflections in parallel.
    // Skills + reflections only need queryVec — no dependency on graph results.
    const SKILL_INTENTS = new Set(["code-write", "code-debug", "multi-step", "code-read"]);
    mark("graph-expand");
    const [expandResult, causalResult, skillsFound, reflectionsFound] = await Promise.all([
      topIds.length > 0
        ? store.graphExpand(topIds, queryVec, graphHops).catch(e => { swallow.error("graph-context:graphExpand", e); return [] as VectorSearchResult[]; })
        : Promise.resolve([] as VectorSearchResult[]),
      topIds.length > 0 && queryVec
        ? queryCausalContext(topIds, queryVec, 2, 0.4, store).catch(e => { swallow("graph-context:causal", e); return [] as VectorSearchResult[]; })
        : Promise.resolve([] as VectorSearchResult[]),
      SKILL_INTENTS.has(currentIntent)
        ? findRelevantSkills(queryVec, 5, store, { queryText, rerank: crossEncoderScorePairs }).catch(e => { swallow("graph-context:skills", e); return [] as import("./skills.js").Skill[]; })
        : Promise.resolve([] as import("./skills.js").Skill[]),
      retrieveReflections(queryVec, 5, store, session.projectId || undefined)
        .catch(e => { swallow("graph-context:reflections", e); return [] as import("./reflection.js").Reflection[]; }),
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
    const reranked = await rerankResults(deduped, queryText);
    applyDistributionBands(reranked);
    let contextNodes = takeWithConstraints(reranked, tokenBudget, budgets.maxContextItems);
    mark("recent-turns");
    contextNodes = await ensureRecentTurns(contextNodes, session, store);

    if (contextNodes.length === 0) {
      const result = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
      return { messages: injectRulesSuffix(result, session), stats: makeStats(result, 0, 0, result.length, "graph") };
    }

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
    {
      const stageIndexMap = new Map<number, string>();
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
    if (reflectionsFound.length > 0) reflectionContext = formatReflectionContext(reflectionsFound);

    // Write full pipeline results back to prefetch cache for subsequent similar queries
    setCachedContext(queryVec, contextNodes, skillsFound, reflectionsFound, session.sessionId, session.projectId || undefined);

    mark("format-context");
    const injectedContext = await formatContextMessage(contextNodes, store, session, skillContext + reflectionContext, tier0, tier1);
    const recentTurns = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
    const result = [injectedContext, ...recentTurns];
    return {
      messages: injectRulesSuffix(result, session),
      stats: makeStats(
        result,
        contextNodes.filter((n) => !n.fromNeighbor).length,
        contextNodes.filter((n) => n.fromNeighbor).length,
        recentTurns.length, "graph",
      ),
    };
  } catch (err) {
    log.error("Graph context error, falling back:", err);
    const result = getRecentTurns(messages, budgets.conversation, budgets.toolHistory, contextWindow, session);
    return { messages: injectRulesSuffix(result, session), stats: makeStats(result, 0, 0, result.length, "recency-only") };
  }
}
