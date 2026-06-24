/**
 * R2 regression: the K13 rerank circuit-breaker re-introduced the B17
 * queue-timeout pathology.
 *
 * node-llama-cpp serializes rankAll() internally (withLock), so when several
 * callers rank concurrently they compute ONE AT A TIME. The original
 * rankAllWithDeadline armed each call's RERANK_TIMEOUT_MS clock at SUBMIT, so
 * item k "timed out" after waiting k×(compute) in line — ratcheting the shared
 * _rerankConsecutiveTimeouts module-global to the breaker threshold WITHOUT a
 * single slow compute. The fix routes every rankAll through one explicit FIFO
 * that starts each item's deadline clock at DEQUEUE (compute-start), exactly as
 * EmbeddingService.drainEmbedQueue does.
 *
 * This test enqueues many crossEncoderScorePairs calls behind each other while
 * each individual fake compute is well under the deadline, and asserts:
 *   - every call resolves to real scores (none rejected/null'd by a phantom
 *     queue-depth timeout),
 *   - the consecutive-timeout breaker never trips,
 * which is precisely the regression: under the submit-clock design the deep
 * items would have exceeded the deadline purely from queue depth.
 *
 * No DB, no 606MB model — a fake LlamaRankingContext is injected via the
 * @internal _setRankingCtxForTest seam. The module is imported fresh under a
 * short LAQRUMCODE_RERANK_TIMEOUT_MS so the deadline is deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A single fake compute (60ms) is comfortably under the 150ms deadline, but the
// CUMULATIVE wait of the deep queue items (≈11×60 = 660ms) is well over it.
// Submit-clock code → deep items time out; dequeue-clock code → all pass.
const COMPUTE_MS = 60;
const DEADLINE_MS = 150;
const N_CONCURRENT = 12;

type FakeRankingCtx = {
  model: { tokenize: (s: string) => number[] };
  rankAll: (q: number[], docs: number[][]) => Promise<number[]>;
};

function makeFakeCtx(): { ctx: FakeRankingCtx; maxInFlight: () => number } {
  let inFlight = 0;
  let peak = 0;
  const ctx: FakeRankingCtx = {
    // capTokens calls model.tokenize(text); 1 token per char is fine — the
    // values are never interpreted, only sliced to a length cap.
    model: { tokenize: (s: string) => Array.from(s, (_c, i) => i + 1) },
    rankAll: async (_q, docs) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise<void>((r) => setTimeout(r, COMPUTE_MS));
        return docs.map(() => 0.5);
      } finally {
        inFlight--;
      }
    },
  };
  return { ctx, maxInFlight: () => peak };
}

describe("R2: rerank FIFO starts the deadline clock at dequeue, not submit", () => {
  let mod: typeof import("../src/engine/graph-context.js");
  let prevTimeout: string | undefined;

  beforeEach(async () => {
    prevTimeout = process.env.LAQRUMCODE_RERANK_TIMEOUT_MS;
    process.env.LAQRUMCODE_RERANK_TIMEOUT_MS = String(DEADLINE_MS);
    vi.resetModules();
    mod = await import("../src/engine/graph-context.js");
    mod._resetRerankBreaker();
  });

  afterEach(() => {
    mod._setRankingCtxForTest(null);
    mod._resetRerankBreaker();
    if (prevTimeout === undefined) delete process.env.LAQRUMCODE_RERANK_TIMEOUT_MS;
    else process.env.LAQRUMCODE_RERANK_TIMEOUT_MS = prevTimeout;
    vi.resetModules();
  });

  it("does not count queued items as timeouts purely from queue depth", async () => {
    const { ctx, maxInFlight } = makeFakeCtx();
    mod._setRankingCtxForTest(ctx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);

    // Fire N concurrent rank calls. Each is a single-doc scoring, so each
    // enqueues exactly one FIFO item that must wait behind the ones ahead.
    const calls = Array.from({ length: N_CONCURRENT }, (_v, i) =>
      mod.crossEncoderScorePairs(`anchor-${i}`, [`doc-${i}`]),
    );
    const results = await Promise.all(calls);

    // Every call returned real scores — none was rejected/null'd by a phantom
    // queue-depth timeout (the catch in crossEncoderScorePairs maps a real
    // timeout throw to null, so null here would mean a spurious deadline hit).
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r).toHaveLength(1);
      expect(r![0]).toBeCloseTo(0.5);
    }

    // The breaker never tripped: zero consecutive timeouts despite N items
    // queueing for far longer (cumulatively) than the per-item deadline.
    const state = mod._rerankBreakerState();
    expect(state.consecutiveTimeouts).toBe(0);
    expect(state.open).toBe(false);
    expect(state.queueDepth).toBe(0);

    // Serialization is genuine — the FIFO computed one rankAll at a time
    // (proves the per-item clock measures compute, not contention).
    expect(maxInFlight()).toBe(1);
  });

  it("still trips the breaker on genuinely slow single computes (compute clock works)", async () => {
    // A single compute that blows the deadline IS a real timeout and must count.
    const slowCtx: FakeRankingCtx = {
      model: { tokenize: (s: string) => Array.from(s, (_c, i) => i + 1) },
      rankAll: async () => {
        await new Promise<void>((r) => setTimeout(r, DEADLINE_MS * 3));
        return [0.5];
      },
    };
    mod._setRankingCtxForTest(slowCtx as unknown as Parameters<typeof mod._setRankingCtxForTest>[0]);

    // RERANK_MAX_CONSECUTIVE_TIMEOUTS defaults to 3. Three serial slow computes
    // (each a real per-item deadline hit) must open the breaker.
    for (let i = 0; i < 3; i++) {
      const r = await mod.crossEncoderScorePairs(`a${i}`, [`d${i}`]);
      expect(r).toBeNull(); // timeout → catch → null
    }
    const state = mod._rerankBreakerState();
    expect(state.consecutiveTimeouts).toBeGreaterThanOrEqual(3);
    expect(state.open).toBe(true);
  }, 10_000);
});
