import { describe, it, expect } from "vitest";
import { isRerankerActive } from "../src/engine/graph-context.js";

/**
 * Tests for the reranker integration in graph-context.ts.
 *
 * We can't easily test rerankResults directly because it's not exported and
 * depends on the module-level _rankingCtx singleton. Instead we exercise the
 * behavioral contract through the public surface:
 *
 * 1. isRerankerActive() reflects whether _rankingCtx is non-null
 * 2. Without initReranker being called, the reranker is inactive
 * 3. The recall pipeline calls rerankResults internally, which is a no-op
 *    when the reranker isn't loaded — covered by the existing recall test
 *    paths in graph-context.test.ts (548-test baseline still passes).
 *
 * The deeper validation — that rerankResults actually produces 98.2% R@5
 * with the bge-reranker-v2-m3 model loaded — lives in the LongMemEval
 * benchmark (src/bench-longmemeval.ts, ported from laqrumclaw), not in
 * unit tests. Loading the 606MB model in vitest is impractical.
 */

describe("reranker: public surface", () => {
  it("isRerankerActive returns false when reranker isn't initialized", () => {
    // In test environment, initReranker has never been called.
    // _rankingCtx is null by default.
    expect(isRerankerActive()).toBe(false);
  });

  it("isRerankerActive is callable without throwing", () => {
    // Just exercising the function — should never throw, returns boolean.
    expect(typeof isRerankerActive()).toBe("boolean");
  });
});

describe("reranker: graceful degradation contract", () => {
  it("module loads without requiring the reranker model", async () => {
    // Importing graph-context.ts must succeed even when no reranker model
    // is on disk and node-llama-cpp's reranking primitives aren't loaded.
    // This is the contract that lets recall fall back to WMR/ACAN-only
    // scoring on machines without the 606MB model.
    const mod = await import("../src/engine/graph-context.js");
    expect(typeof mod.isRerankerActive).toBe("function");
    expect(typeof mod.initReranker).toBe("function");
    expect(typeof mod.disposeReranker).toBe("function");
  });

  it("disposeReranker is safe to call when reranker was never initialized", async () => {
    const mod = await import("../src/engine/graph-context.js");
    // Should not throw; the function has an internal null guard.
    await expect(mod.disposeReranker()).resolves.toBeUndefined();
  });
});
