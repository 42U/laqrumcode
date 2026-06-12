/**
 * 0.7.121 (QA E1 regression): getCachedContext must return CLONED result
 * rows. Downstream (mergeAccessDeltas) mutates accessCount in place before
 * scoring — handing out references to the cached objects let every cache hit
 * re-fold a growing access delta into the SAME rows, compounding accessCount
 * quadratically within the cache TTL and skewing WMR/ACAN.
 */
import { describe, it, expect } from "vitest";
import { setCachedContext, getCachedContext } from "../src/engine/prefetch.js";
import type { VectorSearchResult } from "../src/engine/surreal.js";

describe("prefetch cache clone-on-read (QA-0.7.121 E1)", () => {
  it("mutating a cache hit's rows does not contaminate later hits", () => {
    const vec = Array.from({ length: 1024 }, () => 0.25);
    const rows = [
      { id: "concept:x", text: "x", accessCount: 3, score: 0.9, table: "concept" } as unknown as VectorSearchResult,
    ];
    setCachedContext(vec, rows, [], [], "sess-clone", "");

    const hit1 = getCachedContext(vec, "sess-clone", undefined);
    expect(hit1).not.toBeNull();
    // Simulate mergeAccessDeltas folding a delta into the first hit.
    (hit1!.results[0] as { accessCount?: number }).accessCount = 99;

    const hit2 = getCachedContext(vec, "sess-clone", undefined);
    expect(hit2).not.toBeNull();
    expect((hit2!.results[0] as { accessCount?: number }).accessCount).toBe(3); // not 99 — no shared reference
    // And the rows handed back are not the cached objects themselves.
    expect(hit2!.results[0]).not.toBe(hit1!.results[0]);
  });
});
