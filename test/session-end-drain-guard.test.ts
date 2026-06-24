/**
 * Unit tests for the drain self-trigger guard in handleSessionEnd (2026-06-09
 * spawn-storm fix). A drain child's own SessionEnd must NOT re-trigger the
 * scheduler (pre-fix: fail → exit → SessionEnd → respawn, ~25s storm cadence)
 * and must NOT enqueue extraction work — but it SHOULD close the session row
 * so deferred cleanup doesn't enqueue for it later.
 *
 * The drain path is distinguished from the normal path by an observable: it
 * logs "(drain session — …)" via log.info. That lets the strict-boolean test
 * genuinely pin `payload.laqrumcode_drain_session === true` (a truthy STRING
 * must not take the drain path). auto-drain + log are vi.mock'd; state/store
 * are hand-rolled fakes. No DB — CI-safe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/daemon/auto-drain.js", () => ({
  triggerDrainCheck: vi.fn(),
}));
vi.mock("../src/engine/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { triggerDrainCheck } from "../src/daemon/auto-drain.js";
import { log } from "../src/engine/log.js";
import { handleSessionEnd } from "../src/hook-handlers/session-end.js";

function makeFakes(surrealSessionId = "session:abc123drain") {
  const claimSessionForCleanup = vi.fn(async () => true);
  const removeSession = vi.fn();
  const state = {
    getSession: vi.fn(() => ({ surrealSessionId })),
    removeSession,
    config: { paths: { cacheDir: "/tmp/kc-test-cache" } },
    store: {
      isAvailable: () => true,
      claimSessionForCleanup,
    },
  };
  return { state, claimSessionForCleanup, removeSession };
}

function drainLogLines(): string[] {
  return vi.mocked(log.info).mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => line.includes("drain session"));
}

describe("handleSessionEnd — drain self-trigger guard", () => {
  beforeEach(() => {
    vi.mocked(triggerDrainCheck).mockClear();
    vi.mocked(log.info).mockClear();
  });

  it("a tagged drain session (boolean true) closes its row and skips queue + drain re-trigger", async () => {
    const { state, claimSessionForCleanup, removeSession } = makeFakes();
    const res = await handleSessionEnd(
      state as never,
      { session_id: "cc-drain-uuid", laqrumcode_drain_session: true },
    );
    expect(res).toEqual({});
    // Observable proof the DRAIN path ran.
    expect(drainLogLines().length).toBe(1);
    // Row closed so deferred cleanup won't enqueue junk extraction for it.
    expect(claimSessionForCleanup).toHaveBeenCalledWith("session:abc123drain");
    expect(removeSession).toHaveBeenCalledWith("cc-drain-uuid");
    // THE fix: no scheduler re-trigger from a drain session's own end.
    expect(triggerDrainCheck).not.toHaveBeenCalled();
  });

  it("a truthy STRING tag does NOT take the drain path (strict === true)", async () => {
    // No surrealSessionId: if the guard correctly ignores the string, the
    // normal pipeline bails at the no-row check (no claim, no trigger). If a
    // coercion bug made the guard fire, the drain log line would appear.
    const { state, claimSessionForCleanup, removeSession } = makeFakes("");
    const res = await handleSessionEnd(
      state as never,
      { session_id: "cc-user-uuid", laqrumcode_drain_session: "true" },
    );
    expect(res).toEqual({});
    expect(drainLogLines().length).toBe(0); // drain path did NOT run
    expect(claimSessionForCleanup).not.toHaveBeenCalled(); // normal no-row bail
    expect(removeSession).toHaveBeenCalledWith("cc-user-uuid");
    expect(triggerDrainCheck).not.toHaveBeenCalled();
  });

  it("an untagged payload takes the normal path (no drain log)", async () => {
    const { state, claimSessionForCleanup } = makeFakes("");
    await handleSessionEnd(state as never, { session_id: "cc-user-uuid-2" });
    expect(drainLogLines().length).toBe(0);
    expect(claimSessionForCleanup).not.toHaveBeenCalled(); // no-row bail
    expect(triggerDrainCheck).not.toHaveBeenCalled();
  });
});
