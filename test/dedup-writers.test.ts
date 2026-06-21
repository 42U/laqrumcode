/**
 * Dedup behavior at the writer layer.
 *
 * Coverage of five SELECT-before-CREATE / pre-check paths shipped to avoid
 * UNIQUE-index violations and duplicate rows:
 *
 *   1. subagent CREATE dedup — three call sites (pre-tool-use, subagent
 *      orphan-stop fallback). subagent-lifecycle.createSubagentSpawnedHandler
 *      retired v0.7.74 along with the OpenClaw-gateway file.
 *   2. artifact dedup — SurrealStore.createArtifact path key.
 *   3. causal_chain dedup — engine/causal.ts linkCausalEdges (trigger,
 *      outcome, chain_type) tuple key.
 *   4. retrieval_outcome + turn_score dedup — engine/retrieval-quality.ts.
 *   5. pendingToolArgs keyed by tool_use_id — PreToolUse / PostToolUse pair.
 *
 * Pattern is mirrored from test/subagent.test.ts and
 * test/retrieval-quality.test.ts: vi.fn() spies on a mock store that exposes
 * queryFirst / queryExec. The tests verify the SELECT runs first and that
 * CREATE is conditionally skipped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handlePreToolUse } from "../src/hook-handlers/pre-tool-use.js";
import { handlePostToolUse } from "../src/hook-handlers/post-tool-use.js";
import { handleSubagentStop } from "../src/hook-handlers/subagent.js";
import { linkCausalEdges, type CausalChain } from "../src/engine/causal.js";
import {
  stageRetrieval,
  evaluateRetrieval,
  getStagedItems,
  type RetrievedItem,
} from "../src/engine/retrieval-quality.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

function mockSession(sessionId = "session-test"): SessionState {
  return {
    sessionId,
    sessionKey: sessionId,
    surrealSessionId: "session:abc",
    taskId: "task:t1",
    toolCallCount: 0,
    toolCallsSinceLastText: 0,
    toolLimit: 100,
    softInterrupted: false,
    _activeSubagents: new Map<string, string>(),
    pendingToolArgs: new Map<string, unknown>(),
    _observedFilePaths: new Set<string>(),
    _editGateChecked: new Set<string>(),
    _editGateLastActivity: 0,
    _pushDetected: false,
    cumulativeTokens: 0,
    _turnToolCalls: 0,
    lastRetrievalSummary: "",
  } as unknown as SessionState;
}

function mockStateForHooks(session: SessionState | null) {
  const queryFirst = vi.fn<(sql: string, params?: any) => Promise<any>>(
    async () => [],
  );
  const queryExec = vi.fn(async () => {});
  const relate = vi.fn(async () => true);
  const upsertConcept = vi.fn(async () => ({ id: "concept:c1", existed: false }));
  const createMemory = vi.fn(async () => "memory:m1");
  const createArtifact = vi.fn(async () => ({ id: "artifact:a1", existed: false }));
  const store = {
    isAvailable: () => true,
    queryFirst,
    queryExec,
    relate,
    upsertConcept,
    createMemory,
    createArtifact,
  };
  const embeddings = {
    isAvailable: () => true,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  };
  const state = {
    store,
    embeddings,
    config: { thresholds: { midSessionCleanupThreshold: 25_000 } },
    workspaceDir: "/tmp",
    getSession: vi.fn((id: string) =>
      session?.sessionId === id ? session : null,
    ),
    getOrCreateSession: vi.fn((id: string) =>
      session?.sessionId === id ? session : null,
    ),
  } as unknown as GlobalPluginState;
  return { state, store, queryFirst, queryExec, relate };
}

// Wait for the fire-and-forget IIFE inside PreToolUse subagent spawn to settle.
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
}

// ────────────────────────────────────────────────────────────────────────────
// 1. SUBAGENT CREATE DEDUP — three call sites
// ────────────────────────────────────────────────────────────────────────────

describe("subagent CREATE dedup — pre-tool-use.ts PreToolUse(Agent|Task) [v0.7.77 migration]", () => {
  // v0.7.77 moved subagent CREATE+edges into commitKnowledge({ kind: "subagent" }).
  // The old SELECT-then-CREATE dedup pattern is gone — commitSubagent goes
  // straight to CREATE and recovers from UNIQUE violations via post-error
  // SELECT. Detailed unit coverage of that path lives in
  // test/commit.test.ts (commitKnowledge — subagent kind). The 3 tests
  // previously at this location asserted the SELECT-first ordering, which
  // no longer holds; removed in v0.7.77.
  it("happy path: CREATE goes through commitKnowledge and stashes the new id", async () => {
    const session = mockSession();
    const { state, queryFirst } = mockStateForHooks(session);
    queryFirst.mockResolvedValueOnce([{ id: "subagent:new-1" }]);  // CREATE returns

    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Task",
      tool_use_id: "tool-use-fresh",
      tool_input: { subagent_type: "general-purpose", prompt: "fresh spawn" },
    });
    await flushMicrotasks();

    // No pre-SELECT — commitSubagent goes straight to CREATE.
    const sqls = queryFirst.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes("CREATE subagent"))).toBe(true);
    expect(session._activeSubagents.get("tool-use-fresh")).toBe("subagent:new-1");
  });
});

describe("subagent CREATE dedup — subagent.ts orphan-stop fallback", () => {
  it("SKIPS the orphan CREATE when SELECT finds a row with the same correlation_key", async () => {
    const session = mockSession();
    const { state, queryFirst, queryExec } = mockStateForHooks(session);
    // First call: handleSubagentStop's exact-match correlation_key fallback
    // (line ~64) — returns empty so we fall to the orphan branch.
    // Second call: orphan-branch dedup SELECT (line ~92) — return a hit.
    queryFirst
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "subagent:orphan-existing" }]);

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "stranded-corr",
      agent_type: "Plan",
      outcome: "completed",
    });

    // Two SELECTs ran. No CREATE queryExec fired.
    expect(queryFirst).toHaveBeenCalledTimes(2);
    expect(queryExec).not.toHaveBeenCalled();
  });

  it("PROCEEDS with the orphan CREATE when no row matches the correlation_key", async () => {
    const session = mockSession();
    const { state, queryFirst, queryExec } = mockStateForHooks(session);
    queryFirst.mockResolvedValue([]); // both SELECTs miss

    await handleSubagentStop(state, {
      session_id: session.sessionId,
      tool_use_id: "stranded-no-match",
      agent_type: "Plan",
      outcome: "error",
    });

    // Orphan CREATE fires only after both SELECTs return empty.
    expect(queryFirst).toHaveBeenCalledTimes(2);
    expect(queryExec).toHaveBeenCalledTimes(1);
    expect(queryExec.mock.calls[0][0]).toContain("CREATE subagent CONTENT");
    expect(queryExec.mock.calls[0][1]).toMatchObject({
      data: expect.objectContaining({
        correlation_key: "stranded-no-match",
        description: "orphan stop (no matching spawn)",
      }),
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. ARTIFACT DEDUP — SurrealStore.createArtifact at src/engine/surreal.ts ~977
// ────────────────────────────────────────────────────────────────────────────

describe("SurrealStore.createArtifact — path-keyed dedup", () => {
  // We test the dedup logic by exercising the createArtifact method on an
  // instance of SurrealStore, mocking queryFirst on the prototype. That way
  // we cover the actual production code path (not a re-implementation).
  async function loadStore() {
    const mod = await import("../src/engine/surreal.js");
    return mod.SurrealStore;
  }

  function makeStoreWithMocks(SurrealStoreClass: any) {
    const store = Object.create(SurrealStoreClass.prototype);
    const queryFirst = vi.fn();
    const queryExec = vi.fn(async () => {});
    store.queryFirst = queryFirst;
    store.queryExec = queryExec;
    store.isAvailable = () => true;
    return { store, queryFirst, queryExec };
  }

  it("CREATE-first: on first call CREATE returns the new id directly", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    // Round 2 (post-F2): the SELECT-then-CREATE pattern was replaced with
    // try-CREATE-catch-UNIQUE. So the first call to createArtifact issues
    // a single CREATE (no preflight SELECT).
    queryFirst.mockResolvedValueOnce([{ id: "artifact:first" }]); // CREATE returns new id
    const id1 = await store.createArtifact("/tmp/foo.ts", "file", "first write", null);
    // W2-09: createArtifact now reports { id, existed } — fresh CREATE → false.
    expect(id1).toEqual({ id: "artifact:first", existed: false });

    // Exactly one query: the CREATE. No preflight SELECT.
    expect(queryFirst).toHaveBeenCalledTimes(1);
    expect(queryFirst.mock.calls[0][0]).toContain("CREATE artifact");
  });

  it("on UNIQUE violation: falls back to SELECT and returns existing id", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    // Simulate a UNIQUE-index rejection from the CREATE, then the fallback
    // SELECT returns the sibling row's id.
    const uniqueErr = Object.assign(new Error("Database index `artifact_path_unique` already contains the value"), { kind: "AlreadyExists" });
    queryFirst
      .mockRejectedValueOnce(uniqueErr)                       // CREATE rejected by UNIQUE
      .mockResolvedValueOnce([{ id: "artifact:sibling" }]);   // fallback SELECT
    const id = await store.createArtifact("/tmp/foo.ts", "file", "second write", null);
    // W2-09: UNIQUE-fallback path resolves to the pre-existing row → existed: true.
    expect(id).toEqual({ id: "artifact:sibling", existed: true });

    expect(queryFirst).toHaveBeenCalledTimes(2);
    expect(queryFirst.mock.calls[0][0]).toContain("CREATE artifact");
    expect(queryFirst.mock.calls[1][0]).toContain("SELECT id FROM artifact");
    expect(queryFirst.mock.calls[1][1]).toMatchObject({ path: "/tmp/foo.ts" });
  });

  it("issues two distinct CREATEs for two distinct paths", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    queryFirst
      .mockResolvedValueOnce([{ id: "artifact:a" }])      // CREATE A
      .mockResolvedValueOnce([{ id: "artifact:b" }]);     // CREATE B

    const idA = await store.createArtifact("/tmp/a.ts", "file", "a", null);
    const idB = await store.createArtifact("/tmp/b.ts", "file", "b", null);

    expect(idA).toEqual({ id: "artifact:a", existed: false });
    expect(idB).toEqual({ id: "artifact:b", existed: false });
    expect(idA.id).not.toBe(idB.id);

    // 2 queryFirst calls: CREATE A + CREATE B (no preflight SELECTs).
    expect(queryFirst).toHaveBeenCalledTimes(2);
    expect(queryFirst.mock.calls[0][0]).toContain("CREATE artifact");
    expect(queryFirst.mock.calls[1][0]).toContain("CREATE artifact");
    // Distinct path bindings — passed via $record.path.
    expect((queryFirst.mock.calls[0][1] as any).record.path).toBe("/tmp/a.ts");
    expect((queryFirst.mock.calls[1][1] as any).record.path).toBe("/tmp/b.ts");
  });

  it("non-UNIQUE CREATE failure surfaces (does not silently swallow)", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    // A non-UNIQUE error must propagate, otherwise we'd silently lose
    // artifact rows (Round 2: previously the SELECT had .catch(() => [])
    // which masked SELECT failures and let duplicate CREATEs land).
    const realErr = new Error("syntax error somewhere");
    queryFirst.mockRejectedValueOnce(realErr);

    await expect(store.createArtifact("/tmp/foo.ts", "file", "x", null))
      .rejects.toThrow(/syntax error/);
    expect(queryFirst).toHaveBeenCalledTimes(1); // CREATE only; no fallback SELECT.
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2.5. UPSERTCONCEPT RACE FALLBACK — R7 F1/F2
// ────────────────────────────────────────────────────────────────────────────

describe("SurrealStore.upsertConcept — race-fallback after UNIQUE rejection", () => {
  async function loadStore() {
    const mod = await import("../src/engine/surreal.js");
    return mod.SurrealStore;
  }

  function makeStoreWithMocks(SurrealStoreClass: any) {
    const store = Object.create(SurrealStoreClass.prototype);
    const queryFirst = vi.fn();
    const queryExec = vi.fn(async () => {});
    store.queryFirst = queryFirst;
    store.queryExec = queryExec;
    store.isAvailable = () => true;
    return { store, queryFirst, queryExec };
  }

  it("R7 F1: KNN race fallback returns winner id when content text differs (synonym/paraphrase)", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    // Sequence:
    //   call 1: initial KNN dedup SELECT → empty (race winner hasn't landed yet).
    //   call 2: CREATE concept → UNIQUE violation (race winner just landed).
    //   call 3: race-fallback lowercase rematch → empty (winner has different text).
    //   call 4: race-fallback KNN rematch → winner with score=0.95 (>0.92).
    // Expected: upsertConcept returns the KNN winner's id, not "".
    const uniqueErr = Object.assign(
      new Error("Database index `concept_content_unique` already contains the value"),
      { kind: "AlreadyExists" },
    );
    queryFirst
      .mockResolvedValueOnce([])                                          // 1: initial KNN dedup miss
      .mockRejectedValueOnce(uniqueErr)                                   // 2: CREATE → UNIQUE
      .mockResolvedValueOnce([])                                          // 3: lowercase rematch miss
      .mockResolvedValueOnce([{ id: "concept:winner-x", score: 0.95 }]);  // 4: KNN rematch hit

    const id = await store.upsertConcept(
      "writing pure functions",
      new Array(1024).fill(0.1),
      undefined,
      undefined,
      undefined,
    );

    // W2-07: race-recovery resolves to the winner's pre-existing row → existed: true.
    expect(id).toEqual({ id: "concept:winner-x", existed: true });
    expect(queryFirst).toHaveBeenCalledTimes(4);
    // Sanity: the 4th call was the KNN fallback, not the lowercase select.
    expect(queryFirst.mock.calls[3][0]).toMatch(/vector::similarity::cosine/);
    expect(queryFirst.mock.calls[3][0]).toMatch(/superseded_at IS NONE/);
  });

  it("R7 F1: KNN race fallback rethrows when KNN score <= 0.92", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    const uniqueErr = Object.assign(
      new Error("Database index `concept_content_unique` already contains the value"),
      { kind: "AlreadyExists" },
    );
    queryFirst
      .mockResolvedValueOnce([])                                       // initial KNN dedup
      .mockRejectedValueOnce(uniqueErr)                                // CREATE → UNIQUE
      .mockResolvedValueOnce([])                                       // lowercase rematch miss
      .mockResolvedValueOnce([{ id: "concept:weak", score: 0.5 }]);    // KNN rematch but weak

    await expect(
      store.upsertConcept("writing pure functions", new Array(1024).fill(0.1)),
    ).rejects.toThrow(/already contains/);
  });

  it("R7 F2: both content dedup SELECTs filter superseded_at IS NONE", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    // No embedding → forces the embedding-less branch (lowercase SELECT at ~1135).
    queryFirst.mockResolvedValueOnce([{ id: "concept:already" }]);
    await store.upsertConcept("plain text", null);

    // The lowercase dedup query must include the superseded_at filter.
    expect(queryFirst.mock.calls[0][0]).toMatch(/superseded_at IS NONE/);
  });

  it("R7 F2: race-fallback lowercase rematch also filters superseded_at IS NONE", async () => {
    const Store = await loadStore();
    const { store, queryFirst } = makeStoreWithMocks(Store);

    const uniqueErr = Object.assign(
      new Error("Database index `concept_content_unique` already contains the value"),
      { kind: "AlreadyExists" },
    );
    queryFirst
      .mockResolvedValueOnce([])                                          // initial KNN dedup
      .mockRejectedValueOnce(uniqueErr)                                   // CREATE → UNIQUE
      .mockResolvedValueOnce([{ id: "concept:resolved" }]);               // lowercase rematch hit

    const id = await store.upsertConcept(
      "writing pure functions",
      new Array(1024).fill(0.1),
    );
    expect(id).toEqual({ id: "concept:resolved", existed: true });
    // The lowercase race-fallback query must include the superseded_at filter.
    expect(queryFirst.mock.calls[2][0]).toMatch(/string::lowercase/);
    expect(queryFirst.mock.calls[2][0]).toMatch(/superseded_at IS NONE/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. CAUSAL_CHAIN DEDUP — engine/causal.ts ~100-134
// ────────────────────────────────────────────────────────────────────────────

describe("linkCausalEdges — causal_chain dedup on (trigger, outcome, type)", () => {
  function makeCausalState(
    queryFirstImpl: (sql: string, params?: any) => Promise<any>,
  ) {
    const queryFirst = vi.fn(queryFirstImpl);
    const queryExec = vi.fn(async () => {});
    const relate = vi.fn(async () => {});
    const upsertConcept = vi.fn(async () => "concept:c1");
    const store = {
      isAvailable: () => true,
      queryFirst,
      queryExec,
      relate,
      upsertConcept,
      createMemory: vi.fn(async () => "memory:m1"),
    } as any;
    const embeddings = {
      isAvailable: () => true,
      embed: vi.fn(async () => new Array(1024).fill(0.1)),
    } as any;
    return { store, embeddings, queryFirst, queryExec };
  }

  function chain(overrides: Partial<CausalChain> = {}): CausalChain {
    return {
      triggerText: "agent hit timeout",
      outcomeText: "applied retry-with-backoff fix",
      chainType: "fix",
      success: true,
      confidence: 0.8,
      description: "Timeout on tool fetch resolved by exponential backoff",
      ...overrides,
    };
  }

  it("runs the pre-check SELECT for each chain before CREATE", async () => {
    // commitKnowledge under the hood may invoke queryFirst for concept
    // linking; we route every SELECT-style call through to []. The dedup
    // SELECT pattern includes "FROM causal_chain WHERE trigger_memory" —
    // we specifically check that this matcher fires.
    const { store, embeddings, queryFirst, queryExec } = makeCausalState(
      async (sql) => {
        if (/FROM causal_chain/.test(sql)) return [];
        return [];
      },
    );

    await linkCausalEdges([chain()], "session-x", store, embeddings);

    const causalSelects = queryFirst.mock.calls.filter(c =>
      /FROM causal_chain/.test(String(c[0])),
    );
    expect(causalSelects.length).toBe(1);
    // The CREATE that follows the SELECT is via queryExec.
    const causalCreates = queryExec.mock.calls.filter(c =>
      /CREATE causal_chain/.test(String(c[0])),
    );
    expect(causalCreates.length).toBe(1);
  });

  it("SKIPS the CREATE when the (trigger, outcome, type) tuple already exists", async () => {
    const { store, embeddings, queryExec } = makeCausalState(async (sql) => {
      if (/FROM causal_chain/.test(sql)) return [{ id: "causal_chain:existing" }];
      return [];
    });

    await linkCausalEdges([chain()], "session-x", store, embeddings);

    const causalCreates = queryExec.mock.calls.filter(c =>
      /CREATE causal_chain/.test(String(c[0])),
    );
    expect(causalCreates.length).toBe(0);
  });

  it("uses swallow.warn (WARN level) for causal:silent — not a silent swallow", async () => {
    // Replace log.warn on the shared engine log so we capture the swallow.warn
    // path. swallow.warn always logs to stderr via log.warn. We spy on that.
    const logMod = await import("../src/engine/log.js");
    const warnSpy = vi.spyOn(logMod.log, "warn").mockImplementation(() => {});

    // Force the outer try/catch (line ~129 in causal.ts) by making
    // store.createMemory throw — commitMemory does not catch this exception,
    // so it propagates up out of commitKnowledge into linkCausalEdges' outer
    // catch which fires swallow.warn("causal:silent", e).
    const { store, embeddings } = makeCausalState(async () => []);
    store.createMemory = vi.fn(async () => { throw new Error("createMemory boom"); });

    await linkCausalEdges([chain()], "session-y", store, embeddings);

    // If swallow.warn fired for the causal:silent context, log.warn was
    // called with a message containing that tag. errors.ts formats
    // `${context}: ${msg}` and passes it as the first arg to log.warn.
    const causalSilentWarns = warnSpy.mock.calls.filter(args =>
      args.some(a => String(a ?? "").includes("causal:silent")),
    );
    expect(causalSilentWarns.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. RETRIEVAL_OUTCOME + TURN_SCORE DEDUP — engine/retrieval-quality.ts
// ────────────────────────────────────────────────────────────────────────────

function makeRetrievalItem(overrides: Partial<RetrievedItem> = {}): RetrievedItem {
  return {
    id: "memory:test1",
    table: "memory",
    text: "SurrealDB WebSocket connection handling",
    score: 0.85,
    importance: 7,
    accessCount: 3,
    finalScore: 0.9,
    fromNeighbor: false,
    ...overrides,
  };
}

describe("evaluateRetrieval — retrieval_outcome + turn_score dedup", () => {
  beforeEach(() => {
    // Drain any stale staged state.
    stageRetrieval("reset", [], undefined);
    void evaluateRetrieval("reset", "", "", {
      queryExec: async () => {},
      updateUtilityCache: async () => {},
      isAvailable: () => false,
    } as any);
  });

  it("runs ONE batched SELECT for retrieval_outcome and skips the bulk INSERT when all rows exist", async () => {
    // K23 (2026): the per-item SELECT+CREATE loop was replaced by ONE batched
    // existence read (`memory_id IN $ids`) + ONE bulk INSERT. When the batched
    // read reports every staged id already present, the INSERT is skipped.
    const queryFirst = vi.fn(async (sql: string) => {
      if (/FROM retrieval_outcome/.test(sql)) {
        // Report both staged ids as already-existing.
        return [{ memory_id: "memory:dup1" }, { memory_id: "memory:dup2" }];
      }
      return [{ id: "turn_score:existing" }]; // turn_score SELECT also hits
    });
    const queryExec = vi.fn(async () => {});
    const store = {
      queryFirst,
      queryExec,
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session-d", [
      makeRetrievalItem({ id: "memory:dup1" }),
      makeRetrievalItem({ id: "memory:dup2", text: "SurrealDB query" }),
    ]);
    await evaluateRetrieval(
      "session-d",
      "turn:dup",
      "SurrealDB WebSocket connection handling response",
      store as any,
    );

    // Allow the fire-and-forget IIFE for turn_score to settle.
    await flushMicrotasks();

    // K23: exactly ONE batched retrieval_outcome SELECT (not one-per-item),
    // plus the single turn_score SELECT.
    const roSelects = queryFirst.mock.calls.filter(c =>
      /FROM retrieval_outcome/.test(String(c[0])),
    );
    const tsSelects = queryFirst.mock.calls.filter(c =>
      /FROM turn_score/.test(String(c[0])),
    );
    expect(roSelects.length).toBe(1);
    expect(roSelects[0][0]).toMatch(/memory_id IN \$ids/);
    expect(tsSelects.length).toBe(1);

    // No writes: bulk INSERT skipped (all rows existed); turn_score CREATE
    // skipped (SELECT hit).
    const roInserts = queryExec.mock.calls.filter(c =>
      /INSERT INTO retrieval_outcome/.test(String(c[0])),
    );
    const tsCreates = queryExec.mock.calls.filter(c =>
      /CREATE turn_score/.test(String(c[0])),
    );
    expect(roInserts.length).toBe(0);
    expect(tsCreates.length).toBe(0);
  });

  it("issues ONE bulk INSERT for all new rows when the batched SELECT returns empty", async () => {
    const queryFirst = vi.fn(async () => []);
    const queryExec = vi.fn(async () => {});
    const store = {
      queryFirst,
      queryExec,
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session-e", [
      makeRetrievalItem({ id: "memory:fresh1" }),
      makeRetrievalItem({ id: "memory:fresh2", text: "SurrealDB query planner" }),
    ]);
    await evaluateRetrieval(
      "session-e",
      "turn:fresh",
      "SurrealDB WebSocket connection",
      store as any,
    );
    await flushMicrotasks();

    // K23: ONE bulk INSERT carrying ALL new rows (not N CREATEs).
    const roInserts = queryExec.mock.calls.filter(c =>
      /INSERT INTO retrieval_outcome/.test(String(c[0])),
    );
    const roCreates = queryExec.mock.calls.filter(c =>
      /CREATE retrieval_outcome/.test(String(c[0])),
    );
    const tsCreates = queryExec.mock.calls.filter(c =>
      /CREATE turn_score/.test(String(c[0])),
    );
    expect(roInserts.length).toBe(1);
    expect(roCreates.length).toBe(0); // per-item CREATE path is gone
    // The single INSERT carries both staged rows in its $rows array bind.
    const rows = (roInserts[0][1] as any)?.rows as unknown[];
    expect(rows).toHaveLength(2);
    expect(tsCreates.length).toBe(1);
  });

  it("turn_score write is fire-and-forget (no awaited side effect from evaluateRetrieval)", async () => {
    // Verify the IIFE shape: evaluateRetrieval returns BEFORE the turn_score
    // write completes if the SELECT/CREATE is slow. The retrieval_outcome
    // loop is awaited inside the function, but the turn_score block is an
    // unwaited async IIFE per the source (line ~242).
    let turnScoreResolveTurnScore!: () => void;
    const turnScorePending = new Promise<void>(r => { turnScoreResolveTurnScore = r; });

    const queryFirst = vi.fn(async (sql: string) => {
      if (/FROM turn_score/.test(sql)) {
        // Block this SELECT until the test releases it.
        await turnScorePending;
        return [{ id: "turn_score:held" }];
      }
      return []; // retrieval_outcome SELECTs miss → CREATE proceeds
    });
    const queryExec = vi.fn(async () => {});
    const store = {
      queryFirst,
      queryExec,
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session-f", [makeRetrievalItem({ id: "memory:fnf" })]);

    // Run evaluateRetrieval — it must resolve EVEN THOUGH the turn_score
    // SELECT is still hanging. This is the fire-and-forget guarantee.
    const evalPromise = evaluateRetrieval(
      "session-f",
      "turn:fnf",
      "SurrealDB WebSocket connection",
      store as any,
    );

    // Race: if turn_score were awaited, evalPromise would not settle until
    // we release turnScorePending. Use a 50ms timeout to assert non-blocking.
    const winner = await Promise.race([
      evalPromise.then(() => "eval"),
      new Promise(r => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(winner).toBe("eval");

    // Now release the held SELECT so the dangling IIFE settles cleanly.
    turnScoreResolveTurnScore();
    await flushMicrotasks();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. pendingToolArgs KEYED BY tool_use_id — pre-tool-use + post-tool-use
// ────────────────────────────────────────────────────────────────────────────

describe("pendingToolArgs — keyed by tool_use_id (parallel Write/Edit safety)", () => {
  it("stores two parallel Write calls with different tool_use_ids and retrieves them independently", async () => {
    const session = mockSession();
    const { state } = mockStateForHooks(session);

    // Two parallel PreToolUse Writes.
    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-A",
      tool_input: { file_path: "/tmp/a.ts", content: "A" },
    });
    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-B",
      tool_input: { file_path: "/tmp/b.ts", content: "B" },
    });

    // Both stashed under their own tool_use_id key.
    expect(session.pendingToolArgs.size).toBe(2);
    expect(session.pendingToolArgs.get("tu-A")).toMatchObject({ file_path: "/tmp/a.ts" });
    expect(session.pendingToolArgs.get("tu-B")).toMatchObject({ file_path: "/tmp/b.ts" });
  });

  it("overwrites stored args when two PreToolUses share the same tool_use_id but different file_path", async () => {
    const session = mockSession();
    const { state } = mockStateForHooks(session);

    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-same",
      tool_input: { file_path: "/tmp/first.ts", content: "1" },
    });
    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-same",
      tool_input: { file_path: "/tmp/second.ts", content: "2" },
    });

    // Single entry — overwrite is the documented behavior (acceptable).
    expect(session.pendingToolArgs.size).toBe(1);
    expect(session.pendingToolArgs.get("tu-same")).toMatchObject({
      file_path: "/tmp/second.ts",
    });
  });

  it("PostToolUse reads pendingToolArgs by tool_use_id and DELETES the entry after consumption", async () => {
    const session = mockSession();
    const { state, store } = mockStateForHooks(session);

    // Pre-stash two parallel Writes.
    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-X",
      tool_input: { file_path: "/tmp/x.ts", content: "X" },
    });
    await handlePreToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-Y",
      tool_input: { file_path: "/tmp/y.ts", content: "Y" },
    });
    expect(session.pendingToolArgs.size).toBe(2);

    // PostToolUse for tu-X. Reads /tmp/x.ts (not /tmp/y.ts) and deletes
    // its entry from pendingToolArgs.
    await handlePostToolUse(state, {
      session_id: session.sessionId,
      tool_name: "Write",
      tool_use_id: "tu-X",
      tool_response: { ok: true },
    });

    // The X entry was deleted; Y is untouched.
    expect(session.pendingToolArgs.has("tu-X")).toBe(false);
    expect(session.pendingToolArgs.has("tu-Y")).toBe(true);

    // The artifact write went through commitKnowledge → createArtifact with
    // the x.ts path, NOT y.ts. (Proves PostToolUse read the right entry.)
    const artifactCalls = (store.createArtifact as ReturnType<typeof vi.fn>).mock.calls;
    expect(artifactCalls.length).toBe(1);
    expect(artifactCalls[0][0]).toBe("/tmp/x.ts");
  });
});
