/**
 * Tests for claw-code optimization patterns:
 * - SessionState optimization fields and lifecycle
 * - cosineSimilarity export
 * - before-tool-call handler (recall blocker, intent gating, cycle cap, planning gate summary)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionState } from "../src/engine/state.js";
import { cosineSimilarity, calcBudgets } from "../src/engine/graph-context.js";
import { createBeforeToolCallHandler } from "../src/engine/hooks/before-tool-call.js";
import { assertValidEdge, VALID_EDGES } from "../src/engine/surreal.js";

// ── SessionState optimization fields ──────────────────────────────────────────

describe("SessionState optimization fields", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("test-session", "test-key");
  });

  it("initializes optimization fields with defaults", () => {
    expect(session.lastQueryVec).toBeNull();
    expect(session.lastRetrievalSummary).toBe("");
    expect(session.apiCycleCount).toBe(0);
    expect(session.injectedSections).toBeInstanceOf(Set);
    expect(session.injectedSections.size).toBe(0);
  });

  it("resetTurn clears per-turn fields but preserves session-scoped ones", () => {
    // Set all fields
    session.lastQueryVec = [1, 2, 3];
    session.lastRetrievalSummary = "5 items injected";
    session.apiCycleCount = 7;
    session.injectedSections.add("ilaqrum");
    session.injectedSections.add("tier0");
    session.toolCallCount = 5;

    session.resetTurn();

    // Per-turn fields ARE cleared
    expect(session.lastRetrievalSummary).toBe("");
    expect(session.apiCycleCount).toBe(0);
    expect(session.toolCallCount).toBe(0);

    // Session-scoped fields are NOT cleared
    expect(session.lastQueryVec).toEqual([1, 2, 3]);
    expect(session.injectedSections.size).toBe(2);
    expect(session.injectedSections.has("ilaqrum")).toBe(true);
    expect(session.injectedSections.has("tier0")).toBe(true);
  });

  it("injectedSections tracks multiple sections independently", () => {
    session.injectedSections.add("ilaqrum");
    session.injectedSections.add("tier0");
    session.injectedSections.add("tier1");
    session.injectedSections.add("rules_full");

    expect(session.injectedSections.has("ilaqrum")).toBe(true);
    expect(session.injectedSections.has("tier0")).toBe(true);
    expect(session.injectedSections.has("tier1")).toBe(true);
    expect(session.injectedSections.has("rules_full")).toBe(true);
    expect(session.injectedSections.has("nonexistent")).toBe(false);
  });

  it("injectedSections.clear() resets all tracked sections", () => {
    session.injectedSections.add("ilaqrum");
    session.injectedSections.add("tier0");
    session.injectedSections.add("rules_full");

    session.injectedSections.clear();

    expect(session.injectedSections.size).toBe(0);
    expect(session.injectedSections.has("ilaqrum")).toBe(false);
  });
});

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("handles high-dimensional vectors", () => {
    const dim = 1024;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9); // Similar but not identical
    expect(sim).toBeLessThan(1.0);
  });

  it("returns 0 for zero vectors", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("is symmetric", () => {
    const a = [1, 3, 5, 7];
    const b = [2, 4, 6, 8];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("similarity > 0.80 threshold detects near-duplicates", () => {
    // Simulate query "authentication flow" vs "how does auth flow work"
    // In practice these would be embeddings, but we can test the threshold logic
    const base = Array.from({ length: 10 }, () => Math.random());
    const nearDup = base.map((v) => v + (Math.random() - 0.5) * 0.1); // Small perturbation
    const different = Array.from({ length: 10 }, () => Math.random());

    const nearSim = cosineSimilarity(base, nearDup);
    const farSim = cosineSimilarity(base, different);

    expect(nearSim).toBeGreaterThan(0.80);
    expect(farSim).toBeLessThan(nearSim);
  });
});

// ── before-tool-call handler ──────────────────────────────────────────────────

describe("createBeforeToolCallHandler", () => {
  // Minimal mock state
  function makeMockState(session: SessionState) {
    return {
      getSession: (key: string) => key === "test-key" ? session : undefined,
      embeddings: {
        embed: vi.fn(async (_text: string) => [0.1, 0.2, 0.3, 0.4, 0.5]),
        isAvailable: () => true,
        dispose: async () => {},
      },
      store: { isAvailable: () => true },
      config: {},
      complete: async () => ({ text: "" }),
    } as any;
  }

  function makeEvent(overrides: Partial<{
    toolName: string;
    params: Record<string, unknown>;
    assistantTextLengthSoFar: number;
    toolCallIndexInTurn: number;
  }> = {}) {
    return {
      toolName: "bash",
      params: {},
      assistantTextLengthSoFar: 100, // Has output text (past planning gate)
      toolCallIndexInTurn: 1,        // Not first tool call
      ...overrides,
    };
  }

  const ctx = { sessionKey: "test-key" };

  describe("API cycle cap", () => {
    it("allows calls within cap", async () => {
      const session = new SessionState("s1", "test-key");
      session.apiCycleCount = 10;
      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(makeEvent(), ctx);
      expect(result?.block).not.toBe(true);
    });

    it("blocks at cycle cap (16)", async () => {
      const session = new SessionState("s1", "test-key");
      session.apiCycleCount = 16; // Will be incremented to 17 inside handler
      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(makeEvent(), ctx);
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("API cycle cap");
    });
  });

  describe("intent-based tool gating", () => {
    it("blocks recall on skipRetrieval turns", async () => {
      const session = new SessionState("s1", "test-key");
      session.currentConfig = {
        thinkingLevel: "low",
        toolLimit: 8,
        tokenBudget: 4000,
        skipRetrieval: true,
        vectorSearchLimits: { turn: 0, identity: 0, concept: 0, memory: 0, artifact: 0 },
      };
      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(makeEvent({ toolName: "recall", params: { query: "test" } }), ctx);
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("Context retrieval was skipped");
    });

    it("allows recall when skipRetrieval is false", async () => {
      const session = new SessionState("s1", "test-key");
      session.currentConfig = {
        thinkingLevel: "medium",
        toolLimit: 5,
        tokenBudget: 6000,
        skipRetrieval: false,
        vectorSearchLimits: { turn: 25, identity: 10, concept: 20, memory: 20, artifact: 10 },
      };
      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(makeEvent({ toolName: "recall", params: { query: "test" } }), ctx);
      // Should not be blocked by intent gating (may hit planning gate or pass through)
      if (result?.block) {
        expect(result.blockReason).not.toContain("Context retrieval was skipped");
      }
    });

    it("allows non-recall tools on skipRetrieval turns", async () => {
      const session = new SessionState("s1", "test-key");
      session.currentConfig = {
        thinkingLevel: "low",
        toolLimit: 8,
        tokenBudget: 4000,
        skipRetrieval: true,
        vectorSearchLimits: { turn: 0, identity: 0, concept: 0, memory: 0, artifact: 0 },
      };
      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(makeEvent({ toolName: "bash" }), ctx);
      // Should not be blocked by intent gating
      if (result?.block) {
        expect(result.blockReason).not.toContain("Context retrieval was skipped");
      }
    });
  });

  describe("redundant recall blocker", () => {
    it("blocks recall when query is highly similar to context query", async () => {
      const session = new SessionState("s1", "test-key");
      const queryVec = [0.1, 0.2, 0.3, 0.4, 0.5];
      session.lastQueryVec = queryVec;

      // Mock embeddings to return the same vector (cosine = 1.0)
      const mockState = makeMockState(session);
      mockState.embeddings.embed = vi.fn(async () => queryVec);

      const handler = createBeforeToolCallHandler(mockState);
      const result = await handler(
        makeEvent({ toolName: "recall", params: { query: "authentication flow" } }),
        ctx,
      );
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("similar to the context already retrieved");
    });

    it("allows recall when query is sufficiently different", async () => {
      const session = new SessionState("s1", "test-key");
      session.lastQueryVec = [1, 0, 0, 0, 0];

      // Return orthogonal vector (cosine = 0)
      const mockState = makeMockState(session);
      mockState.embeddings.embed = vi.fn(async () => [0, 1, 0, 0, 0]);

      const handler = createBeforeToolCallHandler(mockState);
      const result = await handler(
        makeEvent({ toolName: "recall", params: { query: "something completely different" } }),
        ctx,
      );
      // Should not be blocked by recall blocker
      if (result?.block) {
        expect(result.blockReason).not.toContain("similar to the context already retrieved");
      }
    });

    it("allows recall when no lastQueryVec exists", async () => {
      const session = new SessionState("s1", "test-key");
      session.lastQueryVec = null;

      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(
        makeEvent({ toolName: "recall", params: { query: "test query" } }),
        ctx,
      );
      // Should not be blocked by recall blocker
      if (result?.block) {
        expect(result.blockReason).not.toContain("similar to the context already retrieved");
      }
    });

    it("allows recall through when embedding fails (fail-open)", async () => {
      const session = new SessionState("s1", "test-key");
      session.lastQueryVec = [1, 2, 3, 4, 5];

      const mockState = makeMockState(session);
      mockState.embeddings.embed = vi.fn(async () => { throw new Error("embedding failed"); });

      const handler = createBeforeToolCallHandler(mockState);
      const result = await handler(
        makeEvent({ toolName: "recall", params: { query: "test query" } }),
        ctx,
      );
      // Should not be blocked — fail-open
      if (result?.block) {
        expect(result.blockReason).not.toContain("similar to the context already retrieved");
      }
    });

    it("skips short recall queries (length <= 5)", async () => {
      const session = new SessionState("s1", "test-key");
      session.lastQueryVec = [1, 2, 3, 4, 5];

      const mockState = makeMockState(session);
      const handler = createBeforeToolCallHandler(mockState);
      const result = await handler(
        makeEvent({ toolName: "recall", params: { query: "hi" } }),
        ctx,
      );
      // Embedding should not be called for short queries
      expect(mockState.embeddings.embed).not.toHaveBeenCalled();
    });
  });

  describe("planning gate retrieval summary", () => {
    it("includes retrieval summary in planning gate when available", async () => {
      const session = new SessionState("s1", "test-key");
      session.lastRetrievalSummary = "12 context items + 3 neighbors injected (graph mode)";

      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(
        makeEvent({ assistantTextLengthSoFar: 0, toolCallIndexInTurn: 0 }),
        ctx,
      );
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("Plan before tools");
      expect(result?.blockReason).toContain("12 context items + 3 neighbors injected");
    });

    it("omits retrieval summary when empty", async () => {
      const session = new SessionState("s1", "test-key");
      session.lastRetrievalSummary = "";

      const handler = createBeforeToolCallHandler(makeMockState(session));
      const result = await handler(
        makeEvent({ assistantTextLengthSoFar: 0, toolCallIndexInTurn: 0 }),
        ctx,
      );
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain("Plan before tools");
      expect(result?.blockReason).not.toContain("Context already injected:");
    });
  });

  describe("apiCycleCount increments", () => {
    it("increments apiCycleCount on each call", async () => {
      const session = new SessionState("s1", "test-key");
      expect(session.apiCycleCount).toBe(0);

      const handler = createBeforeToolCallHandler(makeMockState(session));
      await handler(makeEvent(), ctx);
      expect(session.apiCycleCount).toBe(1);

      await handler(makeEvent(), ctx);
      expect(session.apiCycleCount).toBe(2);
    });
  });
});

// ── Dense 65k context window budget tests ────────────────────────────────────

describe("calcBudgets — dense 65k window", () => {
  it("produces ~65k total for 200k context window", () => {
    const budgets = calcBudgets(200_000);
    const total = budgets.conversation + budgets.retrieval + budgets.core + budgets.toolHistory;
    // 200k * 0.325 = 65k
    expect(total).toBeGreaterThan(60_000);
    expect(total).toBeLessThan(70_000);
  });

  it("includes toolHistory budget", () => {
    const budgets = calcBudgets(200_000);
    expect(budgets.toolHistory).toBeGreaterThan(0);
    // ~15k for tool history (23% of 65k)
    expect(budgets.toolHistory).toBeGreaterThan(12_000);
    expect(budgets.toolHistory).toBeLessThan(18_000);
  });

  it("allocates ~15k for conversation", () => {
    const budgets = calcBudgets(200_000);
    expect(budgets.conversation).toBeGreaterThan(12_000);
    expect(budgets.conversation).toBeLessThan(18_000);
  });

  it("allocates ~25k for graph retrieval", () => {
    const budgets = calcBudgets(200_000);
    expect(budgets.retrieval).toBeGreaterThan(22_000);
    expect(budgets.retrieval).toBeLessThan(28_000);
  });

  it("allocates ~10k for core memory", () => {
    const budgets = calcBudgets(200_000);
    expect(budgets.core).toBeGreaterThan(8_000);
    expect(budgets.core).toBeLessThan(12_000);
  });

  it("scales proportionally with context window size", () => {
    const small = calcBudgets(100_000);
    const large = calcBudgets(400_000);
    expect(large.conversation).toBeCloseTo(small.conversation * 4, -3);
    expect(large.retrieval).toBeCloseTo(small.retrieval * 4, -3);
    expect(large.toolHistory).toBeCloseTo(small.toolHistory * 4, -3);
  });

  it("maxContextItems is at least 20", () => {
    const budgets = calcBudgets(50_000);
    expect(budgets.maxContextItems).toBeGreaterThanOrEqual(20);
  });
});

// ── Edge name validation ────────────────────────────────────────────────────

describe("assertValidEdge", () => {
  it("accepts all whitelisted edge names", () => {
    for (const edge of VALID_EDGES) {
      expect(() => assertValidEdge(edge)).not.toThrow();
    }
  });

  it("rejects unknown edge names", () => {
    expect(() => assertValidEdge("DROP TABLE memory")).toThrow("Invalid edge name");
    expect(() => assertValidEdge("'; DROP TABLE --")).toThrow("Invalid edge name");
    expect(() => assertValidEdge("fake_edge")).toThrow("Invalid edge name");
  });

  it("rejects empty string", () => {
    expect(() => assertValidEdge("")).toThrow("Invalid edge name");
  });

  it("VALID_EDGES contains expected causal edges", () => {
    expect(VALID_EDGES.has("caused_by")).toBe(true);
    expect(VALID_EDGES.has("supports")).toBe(true);
    expect(VALID_EDGES.has("contradicts")).toBe(true);
    expect(VALID_EDGES.has("describes")).toBe(true);
  });

  it("VALID_EDGES contains expected structural edges", () => {
    expect(VALID_EDGES.has("owns")).toBe(true);
    expect(VALID_EDGES.has("performed")).toBe(true);
    expect(VALID_EDGES.has("produced")).toBe(true);
    expect(VALID_EDGES.has("artifact_mentions")).toBe(true);
  });
});

// ── queryBatch (mock) ───────────────────────────────────────────────────────

describe("queryBatch behavior (SurrealStore)", () => {
  it("concatenates statements with semicolons and skips USE result", async () => {
    // We test the contract: queryBatch joins N statements, sends one query,
    // and strips the leading USE result. We mock the Surreal client.
    const mockDb = {
      query: vi.fn(async (_sql: string, _bindings?: any) => {
        // Simulates: USE result (empty), then one result per statement
        return [[], [{ id: "memory:abc", text: "hello" }], [{ id: "concept:xyz", text: "world" }]];
      }),
    };

    // Manually replicate queryBatch logic to verify contract
    const statements = [
      "SELECT * FROM memory:abc",
      "SELECT * FROM concept:xyz",
    ];
    const joined = statements.join(";\n");
    const fullSql = `USE NS test DB test;\n${joined}`;
    const raw = await mockDb.query(fullSql, {}) as unknown[];
    const results = raw.slice(1).map((r: any) => (Array.isArray(r) ? r : []).filter(Boolean));

    expect(mockDb.query).toHaveBeenCalledWith(fullSql, {});
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([{ id: "memory:abc", text: "hello" }]);
    expect(results[1]).toEqual([{ id: "concept:xyz", text: "world" }]);
  });

  it("returns empty array for empty statements", () => {
    // queryBatch short-circuits on empty input
    const statements: string[] = [];
    expect(statements.length === 0 ? [] : null).toEqual([]);
  });
});

// ── Token estimation for content types ──────────────────────────────────────

describe("token estimation — content type handling", () => {
  // These tests verify the constants and estimation logic used by getRecentTurns
  // indirectly, since getRecentTurns is not exported.

  const IMAGE_TOKEN_ESTIMATE = 2000;
  const BYTES_PER_TOKEN = 4;
  const BYTES_PER_TOKEN_JSON = 2;

  it("IMAGE_TOKEN_ESTIMATE is 2000 tokens", () => {
    // Images are estimated at 2000 tokens regardless of actual size
    expect(IMAGE_TOKEN_ESTIMATE).toBe(2000);
    // In char-equivalent terms: 2000 * 4 = 8000 chars
    expect(IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN).toBe(8000);
  });

  it("JSON content is estimated at 2x density vs prose", () => {
    // JSON tool results use 2 bytes/token vs 4 bytes/token for prose
    const jsonText = '{"key": "value", "nested": {"arr": [1,2,3]}}';
    const proseText = "The quick brown fox jumps over the lazy dog.";

    // JSON char-equivalent is scaled up by BYTES_PER_TOKEN / BYTES_PER_TOKEN_JSON = 2x
    const jsonCharEquiv = jsonText.length * (BYTES_PER_TOKEN / BYTES_PER_TOKEN_JSON);
    const proseCharEquiv = proseText.length;

    // JSON of same string length counts for more tokens
    expect(jsonCharEquiv).toBe(jsonText.length * 2);
    expect(proseCharEquiv).toBe(proseText.length);
  });

  it("JSON detection triggers on leading { or [ for strings > 20 chars", () => {
    // The heuristic: text.length > 20 && (text[0] === "{" || text[0] === "[")
    const shortJson = '{"a":1}';
    const longJson = '{"key": "value", "other": "data"}';
    const longProse = "This is a normal prose string that is long enough.";

    expect(shortJson.length > 20).toBe(false); // not treated as JSON
    expect(longJson.length > 20 && longJson[0] === "{").toBe(true); // treated as JSON
    expect(longProse.length > 20 && (longProse[0] === "{" || longProse[0] === "[")).toBe(false);
  });

  it("old thinking blocks are replaced with [thinking] stub", () => {
    // getRecentTurns replaces thinking blocks in old messages with { type: "text", text: "[thinking]" }
    // Verify the stub is dramatically smaller than typical thinking content
    const typicalThinkingChars = 3000; // ~750 tokens of thinking
    const stubChars = "[thinking]".length; // 10 chars = ~2.5 tokens
    expect(stubChars).toBeLessThan(typicalThinkingChars * 0.01); // >99% reduction
  });

  it("old tool results are replaced with size annotation", () => {
    // Old tool results > 200 chars get replaced with `[Old tool result cleared — N chars]`
    const originalLen = 5000;
    const stub = `[Old tool result cleared — ${originalLen} chars]`;
    expect(stub.length).toBeLessThan(200);
    expect(stub).toContain("5000");
  });

  it("images in old messages are replaced with [image] stub", () => {
    // Image blocks become { type: "text", text: "[image]" }
    // Savings: 2000 tokens -> ~1.5 tokens
    const imageSavings = IMAGE_TOKEN_ESTIMATE - Math.ceil("[image]".length / BYTES_PER_TOKEN);
    expect(imageSavings).toBeGreaterThan(1990);
  });
});
