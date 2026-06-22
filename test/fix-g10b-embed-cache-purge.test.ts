/**
 * G10B — purgeStaleEmbedCache hard-delete phase (2026-06-21).
 *
 * embedding_cache is TELEMETRY (D4 lists it "DELETE OK"; not a gc.ts content
 * table), so already-pruned rows (pruned_at IS NOT NONE) can be HARD-deleted.
 * They are truly dead: l2Get filters `pruned_at IS NONE` so they're never read,
 * and l2Put recomputes the embedding on a cache miss, so a resurrected row gains
 * nothing over a fresh insert. Pre-G10B purgeStaleEmbedCache only soft-tagged.
 *
 * IMPLEMENTATION NOTE (the bug this guards): the first cut used a
 * LET+FOR(write)+LIMIT form via queryMulti that PARSE-ERRORED on this SurrealDB
 * ("Unexpected token LIMIT") — and since it was the first statement, it skipped
 * the whole purge. The shipped form is the proven keystone idiom: a plain
 * `SELECT id ... LIMIT 500` (queryFirst) then `DELETE embedding_cache WHERE id
 * IN [<Things>]` (queryExec). These tests assert that exact shape: a SELECT that
 * targets `pruned_at IS NOT NONE`, a WHERE-id-IN DELETE, batch looping, and the
 * store-availability guard. No live SurrealDB is touched.
 */
import { describe, it, expect, vi } from "vitest";
import type { GlobalPluginState } from "../src/engine/state.js";

async function importMaintenance() {
  return await import("../src/engine/maintenance.js");
}

const BATCH = 500;

/** Build a fake state. queryFirst answers the Phase-2 SELECT
 *  (`pruned_at IS NOT NONE`) with a scripted batch of fake embedding_cache ids
 *  (sizes from `deleteBatchCounts`); the Phase-1 SELECT (`pruned_at IS NONE`)
 *  drains immediately ([]). queryExec records every UPDATE/DELETE SQL. */
function makeState(opts: { available: boolean; deleteBatchCounts: number[] }): {
  state: GlobalPluginState;
  firstLog: string[];
  execLog: string[];
} {
  const firstLog: string[] = [];
  const execLog: string[] = [];
  let delIdx = 0;
  const fakeIds = (n: number, tag: number) =>
    Array.from({ length: n }, (_, k) => ({ id: `embedding_cache:zz${tag}x${k}` }));

  const queryFirst = vi.fn(async (sql: string) => {
    firstLog.push(sql);
    if (/pruned_at IS NOT NONE/.test(sql)) {
      const n = opts.deleteBatchCounts[delIdx] ?? 0;
      const rows = fakeIds(n, delIdx);
      delIdx++;
      return rows;
    }
    return []; // Phase-1 stale SELECT — nothing to soft-tag in these tests
  });
  const queryExec = vi.fn(async (sql: string) => {
    execLog.push(sql);
  });

  const store = {
    isAvailable: () => opts.available,
    queryFirst,
    queryExec,
    queryMulti: vi.fn(async () => undefined),
    runMemoryMaintenance: async () => {},
    archiveOldTurns: async () => {},
    consolidateMemories: async () => {},
    garbageCollectMemories: async () => {},
    garbageCollectConcepts: async () => {},
    purgeStalePendingWork: async () => {},
    purgeOldRetrievalOutcomes: async () => 0,
    purgeOldTurnScores: async () => 0,
    purgeOldMaintenanceRuns: async () => 0,
    // M4: Group-1 Promise.all now also calls purgeOldCompactionCheckpoints —
    // stub it like the sibling purges so the fire-and-forget chain doesn't reject.
    purgeOldCompactionCheckpoints: async () => 0,
  } as any;

  const state: Partial<GlobalPluginState> = {
    store,
    embeddings: { isAvailable: () => false, embed: async () => [] } as any,
    config: { thresholds: { acanTrainingThreshold: 1 }, paths: { cacheDir: "/tmp/kc-g10b" } } as any,
  };
  return { state: state as GlobalPluginState, firstLog, execLog };
}

const deletes = (execLog: string[]) => execLog.filter((s) => /DELETE\s+embedding_cache/.test(s));

describe("G10B purgeStaleEmbedCache hard-delete (via runBootstrapMaintenance)", () => {
  it("SELECTs pruned rows then issues a WHERE-id-IN DELETE (not a bare/unbounded delete)", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests();

    const { state, firstLog, execLog } = makeState({ available: true, deleteBatchCounts: [10] });
    runBootstrapMaintenance(state);
    await new Promise((r) => setTimeout(r, 50));

    // The detector SELECT targets only already-pruned rows, bounded by LIMIT 500.
    expect(firstLog.some((s) => /SELECT id FROM embedding_cache\s+WHERE pruned_at IS NOT NONE\s+LIMIT 500/.test(s))).toBe(true);
    // Exactly one hard-delete (the 10-id batch is < BATCH so the loop exits).
    const dels = deletes(execLog);
    expect(dels.length).toBe(1);
    // WHERE-id-IN over interpolated Things — never a bare `DELETE embedding_cache;`.
    expect(dels[0]).toMatch(/DELETE embedding_cache WHERE id IN \[embedding_cache:/);
    expect(dels[0]).not.toMatch(/LIMIT/); // the DELETE is bounded by the IN list, not LIMIT
  });

  it("loops across batches until a sub-BATCH batch drains the backlog", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests();

    const { state, execLog } = makeState({ available: true, deleteBatchCounts: [BATCH, BATCH, 3] });
    runBootstrapMaintenance(state);
    await new Promise((r) => setTimeout(r, 50));

    expect(deletes(execLog).length).toBe(3); // 500,500,3 → looped until n < BATCH
  });

  it("is store-availability-guarded — no SELECT/DELETE when the store is down", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests();

    const { state, firstLog, execLog } = makeState({ available: false, deleteBatchCounts: [10] });
    runBootstrapMaintenance(state);
    await new Promise((r) => setTimeout(r, 50));

    expect(deletes(execLog).length).toBe(0);
    expect(firstLog.filter((s) => /pruned_at IS NOT NONE/.test(s)).length).toBe(0);
  });
});
