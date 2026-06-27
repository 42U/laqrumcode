import { describe, it, expect } from "vitest";
import { mmrReorder } from "../src/engine/graph-context.js";
import type { ScoredResult } from "../src/engine/graph-context.js";

// Minimal ScoredResult factory — mmrReorder only reads id/finalScore/embedding.
function item(id: string, finalScore: number, embedding: number[]): ScoredResult {
  return { id, table: "concept", text: id, finalScore, embedding } as unknown as ScoredResult;
}

describe("mmrReorder (MMR diversification)", () => {
  it("promotes a diverse lower-scored item above a redundant higher-scored one", () => {
    const A = item("a", 0.9, [0, 1, 0, 0]);   // anchor
    const B = item("b", 0.85, [0, 1, 0, 0]);  // ~identical to A (cosine 1) -> redundant
    const C = item("c", 0.7, [1, 0, 0, 0]);   // orthogonal to A (cosine 0) -> diverse
    // Greedy-by-score order is A, B, C. MMR(λ=0.7) after picking A:
    //   B: 0.7*0.85 - 0.3*1 = 0.295 ; C: 0.7*0.7 - 0.3*0 = 0.49  -> C wins.
    const out = mmrReorder([A, B, C], 0.7).map((r) => r.id);
    expect(out).toEqual(["a", "c", "b"]);
  });

  it("leaves <=2 eligible items unchanged", () => {
    const A = item("a", 0.9, [1, 0]);
    const B = item("b", 0.8, [0, 1]);
    expect(mmrReorder([A, B], 0.7).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps below-floor items after the diversified eligible set (floor-break stays correct)", () => {
    const A = item("a", 0.9, [0, 1, 0]);
    const B = item("b", 0.85, [0, 1, 0]);   // redundant with A
    const C = item("c", 0.7, [1, 0, 0]);    // diverse
    const low = item("low", 0.1, [0, 0, 1]); // below MIN_RELEVANCE_SCORE (0.30)
    const out = mmrReorder([A, B, C, low], 0.7).map((r) => r.id);
    expect(out).toEqual(["a", "c", "b", "low"]);
  });

  it("with λ=1 (pure relevance) preserves score order", () => {
    const A = item("a", 0.9, [0, 1, 0, 0]);
    const B = item("b", 0.85, [0, 1, 0, 0]);
    const C = item("c", 0.7, [1, 0, 0, 0]);
    expect(mmrReorder([A, B, C], 1.0).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
