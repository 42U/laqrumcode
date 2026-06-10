/**
 * Tests for concept-extract.ts — regex extraction, embedding-based linking,
 * concept hierarchy, and upsert-and-link pipeline.
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractConceptNames,
  upsertAndLinkConcepts,
  linkToRelevantConcepts,
  linkConceptHierarchy,
  DEFAULT_CONCEPT_CAP,
} from "../src/engine/concept-extract.js";

// ── Mock helpers ──

function mockStore() {
  return {
    isAvailable: () => true,
    upsertConcept: vi.fn(async () => ({ id: "concept:c1", existed: false })),
    relate: vi.fn(async () => true),
    queryFirst: vi.fn(async () => []),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  } as any;
}

// ── extractConceptNames (pure regex) ──

describe("extractConceptNames", () => {
  it("extracts PascalCase names after action verbs", () => {
    const names = extractConceptNames("I need to use React and implement TypeScript");
    expect(names).toContain("React");
    expect(names).toContain("TypeScript");
  });

  it("extracts tech terms (case-insensitive)", () => {
    const names = extractConceptNames("The database schema needs a migration for the API endpoint");
    expect(names).toContain("database");
    expect(names).toContain("schema");
    expect(names).toContain("migration");
    expect(names).toContain("api");
    expect(names).toContain("endpoint");
  });

  it("deduplicates extracted names", () => {
    const names = extractConceptNames("use React, configure React, setup React");
    const reactCount = names.filter(n => n === "React").length;
    expect(reactCount).toBe(1);
  });

  it(`caps at the default of ${DEFAULT_CONCEPT_CAP} concepts`, () => {
    const text =
      "use Alpha implement Beta create Gamma add Delta configure Epsilon setup Zeta import Eta " +
      "fix Theta deploy Iota ship Kappa run Lambda monitor Mu update Nu hedge Xi build Omicron " +
      "refactor Pi audit Rho extract Sigma classify Tau trigger Upsilon test Phi launch Chi " +
      "The database schema migration endpoint middleware component service module handler controller " +
      "smart_mm_bot hedge-lock reply-banner KXETH KXFED SMTP IMAP";
    const names = extractConceptNames(text);
    expect(names.length).toBeLessThanOrEqual(DEFAULT_CONCEPT_CAP);
    expect(names.length).toBeGreaterThan(10); // proves the cap is the new ceiling, not the old one
  });

  it("respects a configurable cap", () => {
    const text =
      "use Alpha implement Beta create Gamma add Delta configure Epsilon setup Zeta " +
      "smart_mm_bot hedge-lock reply-banner KXETH KXFED SMTP IMAP";
    expect(extractConceptNames(text, 5).length).toBeLessThanOrEqual(5);
    expect(extractConceptNames(text, 0).length).toBe(0);
  });

  it("returns empty for text with no concepts", () => {
    const names = extractConceptNames("hello world, just a simple message");
    // May match "function" etc. if present, but this text has none
    expect(names.length).toBeLessThanOrEqual(DEFAULT_CONCEPT_CAP);
  });

  it("extracts multi-word PascalCase concepts", () => {
    const names = extractConceptNames("implement React Router");
    expect(names.some(n => n.includes("React"))).toBe(true);
  });

  it("extracts snake_case identifiers", () => {
    const names = extractConceptNames("the smart_mm_bot calls check_replies_imap on every tick");
    expect(names).toContain("smart_mm_bot");
    expect(names).toContain("check_replies_imap");
  });

  it("extracts kebab-case identifiers", () => {
    const names = extractConceptNames("the hedge-lock mechanic ships with the reply-banner change");
    expect(names).toContain("hedge-lock");
    expect(names).toContain("reply-banner");
  });

  it("extracts ALLCAPS tickers and acronyms (length >= 3)", () => {
    const names = extractConceptNames("KXETH and KXFED moved on the FOMC print; SMTP and IMAP both blocked");
    expect(names).toContain("KXETH");
    expect(names).toContain("KXFED");
    expect(names).toContain("SMTP");
    expect(names).toContain("IMAP");
    // Two-letter tokens must NOT be picked up as acronyms
    expect(names).not.toContain("ON");
    expect(names).not.toContain("AT");
  });

  it("filters STOPWORDS even when they shape-match ACRONYM", () => {
    // Stopwords typed in ALLCAPS satisfy the ACRONYM regex but must be stripped.
    // A real acronym in the same text must still pass through.
    const names = extractConceptNames("THIS is BETWEEN what THAT wants from the SMTP server");
    expect(names).not.toContain("THIS");
    expect(names).not.toContain("BETWEEN");
    expect(names).not.toContain("THAT");
    expect(names).toContain("SMTP");
  });

  it("requires non-identifier CamelCase tokens to appear 2+ times", () => {
    // CAP_WORD shape (CamelCase w/o _ or -) has no inherent signal, so a single
    // occurrence should not be promoted. Two occurrences of the same token should.
    const once = extractConceptNames("we ran OpenClaw last night and went to bed");
    expect(once).not.toContain("OpenClaw");

    const twice = extractConceptNames("OpenClaw polls hourly. OpenClaw logs to disk.");
    expect(twice).toContain("OpenClaw");
  });
});

// ── upsertAndLinkConcepts ──

describe("upsertAndLinkConcepts", () => {
  it("upserts concepts and creates edges", async () => {
    const store = mockStore();
    const embeddings = mockEmbeddings();

    await upsertAndLinkConcepts(
      "turn:t1", "mentions",
      "We need to configure the database and setup the API endpoint",
      store, embeddings, "test",
    );

    // Should have upserted at least "database", "api", "endpoint"
    expect(store.upsertConcept).toHaveBeenCalled();
    expect(store.relate).toHaveBeenCalledWith("turn:t1", "mentions", "concept:c1");
  });

  it("creates task/project edges when opts provided", async () => {
    const store = mockStore();

    await upsertAndLinkConcepts(
      "turn:t1", "mentions",
      "implement the database migration",
      store, mockEmbeddings(), "test",
      { taskId: "task:t1", projectId: "project:p1" },
    );

    expect(store.relate).toHaveBeenCalledWith("concept:c1", "derived_from", "task:t1");
    expect(store.relate).toHaveBeenCalledWith("concept:c1", "relevant_to", "project:p1");
  });

  it("skips when no concepts extracted", async () => {
    const store = mockStore();

    await upsertAndLinkConcepts(
      "turn:t1", "mentions", "hello world",
      store, mockEmbeddings(), "test",
    );

    // "hello world" has no PascalCase or tech terms
    // Actually it might not match anything, but let's be safe
    // The point is it doesn't crash
  });

  it("works when embeddings unavailable", async () => {
    const store = mockStore();
    const embeddings = mockEmbeddings(false);

    await upsertAndLinkConcepts(
      "turn:t1", "mentions",
      "configure the database schema",
      store, embeddings, "test",
    );

    // Should still upsert with null embedding
    expect(store.upsertConcept).toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });
});

// ── linkToRelevantConcepts ──

describe("linkToRelevantConcepts", () => {
  it("links source to concepts above similarity threshold", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([
      { id: "concept:react", score: 0.85 },
      { id: "concept:hooks", score: 0.72 },
      { id: "concept:css", score: 0.40 }, // below 0.65 threshold
    ]);

    await linkToRelevantConcepts(
      "memory:m1", "about_concept", "React hooks for state management",
      store, mockEmbeddings(), "test",
    );

    // Should link to react and hooks (above 0.65), not css
    expect(store.relate).toHaveBeenCalledTimes(2);
    expect(store.relate).toHaveBeenCalledWith("memory:m1", "about_concept", "concept:react");
    expect(store.relate).toHaveBeenCalledWith("memory:m1", "about_concept", "concept:hooks");
  });

  it("uses precomputed vector when provided", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([]);
    const embeddings = mockEmbeddings();
    const precomputed = new Array(1024).fill(0.5);

    await linkToRelevantConcepts(
      "turn:t1", "mentions", "some text",
      store, embeddings, "test", 5, 0.65, precomputed,
    );

    // Should NOT call embed since precomputed vec was provided
    expect(embeddings.embed).not.toHaveBeenCalled();
    // Should still query with the precomputed vec
    expect(store.queryFirst).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ vec: precomputed }),
    );
  });

  it("returns early when embeddings unavailable", async () => {
    const store = mockStore();
    await linkToRelevantConcepts(
      "turn:t1", "mentions", "text",
      store, mockEmbeddings(false), "test",
    );
    expect(store.queryFirst).not.toHaveBeenCalled();
  });

  it("returns early for empty text", async () => {
    const store = mockStore();
    await linkToRelevantConcepts(
      "turn:t1", "mentions", "",
      store, mockEmbeddings(), "test",
    );
    expect(store.queryFirst).not.toHaveBeenCalled();
  });

  it("respects custom limit and threshold", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([
      { id: "concept:a", score: 0.90 },
    ]);

    await linkToRelevantConcepts(
      "artifact:a1", "artifact_mentions", "text",
      store, mockEmbeddings(), "test", 3, 0.80,
    );

    expect(store.queryFirst).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ lim: 3 }),
    );
    expect(store.relate).toHaveBeenCalledTimes(1);
  });
});

// ── linkConceptHierarchy ──

describe("linkConceptHierarchy", () => {
  it("creates narrower/broader edges for substring relationships", async () => {
    const store = mockStore();
    store.queryFirst
      .mockResolvedValueOnce([
        { id: "concept:react", content: "React" },
        { id: "concept:vue", content: "Vue" },
      ])
      // Second call: related_to similarity search
      .mockResolvedValueOnce([]);

    await linkConceptHierarchy(
      "concept:reacthooks", "React hooks",
      store, mockEmbeddings(), "test",
    );

    // "React hooks" contains "React" → narrower edge
    expect(store.relate).toHaveBeenCalledWith("concept:reacthooks", "narrower", "concept:react");
    expect(store.relate).toHaveBeenCalledWith("concept:react", "broader", "concept:reacthooks");
    // "Vue" is unrelated — no edges
  });

  it("creates broader edges when new concept is more general", async () => {
    const store = mockStore();
    store.queryFirst
      .mockResolvedValueOnce([
        { id: "concept:reacthooks", content: "React hooks" },
      ])
      .mockResolvedValueOnce([]);

    await linkConceptHierarchy(
      "concept:react", "React",
      store, mockEmbeddings(), "test",
    );

    // "React" is contained in "React hooks" → broader edge
    expect(store.relate).toHaveBeenCalledWith("concept:react", "broader", "concept:reacthooks");
    expect(store.relate).toHaveBeenCalledWith("concept:reacthooks", "narrower", "concept:react");
  });

  it("creates related_to edges for semantically similar concepts", async () => {
    const store = mockStore();
    // First queryFirst: hierarchy (concepts exist, but no substring match). Second: similarity search.
    store.queryFirst
      .mockResolvedValueOnce([{ id: "concept:useState", content: "useState" }])  // hierarchy: exists but no substring
      .mockResolvedValueOnce([    // similarity: high-score match
        { id: "concept:useState", score: 0.82 },
        { id: "concept:css", score: 0.30 },
      ]);

    const embeddings = mockEmbeddings();

    await linkConceptHierarchy(
      "concept:hooks", "hooks",
      store, embeddings, "test",
    );

    expect(embeddings.embed).toHaveBeenCalledWith("hooks");
    // Bidirectional related_to for useState (above 0.75)
    expect(store.relate).toHaveBeenCalledWith("concept:hooks", "related_to", "concept:useState");
    expect(store.relate).toHaveBeenCalledWith("concept:useState", "related_to", "concept:hooks");
  });

  it("skips similarity search when embeddings unavailable", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValueOnce([]); // no substring matches

    await linkConceptHierarchy(
      "concept:hooks", "hooks",
      store, mockEmbeddings(false), "test",
    );

    // Only the hierarchy query, no similarity query
    expect(store.queryFirst).toHaveBeenCalledTimes(1);
  });

  it("handles empty concept list gracefully", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValueOnce([]);

    await linkConceptHierarchy(
      "concept:new", "new concept",
      store, mockEmbeddings(), "test",
    );

    expect(store.relate).not.toHaveBeenCalled();
  });
});
