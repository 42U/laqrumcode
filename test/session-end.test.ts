/**
 * Regression tests for src/hook-handlers/session-end.ts.
 *
 * Wave 2 Fix #2 (v0.7.89): `triggerDrainCheck` must be invoked BEFORE the
 * `clearSessionClaim` retry loop so the 60s Claude Code hook timeout never
 * cancels the SessionEnd handler before the drain trigger fires. Earlier
 * (pre-0.7.89) order:
 *
 *     await clearSessionClaim(...);  // retry loop with 1s sleep on failure
 *     // ...
 *     triggerDrainCheck(state, opts, "session-end");
 *     return {};
 *
 * was vulnerable to "trigger never reached" when the retry path exceeded
 * the hook budget. The new order fires trigger first (fire-and-forget,
 * returns immediately) then awaits the clearSessionClaim flow.
 *
 * These tests assert:
 *   (a) on the happy path triggerDrainCheck is called once,
 *   (b) the call to triggerDrainCheck completes BEFORE clearSessionClaim
 *       (verified via call-order spy on a single recorder array).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock the auto-drain module so triggerDrainCheck can be intercepted
// without spawning real subprocesses. Order matters: vi.mock is hoisted
// above imports, so the handler under test imports the mocked version.
vi.mock("../src/daemon/auto-drain.js", () => ({
  triggerDrainCheck: vi.fn(),
}));

// hasSoul / checkStageTransition: both DB readers — mocked to avoid the
// session-end handler hitting a real store on the happy path.
vi.mock("../src/engine/soul.js", () => ({
  hasSoul: vi.fn(async () => false),
  checkStageTransition: vi.fn(async () => ({ transitioned: false })),
}));

// writeHandoffFileSync: filesystem side-effect we don't care about in
// this test; stub it out so handoff writes don't pollute the cwd.
vi.mock("../src/engine/handoff-file.js", () => ({
  writeHandoffFileSync: vi.fn(),
}));

import { handleSessionEnd } from "../src/hook-handlers/session-end.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import { triggerDrainCheck } from "../src/daemon/auto-drain.js";

describe("handleSessionEnd — triggerDrainCheck ordering (Wave 2 Fix #2)", () => {
  let session: SessionState;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    vi.clearAllMocks();

    session = new SessionState("sess-fix2", "sess-fix2");
    (session as unknown as { surrealSessionId: string }).surrealSessionId = "session:abc123";
    (session as unknown as { userTurnCount: number }).userTurnCount = 3;
  });

  function makeState(opts: {
    claimWins: boolean;
    clearSucceeds: boolean;
    clearDelayMs?: number;
  }): GlobalPluginState {
    const queryExec = vi.fn(async () => {
      callOrder.push("queryExec");
      return undefined;
    });
    const claimSessionForCleanup = vi.fn(async () => {
      callOrder.push("claimSessionForCleanup");
      return opts.claimWins;
    });
    const releaseSessionClaim = vi.fn(async () => {
      callOrder.push("releaseSessionClaim");
    });
    const clearSessionClaim = vi.fn(async () => {
      callOrder.push("clearSessionClaim");
      if (opts.clearDelayMs && opts.clearDelayMs > 0) {
        await new Promise(r => setTimeout(r, opts.clearDelayMs));
      }
      if (!opts.clearSucceeds) throw new Error("simulated clear failure");
    });

    const store = {
      isAvailable: () => true,
      claimSessionForCleanup,
      releaseSessionClaim,
      clearSessionClaim,
      queryExec,
      queryFirst: vi.fn(async () => []),
      // Enqueue dedup gate (2026-06-18): false → no existing pending row, so
      // the causal_graduate / soul_* enqueues proceed and these ordering tests
      // see the queryExec calls they expect.
      hasPendingWorkOfType: vi.fn(async () => false),
    } as unknown as GlobalPluginState["store"];

    const state = {
      store,
      config: { paths: { cacheDir: "/tmp/kc-test-cache" } },
      workspaceDir: "/tmp",
    } as unknown as GlobalPluginState;

    (state as unknown as { getSession: (k: string) => SessionState | undefined }).getSession =
      (k: string) => k === session.sessionKey ? session : undefined;
    (state as unknown as { removeSession: (k: string) => void }).removeSession = vi.fn();

    // Intercept the mocked triggerDrainCheck so we record exactly when it
    // ran relative to the store calls.
    (triggerDrainCheck as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("triggerDrainCheck");
    });

    return state;
  }

  it("invokes triggerDrainCheck BEFORE clearSessionClaim on the happy path", async () => {
    const state = makeState({ claimWins: true, clearSucceeds: true });
    await handleSessionEnd(state, {
      session_id: "sess-fix2",
      hook_event_name: "SessionEnd",
    });
    const trigger = callOrder.indexOf("triggerDrainCheck");
    const clear = callOrder.indexOf("clearSessionClaim");
    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeLessThan(clear);
  });

  it("triggerDrainCheck fires exactly once per SessionEnd", async () => {
    const state = makeState({ claimWins: true, clearSucceeds: true });
    await handleSessionEnd(state, {
      session_id: "sess-fix2",
      hook_event_name: "SessionEnd",
    });
    expect(triggerDrainCheck).toHaveBeenCalledTimes(1);
  });

  it("fires trigger even when clearSessionClaim is slow (would otherwise blow past 60s hook budget)", async () => {
    // Simulate a slow clear so the retry path waits the full 1s backoff if
    // it failed. Even with the slow clear, trigger must have already run.
    const state = makeState({ claimWins: true, clearSucceeds: true, clearDelayMs: 50 });
    await handleSessionEnd(state, {
      session_id: "sess-fix2",
      hook_event_name: "SessionEnd",
    });
    expect(callOrder.indexOf("triggerDrainCheck")).toBeLessThan(
      callOrder.indexOf("clearSessionClaim"),
    );
  });

  it("does NOT call triggerDrainCheck if the claim was lost (early return before trigger)", async () => {
    // Lost claim → handler returns before reaching either trigger or clear.
    const state = makeState({ claimWins: false, clearSucceeds: true });
    await handleSessionEnd(state, {
      session_id: "sess-fix2",
      hook_event_name: "SessionEnd",
    });
    expect(triggerDrainCheck).not.toHaveBeenCalled();
  });

  it("does NOT call triggerDrainCheck if there is no surrealSessionId (nothing to queue)", async () => {
    // Empty surrealSessionId → early bail before any work.
    (session as unknown as { surrealSessionId: string }).surrealSessionId = "";
    const state = makeState({ claimWins: true, clearSucceeds: true });
    await handleSessionEnd(state, {
      session_id: "sess-fix2",
      hook_event_name: "SessionEnd",
    });
    expect(triggerDrainCheck).not.toHaveBeenCalled();
  });
});
