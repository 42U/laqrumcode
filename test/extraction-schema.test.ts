import { describe, it, expect } from "vitest";
import { validateExtraction, ExtractionResultSchema } from "../src/engine/daemon-types.js";
import { Value } from "@sinclair/typebox/value";

describe("ExtractionResultSchema", () => {
  it("validates a full valid extraction result", () => {
    const input = {
      causal: [{ triggerText: "file not found", outcomeText: "added fallback", chainType: "fix", success: true, confidence: 0.9, description: "quick fix" }],
      monologue: [{ category: "insight", content: "caching helps here" }],
      resolved: ["memory:abc123"],
      concepts: [{ name: "API rate limiting", content: "Rate limits are 100/min", category: "technical", importance: 7, searchTerms: ["rate limit configuration", "API throttling"] }],
      corrections: [{ original: "wrong path", correction: "right path", context: "file lookup" }],
      preferences: [{ preference: "user prefers terse output", evidence: "said 'stop summarizing'" }],
      artifacts: [{ path: "/src/index.ts", action: "modified", summary: "added export" }],
      decisions: [{ decision: "use Redis", rationale: "faster", alternatives_considered: "Memcached" }],
      skills: [{ name: "deploy", steps: ["build", "push", "tag"], trigger_context: "release time" }],
    };
    const { data, errors } = validateExtraction(input);
    expect(errors).toEqual([]);
    expect(data).toBeDefined();
  });

  it("accepts empty arrays for all fields", () => {
    const input = {
      causal: [], monologue: [], resolved: [], concepts: [],
      corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
    };
    const { errors } = validateExtraction(input);
    expect(errors).toEqual([]);
  });

  it("accepts missing optional fields (backward compat)", () => {
    const input = {
      concepts: [{ name: "test", content: "some content" }],
    };
    const { errors } = validateExtraction(input);
    expect(errors).toEqual([]);
  });

  it("accepts concepts without searchTerms (backward compat)", () => {
    const input = {
      concepts: [{ name: "old concept", content: "from before searchTerms existed", category: "technical", importance: 5 }],
    };
    const { errors } = validateExtraction(input);
    expect(errors).toEqual([]);
  });

  it("coerces string importance to number via Value.Convert", () => {
    const raw = { concepts: [{ name: "test", content: "content", importance: "7" }] };
    const converted = Value.Convert(ExtractionResultSchema, raw);
    const concept = (converted as any).concepts[0];
    expect(concept.importance).toBe(7);
  });

  it("coerces string boolean to boolean via Value.Convert", () => {
    const raw = { causal: [{ triggerText: "x", outcomeText: "y", chainType: "fix", success: "true", confidence: 0.5 }] };
    const converted = Value.Convert(ExtractionResultSchema, raw);
    const causal = (converted as any).causal[0];
    expect(causal.success).toBe(true);
  });

  it("reports errors for invalid items but does not throw", () => {
    const input = {
      concepts: [{ name: 123, content: null }],
    };
    const { errors } = validateExtraction(input);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("handles non-object input gracefully", () => {
    const { data, errors } = validateExtraction("not an object");
    expect(errors).toEqual(["Input is not an object"]);
    expect(data).toEqual({});
  });

  it("handles null input gracefully", () => {
    const { data, errors } = validateExtraction(null);
    expect(errors).toEqual(["Input is not an object"]);
    expect(data).toEqual({});
  });

  it("accepts handoff_note and reflection fields (coalesced)", () => {
    const input = {
      concepts: [],
      handoff_note: "Worked on auth refactor. JWT validation still needs tests.",
      reflection: "Good progress on the core logic. Should have written tests first.",
    };
    const { errors } = validateExtraction(input);
    expect(errors).toEqual([]);
  });
});
