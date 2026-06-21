import { describe, it, expect, vi } from "vitest";
import {
  stageRetrieval,
  evaluateRetrieval,
  type RetrievedItem,
} from "../src/engine/retrieval-quality.js";

/** Regression for v0.7.27 citation-pattern + grounding feedback.
 *
 * Items are injected with [#N] index tags. The Stop hook parses the
 * assistant response for [#1], [#2]... and writes `cited: true` on
 * matching retrieval_outcome rows. This test pins:
 *   1. citation parsing actually catches [#N] tokens
 *   2. retrieval_outcome row gets cited + citation_method when indexMap
 *      was provided
 *   3. cited=false items get citation_method='none' (the audit signal —
 *      "you injected this, the model ignored it")
 *   4. legacy callers without indexMap still write rows (no cited field) */
describe("evaluateRetrieval — [#N] citation parsing", () => {
  function makeItem(id: string, score: number): RetrievedItem {
    return {
      id,
      table: "concept" as any,
      text: `content for ${id}`,
      finalScore: score,
    };
  }

  function setup() {
    const created: any[] = [];
    const queryExec = vi.fn().mockImplementation(async (sql: string, params: any) => {
      // K23 (2026): retrieval_outcome rows are written via one bulk
      // `INSERT INTO retrieval_outcome $rows` (array bind), not per-item
      // `CREATE ... CONTENT $data`. Capture the array form.
      if (/INSERT INTO retrieval_outcome/i.test(sql) && Array.isArray(params?.rows)) {
        created.push(...params.rows);
      } else if (sql.startsWith("CREATE retrieval_outcome")) {
        created.push(params.data);
      }
    });
    // Batched dedup: writer pre-checks the UNIQUE-index tuples via one
    // queryFirst (memory_id IN $ids) before the bulk INSERT. Returning []
    // lets the INSERT fire.
    const queryFirst = vi.fn().mockResolvedValue([]);
    const updateUtilityCache = vi.fn().mockResolvedValue(undefined);
    const store = { queryFirst, queryExec, updateUtilityCache } as any;
    return { store, created };
  }

  it("marks cited=true for items whose [#N] appears in the response", async () => {
    const { store, created } = setup();
    const items = [makeItem("concept:a", 0.9), makeItem("concept:b", 0.7), makeItem("concept:c", 0.5)];
    const indexMap = new Map<number, string>([
      [1, "concept:a"], [2, "concept:b"], [3, "concept:c"],
    ]);
    stageRetrieval("session:s1", items, undefined, indexMap);

    await evaluateRetrieval(
      "session:s1",
      "turn:t1",
      "Per [#1] and [#3], the answer is yes.",
      store,
    );

    const byId = new Map(created.map((r) => [r.memory_id, r]));
    expect(byId.get("concept:a")?.cited).toBe(true);
    expect(byId.get("concept:a")?.citation_method).toBe("index");
    expect(byId.get("concept:b")?.cited).toBe(false);
    expect(byId.get("concept:b")?.citation_method).toBe("none");
    expect(byId.get("concept:c")?.cited).toBe(true);
    expect(byId.get("concept:c")?.citation_method).toBe("index");
  });

  it("ignores [#N] indices not in the indexMap (e.g. model hallucinated [#99])", async () => {
    const { store, created } = setup();
    const items = [makeItem("concept:a", 0.9)];
    const indexMap = new Map<number, string>([[1, "concept:a"]]);
    stageRetrieval("session:s1", items, undefined, indexMap);

    await evaluateRetrieval("session:s1", "turn:t1", "Citing [#99] which doesn't exist.", store);

    expect(created[0].cited).toBe(false);
    expect(created[0].citation_method).toBe("none");
  });

  it("legacy callers without indexMap omit cited/citation_method (no regression)", async () => {
    const { store, created } = setup();
    const items = [makeItem("concept:a", 0.9)];
    stageRetrieval("session:s1", items, undefined);

    await evaluateRetrieval("session:s1", "turn:t1", "Some response.", store);

    expect(created).toHaveLength(1);
    expect(created[0].cited).toBeUndefined();
    expect(created[0].citation_method).toBeUndefined();
    // Other fields still present
    expect(created[0].memory_id).toBe("concept:a");
    expect(created[0].retrieval_score).toBe(0.9);
  });

  it("0.7.33: marks cited=true with citation_method='lexical' when response paraphrases item content (no [#N])", async () => {
    const { store, created } = setup();
    // Item text shares many key terms + trigrams with the response — high
    // utilization signal. No [#N] in the response.
    const items: RetrievedItem[] = [{
      id: "concept:lexical_test",
      table: "concept" as any,
      text: "The release version-bump checklist requires updating package.json package-lock.json plugin.json and the README badge — all four version surfaces together to keep the marketplace cache in sync.",
      finalScore: 0.9,
    }];
    const indexMap = new Map<number, string>([[1, "concept:lexical_test"]]);
    stageRetrieval("session:s1", items, undefined, indexMap);

    await evaluateRetrieval(
      "session:s1",
      "turn:t1",
      "When releasing a new version remember to bump package.json package-lock.json and plugin.json plus the README version badge — all four version surfaces — so the marketplace cache stays in sync with the new release.",
      store,
    );

    expect(created[0].cited).toBe(true);
    expect(created[0].citation_method).toBe("lexical");
  });

  it("handles multiple citations of the same [#N]", async () => {
    const { store, created } = setup();
    const items = [makeItem("concept:a", 0.9)];
    const indexMap = new Map<number, string>([[1, "concept:a"]]);
    stageRetrieval("session:s1", items, undefined, indexMap);

    await evaluateRetrieval("session:s1", "turn:t1", "[#1] is great. See also [#1] for confirmation.", store);

    expect(created[0].cited).toBe(true);
  });
});
