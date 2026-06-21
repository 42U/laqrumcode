/**
 * R22 / R10 regression: the K6 abort chain in graphTransformInner.
 *
 * The wrapper (graphTransformContext) races the inner pipeline against a
 * deadline and returns raw messages on timeout, but the inner pipeline kept
 * running afterward. The round-1 K6 fix gated only the prefetch-cache WRITE on
 * `!signal.aborted`; bumpAccessCounts and stageRetrieval on the SAME
 * post-deadline path were left UNGUARDED, so an abandoned late-completing
 * transform still:
 *   - bumped access counts (polluting the ACAN access signal / WMR feature),
 *   - staged the discarded result into Stop's evaluateRetrieval indexMap.
 * R10 wraps both in the same `!signal?.aborted` guard, on the main path AND the
 * prefetch-hit path. R22 is the missing coverage: no test exercised the abort
 * chain at all (transform-timeout.test.ts only covers the timeout-number
 * helper).
 *
 * This drives the REAL graphTransformContext with stubbed embeddings + store so
 * the pipeline reaches the cross-encoder rerank stage, then aborts the passed
 * signal WHILE the (fake) reranker is computing. On release the pipeline runs
 * past the pre-rerank checkAbort (which already passed) and reaches the R10
 * guards with signal.aborted === true. We assert the three side effects did NOT
 * fire, observed through real module state — not mock introspection:
 *   - retrieval-quality.getStagedItems(sessionId) stays empty   (no stageRetrieval)
 *   - prefetch.getPrefetchStats().entries stays 0               (no setCachedContext)
 *   - the store stub's bumpAccessCounts spy is never called     (no access bump)
 * A positive-control run WITHOUT abort proves all three DO fire otherwise, so a
 * regressed (un-guarded) build would fail the abort assertions.
 *
 * No DB, no 606MB model — a fake LlamaRankingContext is injected via the
 * @internal _setRankingCtxForTest seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  graphTransformContext,
  _setRankingCtxForTest,
  _resetRerankBreaker,
} from "../src/engine/graph-context.js";
import { getStagedItems } from "../src/engine/retrieval-quality.js";
import { getPrefetchStats, clearPrefetchCache } from "../src/engine/prefetch.js";
import { SessionState } from "../src/engine/state.js";
import type { SurrealStore, VectorSearchResult } from "../src/engine/surreal.js";
import type { EmbeddingService } from "../src/engine/embeddings.js";

const DIM = 6;
/** ONE-HOT (mutually orthogonal) embeddings so deduplicateResults — which
 *  prefers embedding-cosine over text-Jaccard when both rows carry equal-length
 *  vectors — keeps all 6 rows (cosine 0 << DEDUP_COSINE_THRESHOLD 0.88). If the
 *  rows collapsed to <6, rerankResults would early-return (its `deduped.length >
 *  5` gate) and never call rankAll, so the gated reranker would never start. */
function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i % DIM] = 1;
  return v;
}

/** Six recent, distinct concept rows. score=0.95 is the raw cosine WMR reads
 *  directly (it does not recompute from the embedding), clearing MIN_COSINE
 *  (0.25), the WMR floor (0.08), and takeWithConstraints' MIN_RELEVANCE_SCORE
 *  (0.30) after the 0.6/0.4 rerank blend. */
function makeRows(): VectorSearchResult[] {
  const now = new Date().toISOString();
  return Array.from({ length: 6 }, (_v, i) => ({
    id: `concept:c${i}`,
    text: `distinct retrievable concept number ${i} alpha bravo charlie ${i}`,
    score: 0.95,
    table: "concept",
    timestamp: now,
    importance: 5,
    accessCount: 0,
    embedding: oneHot(i),
  }));
}

interface FakeStore {
  store: SurrealStore;
  bumpSpy: ReturnType<typeof vi.fn>;
}

function makeStore(): FakeStore {
  const bumpSpy = vi.fn(async () => {});
  const store = {
    isAvailable: () => true,
    getAllCoreMemory: async () => [],
    vectorSearch: async () => makeRows(),
    tagBoostedConcepts: async () => [],
    graphExpand: async () => [],
    queryBatch: async () => [],                 // causal traversal → empty
    fetchAccessDeltas: async () => new Map(),   // mergeAccessDeltas → no deltas
    getUtilityCacheEntries: async () => new Map(),
    getReflectionSessionIds: async () => new Set<string>(),
    getPreviousSessionTurns: async () => [],
    getDueMemories: async () => [],             // formatContextMessage
    bumpAccessCounts: bumpSpy,
  } as unknown as SurrealStore;
  return { store, bumpSpy };
}

