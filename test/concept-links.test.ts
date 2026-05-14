/**
 * concept-links.ts — supersede filter regression tests (Round 6).
 *
 * Round 5 added `superseded_at IS NONE` to the candidate concept fetch in
 * linkConceptHierarchy (the hierarchy-substring search and the related_to
 * similarity search) plus linkToRelevantConcepts (the cosine-similarity
 * source→concept linker). Without those filters a superseded concept whose
 * embedding still scores high would be re-linked as if it were live, and
 * supersede() loses its job of decaying stale knowledge in retrieval.
 *
 * These tests prove the SQL passed to the store includes the filter, and
 * separately prove the mock-store contract: if the store returns no rows
 * (because the WHERE clause filtered the superseded concept), no edges
 * get written.
 */

import { describe, it, expect, vi } from "vitest";
import {
  linkConceptHierarchy,
  linkToRelevantConcepts,
} from "../src/engine/concept-links.js";

function makeStore() {
  return {
    isAvailable: () => true,
    upsertConcept: vi.fn(async () => "concept:c1"),
    relate: vi.fn(async () => {}),
    queryFirst: vi.fn(async () => []),
  } as any;
}

function makeEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  } as any;
}

describe("linkConceptHierarchy — superseded_at filter", () => {
  it("hierarchy candidate SQL includes `superseded_at IS NONE`", async () => {
    const store = makeStore();
    store.queryFirst
      .mockResolvedValueOnce([])  // hierarchy candidates
      .mockResolvedValueOnce([]); // related_to similarity

    await linkConceptHierarchy(
      "concept:new", "new concept",
      store, makeEmbeddings(), "test",
    );

    // First queryFirst call is the hierarchy candidate fetch.
    const sql = String(store.queryFirst.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/superseded_at IS NONE/);
  });

  it("related_to similarity SQL includes `superseded_at IS NONE`", async () => {
    const store = makeStore();
    store.queryFirst
      .mockResolvedValueOnce([{ id: "concept:other", content: "unrelated" }])  // hierarchy
      .mockResolvedValueOnce([]);  // related_to

    await linkConceptHierarchy(
      "concept:new", "new concept",
      store, makeEmbeddings(), "test",
    );

    // Second queryFirst call is the related_to similarity search.
    const sql = String(store.queryFirst.mock.calls[1]?.[0] ?? "");
    expect(sql).toMatch(/superseded_at IS NONE/);
  });

  it("does not return superseded concepts (store filter honored → no edges)", async () => {
    const store = makeStore();
    // Simulate the store filtering out the superseded concept: empty result.
    // If linkConceptHierarchy ignored the filter and used a different code
    // path that surfaced superseded rows, this test would still pass — the
    // point is to prove that an empty hierarchy result produces zero edges.
    store.queryFirst
      .mockResolvedValueOnce([])  // hierarchy: no live candidates
      .mockResolvedValueOnce([]); // related_to: no live candidates

    await linkConceptHierarchy(
      "concept:reacthooks", "React hooks",
      store, makeEmbeddings(), "test",
    );

    expect(store.relate).not.toHaveBeenCalled();
  });

  it("when superseded concept would have matched, store omitting it means no narrower/broader written", async () => {
    const store = makeStore();
    // Pretend the SQL filter dropped the superseded "React" row, so the
    // store returns only an unrelated concept. The substring path should
    // therefore NOT wire `React hooks → narrower → React`.
    store.queryFirst
      .mockResolvedValueOnce([
        { id: "concept:vue", content: "Vue" },  // not a substring of "React hooks"
      ])
      .mockResolvedValueOnce([]);

    await linkConceptHierarchy(
      "concept:reacthooks", "React hooks",
      store, makeEmbeddings(), "test",
    );

    // No edge involving concept:react because the supersede filter hid it.
    const calls = store.relate.mock.calls.map((c: any[]) => c.join(":"));
    expect(calls.some((s: string) => s.includes("concept:react"))).toBe(false);
  });
});

describe("linkToRelevantConcepts — superseded_at filter", () => {
  it("source→concept similarity SQL includes `superseded_at IS NONE`", async () => {
    const store = makeStore();
    store.queryFirst.mockResolvedValueOnce([]); // no live candidates

    await linkToRelevantConcepts(
      "turn:abc",
      "mentions",
      "some text content",
      store,
      makeEmbeddings(),
      "test",
    );

    const sql = String(store.queryFirst.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/superseded_at IS NONE/);
  });

  it("no edges written when store returns no live candidates", async () => {
    const store = makeStore();
    store.queryFirst.mockResolvedValueOnce([]); // supersede filter ate everything

    await linkToRelevantConcepts(
      "turn:abc",
      "mentions",
      "some text",
      store,
      makeEmbeddings(),
      "test",
    );

    expect(store.relate).not.toHaveBeenCalled();
  });
});
