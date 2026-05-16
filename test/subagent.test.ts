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

  it("writes a bare orphan row when payload has tool_use_id but no stash and no DB match", async () => {
    const session = mockSession();
    const state = mockState(session, []); // fallback query returns []

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-ghost",
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

  // v0.7.78 Bug B auditor: when SubagentStop fires with no correlation key
  // at all (neither tool_use_id nor agent_id) the prior orphan-write path
  // created a "correlation_key: orphan" row that collided with itself on
  // every subsequent uncorrelated Stop. The fix returns cleanly with a
  // debug log instead. This test pins that contract.
  it("skips cleanly when no correlation key is present (no tool_use_id, no agent_id)", async () => {
    const session = mockSession();
    const state = mockState(session, []);

    const result = await handleSubagentStop(state, {
      session_id: session.sessionId,
      agent_type: "general-purpose",
      result: "some result text",
      outcome: "error",
    });

    expect(result).toEqual({});
    // No SELECT fallback — the early-return fires BEFORE the SELECT.
    expect(state.store.queryFirst).not.toHaveBeenCalled();
    // And critically: no orphan-row CREATE.
    expect(state.store.queryExec).not.toHaveBeenCalled();
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

  // Wave 2: auto-drain internal subprocess agents (kongcode:memory-extractor
  // and kongcode:memory-extractor-lite) live outside the PreToolUse →
  // SubagentStop lifecycle. The daemon spawn()s them directly, so no
  // spawn row ever exists. SubagentStop for these agent_types must be
  // SILENTLY skipped — never an orphan-row write, never a warn-channel log.
  it("silently skips stop events for kongcode:memory-extractor (auto-drain internal)", async () => {
    const session = mockSession();
    const state = mockState(session, []);

    const result = await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-internal-drain",
      agent_type: "kongcode:memory-extractor",
      result: "extracted 7 gems",
      outcome: "completed",
    });

    expect(result).toEqual({});
    // No fallback SELECT and no orphan CREATE — internal drains aren't
    // tracked in the subagent table at all.
    expect(state.store.queryFirst).not.toHaveBeenCalled();
    expect(state.store.queryExec).not.toHaveBeenCalled();
  });

  it("silently skips stop events for kongcode:memory-extractor-lite (auto-drain internal)", async () => {
    const session = mockSession();
    const state = mockState(session, []);

    const result = await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-internal-drain-lite",
      agent_type: "kongcode:memory-extractor-lite",
      outcome: "completed",
    });

    expect(result).toEqual({});
    expect(state.store.queryFirst).not.toHaveBeenCalled();
    expect(state.store.queryExec).not.toHaveBeenCalled();
  });

  // Wave 3 fix: SubagentStop arrives from Claude Code with `agent_id` (a hex
  // string) instead of the original PreToolUse(Task).tool_use_id. Falling
  // back to agent_id as a SELECT key always misses (correlation_key in the
  // subagent table was written as `toolu_*` by PreToolUse). Resolve via the
  // session's in-flight stash instead — when exactly one spawn row is
  // outstanding, that's the row we're closing.
  it("resolves agent_id-only stop via single-in-flight stash (Wave 3)", async () => {
    const session = mockSession();
    // Simulate PreToolUse having stashed one in-flight subagent under its
    // tool_use_id key. Claude Code's SubagentStop ships agent_id (hex), not
    // tool_use_id.
    session._activeSubagents.set("toolu_01ABC", "subagent:wave3target");
    const state = mockState(session);

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      agent_id: "a87d8ea828b72b05d", // 17-char hex, the agent_id-only shape
      agent_type: "general-purpose",
      result: "done",
      outcome: "completed",
    });

    // Must UPDATE the in-flight row — NOT write an orphan.
    expect(state.store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE subagent:wave3target"),
      expect.objectContaining({ outcome: "completed", result: "done" }),
    );
    // Critically: no CREATE subagent (no orphan write).
    const createCall = (state.store.queryExec as ReturnType<typeof vi.fn>).mock.calls
      .find(c => typeof c[0] === "string" && c[0].includes("CREATE subagent"));
    expect(createCall).toBeUndefined();
    // The matched stash entry was deleted so subsequent stops don't re-close
    // the same row.
    expect(session._activeSubagents.size).toBe(0);
  });

  it("honors subagent_type field when present (Claude Code's documented key)", async () => {
    // Claude Code's SubagentStop hook may send `subagent_type` rather than
    // `agent_type`. The guard must match on either. This pins both paths.
    const session = mockSession();
    const state = mockState(session, []);

    const result = await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "tool-use-st",
      subagent_type: "kongcode:memory-extractor",
      outcome: "completed",
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
