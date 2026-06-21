/**
 * Regression tests for the daemon-lane memory-bound fixes in engine/state.ts:
 *
 *   K1  — GlobalPluginState.sessions Map must be hard-capped (backstop for the
 *         periodic reaper) so a long-lived daemon whose SessionEnd never fires
 *         can't grow the Map without bound → OOM. Oldest entry is evicted and
 *         its onSessionRemoved callbacks fire.
 *
 *   K48 — SessionState._observedFilePaths must be bounded. Fed by every
 *         Read/Edit (pre-tool-use) AND by path extraction over Grep/Glob/recall
 *         result text (post-tool-use); a single big payload can balloon it and
 *         on a long session it only grows. observeFilePath() caps it FIFO.
 *
 * Both would FAIL before the fix: getOrCreateSession had no eviction (Map grew
 * unbounded) and _observedFilePaths was a raw Set with direct .add() and no cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import type { MemoryConfig } from "../src/engine/config.js";

function makeState(): GlobalPluginState {
  const fakeConfig = {
    thresholds: { midSessionCleanupThreshold: 25_000 },
  } as unknown as MemoryConfig;
  const fakeStore = { isAvailable: () => false } as any;
  const fakeEmbeddings = { isAvailable: () => false, dispose: async () => {} } as any;
  return new GlobalPluginState(fakeConfig, fakeStore, fakeEmbeddings);
}

describe("K1: sessions Map hard size cap", () => {
  const original = process.env.KONGCODE_MAX_SESSIONS;
  beforeEach(() => { process.env.KONGCODE_MAX_SESSIONS = "3"; });
  afterEach(() => {
    if (original === undefined) delete process.env.KONGCODE_MAX_SESSIONS;
    else process.env.KONGCODE_MAX_SESSIONS = original;
  });

  it("never exceeds the cap no matter how many sessions are created", () => {
    const state = makeState();
    for (let i = 0; i < 50; i++) {
      state.getOrCreateSession(`sk-${i}`, `claude-${i}`);
    }
    // Without the cap this Map would hold 50 entries (the OOM path).
    expect(state.sessionCount).toBe(3);
  });

  it("evicts the OLDEST session and fires its onSessionRemoved callbacks", () => {
    const state = makeState();
    const removed: Array<[string, string]> = [];
    state.onSessionRemoved((sid, surreal) => removed.push([sid, surreal]));

    const s0 = state.getOrCreateSession("sk-0", "claude-0");
    s0.surrealSessionId = "session:0";
    state.getOrCreateSession("sk-1", "claude-1");
    state.getOrCreateSession("sk-2", "claude-2");
    // At cap (3). Creating a 4th must evict sk-0 (oldest).
    state.getOrCreateSession("sk-3", "claude-3");

    expect(state.sessionCount).toBe(3);
    expect(state.getSession("sk-0")).toBeUndefined();
    expect(state.getSession("sk-3")).toBeDefined();
    // The eviction must fire the removal callback with the evicted identity so
    // module-scoped session-keyed maps clear too.
    expect(removed).toContainEqual(["claude-0", "session:0"]);
  });

  it("re-fetching an existing session does NOT evict (no churn on the happy path)", () => {
    const state = makeState();
    state.getOrCreateSession("sk-a", "claude-a");
    state.getOrCreateSession("sk-b", "claude-b");
    state.getOrCreateSession("sk-c", "claude-c");
    const removed = vi.fn();
    state.onSessionRemoved(removed);
    // Touch an existing key many times — must be a pure lookup, no eviction.
    for (let i = 0; i < 20; i++) state.getOrCreateSession("sk-b", "claude-b");
    expect(state.sessionCount).toBe(3);
    expect(removed).not.toHaveBeenCalled();
  });
});

describe("K48: _observedFilePaths FIFO cap", () => {
  it("observeFilePath bounds the Set at OBSERVED_PATHS_CAP, evicting oldest", () => {
    const s = new SessionState("sid", "skey");
    const cap = SessionState.OBSERVED_PATHS_CAP;
    // Insert cap + 500 distinct paths.
    for (let i = 0; i < cap + 500; i++) {
      s.observeFilePath(`/repo/file-${i}.ts`);
    }
    // Bounded — would be cap+500 with a raw Set.add() and no cap.
    expect(s._observedFilePaths.size).toBe(cap);
    // Oldest evicted, newest retained (FIFO).
    expect(s._observedFilePaths.has("/repo/file-0.ts")).toBe(false);
    expect(s._observedFilePaths.has(`/repo/file-${cap + 499}.ts`)).toBe(true);
  });

  it("keeps membership stable for recently-observed paths (edit-gate contract)", () => {
    const s = new SessionState("sid", "skey");
    s.observeFilePath("/repo/recent.ts");
    // A burst of other paths below the cap must not evict the recent one.
    for (let i = 0; i < 100; i++) s.observeFilePath(`/repo/other-${i}.ts`);
    expect(s._observedFilePaths.has("/repo/recent.ts")).toBe(true);
  });
});
