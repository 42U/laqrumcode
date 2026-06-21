/**
 * K51 regression — memory embedding backfill healed un-embedded rows with the
 * WRONG (full-text) embed target.
 *
 * BUG (pre-fix): commitMemory() embeds `embeddingText ?? text` at create time —
 * record-finding.ts passes the bare finding as `embeddingText` while storing the
 * prefixed/rationale-laden form in `text`:
 *     text:          "[CORRECTION] <finding>\nRationale: <why>"
 *     embeddingText: "<finding>"
 * so the create-time vector matches short keyword queries well. But if the
 * embedder was DOWN at create time, backfillMemoryEmbeddings() in
 * src/engine/maintenance.ts re-embedded `row.text` — the long prefixed form —
 * permanently degrading short-query match quality for any row healed via the
 * backfill path. The create path's intended embed target was never persisted,
 * so the heal could not reproduce it.
 *
 * FIX:
 *   1. Persist an optional `embedding_target` column on memory at create time
 *      (surreal.ts createMemory, fed by commit.ts commitMemory via
 *      data.embeddingText), and declare it in schema.surql (option<string>).
 *   2. backfillMemoryEmbeddings SELECTs `embedding_target` and embeds
 *      `embedding_target ?? text` so the heal path reproduces the create-time
 *      target. NONE → fall back to text (the common case), preserving
 *      backfill-coverage (the WHERE filter is unchanged — every un-embedded,
 *      non-archived, non-empty row is still selectable).
 *
 * Pure-static source assertions (no DB, no mock), mirroring
 * fix-k16-concept-backfill-content.test.ts and lint-backfill-coverage.test.ts.
 * Each assertion FAILS against the pre-fix body (`let target = row.text;` with
 * no embedding_target in the SELECT and no persist in createMemory).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const maintenanceSrc = readFileSync(new URL("../src/engine/maintenance.ts", import.meta.url), "utf8");
const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");
const commitSrc = readFileSync(new URL("../src/engine/commit.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");

/** Slice out a named async function body (generous window; these are small). */
function fnBody(s: string, decl: string): string {
  const start = s.indexOf(decl);
  expect(start, `${decl} not found`).toBeGreaterThan(-1);
  return s.slice(start, start + 4000);
}

describe("K51: memory backfill heals with the persisted embed target, not full text", () => {
  it("schema declares an optional embedding_target column on memory", () => {
    // option<string> so an un-embedded row can carry the short target through to
    // the heal path. Must be IF NOT EXISTS (file convention; UNIQUE-index dedup
    // rules N/A — this is a plain optional field, no index).
    expect(schemaSrc).toMatch(
      /DEFINE FIELD IF NOT EXISTS embedding_target ON memory TYPE option<string>/,
    );
  });

  describe("create path persists the embed target", () => {
    const createBody = fnBody(surrealSrc, "async createMemory(");

    it("createMemory accepts an embeddingTarget parameter", () => {
      expect(createBody).toMatch(/embeddingTarget\??\s*:\s*string/);
    });

    it("createMemory writes embedding_target onto the created row", () => {
      // The CONTENT record must receive embedding_target (only meaningful when
      // it diverges from text — but the column write must exist).
      expect(createBody).toMatch(/embedding_target\s*=\s*embeddingTarget/);
    });

    it("commitMemory forwards data.embeddingText as the persisted target", () => {
      const commitBody = fnBody(commitSrc, "async function commitMemory");
      // createMemory(...) call must pass data.embeddingText through. Pre-fix the
      // call ended at data.projectId with no embed-target argument.
      const call = commitBody.slice(
        commitBody.indexOf("store.createMemory("),
        commitBody.indexOf("store.createMemory(") + 400,
      );
      expect(call).toMatch(/data\.embeddingText/);
    });
  });

  describe("heal path uses the persisted target", () => {
    const backfillBody = fnBody(maintenanceSrc, "async function backfillMemoryEmbeddings");

    it("SELECTs embedding_target from memory", () => {
      const select = backfillBody.slice(
        backfillBody.search(/SELECT/i),
        backfillBody.search(/FROM\s+memory/i) + "FROM memory".length,
      );
      expect(select).toMatch(/embedding_target/i);
    });

    it("embed target falls back to text via embedding_target ?? text (NOT row.text alone)", () => {
      // Pre-fix: `let target = row.text;`. The fix must coalesce the persisted
      // target with text. We require an explicit `?? row.text` (or
      // `?? row?.text`) so the common NONE case still heals via text.
      expect(backfillBody).toMatch(/row\.embedding_target\s*\?\?\s*row\??\.?text/);
    });

    it("still embeds the resolved `target` (heal path intact)", () => {
      expect(backfillBody).toMatch(/embed\(\s*target\s*\)/);
    });

    it("WHERE filter is unchanged — backfill coverage preserved (gates on embedding/status/text, not embedding_target)", () => {
      // BACKFILL-COVERAGE invariant: a row missing embedding_target must STILL
      // be selectable. The WHERE must gate on the embedding emptiness + text
      // presence, and must NOT require embedding_target to be present.
      const where = backfillBody.slice(
        backfillBody.search(/WHERE/i),
        backfillBody.search(/LIMIT/i),
      );
      expect(where).toMatch(/embedding IS NONE OR array::len\(embedding\) = 0/i);
      expect(where).toMatch(/text\s+IS\s+NOT\s+NONE/i);
      expect(
        /embedding_target\s+IS\s+NOT\s+NONE/i.test(where),
        "WHERE must not require embedding_target — that would skip rows that have none",
      ).toBe(false);
    });
  });
});
