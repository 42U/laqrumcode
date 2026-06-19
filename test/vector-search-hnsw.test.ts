/**
 * Regression guard for the HNSW vector-search fix.
 *
 * The 2026-06 pre-1M audit found that EVERY vector search was a full linear
 * cosine scan — the 8 HNSW indexes were never used on reads (zero `<|K,EF|>`
 * KNN operators). That's ~26x slower and, fatally, O(n) in graph size (≈1.5s
 * per turn at ~13K rows, seconds at 1M). These assertions ensure the KNN path
 * stays in place and keeps its safety net.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const surreal = readFileSync(join(root, "src", "engine", "surreal.ts"), "utf-8");
const schema = readFileSync(join(root, "src", "engine", "schema.surql"), "utf-8");

describe("vector search uses HNSW (not full linear scans)", () => {
  it("the retrieval path uses the <|K,EF|> KNN operator", () => {
    expect(surreal.includes("<|")).toBe(true);
  });

  it("keeps a linear fallback if KNN fails (fresh-install index not yet built)", () => {
    expect(surreal).toContain("buildStmts(false)");
    expect(surreal).toContain("knn-fallback-to-linear");
  });

  it("turn_archive (largest vector table) has an HNSW index so it isn't scanned linearly", () => {
    expect(schema).toContain("turn_archive_vec_idx");
    expect(schema).toMatch(/turn_archive_vec_idx[\s\S]*HNSW/);
  });
});
