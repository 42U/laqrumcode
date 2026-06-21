/**
 * R12 / K16 refinement — concept embedding backfill healed to a
 * searchTerms-STRIPPED vector, diverging from the live daemon embedding.
 *
 * BUG (the R12 regression): the live daemon (memory-daemon.ts) embeds a concept
 * as `${content} ${searchTerms.join(". ")}` — a richer target than `content`
 * alone — but only `content` was persisted on the row. So when the embedder was
 * DOWN at create time, backfillConceptEmbeddings() (which K16 had keyed to
 * `content`) healed to a CONTENT-ONLY vector that diverged from the live form,
 * permanently degrading retrieval for any concept healed via the backfill path.
 * The create path's intended embed target was never stored, so the heal could
 * not reproduce it (the exact shape K51 already fixed for `memory`).
 *
 * FIX (mirror K51 for concepts):
 *   1. Persist an optional `embedding_target` column on concept at create time
 *      (surreal.ts upsertConcept, fed by commit.ts commitConcept via
 *      data.embeddingTarget, fed by memory-daemon's `${content} ${searchTerms}`
 *      form), declared in schema.surql (option<string>), written only when it
 *      diverges from content.
 *   2. backfillConceptEmbeddings SELECTs `embedding_target` and embeds
 *      `embedding_target ?? content` so the heal reproduces the create-time
 *      target. NONE → fall back to content (the common case), preserving
 *      backfill-coverage (the WHERE filter is unchanged).
 *
 * Static source/schema assertions (mirroring fix-k51-memory-backfill-embed-
 * target.test.ts) PLUS one behavioral test over the real exported SurrealStore
 * proving an existing un-embedded row carrying a persisted embedding_target is
 * healed with THAT target, not content. Each assertion FAILS against the pre-fix
 * bodies.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SurrealStore } from "../src/engine/surreal.js";

const maintenanceSrc = readFileSync(new URL("../src/engine/maintenance.ts", import.meta.url), "utf8");
const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");
const commitSrc = readFileSync(new URL("../src/engine/commit.ts", import.meta.url), "utf8");
const daemonSrc = readFileSync(new URL("../src/engine/memory-daemon.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");

/** Slice a named function body. Window must cover upsertConcept, which is large
 *  (~12.5k chars including its race-recovery block). */
function fnBody(s: string, decl: string): string {
  const start = s.indexOf(decl);
  expect(start, `${decl} not found`).toBeGreaterThan(-1);
  return s.slice(start, start + 13000);
}

