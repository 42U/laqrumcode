/**
 * getSessionTurnsRich — null/undefined id row filter regression test (R6).
 *
 * R5 regression: SurrealDB rarely returns a `turn` row whose `id` field is
 * null/undefined (driver edge case during reconnection, or a projection
 * that dropped `id` upstream). `String(undefined)` yields the literal
 * `"undefined"` — a truthy string that passes the downstream `if (turnId)`
 * gate inside linkToRelevantConcepts and then explodes when the writer
 * RELATEs `turn:undefined → mentions → concept:xyz`. The fix:
 *  1. Map row.id through `safeId` (returns "" on nullish).
 *  2. Filter out rows whose mapped turnId is the empty string.
 *
 * This test pins both behaviours so a refactor cannot silently drop the
 * safeId guard or the trailing filter.
 */

import { describe, it, expect, vi } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

describe("getSessionTurnsRich — null/undefined id filtering", () => {
  function makeStore(rawRows: Array<Record<string, unknown>>) {
    const store = new SurrealStore({
      url: "ws://stub",
      ns: "test",
      db: "test",
      user: "u",
      pass: "p",
    } as any);
    // Stub queryFirst directly — the method under test calls it once.
    vi.spyOn(store as any, "queryFirst").mockImplementation(
      async (_sql: string, _bindings?: Record<string, unknown>) => rawRows,
    );
    return store;
  }

  it("filters out rows where id is null", async () => {
    const store = makeStore([
      { id: "turn:keep1", role: "user", text: "hello" },
      { id: null, role: "user", text: "ghost row 1" },
      { id: "turn:keep2", role: "assistant", text: "hi" },
    ]);
    const result = await store.getSessionTurnsRich("session:abc");
    expect(result).toHaveLength(2);
    expect(result.map(r => r.turnId)).toEqual(["turn:keep1", "turn:keep2"]);
  });

  it("filters out rows where id is undefined", async () => {
    const store = makeStore([
      { id: undefined, role: "user", text: "ghost row" },
      { id: "turn:k1", role: "assistant", text: "real" },
    ]);
    const result = await store.getSessionTurnsRich("session:abc");
    expect(result).toHaveLength(1);
    expect(result[0].turnId).toBe("turn:k1");
  });

  it("never surfaces the literal string 'undefined' as a turnId", async () => {
    // The original bug: String(undefined) === "undefined". If the safeId guard
    // ever regresses, this assertion catches it.
    const store = makeStore([
      { id: undefined, role: "user", text: "ghost" },
      { id: null, role: "user", text: "ghost2" },
    ]);
    const result = await store.getSessionTurnsRich("session:abc");
    const turnIds = result.map(r => r.turnId);
    expect(turnIds).not.toContain("undefined");
    expect(turnIds).not.toContain("null");
    expect(turnIds).not.toContain("");
  });

  it("preserves rows with valid ids and surfaces them in order", async () => {
    const store = makeStore([
      { id: "turn:a", role: "user", text: "first" },
      { id: "turn:b", role: "assistant", text: "second", tool_name: "Read" },
      { id: "turn:c", role: "user", text: "third" },
    ]);
    const result = await store.getSessionTurnsRich("session:abc");
    expect(result.map(r => r.turnId)).toEqual(["turn:a", "turn:b", "turn:c"]);
    // Confirms the optional tool_name field is passed through when present.
    expect(result[1].tool_name).toBe("Read");
  });

  it("returns empty when store returns no rows", async () => {
    const store = makeStore([]);
    const result = await store.getSessionTurnsRich("session:nonexistent");
    expect(result).toEqual([]);
  });

  it("drops all-nullish rows entirely", async () => {
    const store = makeStore([
      { id: null, role: "user", text: "ghost1" },
      { id: undefined, role: "assistant", text: "ghost2" },
    ]);
    const result = await store.getSessionTurnsRich("session:abc");
    expect(result).toEqual([]);
  });
});
