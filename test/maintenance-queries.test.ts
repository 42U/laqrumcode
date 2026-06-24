/**
 * Regression tests for maintenance + observability SurrealQL that previously
 * shipped malformed and failed SILENTLY (caught only at runtime in the daemon
 * log). These run the actual queries against a live throwaway SurrealDB so a
 * parse error fails CI instead of becoming an unbounded-growth no-op.
 *
 *  - GH #17: purgeStaleEmbedCache used `LIMIT` on an UPDATE (rejected by
 *    SurrealDB → the 30-day embedding_cache prune never ran).
 *  - The pending_work aging/buildup alerts counted soft-archived (active=false)
 *    rows, firing false "drain now" alarms for rows the purge already handled.
 *
 * Requires a live SurrealDB on localhost:8000 (skips otherwise, like the other
 * integration suites).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "laqrum_test";
const TEST_DB = `maint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let store: SurrealStore;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  store = new SurrealStore({
    url,
    get httpUrl() { return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: process.env.SURREAL_USER ?? "root",
    pass: process.env.SURREAL_PASS ?? "root",
    ns: TEST_NS,
    db: TEST_DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 10_000)),
    ]);
  } catch {
    store = undefined as any;
  }
}, 15_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => { if (SKIP || !store?.isAvailable()) return; await fn(); }, timeout);
}

describe("maintenance: purgeStaleEmbedCache (GH #17)", () => {
  itDb("the LET+FOR prune is valid SurrealQL and soft-tags only >30d rows", async () => {
    // Two cache rows: one 31 days old (should prune), one fresh (should not).
    await store.queryExec(
      `CREATE embedding_cache CONTENT { text_hash: "old-h1", embedding: [0.1, 0.2], model_version: "test", created_at: time::now() - 31d };
       CREATE embedding_cache CONTENT { text_hash: "new-h1", embedding: [0.1, 0.2], model_version: "test", created_at: time::now() };`,
    );
    // The exact production query (mirrors maintenance.ts purgeStaleEmbedCache).
    // Pre-fix this threw "Unexpected token 'LIMIT'" and pruned nothing.
    await store.queryMulti(
      `LET $stale = (SELECT id FROM embedding_cache
         WHERE created_at < time::now() - 30d AND pruned_at IS NONE LIMIT 500);
       FOR $row IN $stale {
         UPDATE $row.id SET pruned_at = time::now(), prune_reason = "stale_30d";
       };`,
    );
    const oldRows = await store.queryFirst<{ pruned_at: unknown; prune_reason: string }>(
      `SELECT pruned_at, prune_reason FROM embedding_cache WHERE text_hash = "old-h1"`,
    );
    const newRows = await store.queryFirst<{ pruned_at: unknown }>(
      `SELECT pruned_at FROM embedding_cache WHERE text_hash = "new-h1"`,
    );
    expect(oldRows[0]?.pruned_at).not.toBeNull();
    expect(oldRows[0]?.pruned_at).not.toBeUndefined();
    expect(oldRows[0]?.prune_reason).toBe("stale_30d");
    // Fresh row untouched (pruned_at stays NONE/absent).
    expect(newRows[0]?.pruned_at ?? null).toBeNull();
  });
});

describe("observability: pending_work alerts ignore soft-archived rows", () => {
  itDb("the aging count query excludes active=false rows", async () => {
    const sid = `maint-aging-${Date.now()}`;
    // An OLD claimable row (active=true) and an OLD soft-archived row (active=false).
    await store.queryExec(
      `CREATE pending_work CONTENT { session_id: $sid, work_type: "coalesced_extraction", status: "pending", active: true, created_at: time::now() - 9d };
       CREATE pending_work CONTENT { session_id: $sid, work_type: "soul_evolve", status: "pending", active: false, archived_at: time::now(), created_at: time::now() - 9d };`,
      { sid },
    );
    // The fixed aging-count predicate (mirrors observability.ts detectPendingWorkAging).
    const rows = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM pending_work
         WHERE session_id = $sid AND status = "pending"
           AND (active = true OR active IS NONE)
           AND created_at < time::now() - 5d GROUP ALL`,
      { sid },
    );
    // Only the active=true row counts; the soft-archived one is excluded.
    expect(rows[0]?.n).toBe(1);
  });
});