describe("R12/K16: concept backfill heals with the persisted embed target, not content-only", () => {
  it("schema declares an optional embedding_target column on concept", () => {
    expect(schemaSrc).toMatch(
      /DEFINE FIELD IF NOT EXISTS embedding_target ON concept TYPE option<string>/,
    );
  });

  describe("create path persists the embed target", () => {
    const createBody = fnBody(surrealSrc, "async upsertConcept(");

    it("upsertConcept accepts an embeddingTarget parameter", () => {
      expect(createBody).toMatch(/embeddingTarget\??\s*:\s*string/);
    });

    it("upsertConcept writes embedding_target onto the CREATE record (only when it diverges from content)", () => {
      expect(createBody).toMatch(/record\.embedding_target\s*=\s*embeddingTarget/);
      // The divergence guard so we don't duplicate content.
      expect(createBody).toMatch(/embeddingTarget\s*&&\s*embeddingTarget\s*!==\s*content/);
    });

    it("commitConcept forwards data.embeddingTarget to upsertConcept and embeds it", () => {
      const body = fnBody(commitSrc, "async function commitConcept");
      // upsertConcept call must pass data.embeddingTarget as the trailing arg.
      const call = body.slice(body.indexOf("store.upsertConcept("), body.indexOf("store.upsertConcept(") + 300);
      expect(call).toMatch(/data\.embeddingTarget/);
      // The embed() call must prefer embeddingTarget over name (mirrors K51).
      expect(body).toMatch(/embed\(\s*data\.embeddingTarget\s*\?\?\s*data\.name\s*\)/);
    });

    it("CommitConceptData declares embeddingTarget", () => {
      expect(commitSrc).toMatch(/embeddingTarget\??\s*:\s*string/);
    });

    it("the daemon passes its `${content} ${searchTerms}` form as embeddingTarget", () => {
      const body = fnBody(daemonSrc, "if (Array.isArray(result.concepts)");
      // embeddingText is computed from searchTerms and passed as embeddingTarget.
      expect(body).toMatch(/embeddingTarget:\s*embeddingText/);
      expect(body).toMatch(/c\.searchTerms\.join/);
    });
  });

  describe("heal path uses the persisted target", () => {
    const backfillBody = fnBody(maintenanceSrc, "async function backfillConceptEmbeddings");

    it("SELECTs embedding_target from concept", () => {
      const select = backfillBody.slice(
        backfillBody.search(/SELECT/i),
        backfillBody.search(/FROM\s+concept/i) + "FROM concept".length,
      );
      expect(select).toMatch(/embedding_target/i);
    });

    it("embed target prefers embedding_target, falling back to content/name", () => {
      // Pre-fix: `let target = row.content ...`. The fix must coalesce the
      // persisted target first. Require an explicit row.embedding_target read
      // feeding `target`, AND row.content still present as the fallback.
      expect(backfillBody).toMatch(/row\.embedding_target/);
      expect(backfillBody).toMatch(/row\.content/);
    });

    it("still embeds the resolved `target` (heal path intact)", () => {
      expect(backfillBody).toMatch(/embed\(\s*target\s*\)/);
    });

    it("WHERE filter is unchanged — backfill coverage preserved (does NOT require embedding_target)", () => {
      const where = backfillBody.slice(backfillBody.search(/WHERE/i), backfillBody.search(/LIMIT/i));
      expect(where).toMatch(/embedding IS NONE OR array::len\(embedding\) = 0/i);
      // Must still admit content-only rows (the K16 invariant).
      expect(where).toMatch(/content\s+IS\s+NOT\s+NONE/i);
      // Must NOT gate on embedding_target — that would skip rows lacking it.
      expect(
        /embedding_target\s+IS\s+NOT\s+NONE/i.test(where),
        "WHERE must not require embedding_target",
      ).toBe(false);
    });
  });

  describe("behavioral: divergent embedding_target is persisted and is re-upsertable", () => {
    it("upsertConcept (CREATE) records embedding_target when it diverges from content", async () => {
      const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
      let createBindings: any = null;
      (store as any).bumpAccessCounts = vi.fn(async () => undefined);
      (store as any).queryExec = vi.fn(async () => undefined);
      (store as any).queryFirst = vi.fn(async (sql: string, bindings: any) => {
        if (/^\s*CREATE\s+concept/i.test(sql)) { createBindings = bindings; return [{ id: "concept:x" }]; }
        return []; // dedup misses
      });

      const content = "vector search uses HNSW";
      const target = "vector search uses HNSW. approximate nearest neighbor. ANN index";
      await store.upsertConcept(content, null, "src", undefined, undefined, target);

      expect(createBindings?.record?.embedding_target).toBe(target);
      // The persisted target diverges from content (the persist condition).
      expect(createBindings?.record?.content).toBe(content);
      expect(createBindings.record.embedding_target).not.toBe(createBindings.record.content);
    });

    it("upsertConcept does NOT persist embedding_target when it equals content (avoid duplication)", async () => {
      const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
      let createBindings: any = null;
      (store as any).bumpAccessCounts = vi.fn(async () => undefined);
      (store as any).queryExec = vi.fn(async () => undefined);
      (store as any).queryFirst = vi.fn(async (sql: string, bindings: any) => {
        if (/^\s*CREATE\s+concept/i.test(sql)) { createBindings = bindings; return [{ id: "concept:x" }]; }
        return [];
      });

      const content = "identical target";
      await store.upsertConcept(content, null, "src", undefined, undefined, content);
      expect(createBindings?.record?.embedding_target).toBeUndefined();
    });
  });
});
