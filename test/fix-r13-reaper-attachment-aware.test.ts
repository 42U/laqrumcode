/**
 * Regression test for R13: the stale-session reaper must NOT drop a session
 * that is still LIVE.
 *
 * The round-1 K1 reaper (commit 26ea0b0) reaped purely on turnStartMs age.
 * But turnStartMs is only reset at turn START (resetTurn), so a single long
 * agentic turn that runs past the stale threshold looks "idle" — and a session
 * whose client socket is still attached can likewise be mid-long-turn. Reaping
 * either one orphans its subagent rows + unconsumed pending tool args and
 * resets mid-conversation state.
 *
 * The R13 fix adds two skip guards to reapStaleSessions, both fail-safe:
 *   1. an `isLive(sessionId)` predicate (daemon backs it with the set of
 *      session ids whose client socket is attached — server.attachedSessionIds);
 *   2. an in-progress-turn check (non-empty _activeSubagents OR pendingToolArgs).
 *
 * These exercise the predicate + guards directly against real SessionState /
 * GlobalPluginState — no DB, CI-safe.
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

const STALE_MS = 60_000;

describe("R13: stale-session reaper skips live + in-progress sessions", () => {
  // LAQRUMCODE_MAX_SESSIONS large so the cap never interferes with these.
  const original = process.env.LAQRUMCODE_MAX_SESSIONS;
  beforeEach(() => { process.env.LAQRUMCODE_MAX_SESSIONS = "1000"; });
  afterEach(() => {
    if (original === undefined) delete process.env.LAQRUMCODE_MAX_SESSIONS;
    else process.env.LAQRUMCODE_MAX_SESSIONS = original;
  });

  it("reaps a genuinely idle session (no client, no in-progress turn)", () => {
    const state = makeState();
    const s = state.getOrCreateSession("sk-idle", "claude-idle");
    s.turnStartMs = Date.now() - STALE_MS - 1; // older than threshold
    const reaped = state.reapStaleSessions(STALE_MS, () => false);
    expect(reaped).toBe(1);
    expect(state.getSession("sk-idle")).toBeUndefined();
  });

  it("does NOT reap a stale-by-age session whose client socket is still attached", () => {
    const state = makeState();
    const s = state.getOrCreateSession("sk-live", "claude-live");
    s.turnStartMs = Date.now() - STALE_MS - 1; // a long agentic turn

    // isLive mirrors what daemon/index.ts builds from server.attachedSessionIds().
    const attached = new Set<string>(["claude-live"]);
    const reaped = state.reapStaleSessions(STALE_MS, (sid) => attached.has(sid));

    expect(reaped).toBe(0);
    // getSession re-bumps recency but the session must still be present.
    expect(state.getSession("sk-live")).toBeDefined();
  });

  it("does NOT reap a session with an in-progress turn (unfinished subagent)", () => {
    const state = makeState();
    const s = state.getOrCreateSession("sk-subagent", "claude-subagent");
    s.turnStartMs = Date.now() - STALE_MS - 1;
    // A PreToolUse(Agent) wrote a subagent row that SubagentStop hasn't closed.
    s._activeSubagents.set("toolu_123", "subagent:abc");

    // No live socket — only the in-progress-turn guard can save it.
    const reaped = state.reapStaleSessions(STALE_MS, () => false);
    expect(reaped).toBe(0);
    expect(state.getSession("sk-subagent")).toBeDefined();
  });

  it("does NOT reap a session with unconsumed pending tool args", () => {
    const state = makeState();
    const s = state.getOrCreateSession("sk-pending", "claude-pending");
    s.turnStartMs = Date.now() - STALE_MS - 1;
    s.pendingToolArgs.set("toolu_456", { file_path: "/x.ts" });

    const reaped = state.reapStaleSessions(STALE_MS, () => false);
    expect(reaped).toBe(0);
    expect(state.getSession("sk-pending")).toBeDefined();
  });

  it("reaps idle but spares live within the same sweep", () => {
    const state = makeState();
    const idle = state.getOrCreateSession("sk-i", "claude-i");
    const live = state.getOrCreateSession("sk-l", "claude-l");
    idle.turnStartMs = Date.now() - STALE_MS - 1;
    live.turnStartMs = Date.now() - STALE_MS - 1;

    const attached = new Set<string>(["claude-l"]);
    const reaped = state.reapStaleSessions(STALE_MS, (sid) => attached.has(sid));

    expect(reaped).toBe(1);
    expect(state.getSession("sk-i")).toBeUndefined();
    expect(state.getSession("sk-l")).toBeDefined();
  });

  it("with no predicate, falls back to age-only behavior (round-1 compat)", () => {
    const state = makeState();
    const s = state.getOrCreateSession("sk-old", "claude-old");
    s.turnStartMs = Date.now() - STALE_MS - 1;
    // No isLive, no in-progress turn → reaped, exactly as round-1 did.
    const reaped = state.reapStaleSessions(STALE_MS);
    expect(reaped).toBe(1);
    expect(state.getSession("sk-old")).toBeUndefined();
  });
});
