/**
 * Regression test for K12 (embed-queue half): EmbeddingService.embed() must
 * fast-fail past a bounded queue depth instead of pushing without limit.
 *
 * llama serializes embedding compute (one item at a time). The old embed()
 * pushed every request into embedQueue unconditionally — so a burst of hook
 * traffic, or a wedged/slow embedder, grew the FIFO without bound. Each entry
 * pins its text + two closures, making the queue the memory-leak surface on a
 * long-lived per-host daemon. The fix caps the queue and throws a clear,
 * retryable error past the ceiling.
 *
 * This stubs a never-resolving compute context so items stay queued, fills the
 * queue to the cap, and asserts the next embed() throws. Against the old code
 * the push was unbounded and no throw occurred.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EmbeddingService } from "../src/engine/embeddings.js";
import type { EmbeddingConfig } from "../src/engine/config.js";

describe("K12: embed queue hard cap", () => {
  const original = process.env.LAQRUMCODE_EMBED_QUEUE_MAX;
  beforeEach(() => { process.env.LAQRUMCODE_EMBED_QUEUE_MAX = "4"; });
  afterEach(() => {
    if (original === undefined) delete process.env.LAQRUMCODE_EMBED_QUEUE_MAX;
    else process.env.LAQRUMCODE_EMBED_QUEUE_MAX = original;
  });

  function makeReadyService(): EmbeddingService {
    const config = { modelPath: "/tmp/fake-model.gguf" } as unknown as EmbeddingConfig;
    const svc = new EmbeddingService(config) as any;
    // Mark ready and install a compute context whose getEmbeddingFor never
    // settles, so enqueued items stay in the FIFO (the drain can't pop them).
    svc.ready = true;
    svc.ctx = { getEmbeddingFor: () => new Promise(() => {}) };
    // No store set → l2Get short-circuits to null before the cap check.
    return svc as EmbeddingService;
  }

  // embed() awaits l2Get before the cap check, so a fill call only lands in the
  // queue after a microtask/timer turn. Flush a macrotask between fills so each
  // push completes deterministically before the next call's cap check runs.
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("throws a retryable error once the queue is full", async () => {
    const svc = makeReadyService();
    // Fill the FIFO to the cap (4). drainEmbedQueue() pulls the HEAD item into
    // in-flight compute the moment it's pushed, so an enqueued item leaves
    // embedQueue while it's "computing" (here: the never-resolve stub). To leave
    // exactly maxQueueDepth (4) items WAITING in embedQueue we must issue 5
    // embed() calls: 1 held in-flight by the drain + 4 still queued. These
    // promises stay pending (never-resolve compute) — that's intended; we only
    // care that they occupy queue slots.
    for (let i = 0; i < 5; i++) {
      const p = svc.embed(`text-${i}`);
      p.catch(() => {}); // avoid unhandled-rejection noise
      await flush(); // ensure this item is enqueued before the next fill
    }
    expect((svc as any).embedQueue.length).toBe(4);
    // The next embed() hits the cap (embedQueue.length >= maxQueueDepth) and
    // must be rejected, not enqueued.
    await expect(svc.embed("overflow")).rejects.toThrow(/queue full/i);
    // Queue length unchanged — the overflow item was never pushed.
    expect((svc as any).embedQueue.length).toBe(4);
  });

  it("does not throw below the cap (happy path enqueues normally)", async () => {
    const svc = makeReadyService();
    // Three embed() calls, cap is 4 — must enqueue without throwing. The drain
    // holds one item in-flight (never-resolve stub), leaving 2 WAITING in
    // embedQueue. We assert no rejection from the cap and the expected depth.
    let threw = false;
    try {
      const p1 = svc.embed("a"); p1.catch(() => {});
      await flush();
      const p2 = svc.embed("b"); p2.catch(() => {});
      await flush();
      const p3 = svc.embed("c"); p3.catch(() => {});
      await flush();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect((svc as any).embedQueue.length).toBe(2);
  });
});
