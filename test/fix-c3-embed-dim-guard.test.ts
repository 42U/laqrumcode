/**
 * Regression test for C3 (embed-integrity): EmbeddingService must validate the
 * embedding output dimension BEFORE any write, and REJECT a wrong-dimension
 * vector instead of poisoning vector search.
 *
 * The HNSW indexes are DIMENSION 1024 (schema.surql, 10+ tables). SurrealDB's
 * vector::similarity::cosine throws "vectors must be of the same dimension"
 * DB-wide the moment ONE wrong-dim vector lands — so a single mis-set
 * EMBED_MODEL_PATH, a partial/corrupt GGUF, or a model that silently emits a
 * different width takes down recall for the WHOLE graph, and the only fix today
 * is the manual scripts/repair-vector-dim.mjs.
 *
 * The pre-C3 code took `Array.from(result.vector)` in computeAndSettle and wrote
 * it to the in-mem cache + L2 (embedding_cache) + resolved the caller with NO
 * `=== dimensions` check (embeddings.ts ~274-280); l2Get validated only
 * `vec.length > 0` (~125). Against that code these tests fail: a 512-dim/0-dim
 * vector was cached, persisted, and resolved.
 *
 * The fix validates `vec.length === this.config.dimensions` at the embed
 * boundary. On mismatch it:
 *   1. does NOT write the poison vector (no in-mem cache set, no L2 UPSERT),
 *   2. rejects the embed() promise (routing the caller through the EXISTING K5
 *      degrade path → the row is stored un-embedded and the maintenance
 *      embedding-backfill heals it later — never auto-deleted),
 *   3. records a maintenance_runs row {job:'embedDimGuard', status:'error'} so
 *      memory_health goes RED automatically.
 * And l2Get drops a wrong-dim cache hit (a poison row left by an older daemon)
 * so it can't re-poison search.
 *
 * SAFETY asserted here: a VALID 1024-dim vector is NEVER rejected (exact
 * equality), and a wrong-dim vector is NEVER written.
 *
 * Stubs the compute context (ctx.getEmbeddingFor) and the store — the real DB
 * is never touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingService } from "../src/engine/embeddings.js";
import type { EmbeddingConfig } from "../src/engine/config.js";

// Quiet the log module so the rejection-path log.warn/error don't spam output.
vi.mock("../src/engine/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const EXPECTED_DIM = 1024;

interface ExecCall {
  sql: string;
  bindings: any;
}

/**
 * Build a ready EmbeddingService whose compute context returns a vector of the
 * requested length, with the store stubbed to capture every queryExec call.
 */
function makeService(vectorLength: number): {
  svc: EmbeddingService;
  execCalls: ExecCall[];
} {
  const config = {
    modelPath: "/tmp/fake-model.gguf",
    dimensions: EXPECTED_DIM,
  } as unknown as EmbeddingConfig;
  const svc = new EmbeddingService(config) as any;

  const execCalls: ExecCall[] = [];
  const fakeStore = {
    isAvailable: () => true,
    queryExec: vi.fn(async (sql: string, bindings?: any) => {
      execCalls.push({ sql, bindings });
      return undefined;
    }),
    // l2Get path: no cache hit, so the compute path runs.
    queryFirst: vi.fn(async () => []),
  };
  svc.setStore(fakeStore);

  // Mark ready and install a compute context that yields a controllable-width
  // vector. node-llama-cpp returns { vector } and the code does Array.from(it).
  svc.ready = true;
  svc.ctx = {
    getEmbeddingFor: async () => ({
      vector: new Array(vectorLength).fill(0.01),
    }),
  };
  return { svc: svc as EmbeddingService, execCalls };
}

const cacheWrites = (calls: ExecCall[]) =>
  calls.filter((c) => /UPSERT\s+embedding_cache/i.test(c.sql));
const dimGuardRows = (calls: ExecCall[]) =>
  calls.filter(
    (c) =>
      /CREATE\s+maintenance_runs/i.test(c.sql) &&
      c.bindings?.data?.job === "embedDimGuard",
  );

