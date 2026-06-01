import { describe, it, expect, beforeEach, vi } from "vitest";
import { stageRetrieval, stageSkills, getStagedItems, recordToolOutcome, evaluateRetrieval, computeSignals, classifyItem } from "../src/engine/retrieval-quality.js";
import type { RetrievedItem } from "../src/engine/retrieval-quality.js";

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

describe("stageRetrieval / getStagedItems", () => {
  beforeEach(() => {
    // Clear any pending state (drain entries from previous tests)
    stageRetrieval("session1", [], undefined);
    evaluateRetrieval("session1", "", "", { queryExec: async () => {}, updateUtilityCache: async () => {}, isAvailable: () => false } as any);
  });

  it("stages items and retrieves them", () => {
    const items = [makeItem(), makeItem({ id: "memory:test2" })];
    stageRetrieval("session1", items);
    const staged = getStagedItems("session1");
    expect(staged).toHaveLength(2);
    expect(staged[0].id).toBe("memory:test1");
  });

  it("returns empty array when nothing staged", () => {
    expect(getStagedItems("session-empty")).toHaveLength(0);
  });

  it("returns a copy, not the original array", () => {
    stageRetrieval("session1", [makeItem()]);
    const a = getStagedItems("session1");
    const b = getStagedItems("session1");
    expect(a).not.toBe(b);
  });
});

describe("recordToolOutcome", () => {
  it("records tool outcomes into pending retrieval", () => {
    stageRetrieval("session1", [makeItem()]);
    recordToolOutcome("session1", true);
    recordToolOutcome("session1", false);
    // Outcomes are consumed by evaluateRetrieval — we just verify no crash
  });

  it("no-ops when nothing is staged for that session", () => {
    // Should not throw
    recordToolOutcome("session-not-staged", true);
  });
});

describe("evaluateRetrieval", () => {
  it("writes outcome records to store", async () => {
    const created: any[] = [];
    const mockStore = {
      // SELECT-then-CREATE dedup: writer checks the UNIQUE-index tuple before
      // inserting. Tests want the CREATE to fire, so queryFirst returns [].
      queryFirst: async () => [],
      queryExec: async (_sql: string, params: any) => { created.push(params.data); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "SurrealDB WebSocket connection handling" }),
    ]);

    // Response references the retrieved content
    await evaluateRetrieval(
      "session1",
      "turn:123",
      "The SurrealDB WebSocket connection was reset due to a timeout",
      mockStore as any,
    );

    const outcomes = created.filter((r: any) => r.memory_id);
    const turnScores = created.filter((r: any) => r.context_util !== undefined);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].session_id).toBe("session1");
    expect(outcomes[0].turn_id).toBe("turn:123");
    expect(outcomes[0].memory_id).toBe("memory:test1");
    expect(outcomes[0].utilization).toBeGreaterThan(0);
    expect(turnScores).toHaveLength(1);
    expect(turnScores[0].session_id).toBe("session1");
  });

  it("high utilization when response references retrieved text", async () => {
    const created: any[] = [];
    const mockStore = {
      queryFirst: async () => [],
      queryExec: async (_sql: string, params: any) => { created.push(params.data); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "React hooks useState useEffect component lifecycle" }),
    ]);

    await evaluateRetrieval(
      "session1",
      "turn:456",
      "You should use useState and useEffect hooks in your React component lifecycle",
      mockStore as any,
    );

    expect(created[0].utilization).toBeGreaterThan(0.3);
  });

  it("low utilization when response ignores retrieved text", async () => {
    const created: any[] = [];
    const mockStore = {
      queryFirst: async () => [],
      queryExec: async (_sql: string, params: any) => { created.push(params.data); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "Kubernetes pod scheduling affinity rules" }),
    ]);

    await evaluateRetrieval(
      "session1",
      "turn:789",
      "Here is how to write a Python function that sorts a list",
      mockStore as any,
    );

    expect(created[0].utilization).toBeLessThan(0.2);
  });

  it("clears pending state after evaluation", async () => {
    const mockStore = {
      queryFirst: async () => [],
      queryExec: async () => {},
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [makeItem()]);
    await evaluateRetrieval("session1", "turn:1", "response", mockStore as any);
    expect(getStagedItems("session1")).toHaveLength(0);
  });

  it("no-ops when nothing staged", async () => {
    const mockStore = {
      queryExec: async () => { throw new Error("should not be called"); },
      updateUtilityCache: async () => {},
    };
    // Should not throw
    await evaluateRetrieval("session-empty", "turn:1", "response", mockStore as any);
  });
});

