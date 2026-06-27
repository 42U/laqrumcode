import { describe, it, expect } from "vitest";
import { extractFtsTerms } from "../src/engine/surreal.js";

// Unit coverage for the lexical (BM25) arm's query-keyword extraction. The
// fulltextSearch() method itself is validated live against the real *_fts_idx
// indexes (it hardcodes the content tables, so it has no standalone unit form).
describe("extractFtsTerms", () => {
  it("lowercases, strips punctuation, drops stopwords + short words", () => {
    expect(extractFtsTerms("How does the BGE-M3 reranker work?")).toEqual(["bge-m3", "reranker", "work"]);
  });

  it("keeps hyphenated identifiers (code-ish tokens)", () => {
    expect(extractFtsTerms("the cross-encoder")).toEqual(["cross-encoder"]);
  });

  it("caps at 6 terms (bounds the per-term OR query + match-refs)", () => {
    expect(extractFtsTerms("alpha beta gamma delta epsilon zeta eta theta").length).toBe(6);
  });

  it("returns empty for all-stopword / all-short input", () => {
    expect(extractFtsTerms("is it on the to do")).toEqual([]);
  });

  it("drops short tokens (<=2 chars)", () => {
    expect(extractFtsTerms("ab cd surrealdb")).toEqual(["surrealdb"]);
  });
});
