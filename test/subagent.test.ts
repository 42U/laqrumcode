/**
 * Tests for subagent tracking v1 hook handlers.
 *
 * Covers the three paths through handleSubagentStop:
 *   1. Correlation via tool_use_id → session._activeSubagents lookup
 *   2. Fallback DB query for most-recent in_progress row
 *   3. Orphan stop (nothing matches) — writes a bare row rather than drop
 */

import { describe, it, expect, vi } from "vitest";
import { handleSubagentStop, handleTaskCreated } from "../src/hook-handlers/subagent.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

function mockSession(sessionId = "session-test-1"): SessionState {
  return {
    sessionId,
    surrealSessionId: "session:abc123",
    taskId: "task:t1",
    _activeSubagents: new Map<string, string>(),
  } as unknown as SessionState;
}

function mockState(session: SessionState | null, queryFirstResult: unknown[] = []): GlobalPluginState {
  const store = {
    isAvailable: () => true,
    queryFirst: vi.fn(async () => queryFirstResult),
    queryExec: vi.fn(async () => {}),
    relate: vi.fn(async () => {}),
  };
  return {
    store,
    getSession: vi.fn((id: string) => (session?.sessionId === id ? session : null)),
  } as unknown as GlobalPluginState;
}

describe("handleSubagentStop", () => {
  it("updates the row via tool_use_id correlation when the stash has it", async () => {
    const session = mockSession();
    session._activeSubagents.set("tool-use-abc", "subagent:s1");
    const state = mockState(session);

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-abc",
      agent_type: "Explore",
      result: "found 4 endpoints",
      outcome: "completed",
    });

    // Should have UPDATEd the stashed subagent id (no fallback DB lookup needed).
    expect(state.store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE subagent:s1"),
      expect.objectContaining({ outcome: "completed", result: "found 4 endpoints" }),
    );
    // Stash entry removed after use.
    expect(session._activeSubagents.has("tool-use-abc")).toBe(false);
  });

  it("falls back to DB lookup when no tool_use_id stash match", async () => {
    const session = mockSession();
    // tool_use_id is present in the payload but NOT in the stash — the
    // exact-match correlation_key fallback should fire. (Recency-based
    // fallback was retired: a re-fired SubagentStop on a session with
    // multiple live subagents would close the wrong row.)
    const state = mockState(session, [{ id: "subagent:s2" }]);

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-stranded",
      agent_type: "Plan",
      outcome: "completed",
    });

    // Fallback query ran — exact match on correlation_key.
    expect(state.store.queryFirst).toHaveBeenCalledWith(
      expect.stringContaining("FROM subagent"),
      expect.objectContaining({ cid: "tool-use-stranded" }),
    );
    // Then the UPDATE on the row it found.
    expect(state.store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE subagent:s2"),
      expect.any(Object),
    );
  });

  it("writes a bare orphan row when no stash and no DB match", async () => {
    const session = mockSession();
    const state = mockState(session, []); // fallback query returns []

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      agent_type: "general-purpose",
      result: "some result text",
      outcome: "error",
    });

    // Should have tried the fallback query and then written an orphan.
    expect(state.store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("CREATE subagent CONTENT"),
      expect.objectContaining({
        data: expect.objectContaining({
          parent_session_id: session.sessionId,
          agent_type: "general-purpose",
          outcome: "error",
          description: "orphan stop (no matching spawn)",
        }),
      }),
    );
  });

  it("uses ?? coalesce for spawned_at to avoid time::unix(NONE)", async () => {
    const session = mockSession();
    session._activeSubagents.set("tool-use-x", "subagent:s5");
    const state = mockState(session);

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-x",
      outcome: "completed",
    });

    const sql = (state.store.queryExec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("created_at ?? time::now()");
    expect(sql).not.toContain("IF created_at IS NOT NONE");
  });

  it("returns empty {} when store is unavailable", async () => {
    const session = mockSession();
    const state = mockState(session);
    state.store.isAvailable = () => false;

    const result = await handleSubagentStop(state, {
      session_id: session.sessionId,
    });

    expect(result).toEqual({});
    expect(state.store.queryExec).not.toHaveBeenCalled();
  });
});

describe("handleTaskCreated", () => {
  it("returns empty {} and does not throw on any payload shape", async () => {
    const state = mockState(null);
    const result = await handleTaskCreated(state, {
      session_id: "session-test-1",
      some_field: "anything",
    });
    expect(result).toEqual({});
  });
});
