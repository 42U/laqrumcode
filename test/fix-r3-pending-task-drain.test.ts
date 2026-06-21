/**
 * Regression test for R3: detached Stop-path background work (evaluateRetrieval,
 * which writes the LAST turn's ACAN rows — retrieval_outcome + turn_score) must
 * be drained by graceful shutdown BEFORE the reranker is disposed and Surreal is
 * force-closed.
 *
 * Before R3 that eval was a bare `void evaluateRetrieval(...).catch(...)`. The
 * server's in-flight drain (DaemonServer.close → awaitInFlightDrain) only counts
 * RPCs still executing in dispatchLine, and the Stop RPC has already returned by
 * the time the eval runs — so the drain skipped it and gracefulCleanup raced
 * into disposeReranker()/shutdownManagedSurreal({force}), tearing the reranker
 * and DB out from under the in-flight eval and losing those rows.
 *
 * The R3 fix adds a daemon-level pending-task registry on GlobalPluginState:
 * Stop registers the eval promise, and gracefulCleanup awaits
 * awaitPendingTasks(<=3s) before disposing shared resources.
 *
 * This pins the registry's real behavior (no mocks): the drain blocks on a
 * registered task, is bounded by its timeout, and entries self-remove on settle
 * so the set can't grow unbounded on a long-lived daemon. CI-safe — no DB.
 */
import { describe, it, expect } from "vitest";
import { GlobalPluginState } from "../src/engine/state.js";
import type { MemoryConfig } from "../src/engine/config.js";

function makeState(): GlobalPluginState {
  const fakeConfig = {
    thresholds: { midSessionCleanupThreshold: 25_000 },
  } as unknown as MemoryConfig;
  const fakeStore = { isAvailable: () => false, dispose: async () => {} } as any;
  const fakeEmbeddings = { isAvailable: () => false, dispose: async () => {} } as any;
  return new GlobalPluginState(fakeConfig, fakeStore, fakeEmbeddings);
}

describe("R3: detached pending-task drain on shutdown", () => {
  it("awaitPendingTasks blocks until a registered detached task settles", async () => {
    const state = makeState();
    let release!: () => void;
    let finished = false;
    const task = new Promise<void>((r) => { release = r; }).then(() => { finished = true; });
    state.registerPendingTask(task);

    // Drain with a generous timeout; it must NOT resolve before the task does.
    let drainResolved = false;
    const drainP = state.awaitPendingTasks(2_000).then(() => { drainResolved = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(drainResolved).toBe(false);
    expect(finished).toBe(false);

    release();
    await drainP;
    expect(drainResolved).toBe(true);
    expect(finished).toBe(true);
  });

  it("is bounded by timeoutMs so a wedged task can't hang shutdown", async () => {
    const state = makeState();
    // A task that never settles (the zombie-DB-write scenario).
    state.registerPendingTask(new Promise<void>(() => {}));
    const t0 = Date.now();
    await state.awaitPendingTasks(120);
    const elapsed = Date.now() - t0;
    // Returned at the bound, not hung. Allow scheduler slack.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_500);
  });

  it("a rejected detached task does not abort the drain (allSettled)", async () => {
    const state = makeState();
    state.registerPendingTask(Promise.reject(new Error("eval boom")));
    // Must resolve, not throw — a failed last-turn eval can't crash shutdown.
    await expect(state.awaitPendingTasks(500)).resolves.toBeUndefined();
  });

  it("settled tasks self-remove from the registry (no unbounded growth)", async () => {
    const state = makeState();
    expect(state.pendingTaskCount).toBe(0);
    for (let i = 0; i < 100; i++) {
      state.registerPendingTask(Promise.resolve(i));
    }
    // Let the .then(done) microtasks flush.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(state.pendingTaskCount).toBe(0);
  });

  it("returns immediately when nothing is registered", async () => {
    const state = makeState();
    const t0 = Date.now();
    await state.awaitPendingTasks(5_000);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
