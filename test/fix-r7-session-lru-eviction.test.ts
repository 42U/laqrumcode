/**
 * Regression test for R7: the K1 sessions-Map size cap must evict the
 * least-recently-ACCESSED session, not the oldest-by-creation (FIFO).
 *
 * The round-1 K1 fix (commit 26ea0b0) capped the Map but evicted
 * `sessions.keys().next().value` — which, for a Map never re-ordered on
 * access, is the FIRST-INSERTED entry. On a long-lived per-host daemon the
 * first-inserted session is usually the longest-LIVED, still-active one (a
 * developer's primary tab), so the cap would silently drop the active
 * session — resetting its mid-conversation SessionState and dropping its
 * ingest — while younger idle sessions survived.
 *
 * The R7 fix bumps LRU recency on every getSession / getOrCreateSession
 * access (delete + re-set, the same O(1) trick embeddings.ts uses for its L1
 * cache), so keys().next() now yields the genuinely coldest entry.
 *
 * These assert the recency contract directly — no DB, CI-safe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GlobalPluginState } from "../src/engine/state.js";
import type { MemoryConfig } from "../src/engine/config.js";

function makeState(): GlobalPluginState {
  const fakeConfig = {
    thresholds: { midSessionCleanupThreshold: 25_000 },
  } as unknown as MemoryConfig;
  const fakeStore = { isAvailable: () => false } as any;
  const fakeEmbeddings = { isAvailable: () => false, dispose: async () => {} } as any;
  return new GlobalPluginState(fakeConfig, fakeStore, fakeEmbeddings);
}

describe("R7: sessions Map cap evicts least-recently-accessed, not FIFO", () => {
  const original = process.env.KONGCODE_MAX_SESSIONS;
  beforeEach(() => { process.env.KONGCODE_MAX_SESSIONS = "3"; });
  afterEach(() => {
    if (original === undefined) delete process.env.KONGCODE_MAX_SESSIONS;
    else process.env.KONGCODE_MAX_SESSIONS = original;
  });

  it("a recently-ACCESSED (active) session SURVIVES while an idle one is evicted", () => {
    const state = makeState();
    const removed: string[] = [];
    state.onSessionRemoved((sid) => removed.push(sid));

    // Fill to cap. sk-0 is the oldest-by-creation — the FIFO victim.
    state.getOrCreateSession("sk-0", "claude-0"); // the "active" session
    state.getOrCreateSession("sk-1", "claude-1");
    state.getOrCreateSession("sk-2", "claude-2");

    // sk-0 keeps getting touched (an ongoing conversation routes every hook
    // through getSession). Under pure FIFO it would STILL be evicted next.
    expect(state.getSession("sk-0")).toBeDefined();

    // A brand-new session arrives at cap → must evict the COLDEST, which is
    // now sk-1 (sk-0 was just touched, sk-2 inserted after sk-1).
    state.getOrCreateSession("sk-3", "claude-3");

    expect(state.sessionCount).toBe(3);
    // THE fix: the active session survives.
    expect(state.getSession("sk-0")).toBeDefined();
    // The genuinely-coldest idle session was evicted instead.
    expect(state.getSession("sk-1")).toBeUndefined();
    expect(removed).toContain("claude-1");
    expect(removed).not.toContain("claude-0");
  });

  it("getOrCreateSession on an existing key also refreshes recency", () => {
    const state = makeState();
    const removed: string[] = [];
    state.onSessionRemoved((sid) => removed.push(sid));

    state.getOrCreateSession("sk-0", "claude-0");
    state.getOrCreateSession("sk-1", "claude-1");
    state.getOrCreateSession("sk-2", "claude-2");

    // Touch sk-0 via getOrCreateSession (the path daemon tool calls use).
    state.getOrCreateSession("sk-0", "claude-0");

    // New session at cap → coldest (sk-1) evicted, sk-0 survives.
    state.getOrCreateSession("sk-3", "claude-3");
    expect(state.getSession("sk-0")).toBeDefined();
    expect(removed).toContain("claude-1");
    expect(removed).not.toContain("claude-0");
  });

  it("under no touches, eviction still matches insertion order (round-1 behavior preserved)", () => {
    const state = makeState();
    const removed: string[] = [];
    state.onSessionRemoved((sid) => removed.push(sid));
    // No getSession touches between inserts → access order == insertion order.
    for (let i = 0; i < 4; i++) state.getOrCreateSession(`sk-${i}`, `claude-${i}`);
    expect(state.sessionCount).toBe(3);
    // sk-0 (first inserted, never touched) is the coldest → evicted, as before.
    expect(removed).toContain("claude-0");
    expect(state.getSession("sk-0")).toBeUndefined();
  });
});