function makeEmbeddings(): EmbeddingService {
  // The query vector only feeds ACAN (off in a fresh module) — WMR reads each
  // row's `score` directly — so any fixed DIM-length vector is fine here.
  const qv = new Array(DIM).fill(1);
  return {
    isAvailable: () => true,
    embed: async () => qv,
    embedBatch: async (xs: string[]) => xs.map(() => qv),
  } as unknown as EmbeddingService;
}

/** Fake ranking context whose rankAll blocks on an externally-resolved gate so
 *  the test controls exactly when "compute" finishes relative to the abort. */
function makeGatedCtx(): { ctx: unknown; release: () => void; started: Promise<void> } {
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => { signalStarted = r; });
  const ctx = {
    model: { tokenize: (s: string) => Array.from(s, (_c, i) => i + 1) },
    rankAll: async (_q: number[], docs: number[][]) => {
      signalStarted();
      await gate;
      return docs.map(() => 0.8); // high cross score → survives BAND_DROP_BELOW
    },
  };
  return { ctx, release: releaseGate, started };
}

function makeSession(sessionId: string): SessionState {
  const s = new SessionState(sessionId, sessionId);
  // Force the full-retrieval miss path: provide a user message, skip the
  // "skipRetrieval" branch, and short-circuit ensureRecentTurns' DB read.
  s.currentConfig = { intent: "unknown", skipRetrieval: false } as unknown as SessionState["currentConfig"];
  s._cachedPrevTurns = [];
  return s;
}

const messages = [
  { role: "user", content: [{ type: "text", text: "tell me about the retrievable concepts alpha bravo" }] },
] as unknown as Parameters<typeof graphTransformContext>[0]["messages"];

describe("R22/R10: aborted transform skips bump/stage/cache side effects", () => {
  beforeEach(() => {
    _resetRerankBreaker();
    clearPrefetchCache();
  });
  afterEach(() => {
    _setRankingCtxForTest(null);
    _resetRerankBreaker();
    clearPrefetchCache();
    vi.restoreAllMocks();
  });

  it("positive control: a NON-aborted run DOES bump, stage, and cache", async () => {
    const sessionId = "r22-control";
    const { store, bumpSpy } = makeStore();
    const { ctx, release } = makeGatedCtx();
    _setRankingCtxForTest(ctx as Parameters<typeof _setRankingCtxForTest>[0]);
    release(); // let rerank complete immediately — no abort

    const session = makeSession(sessionId);
    const res = await graphTransformContext({
      messages, session, store, embeddings: makeEmbeddings(), contextWindow: 200_000,
    });

    // Reached the graph path (not passthrough) and ran all side effects.
    expect(res.stats.mode).toBe("graph");
    expect(bumpSpy).toHaveBeenCalledTimes(1);
    expect(getStagedItems(sessionId).length).toBeGreaterThan(0);
    expect(getPrefetchStats().entries).toBe(1);
  });

  it("aborting WHILE the reranker computes skips bump, stage, and cache", async () => {
    const sessionId = "r22-aborted";
    const { store, bumpSpy } = makeStore();
    const { ctx, release, started } = makeGatedCtx();
    _setRankingCtxForTest(ctx as Parameters<typeof _setRankingCtxForTest>[0]);

    const ac = new AbortController();
    const session = makeSession(sessionId);
    const p = graphTransformContext({
      messages, session, store, embeddings: makeEmbeddings(),
      contextWindow: 200_000, signal: ac.signal,
    });

    // Wait until the pipeline is INSIDE rerank (past the pre-rerank checkAbort),
    // then abort and release. The post-rerank R10 guards must now see
    // signal.aborted === true and skip every side effect.
    await started;
    ac.abort();
    release();

    const res = await p;

    // The function still returns (the R10 guard skips side effects; it does not
    // throw) — the assembler discards this late result. The load-bearing
    // assertions are that NONE of the three side effects fired.
    expect(res).toBeDefined();
    expect(bumpSpy).not.toHaveBeenCalled();
    expect(getStagedItems(sessionId)).toHaveLength(0);
    expect(getPrefetchStats().entries).toBe(0);
  });
});
