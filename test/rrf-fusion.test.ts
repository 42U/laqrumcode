import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../src/engine/graph-context.js";

describe("reciprocalRankFusion", () => {
  it("ranks items appearing high in multiple lists above single-list items", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "a", "d"]]);
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    // a and c appear in BOTH lists -> they outrank b (only list1) and d (only list2)
    expect(order.slice(0, 2).sort()).toEqual(["a", "c"]);
    expect(order[0]).toBe("a"); // a ranks 1+2 vs c's 3+1 -> a slightly higher overall
    expect(fused.get("a")!).toBeGreaterThan(fused.get("b")!);
    expect(fused.get("c")!).toBeGreaterThan(fused.get("d")!);
  });

  it("uses the standard k=60 constant: a rank-1 item scores 1/61", () => {
    expect(reciprocalRankFusion([["x"]]).get("x")!).toBeCloseTo(1 / 61, 6);
  });

  it("accumulates across lists for a shared id", () => {
    expect(reciprocalRankFusion([["x"], ["x"]]).get("x")!).toBeCloseTo(2 / 61, 6);
  });

  it("returns an empty map for no lists", () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });
});
