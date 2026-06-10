/**
 * Tests for memory-daemon.ts — extraction pipeline that writes 9 knowledge
 * types to the graph: causal, monologue, resolved, concepts, corrections,
 * preferences, artifacts, decisions, skills.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  writeExtractionResults,
  type ExtractionCounts,
} from "../src/engine/memory-daemon.js";
import type { PriorExtractions } from "../src/engine/daemon-types.js";

// ── Mock helpers ──

function mockStore() {
  return {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql?: string) => {
      // v0.7.81: commitKnowledge auto-seal helpers (linkToProject,
      // linkToRelevantConcepts) do SELECT-before-RELATE dedup pre-checks.
      // Return [] for those so the relate path executes — otherwise the
      // mock's default truthy return would short-circuit auto-seals and
      // existing assertions about store.relate calls would silently fail.
      if (typeof sql === "string" && /SELECT\s+id\s+FROM\s+(relevant_to|used_in|skill_uses_concept|about_concept|artifact_mentions|mentions)\b/i.test(sql)) {
        return [];
      }
      return [{ id: "skill:new1" }];
    }),
    queryExec: vi.fn(async () => {}),
    upsertConcept: vi.fn(async () => ({ id: "concept:c1", existed: false })),
    createMemory: vi.fn(async () => "memory:m1"),
    createMonologue: vi.fn(async () => "monologue:m1"),
    createArtifact: vi.fn(async () => ({ id: "artifact:a1", existed: false })),
    clearReflectionCache: vi.fn(() => {}),
    relate: vi.fn(async () => true),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as any;
}

function emptyPrior(): PriorExtractions {
  return { conceptNames: [], artifactPaths: [], skillNames: [] };
}

// ── writeExtractionResults ──

describe("writeExtractionResults", () => {
  let store: ReturnType<typeof mockStore>;
  let embeddings: ReturnType<typeof mockEmbeddings>;

  beforeEach(() => {
    store = mockStore();
    embeddings = mockEmbeddings();
  });

  it("returns zero counts for empty extraction", async () => {
    const counts = await writeExtractionResults(
      { causal: [], monologue: [], resolved: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [] },
      "session:s1", store, embeddings, emptyPrior(),
    );
    expect(counts.causal).toBe(0);
    expect(counts.concept).toBe(0);
    expect(counts.correction).toBe(0);
  });

  it("extracts concepts and embeds them", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
        concepts: [
          { name: "React hooks", content: "useEffect runs after render", category: "technical", importance: 7 },
          { name: "TypeScript generics", content: "Generics enable reusable typed components", category: "technical", importance: 6 },
        ],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.concept).toBe(2);
    expect(store.upsertConcept).toHaveBeenCalledTimes(2);
    expect(embeddings.embed).toHaveBeenCalled();
  });

  it("deduplicates concepts against prior extractions", async () => {
    const prior = emptyPrior();
    prior.conceptNames.push("React hooks");

    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
        concepts: [
          { name: "React hooks", content: "duplicate — should skip", category: "technical", importance: 7 },
          { name: "New concept", content: "this is new", category: "technical", importance: 5 },
        ],
      },
      "session:s1", store, embeddings, prior,
    );

    expect(counts.concept).toBe(1); // only "New concept"
    expect(store.upsertConcept).toHaveBeenCalledTimes(1);
  });

  it("caps concepts at 11 per batch", async () => {
    const concepts = Array.from({ length: 20 }, (_, i) => ({
      name: `concept-${i}`, content: `content ${i}`, category: "technical", importance: 5,
    }));

    const counts = await writeExtractionResults(
      { causal: [], monologue: [], resolved: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [], concepts },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.concept).toBe(11);
  });

  it("extracts corrections as high-importance memories", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], preferences: [], artifacts: [], decisions: [], skills: [],
        corrections: [
          { original: "used var", correction: "use const", context: "variable declarations" },
        ],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.correction).toBe(1);
    expect(store.createMemory).toHaveBeenCalledWith(
      expect.stringContaining("[CORRECTION]"),
      expect.any(Array), // embedding
      9, // importance = 9 (highest for corrections)
      "correction",
      "session:s1",
      undefined,
    );
  });

  it("extracts monologue traces", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], resolved: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
        monologue: [
          { category: "insight", content: "The bug was caused by a race condition" },
          { category: "doubt", content: "Not sure if this approach scales" },
        ],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.monologue).toBe(2);
    expect(store.createMonologue).toHaveBeenCalledTimes(2);
  });

  it("caps monologue at 5 per batch", async () => {
    const monologue = Array.from({ length: 10 }, (_, i) => ({
      category: "insight", content: `thought ${i}`,
    }));

    const counts = await writeExtractionResults(
      { causal: [], resolved: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [], monologue },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.monologue).toBe(5);
  });

  it("resolves memories by marking status in DB", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
        resolved: ["memory:abc123", "memory:def456"],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.resolved).toBe(2);
    expect(store.queryExec).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid memory IDs in resolved array", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
        resolved: ["memory:valid1", "not-a-record-id", "'; DROP TABLE --", "memory:valid2"],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    // Only the two valid memory:xxx IDs should be resolved
    expect(counts.resolved).toBe(2);
  });

  it("extracts preferences as memories", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [], artifacts: [], decisions: [], skills: [],
        preferences: [
          { preference: "prefers concise responses", evidence: "asked me to be brief" },
        ],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.preference).toBe(1);
    expect(store.createMemory).toHaveBeenCalledWith(
      expect.stringContaining("[USER PREFERENCE]"),
      expect.any(Array),
      7, // importance
      "preference",
      "session:s1",
      undefined,
    );
  });

  it("extracts artifacts and deduplicates against prior", async () => {
    const prior = emptyPrior();
    prior.artifactPaths.push("/src/old.ts");

    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [], preferences: [], decisions: [], skills: [],
        artifacts: [
          { path: "/src/old.ts", action: "modified", summary: "should skip" },
          { path: "/src/new.ts", action: "created", summary: "new file" },
        ],
      },
      "session:s1", store, embeddings, prior,
    );

    expect(counts.artifact).toBe(1); // only new.ts
    expect(store.createArtifact).toHaveBeenCalledTimes(1);
  });

  it("links artifacts to project via used_in edge", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [], preferences: [], decisions: [], skills: [],
        artifacts: [{ path: "/src/foo.ts", action: "created", summary: "new" }],
      },
      "session:s1", store, embeddings, emptyPrior(), "task:t1", "project:p1",
    );

    expect(counts.artifact).toBe(1);
    expect(store.relate).toHaveBeenCalledWith("artifact:a1", "used_in", "project:p1");
  });

  it("extracts decisions as memories", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [], preferences: [], artifacts: [], skills: [],
        decisions: [
          { decision: "Use SurrealDB over Postgres", rationale: "Graph queries are native", alternatives_considered: "Postgres, Neo4j" },
        ],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.decision).toBe(1);
    expect(store.createMemory).toHaveBeenCalledWith(
      expect.stringContaining("[DECISION]"),
      expect.any(Array),
      7,
      "decision",
      "session:s1",
      undefined,
    );
  });

  it("extracts skills and creates DB records with edges", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [],
        skills: [
          { name: "Debug test failure", steps: ["Run test", "Read error", "Fix code", "Rerun"], trigger_context: "failing tests" },
        ],
      },
      "session:s1", store, embeddings, emptyPrior(), "task:t1",
    );

    expect(counts.skill).toBe(1);
    expect(store.queryFirst).toHaveBeenCalledWith(
      expect.stringContaining("CREATE skill"),
      expect.objectContaining({
        record: expect.objectContaining({
          name: "Debug test failure",
          steps: ["Run test", "Read error", "Fix code", "Rerun"],
        }),
      }),
    );
    // skill_from_task edge
    expect(store.relate).toHaveBeenCalledWith(expect.stringContaining("skill"), "skill_from_task", "task:t1");
  });

  it("deduplicates skills against prior extractions", async () => {
    const prior = emptyPrior();
    prior.skillNames.push("Debug test failure");

    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [], preferences: [], artifacts: [], decisions: [],
        skills: [
          { name: "Debug test failure", steps: ["step"], trigger_context: "tests" },
          { name: "Deploy to prod", steps: ["build", "push"], trigger_context: "deployment" },
        ],
      },
      "session:s1", store, embeddings, prior,
    );

    expect(counts.skill).toBe(1); // only "Deploy to prod"
  });

  it("handles all 9 types in a single extraction", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [{ triggerText: "bug", outcomeText: "fix", chainType: "fix", success: true, confidence: 0.8, description: "fixed it" }],
        monologue: [{ category: "insight", content: "learned something" }],
        resolved: ["memory:old1"],
        concepts: [{ name: "Testing", content: "tests are good", category: "procedural", importance: 6 }],
        corrections: [{ original: "wrong", correction: "right", context: "code review" }],
        preferences: [{ preference: "concise", evidence: "said so" }],
        artifacts: [{ path: "/src/foo.ts", action: "created", summary: "new file" }],
        decisions: [{ decision: "use vitest", rationale: "fast", alternatives_considered: "jest" }],
        skills: [{ name: "TDD", steps: ["write test", "implement", "refactor"], trigger_context: "new feature" }],
      },
      "session:s1", store, embeddings, emptyPrior(), "task:t1", "project:p1",
    );

    expect(counts.causal).toBe(1);
    expect(counts.monologue).toBe(1);
    expect(counts.resolved).toBe(1);
    expect(counts.concept).toBe(1);
    expect(counts.correction).toBe(1);
    expect(counts.preference).toBe(1);
    expect(counts.artifact).toBe(1);
    expect(counts.decision).toBe(1);
    expect(counts.skill).toBe(1);
  });

  it("works when embeddings are unavailable", async () => {
    embeddings = mockEmbeddings(false);

    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], corrections: [], preferences: [], artifacts: [], decisions: [], skills: [],
        concepts: [{ name: "test", content: "works without embeddings", category: "technical", importance: 5 }],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.concept).toBe(1);
    expect(embeddings.embed).not.toHaveBeenCalled();
    // upsertConcept called with null embedding
    expect(store.upsertConcept).toHaveBeenCalledWith(
      "works without embeddings", null, "daemon:session:s1", undefined, undefined,
    );
  });

  it("skips malformed entries (missing required fields)", async () => {
    const counts = await writeExtractionResults(
      {
        causal: [{ triggerText: "only trigger, no outcome" }], // missing outcomeText, chainType, success
        monologue: [{ category: "insight" }], // missing content
        concepts: [{ name: "no content" }], // missing content
        corrections: [{ original: "only original" }], // missing correction
        preferences: [{}], // missing preference
        artifacts: [{}], // missing path
        decisions: [{}], // missing decision
        skills: [{ name: "no steps" }], // missing steps array
        resolved: [],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    // All should be 0 because required fields are missing
    expect(counts.causal).toBe(0);
    expect(counts.monologue).toBe(0);
    expect(counts.concept).toBe(0);
    expect(counts.correction).toBe(0);
    expect(counts.preference).toBe(0);
    expect(counts.artifact).toBe(0);
    expect(counts.decision).toBe(0);
    expect(counts.skill).toBe(0);
  });

  it("calls supersedeOldSkills after creating a skill with embedding", async () => {
    store = mockStore();
    embeddings = mockEmbeddings(true);
    store.queryFirst.mockResolvedValue([{ id: "skill:new1" }]);

    const counts = await writeExtractionResults(
      {
        causal: [], monologue: [], resolved: [], concepts: [], corrections: [],
        preferences: [], artifacts: [], decisions: [],
        skills: [{ name: "Deploy flow", steps: ["build", "push", "verify"], trigger_context: "when deploying" }],
      },
      "session:s1", store, embeddings, emptyPrior(),
    );

    expect(counts.skill).toBe(1);
    // queryFirst now: creation-dedup pre-check (cosine), CREATE skill,
    // linkToRelevantConcepts, supersedeOldSkills (cosine). Match the supersede
    // query specifically — it has `name =`, which the creation-dedup pre-check
    // does not — so only it is counted.
    const supersedeCalls = store.queryFirst.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("vector::similarity::cosine") && c[0].includes("name =")
    );
    expect(supersedeCalls).toHaveLength(1);
  });
});
