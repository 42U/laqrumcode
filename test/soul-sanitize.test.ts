/**
 * Tests for soul_generate / soul_evolve field sanitization.
 *
 * The LLM generates soul document JSON that may contain extra fields not in
 * the SCHEMAFULL `soul` table (e.g. `earned_values[].name`, `description`,
 * `evidence`). The commit handler must strip these to prevent SurrealDB
 * InternalError rejections. See v0.7.65 CHANGELOG.
 */

import { describe, it, expect, vi } from "vitest";
import * as pendingWork from "../src/tools/pending-work.js";

const parseSoulResult = (pendingWork as any).__test__.parseSoulResult as (r: unknown) => Record<string, any> | null;

describe("parseSoulResult", () => {
  it("parses a plain object", () => {
    const doc = { working_style: ["concise"] };
    expect(parseSoulResult(doc)).toEqual(doc);
  });

  it("parses a JSON string", () => {
    const doc = { working_style: ["concise"] };
    expect(parseSoulResult(JSON.stringify(doc))).toEqual(doc);
  });

  it("extracts JSON from surrounding text", () => {
    const text = 'Here is the soul: {"working_style": ["direct"]} end';
    const result = parseSoulResult(text);
    expect(result).toEqual({ working_style: ["direct"] });
  });

  it("returns null for non-JSON string", () => {
    expect(parseSoulResult("not json at all")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseSoulResult(null)).toBeNull();
    expect(parseSoulResult(undefined)).toBeNull();
  });
});

describe("soul_generate field sanitization", () => {
  function mockStore(createSoulSuccess = true) {
    return {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM soul:laqrumbrain")) return createSoulSuccess ? [] : [{ id: "soul:laqrumbrain" }];
        if (sql.includes("graduation_event")) return [];
        if (sql.includes("FROM concept")) return [{ count: 500 }];
        if (sql.includes("FROM memory")) return [{ count: 200 }];
        if (sql.includes("FROM turn")) return [{ count: 100 }];
        if (sql.includes("FROM artifact")) return [{ count: 50 }];
        if (sql.includes("FROM skill")) return [{ count: 10 }];
        if (sql.includes("FROM reflection")) return [{ count: 20 }];
        if (sql.includes("FROM monologue")) return [{ count: 15 }];
        if (sql.includes("retrieval_outcome")) return [{ total: 100, good: 90 }];
        if (sql.includes("maturity_stage")) return [];
        return [];
      }),
      queryExec: vi.fn(async () => {}),
    };
  }

  function mockState(store: ReturnType<typeof mockStore>) {
    return {
      store,
      embeddings: { isAvailable: () => false, embed: vi.fn() },
    } as any;
  }

  it("strips unknown fields from earned_values and maps common aliases", async () => {
    const store = mockStore();
    const state = mockState(store);

    const llmOutput = {
      working_style: ["concise", "direct"],
      emotional_dimensions: [
        { dimension: "curiosity", description: "driven by exploration" },
      ],
      self_observations: ["I verify before claiming done"],
      earned_values: [
        { name: "accuracy", evidence: "caught 3 bugs", description: "always check twice" },
        { value: "thoroughness", grounded_in: "user corrections" },
      ],
    };

    const item = { id: "pending_work:test1", work_type: "soul_generate", session_id: "s1" } as any;

    // Import and call commitResults indirectly via handleCommitWorkResults
    // We'll test by checking what queryExec receives
    const { handleCommitWorkResults } = await import("../src/tools/pending-work.js");
    store.queryFirst.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE pending_work:test1") && sql.includes("RETURN BEFORE")) return [item];
      // K15 commit-ownership re-assert: handleCommitWorkResults now re-checks
      // ownership (SELECT id ... WHERE status = "committing" AND committing_token)
      // immediately before the non-idempotent commitResults writes. An empty
      // result aborts the commit ("ownership lost") before the soul_generate
      // case runs — so the mock must report this row as still owned.
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: "pending_work:test1" }];
      if (sql.includes("FROM soul:laqrumbrain") && !sql.includes("SELECT *")) return [];
      if (sql.includes("SELECT * FROM soul:laqrumbrain")) return [];
      if (sql.includes("graduation_event")) return [];
      // checkGraduation queries
      if (sql.includes("FROM concept") && sql.includes("count")) return [{ count: 500 }];
      if (sql.includes("FROM memory") && sql.includes("count")) return [{ count: 200 }];
      if (sql.includes("FROM turn") && sql.includes("count")) return [{ count: 100 }];
      if (sql.includes("FROM artifact") && sql.includes("count")) return [{ count: 50 }];
      if (sql.includes("FROM skill") && sql.includes("count")) return [{ count: 10 }];
      if (sql.includes("FROM reflection") && sql.includes("count")) return [{ count: 20 }];
      if (sql.includes("FROM monologue") && sql.includes("count")) return [{ count: 15 }];
      if (sql.includes("retrieval_outcome")) return [{ total: 100, good: 90 }];
      if (sql.includes("maturity_stage")) return [];
      return [];
    });

    await handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:test1",
      results: llmOutput,
    });

    // Find the CREATE soul:laqrumbrain call
    const createCall = store.queryExec.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE soul:laqrumbrain"),
    );
    expect(createCall).toBeDefined();

    const data = createCall![1].data;

    // earned_values should have exactly {value, grounded_in} — no name, evidence, description
    for (const ev of data.earned_values) {
      expect(Object.keys(ev).sort()).toEqual(["grounded_in", "value"]);
    }
    // First one mapped from aliases: name→value, evidence→grounded_in
    expect(data.earned_values[0].value).toBe("accuracy");
    expect(data.earned_values[0].grounded_in).toBe("caught 3 bugs");

    // emotional_dimensions should have exactly {dimension, description, adopted_at}
    for (const ed of data.emotional_dimensions) {
      expect(Object.keys(ed).sort()).toEqual(["adopted_at", "description", "dimension"]);
    }
  });

  it("filters out non-string entries from working_style and self_observations", async () => {
    const store = mockStore();
    const state = mockState(store);

    const llmOutput = {
      working_style: ["good", 42, null, "also good"],
      emotional_dimensions: [],
      self_observations: ["valid", { nested: true }, "also valid"],
      earned_values: [],
    };

    const item = { id: "pending_work:test2", work_type: "soul_generate", session_id: "s1" } as any;
    const { handleCommitWorkResults } = await import("../src/tools/pending-work.js");
    store.queryFirst.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE pending_work:test2") && sql.includes("RETURN BEFORE")) return [item];
      // K15 commit-ownership re-assert (see test1) — report this row as owned
      // so the commit reaches the soul_generate sanitization path.
      if (sql.includes('status = "committing"') && sql.includes("committing_token")) return [{ id: "pending_work:test2" }];
      if (sql.includes("FROM soul:laqrumbrain")) return [];
      if (sql.includes("graduation_event")) return [];
      if (sql.includes("count")) return [{ count: 500 }];
      if (sql.includes("retrieval_outcome")) return [{ total: 100, good: 90 }];
      if (sql.includes("maturity_stage")) return [];
      return [];
    });

    await handleCommitWorkResults(state, {} as any, {
      work_id: "pending_work:test2",
      results: llmOutput,
    });

    const createCall = store.queryExec.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE soul:laqrumbrain"),
    );
    expect(createCall).toBeDefined();

    const data = createCall![1].data;
    expect(data.working_style).toEqual(["good", "also good"]);
    expect(data.self_observations).toEqual(["valid", "also valid"]);
  });
});