describe("classifyItem — three-bucket purpose classification", () => {
  function mkItem(table: string, category?: string): RetrievedItem {
    return { id: `${table}:test`, table, text: "test", score: 1, category } as RetrievedItem;
  }

  it("concepts are knowledge", () => {
    expect(classifyItem(mkItem("concept"))).toBe("knowledge");
  });

  it("artifacts are knowledge", () => {
    expect(classifyItem(mkItem("artifact"))).toBe("knowledge");
  });

  it("identity_chunks are behavioral", () => {
    expect(classifyItem(mkItem("identity_chunk"))).toBe("behavioral");
  });

  it("monologues are context", () => {
    expect(classifyItem(mkItem("monologue"))).toBe("context");
  });

  it("turns are context", () => {
    expect(classifyItem(mkItem("turn"))).toBe("context");
  });

  it("skills are context", () => {
    expect(classifyItem(mkItem("skill"))).toBe("context");
  });

  it("memory with preference category is behavioral", () => {
    expect(classifyItem(mkItem("memory", "preference"))).toBe("behavioral");
  });

  it("memory with correction category is behavioral", () => {
    expect(classifyItem(mkItem("memory", "correction"))).toBe("behavioral");
  });

  it("memory with fact category is knowledge", () => {
    expect(classifyItem(mkItem("memory", "fact"))).toBe("knowledge");
  });

  it("memory with decision category is knowledge", () => {
    expect(classifyItem(mkItem("memory", "decision"))).toBe("knowledge");
  });

  it("memory with causal category is knowledge", () => {
    expect(classifyItem(mkItem("memory", "causal_trigger_fix"))).toBe("knowledge");
  });

  it("memory with no category defaults to knowledge", () => {
    expect(classifyItem(mkItem("memory"))).toBe("knowledge");
  });
});

describe("computeSignals — utilization formula", () => {
  function mkItem(text: string, extra: Partial<RetrievedItem> = {}): RetrievedItem {
    return { id: "concept:test", table: "concept", text, score: 1, ...extra } as RetrievedItem;
  }

  it("gives partial credit for topical (unigram) overlap without exact-term reuse", () => {
    // Old formula halved unigram before max(), often pinning utilization at 0
    // when phrasing differed. New blend keeps broad overlap visible.
    const item = mkItem("The retrieval pipeline embeds queries with bge-m3 and ranks via cosine similarity scoring");
    const response = "i used cosine similarity scoring on embedded queries to rank retrieval results".toLowerCase();
    const { utilization } = computeSignals(item, response, null);
    expect(utilization).toBeGreaterThan(0.15);
  });

  it("toolSuccess=true adds a ~0.2 boost", () => {
    const item = mkItem("Use git rebase to squash commits");
    const response = "ran git rebase to clean up history".toLowerCase();
    const baseline = computeSignals(item, response, null).utilization;
    const boosted = computeSignals(item, response, true).utilization;
    expect(boosted).toBeGreaterThan(baseline);
    expect(boosted - baseline).toBeCloseTo(0.2, 1);
  });

  it("toolSuccess=false does not penalize relative to null", () => {
    const item = mkItem("BGE-M3 embeddings");
    const response = "bge-m3 embeddings worked fine".toLowerCase();
    const neutral = computeSignals(item, response, null).utilization;
    const failed = computeSignals(item, response, false).utilization;
    expect(failed).toBe(neutral);
  });

  it("clamps utilization to [0, 1] even when boost would push over", () => {
    const item = mkItem("KongCode persistent memory graph SurrealDB BGE-M3 embeddings");
    const response = "kongcode persistent memory graph surrealdb bge-m3 embeddings all working".toLowerCase();
    const { utilization } = computeSignals(item, response, true);
    expect(utilization).toBeLessThanOrEqual(1);
    expect(utilization).toBeGreaterThan(0.5);
  });

  it("returns ~0 for unrelated content", () => {
    const item = mkItem("Algorithmic trading volatility risk metrics for derivatives");
    const response = "the cat sat on the mat".toLowerCase();
    const { utilization } = computeSignals(item, response, null);
    expect(utilization).toBeLessThan(0.05);
  });

  it("citation boost floors utilization at 0.7 for cited items", () => {
    const item = mkItem("User prefers bundled PRs for refactors");
    const response = "i suggested a single pull request for the refactor".toLowerCase();
    const uncited = computeSignals(item, response, null).utilization;
    const cited = computeSignals(item, response, null, true).utilization;
    expect(uncited).toBeLessThan(0.7);
    expect(cited).toBeGreaterThanOrEqual(0.7);
  });

  it("citation boost does not lower already-high utilization", () => {
    const item = mkItem("KongCode persistent memory graph SurrealDB BGE-M3 embeddings");
    const response = "kongcode persistent memory graph surrealdb bge-m3 embeddings all working".toLowerCase();
    const base = computeSignals(item, response, true).utilization;
    const withCite = computeSignals(item, response, true, true).utilization;
    expect(withCite).toBeGreaterThanOrEqual(base);
  });
});

