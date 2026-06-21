/**
 * Regression test for K17-emb: EmbeddingService.l2Put must reset
 * pruned_at = NONE in its UPSERT.
 *
 * embedding_cache has a UNIQUE index on text_hash and l2Get filters
 * `pruned_at IS NONE`. When the maintenance purge soft-tags a stale row
 * (pruned_at set), a later re-embed of that same text UPSERTs onto the SAME
 * row (UNIQUE hash) — but the old UPSERT only wrote text_hash/embedding/
 * model_version, leaving pruned_at set. The row stayed permanently invisible
 * to l2Get, so every future embed of that text missed L2 and burned the
 * compute path forever. Resetting pruned_at (and prune_reason) on re-put
 * revives the row.
 *
 * This asserts the UPSERT statement clears pruned_at. Against the old code the
 * query had no `pruned_at = NONE` clause and this test fails.
 */
import { describe, it, expect, vi } from "vitest";
import { EmbeddingService } from "../src/engine/embeddings.js";
import type { EmbeddingConfig } from "../src/engine/config.js";

function makeService(queryExec: (sql: string, bindings?: any) => Promise<any>): {
  svc: EmbeddingService;
  exec: ReturnType<typeof vi.fn>;
} {
  const config = { modelPath: "/tmp/fake-model.gguf" } as unknown as EmbeddingConfig;
  const svc = new EmbeddingService(config);
  const exec = vi.fn(queryExec);
  const fakeStore = {
    isAvailable: () => true,
    queryExec: exec,
  } as any;
  svc.setStore(fakeStore);
  return { svc, exec };
}

describe("K17-emb: l2Put revives soft-tagged cache rows", () => {
  it("UPSERT sets pruned_at = NONE (so a purged row becomes recallable again)", async () => {
    const { svc, exec } = makeService(async () => undefined);
    // l2Put is fire-and-forget internal; invoke directly.
    (svc as any).l2Put("hash-abc", [0.1, 0.2, 0.3]);
    expect(exec).toHaveBeenCalledTimes(1);
    const sql = String(exec.mock.calls[0][0]);
    expect(sql).toContain("UPSERT embedding_cache");
    // The load-bearing clause — must clear the soft-tag so l2Get's
    // `pruned_at IS NONE` filter sees the re-cached row.
    expect(sql).toMatch(/pruned_at\s*=\s*NONE/);
  });

  it("still writes text_hash, embedding, and model_version (happy path intact)", async () => {
    const { svc, exec } = makeService(async () => undefined);
    (svc as any).l2Put("hash-xyz", [1, 2, 3]);
    const [sql, bindings] = exec.mock.calls[0];
    expect(String(sql)).toContain("text_hash = $hash");
    expect(String(sql)).toContain("embedding = $vec");
    expect(String(sql)).toContain("model_version = $mv");
    expect(bindings.hash).toBe("hash-xyz");
    expect(bindings.vec).toEqual([1, 2, 3]);
    expect(typeof bindings.mv).toBe("string");
  });

  it("no-ops when the store is unavailable (no query issued)", async () => {
    const config = { modelPath: "/tmp/fake-model.gguf" } as unknown as EmbeddingConfig;
    const svc = new EmbeddingService(config);
    const exec = vi.fn(async () => undefined);
    svc.setStore({ isAvailable: () => false, queryExec: exec } as any);
    (svc as any).l2Put("hash", [1]);
    expect(exec).not.toHaveBeenCalled();
  });
});
