/**
 * K35 regression — the read-only UI's memory/concept search ran an unindexed
 * `string::contains` full-table scan on the daemon's shared hot-path DB, and
 * allowed deep pagination (offset up to 1e7). The fix:
 *   - gates substring search behind a min length (1-char query → no filter),
 *   - caps the START offset (MAX_UI_OFFSET) at the API layer.
 *
 * These tests mock the store's queryBatch to capture the bindings passed to
 * the SQL. A 1-char query must produce the no-filter binding ($q = '') so the
 * scan branch is skipped — this FAILS against the pre-fix code, which lowercased
 * the raw 1-char string straight into $q and triggered the scan.
 */
import { describe, it, expect, vi } from "vitest";
import { listMemories, listConcepts } from "../src/ui-server.js";

function captureStore() {
  const calls: { binds?: Record<string, unknown> }[] = [];
  return {
    calls,
    store: {
      queryBatch: vi.fn(async (_sql: string[], binds?: Record<string, unknown>) => {
        calls.push({ binds });
        // [countRes, rowRes]
        return [[{ c: 0 }], []];
      }),
    } as any,
  };
}

describe("K35: UI search scan guard", () => {
  it("blanks a 1-char query so the substring scan branch is skipped", async () => {
    const { store, calls } = captureStore();
    await listMemories({ store } as any, "a", 50, 0);
    expect(calls[0].binds!.q).toBe(""); // below MIN_SEARCH_LEN → no-filter
  });

  it("passes a >=2-char query through (lowercased) for an intentional search", async () => {
    const { store, calls } = captureStore();
    await listMemories({ store } as any, "Foo", 50, 0);
    expect(calls[0].binds!.q).toBe("foo");
  });

  it("applies the same gate to concept search", async () => {
    const { store, calls } = captureStore();
    await listConcepts({ store } as any, "x", 50, 0);
    expect(calls[0].binds!.q).toBe("");
  });

  it("trims whitespace-only queries to the no-filter branch", async () => {
    const { store, calls } = captureStore();
    await listConcepts({ store } as any, "   ", 50, 0);
    expect(calls[0].binds!.q).toBe("");
  });
});