describe("composite scoring formula", () => {
  it("composite = 0.6*rules + 0.3*context + 0.1*curation", () => {
    const rules = 0.8, context = 0.5, curation = 1.0;
    const composite = (0.6 * rules) + (0.3 * context) + (0.1 * curation);
    expect(composite).toBeCloseTo(0.73, 2);
  });

  it("composite without context_util omits the 30% bucket", () => {
    const rules = 0.8, curation = 1.0;
    const composite = (0.6 * rules) + (0.1 * curation);
    expect(composite).toBeCloseTo(0.58, 2);
  });
});

describe("stageSkills + evaluateRetrieval skill outcome", () => {
  beforeEach(() => {
    stageRetrieval("session1", [], undefined);
    evaluateRetrieval("session1", "", "", { queryExec: async () => {}, updateUtilityCache: async () => {}, isAvailable: () => false } as any);
  });

  it("calls recordSkillOutcome for each staged skill after evaluation", async () => {
    const execCalls: { sql: string; params: any }[] = [];
    const mockStore = {
      isAvailable: () => true,
      queryFirst: async () => [],
      queryExec: async (sql: string, params: any) => { execCalls.push({ sql, params }); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [
      makeItem({ text: "SurrealDB query optimization" }),
    ]);
    stageSkills("session1", [
      { id: "skill:s1", text: "optimize a surrealdb query with an index hint" },
      { id: "skill:s2", text: "speed up surrealdb query using an index hint" },
    ]);
    recordToolOutcome("session1", true);

    await evaluateRetrieval(
      "session1",
      "turn:100",
      "I optimized the SurrealDB query using an index hint",
      mockStore as any,
    );

    const skillUpdates = execCalls.filter(c => c.sql.includes("UPDATE skill:"));
    expect(skillUpdates).toHaveLength(2);
    expect(skillUpdates[0].sql).toContain("success_count");
    expect(skillUpdates[1].sql).toContain("success_count");
  });

  it("records failure_count when tools fail", async () => {
    const execCalls: { sql: string; params: any }[] = [];
    const mockStore = {
      isAvailable: () => true,
      queryFirst: async () => [],
      queryExec: async (sql: string, params: any) => { execCalls.push({ sql, params }); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [makeItem()]);
    stageSkills("session1", [
      { id: "skill:s1", text: "handle a surrealdb websocket connection reset after a failed query" },
    ]);
    recordToolOutcome("session1", false);
    recordToolOutcome("session1", false);

    await evaluateRetrieval(
      "session1",
      "turn:101",
      "The SurrealDB WebSocket connection was reset after a failed query",
      mockStore as any,
    );

    const skillUpdates = execCalls.filter(c => c.sql.includes("UPDATE skill:"));
    expect(skillUpdates).toHaveLength(1);
    expect(skillUpdates[0].sql).toContain("failure_count");
  });

  it("no-ops skill outcome when no skills staged", async () => {
    const execCalls: { sql: string }[] = [];
    const mockStore = {
      isAvailable: () => true,
      queryFirst: async () => [],
      queryExec: async (sql: string, params: any) => { execCalls.push({ sql }); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [makeItem({ text: "some context" })]);
    // No stageSkills call

    await evaluateRetrieval("session1", "turn:102", "some context in response", mockStore as any);

    const skillUpdates = execCalls.filter(c => c.sql.includes("UPDATE skill:"));
    expect(skillUpdates).toHaveLength(0);
  });

  it("stageSkills no-ops when nothing is staged", () => {
    stageSkills("session-not-staged", [{ id: "skill:s1", text: "x" }]);
    expect(getStagedItems("session-not-staged")).toHaveLength(0);
  });

  it("records NOTHING when there is no tool outcome to judge (no default-to-success)", async () => {
    const execCalls: { sql: string }[] = [];
    const mockStore = {
      isAvailable: () => true,
      queryFirst: async () => [],
      queryExec: async (sql: string) => { execCalls.push({ sql }); },
      updateUtilityCache: async () => {},
    };

    stageRetrieval("session1", [makeItem({ text: "deployment procedure" })]);
    stageSkills("session1", [{ id: "skill:s1", text: "follow the deployment procedure step by step" }]);
    // No recordToolOutcome → toolSuccess is null. The old code wrongly defaulted
    // to success and recorded; the fix records nothing (that default was the bias
    // that left failure_count=0 corpus-wide). Engagement is high here, but with
    // no tool outcome there's nothing to judge the skill on.

    await evaluateRetrieval("session1", "turn:103", "I followed the deployment procedure step by step", mockStore as any);

    const skillUpdates = execCalls.filter(c => c.sql.includes("UPDATE skill:"));
    expect(skillUpdates).toHaveLength(0);
  });
});