describe("C3: embed dimension guard rejects poison vectors before any write", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a 512-dim vector: not cached, not persisted, embed() throws", async () => {
    const { svc, execCalls } = makeService(512);

    await expect(svc.embed("poison-512")).rejects.toThrow(/512-dim/);

    // The poison vector was NOT written to L2 (embedding_cache).
    expect(cacheWrites(execCalls)).toHaveLength(0);
    // The poison vector was NOT written to the in-memory cache, so a re-embed
    // does not serve it from cache (it would re-throw on recompute).
    expect((svc as any).cache.has("poison-512")).toBe(false);
  });

  it("records a maintenance_runs embedDimGuard error row on mismatch (memory_health goes RED)", async () => {
    const { svc, execCalls } = makeService(512);

    await expect(svc.embed("poison-512b")).rejects.toThrow();

    const rows = dimGuardRows(execCalls);
    expect(rows).toHaveLength(1);
    const data = rows[0].bindings.data;
    expect(data.status).toBe("error");
    expect(String(data.error)).toContain("512");
    expect(String(data.error)).toContain(String(EXPECTED_DIM));
  });

  it("rejects a 0-dim (empty) vector the same way", async () => {
    const { svc, execCalls } = makeService(0);

    await expect(svc.embed("poison-empty")).rejects.toThrow(/0-dim/);

    expect(cacheWrites(execCalls)).toHaveLength(0);
    expect(dimGuardRows(execCalls)).toHaveLength(1);
    expect((svc as any).cache.has("poison-empty")).toBe(false);
  });

  it("writes a correct 1024-dim vector normally (no false rejection, no guard row)", async () => {
    const { svc, execCalls } = makeService(EXPECTED_DIM);

    const vec = await svc.embed("healthy-1024");

    // Resolved with the real vector, correct width.
    expect(vec).toHaveLength(EXPECTED_DIM);
    // Persisted to L2 exactly once (the happy-path l2Put UPSERT).
    expect(cacheWrites(execCalls)).toHaveLength(1);
    // Cached in-memory for the next hit.
    expect((svc as any).cache.get("healthy-1024")).toHaveLength(EXPECTED_DIM);
    // No dim-guard error row on the healthy path.
    expect(dimGuardRows(execCalls)).toHaveLength(0);
  });

  it("does not record a guard row when the store is unavailable, but STILL rejects the poison vector", async () => {
    const { svc, execCalls } = makeService(512);
    // Flip the store offline AFTER construction (modelVersion already computed).
    (svc as any).store.isAvailable = () => false;

    // The rejection is load-bearing and must survive a down store; the audit
    // write is best-effort and is simply skipped.
    await expect(svc.embed("poison-no-store")).rejects.toThrow(/512-dim/);
    expect(dimGuardRows(execCalls)).toHaveLength(0);
    expect(cacheWrites(execCalls)).toHaveLength(0);
  });
});

describe("C3: l2Get drops a wrong-dimension cache hit (poison row from an older daemon)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats a 512-dim cached vector as a MISS (does not serve it)", async () => {
    const config = {
      modelPath: "/tmp/fake-model.gguf",
      dimensions: EXPECTED_DIM,
    } as unknown as EmbeddingConfig;
    const svc = new EmbeddingService(config) as any;
    svc.setStore({
      isAvailable: () => true,
      // The cache row holds a wrong-dim vector (loose `array` column allows it).
      queryFirst: vi.fn(async () => [{ embedding: new Array(512).fill(0.01) }]),
      queryExec: vi.fn(async () => undefined),
    });

    const hit = await svc.l2Get("some-hash");
    expect(hit).toBeNull(); // wrong-dim → miss, so the caller recomputes
    expect((svc as any).l2Hits).toBe(0);
    expect((svc as any).l2Misses).toBe(1);
  });

  it("serves a correct 1024-dim cached vector (no regression to the happy cache path)", async () => {
    const config = {
      modelPath: "/tmp/fake-model.gguf",
      dimensions: EXPECTED_DIM,
    } as unknown as EmbeddingConfig;
    const svc = new EmbeddingService(config) as any;
    const good = new Array(EXPECTED_DIM).fill(0.02);
    svc.setStore({
      isAvailable: () => true,
      queryFirst: vi.fn(async () => [{ embedding: good }]),
      queryExec: vi.fn(async () => undefined),
    });

    const hit = await svc.l2Get("good-hash");
    expect(hit).toEqual(good);
    expect((svc as any).l2Hits).toBe(1);
  });
});
