import { describe, it, expect, beforeEach } from "vitest";
import {
  stageRetrieval,
  evaluateRetrieval,
  getHistoricalUtilityBatch,
} from "../src/engine/retrieval-quality.js";
import type { RetrievedItem } from "../src/engine/retrieval-quality.js";

/**
 * Regression for K23 (+ K22 stringification, + K2 single-insert path).
 *
 * BEFORE: evaluateRetrieval did one `SELECT ... LIMIT 1` existence probe AND
 * one `CREATE retrieval_outcome CONTENT` per staged item — 2N serial DB
 * round-trips on the Stop hot path. The fix replaces that with ONE batched
 * read (`WHERE session_id=$sid AND turn_id=$tid AND memory_id IN $ids`) plus
 * ONE bulk `INSERT INTO retrieval_outcome $rows ON DUPLICATE KEY UPDATE ...`.
 *
 * These tests would FAIL against the pre-fix code:
 *  - the per-item-CREATE assertion (old code emitted N CREATEs)
 *  - the single-INSERT assertion (old code emitted zero INSERTs)
 *  - the batched-IN read assertion (old code used `memory_id = $mid`)
 */

interface RecordedCall {
  sql: string;
  bindings?: Record<string, unknown>;
}

function makeMockStore() {
  const execCalls: RecordedCall[] = [];
  const firstCalls: RecordedCall[] = [];
  const store = {
    isAvailable: () => true,
    // queryFirst is used for: the batched existence read, and the turn_score
    // existence read. Return [] (nothing exists yet) so everything inserts.
    queryFirst: async <T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> => {
      firstCalls.push({ sql, bindings });
      return [] as T[];
    },
    queryExec: async (sql: string, bindings?: Record<string, unknown>): Promise<void> => {
      execCalls.push({ sql, bindings });
    },
    updateUtilityCache: async (): Promise<void> => {},
  };
  return { store, execCalls, firstCalls };
}

function makeItem(overrides: Partial<RetrievedItem> = {}): RetrievedItem {
  return {
    id: "memory:test1",
    table: "memory",
    text: "SurrealDB uses WebSocket connections for real-time queries",
    score: 0.85,
    importance: 7,
    accessCount: 3,
    finalScore: 0.9,
    fromNeighbor: false,
    ...overrides,
  };
}

describe("K23: batched retrieval_outcome write (1 read + 1 bulk insert)", () => {
  const SID = "k23-session";
  beforeEach(async () => {
    // Drain any prior staging for this session.
    stageRetrieval(SID, []);
    await evaluateRetrieval(SID, "", "", {
      isAvailable: () => false,
      queryExec: async () => {},
      queryFirst: async () => [],
      updateUtilityCache: async () => {},
    } as any);
  });

  it("issues exactly ONE bulk INSERT and ZERO per-item CREATEs for N items", async () => {
    const items = [
      makeItem({ id: "memory:a" }),
      makeItem({ id: "memory:b", text: "graph context assembly pipeline" }),
      makeItem({ id: "concept:c", table: "concept", text: "the cross-encoder reranker bge-reranker-v2-m3" }),
      makeItem({ id: "memory:d", text: "daemon owns a local SurrealDB per host" }),
    ];
    stageRetrieval(SID, items);

    const { store, execCalls } = makeMockStore();
    // Response long enough to pass the <100 char short-circuit, with no [#N].
    const response = "x".repeat(150);
    await evaluateRetrieval(SID, "turn:k23", response, store as any);

    const insertCalls = execCalls.filter((c) => /INSERT INTO retrieval_outcome/i.test(c.sql));
    const perItemCreateCalls = execCalls.filter((c) => /CREATE retrieval_outcome/i.test(c.sql));

    // The whole point of K23: one statement, not N.
    expect(insertCalls).toHaveLength(1);
    expect(perItemCreateCalls).toHaveLength(0);

    // The bulk INSERT carries all N rows in a single `$rows` array bind.
    const rows = insertCalls[0].bindings?.rows as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(items.length);
    // memory_id must be a plain string (K22: TYPE string column).
    for (const r of rows) expect(typeof r.memory_id).toBe("string");

    // Race-safety idiom present so a residual concurrent collision is a no-op
    // rather than aborting the whole batch.
    expect(insertCalls[0].sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
  });

  it("does the existence check as ONE batched IN read, not per-item equality", async () => {
    stageRetrieval(SID, [makeItem({ id: "memory:a" }), makeItem({ id: "memory:b" })]);
    const { store, firstCalls } = makeMockStore();
    await evaluateRetrieval(SID, "turn:k23b", "y".repeat(150), store as any);

    const outcomeReads = firstCalls.filter((c) => /FROM retrieval_outcome/i.test(c.sql));
    // Exactly one read against retrieval_outcome (the batched membership check).
    expect(outcomeReads).toHaveLength(1);
    expect(outcomeReads[0].sql).toMatch(/memory_id IN \$ids/i);
    // The old per-item form used `memory_id = $mid` — must be gone.
    expect(outcomeReads[0].sql).not.toMatch(/memory_id = \$mid/i);
    const ids = outcomeReads[0].bindings?.ids as unknown[];
    expect(ids).toHaveLength(2);
  });
});

describe("K22: getHistoricalUtilityBatch store + id stringification", () => {
  it("returns an empty map (no throw) when called WITHOUT a store", async () => {
    // The graph-context call site used to omit the store arg entirely, which
    // made this fall straight into the `!store` guard and silently return
    // nothing. Documented as the intended guard behavior.
    const r = await getHistoricalUtilityBatch(["memory:x", "memory:y"]);
    expect(r.size).toBe(0);
  });

  it("stringifies RecordId-like ids before binding into WHERE memory_id IN $ids", async () => {
    let captured: Record<string, unknown> | undefined;
    const store = {
      queryFirst: async (_sql: string, bindings?: Record<string, unknown>) => {
        captured = bindings;
        return [];
      },
    };
    // A RecordId Thing never == a same-text JS string in SurrealDB v3; the fix
    // coerces with String() before the bind. Simulate a Thing via an object
    // whose toString() yields the record id.
    const thing = { tb: "memory", id: "z9", toString: () => "memory:z9" };
    await getHistoricalUtilityBatch([thing as any, "memory:plain"], store as any);

    const ids = captured?.ids as unknown[];
    expect(ids).toEqual(["memory:z9", "memory:plain"]);
    for (const id of ids) expect(typeof id).toBe("string");
  });
});
