import { describe, it, expect, beforeEach } from "vitest";
import { prefetchContext, getPrefetchStats, clearPrefetchCache } from "../src/engine/prefetch.js";

/**
 * Round-5 coverage: prefetchContext fire-and-forget semantics
 * (src/engine/prefetch.ts:126-196).
 *
 * The function must NOT block on embeddings.embed — the caller is on the
 * hot-path of a hook (pre-tool-use, user-prompt-submit), so any extra ms
 * spent in prefetch is paid directly in user-visible latency. The IIFE at
 * line 144-188 fires asynchronously; the outer `for` loop only does sync
 * Map insertions and returns immediately.
 *
 * `_inFlight` is module-internal (line 52). We assert behavior indirectly:
 *   1. Wall-clock budget: the call returns in <50ms even though embed takes 1s.
 *   2. The embed mock is invoked synchronously inside the IIFE (proof the work
 *      started, not deferred to a later tick).
 *   3. After the slow embed resolves, the warmCache picks up the entry — proof
 *      the in-flight promise ran to completion past the return.
 */

// Type-only — we only construct minimal stubs that implement the methods
// prefetch actually calls. The real classes have rich state we don't touch.
type AnyEmbeddings = {
  isAvailable: () => boolean;
  embed: (text: string) => Promise<number[]>;
};
type AnyStore = {
  isAvailable: () => boolean;
  vectorSearch: (...args: unknown[]) => Promise<unknown[]>;
  graphExpand: (...args: unknown[]) => Promise<unknown[]>;
};

function makeSlowEmbedStub(delayMs: number): { stub: AnyEmbeddings; started: { count: number } } {
  const started = { count: 0 };
  const stub: AnyEmbeddings = {
    isAvailable: () => true,
    embed: async (_text: string) => {
      started.count++;
      await new Promise<void>((r) => setTimeout(r, delayMs));
      return new Array(1024).fill(0.01); // BGE-M3 is 1024-dim
    },
  };
  return { stub, started };
}

function makeEmptyStoreStub(): AnyStore {
  return {
    isAvailable: () => true,
    vectorSearch: async () => [],
    graphExpand: async () => [],
  };
}

describe("prefetchContext — fire-and-forget budget", () => {
  beforeEach(() => {
    clearPrefetchCache();
  });

  it("returns in <50ms even with a 1s embed (does not block on embed)", async () => {
    const { stub: embeddings, started } = makeSlowEmbedStub(1000);
    const store = makeEmptyStoreStub();

    const t0 = Date.now();
    await prefetchContext(
      ["test query one"],
      "session-budget-test",
      embeddings as never,
      store as never,
      undefined,
    );
    const elapsed = Date.now() - t0;

    expect(elapsed, `prefetchContext blocked for ${elapsed}ms (should be <50ms)`).toBeLessThan(50);
    // Sanity check: the embed was invoked exactly once (work registered).
    // It's still running (won't resolve for ~1s) but the call started.
    expect(started.count).toBe(1);
  });

  it("registers the in-flight work synchronously (next-tick can observe it)", async () => {
    const { stub: embeddings, started } = makeSlowEmbedStub(500);
    const store = makeEmptyStoreStub();

    // Promise.resolve() returns to the event loop on the next microtask.
    // If the IIFE were deferred past return (e.g. wrapped in setImmediate),
    // started.count would still be 0 here. With proper fire-and-forget
    // semantics it's already 1 because the embed() promise was kicked off
    // inside the IIFE before prefetchContext returned.
    await prefetchContext(
      ["next-tick test"],
      "session-tick-test",
      embeddings as never,
      store as never,
      undefined,
    );

    expect(started.count).toBe(1);
  });

  it("dedups identical (session, project, query) keys within one call", async () => {
    const { stub: embeddings, started } = makeSlowEmbedStub(500);
    const store = makeEmptyStoreStub();

    // Same query four times in the queries array. The for-loop deduplicates
    // via _inFlight.has(key); only the first should kick off embed.
    await prefetchContext(
      ["dup", "dup", "dup", "dup"],
      "session-dedup-test",
      embeddings as never,
      store as never,
      undefined,
    );

    // First call enters _inFlight; subsequent three see the key and continue.
    expect(started.count).toBe(1);
  });

  it("kicks off multiple distinct queries in the same call", async () => {
    const { stub: embeddings, started } = makeSlowEmbedStub(500);
    const store = makeEmptyStoreStub();

    await prefetchContext(
      ["q1", "q2", "q3"],
      "session-multi-test",
      embeddings as never,
      store as never,
      undefined,
    );

    expect(started.count).toBe(3);
  });

  it("populates the warm cache after the slow embed resolves (work continues past return)", async () => {
    const { stub: embeddings } = makeSlowEmbedStub(50); // short enough to wait on
    const store = makeEmptyStoreStub();
    clearPrefetchCache();
    expect(getPrefetchStats().entries).toBe(0);

    await prefetchContext(
      ["cache-write-test"],
      "session-cache-write",
      embeddings as never,
      store as never,
      undefined,
    );

    // prefetchContext returned immediately; the IIFE still has ~50ms to run.
    // Wait for it to complete, then verify the cache picked up the entry.
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(getPrefetchStats().entries).toBeGreaterThan(0);
  });

  it("no-op when embeddings unavailable", async () => {
    const embeddings: AnyEmbeddings = {
      isAvailable: () => false,
      embed: async () => { throw new Error("should not be called"); },
    };
    const store = makeEmptyStoreStub();

    const t0 = Date.now();
    await prefetchContext(
      ["never-runs"],
      "session-unavailable",
      embeddings as never,
      store as never,
      undefined,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(20);
  });

  it("no-op when queries array is empty", async () => {
    const { stub: embeddings, started } = makeSlowEmbedStub(1000);
    const store = makeEmptyStoreStub();

    await prefetchContext(
      [],
      "session-empty",
      embeddings as never,
      store as never,
      undefined,
    );

    expect(started.count).toBe(0);
  });
});
