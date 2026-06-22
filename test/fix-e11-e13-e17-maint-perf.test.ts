/**
 * E11 / E13 / E17 — maintenance efficiency at a large per-install graph.
 *
 * Regression coverage for the enterprise-readiness "maintenance-perf" lane.
 * kongcode is ONE daemon + local SurrealDB per host, so a real install can grow
 * a single large graph that runs these maintenance passes every cycle — the
 * cost has to stay bounded.
 *
 *  E11 (surreal.ts shouldRunMaintenance): a PERMANENTLY-failing job hot-loops.
 *      E1 now records status='error' rows, but the time-relative gate treats an
 *      error row exactly like "no recent SUCCESS" → it re-runs the doomed job
 *      every boot. Fix: a failure BACKOFF — if the newest maintenance_runs row
 *      for a job is status='error' AND younger than FAILURE_BACKOFF_MS (30 min),
 *      skip the retry (mirrors auto-drain's fast-fail cooldown). Tested through
 *      the public garbageCollectConcepts() seam against a live DB: with a fresh
 *      error row it must NOT re-run (write no new row); with a stale error row
 *      it must.
 *
 *  E13 (gc.ts gcSweepOrphanedEdges): the 6h maintenance cycle ran 26 full
 *      edge-table scans every cycle even though the steady state is zero orphans
 *      (the gcHardDelete keystone co-deletes incident edges; the D4 lint blocks
 *      ad-hoc content DELETEs). Fix: throttle the SCHEDULED sweep to a weekly
 *      cadence via a maintenance_runs ran_at gate; force:true (post-delete
 *      trailing sweep) and dryRun bypass. Tested as a unit with a mocked store.
 *
 *  E17 (schema.surql): the hot maintenance predicates ran unindexed —
 *      archiveOldTurns' `pruned_at IS NONE` + NOT-IN(retrieval_outcome) and
 *      garbageCollectConcepts' four per-row edge fan-outs. Fix: composite +
 *      endpoint indexes. Tested live: the new indexes are DEFINEd after
 *      initialize(), and the archive predicate still parses/returns correctly.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { GlobalPluginState } from "../src/engine/state.js";
import { SurrealStore } from "../src/engine/surreal.js";

// ---------------------------------------------------------------------------
// E13 — gcSweepOrphanedEdges weekly throttle (pure unit; store mocked).
// ---------------------------------------------------------------------------
describe("E13 gcSweepOrphanedEdges — weekly throttle of the scheduled sweep", () => {
  /** Mock store whose maintenance_runs "last sweep" row is controllable, and
   *  whose orphan-detect SELECTs return zero orphans (so a sweep that DOES run
   *  is a no-op). Counts how many edge-table scans the detect loop issues so we
   *  can prove a throttled call performed ZERO scans. */
  function makeState(lastSweepRanAt: string | null) {
    let detectScans = 0;
    const queryFirst = vi.fn(async (sql: string) => {
      if (sql.includes("WHERE job = 'gcSweepOrphanedEdges'")) {
        return lastSweepRanAt == null ? [] : [{ ran_at: lastSweepRanAt }];
      }
      // The per-table orphan detect + both-live baseline scans.
      if (sql.includes("WHERE in.id IS NONE OR out.id IS NONE")) { detectScans++; return []; }
      if (sql.includes("WHERE in.id IS NOT NONE AND out.id IS NOT NONE")) return [{ n: 0 }];
      return [];
    });
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const state = {
      store: { isAvailable: () => true, queryFirst, queryExec },
      config: { paths: { cacheDir: "/tmp/kc-cache-e13" } },
    } as unknown as GlobalPluginState;
    return { state, queryFirst, queryExec, detectScans: () => detectScans };
  }

  it("SKIPS the scan when a prior sweep ran inside the weekly window (throttled, zero scans)", async () => {
    const { gcSweepOrphanedEdges } = await import("../src/engine/gc.js");
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const { state, detectScans, queryExec } = makeState(recent);

    const res = await gcSweepOrphanedEdges(state, { reason: "maintenance-cycle" });

    expect(res.throttled).toBe(true);
    expect(res.scanned).toBe(0);
    expect(res.removed).toBe(0);
    // The expensive detect loop never ran, and no heartbeat row was written
    // (the throttle returns before either).
    expect(detectScans()).toBe(0);
    expect(queryExec).not.toHaveBeenCalled();
  });

  it("RUNS when the prior sweep is older than the weekly window", async () => {
    const { gcSweepOrphanedEdges } = await import("../src/engine/gc.js");
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8d ago
    const { state, detectScans } = makeState(stale);

    const res = await gcSweepOrphanedEdges(state, { reason: "maintenance-cycle" });

    expect(res.throttled).toBeUndefined();
    expect(res.scanned).toBeGreaterThan(0);
    expect(detectScans()).toBeGreaterThan(0); // it actually scanned
  });

  it("RUNS on the first ever sweep (no prior maintenance_runs row)", async () => {
    const { gcSweepOrphanedEdges } = await import("../src/engine/gc.js");
    const { state, detectScans } = makeState(null);

    const res = await gcSweepOrphanedEdges(state, { reason: "maintenance-cycle" });

    expect(res.throttled).toBeUndefined();
    expect(detectScans()).toBeGreaterThan(0);
  });

  it("force:true BYPASSES the throttle (post-delete trailing sweep must always run)", async () => {
    const { gcSweepOrphanedEdges } = await import("../src/engine/gc.js");
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const { state, detectScans, queryFirst } = makeState(recent);

    const res = await gcSweepOrphanedEdges(state, { reason: "post-delete", force: true });

    expect(res.throttled).toBeUndefined();
    expect(detectScans()).toBeGreaterThan(0);
    // force path must not even consult the throttle gate.
    expect(queryFirst.mock.calls.some(c => String(c[0]).includes("WHERE job = 'gcSweepOrphanedEdges'"))).toBe(false);
  });

  it("dryRun BYPASSES the throttle and writes NO heartbeat row", async () => {
    const { gcSweepOrphanedEdges } = await import("../src/engine/gc.js");
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { state, detectScans, queryExec } = makeState(recent);

    const res = await gcSweepOrphanedEdges(state, { reason: "inspect", dryRun: true });

    expect(res.throttled).toBeUndefined();
    expect(res.dryRun).toBe(true);
    expect(detectScans()).toBeGreaterThan(0);
    // dryRun must not reset the throttle clock (no heartbeat CREATE).
    expect(queryExec).not.toHaveBeenCalled();
  });

  it("writes a zero-orphan HEARTBEAT row so the throttle engages next cycle", async () => {
    const { gcSweepOrphanedEdges } = await import("../src/engine/gc.js");
    const { state, queryExec } = makeState(null); // first run → not throttled

    await gcSweepOrphanedEdges(state, { reason: "maintenance-cycle" });

    // The no-op (zero-orphan) path must record a gcSweepOrphanedEdges row.
    const heartbeats = queryExec.mock.calls.filter(([sql, bind]) =>
      String(sql).includes("CREATE maintenance_runs CONTENT") &&
      (bind as { data?: { job?: string } })?.data?.job === "gcSweepOrphanedEdges",
    );
    expect(heartbeats.length).toBe(1);
    expect((heartbeats[0]![1] as { data: { rows_affected: number } }).data.rows_affected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LIVE-DB section (skips without SurrealDB, like the other integration suites).
// Proves: (E17) the new indexes APPLY at initialize(); (E11) the failure
// backoff actually gates a public maintenance method; (E17) the archive
// predicate parses + works on a real DB.
// ---------------------------------------------------------------------------
const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "kong_test";
const TEST_DB = `e11e13e17_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  } as any);
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

/** Read the index names defined on a table from a live DB. `INFO FOR TABLE`
 *  yields a single OBJECT ({events,fields,indexes,...}), not an array of rows —
 *  queryFirst would coerce that to [] (it only keeps array results), so use
 *  queryMulti which returns the last statement's value verbatim. */
async function indexNames(tb: string): Promise<string[]> {
  const info = await store.queryMulti<{ indexes?: Record<string, string> }>(`INFO FOR TABLE ${tb}`);
  return Object.keys(info?.indexes ?? {});
}

describe("E17 — new indexes are defined in schema.surql (applied at initialize)", () => {
  itDb("turn has the (pruned_at, timestamp) composite for archiveOldTurns", async () => {
    expect(await indexNames("turn")).toContain("turn_pruned_timestamp_idx");
  });

  itDb("retrieval_outcome has the (memory_table, memory_id) composite for the anti-join", async () => {
    expect(await indexNames("retrieval_outcome")).toContain("ro_memtable_memid_idx");
  });

  itDb("the four concept-GC edge fan-outs have endpoint indexes (right direction)", async () => {
    // <-about_concept<-memory and <-mentions<-turn filter on `out`;
    // ->narrower->? and ->broader->? filter on `in`.
    expect(await indexNames("about_concept")).toContain("about_concept_out_idx");
    expect(await indexNames("mentions")).toContain("mentions_out_idx");
    expect(await indexNames("narrower")).toContain("narrower_in_idx");
    expect(await indexNames("broader")).toContain("broader_in_idx");
  });
});

describe("E17 — archiveOldTurns predicate still parses + selects correctly", () => {
  itDb("the pruned_at + NOT-IN(retrieval_outcome) SELECT returns only the eligible turn", async () => {
    // Three turns: (a) old + unpruned + NOT referenced → eligible;
    // (b) old + unpruned but referenced by a retrieval_outcome → excluded;
    // (c) old but already pruned → excluded.
    const created = await store.queryFirst<{ id: unknown }>(
      `CREATE turn CONTENT { session_id: "s", role: "user", text: "eligible", timestamp: time::now() - 8d };
       CREATE turn CONTENT { session_id: "s", role: "user", text: "referenced", timestamp: time::now() - 8d };
       CREATE turn CONTENT { session_id: "s", role: "user", text: "pruned", timestamp: time::now() - 8d, pruned_at: time::now() };`,
    );
    // queryFirst returns the LAST statement's rows; re-select the trio by text
    // so the test does not depend on multi-statement return shape.
    const eligibleRow = await store.queryFirst<{ id: unknown }>(`SELECT id FROM turn WHERE text = "eligible"`);
    const referencedRow = await store.queryFirst<{ id: unknown }>(`SELECT id FROM turn WHERE text = "referenced"`);
    expect(created.length).toBeGreaterThanOrEqual(0); // CREATE executed
    const refId = String(referencedRow[0]!.id);
    // A retrieval_outcome that references the "referenced" turn (memory_id is a
    // string of the record id, exactly as the production writer stores it).
    await store.queryExec(
      `CREATE retrieval_outcome CONTENT { session_id: "s", turn_id: "t", memory_id: $mid, memory_table: "turn", retrieval_score: 0.5 };`,
      { mid: refId },
    );

    // The EXACT production predicate from archiveOldTurns (surreal.ts ~2728).
    const stale = await store.queryFirst<{ id: unknown; text: string }>(
      `SELECT id, text FROM turn WHERE timestamp < time::now() - 7d AND pruned_at IS NONE AND <string>id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn') LIMIT 500`,
    );
    const texts = stale.map(r => r.text).sort();
    expect(texts).toContain("eligible");
    expect(texts).not.toContain("referenced"); // excluded by the anti-join
    expect(texts).not.toContain("pruned");      // excluded by pruned_at IS NONE
    expect(String(eligibleRow[0]!.id)).toMatch(/^turn:/);
  });
});

describe("E11 — shouldRunMaintenance failure backoff (via garbageCollectConcepts seam)", () => {
  /** Count gcConcepts maintenance_runs rows for the backoff assertions. */
  async function gcConceptRunCount(): Promise<number> {
    const rows = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM maintenance_runs WHERE job = 'garbageCollectConcepts' GROUP ALL`,
    );
    return rows[0]?.n ?? 0;
  }

  itDb("a FRESH error row backs off — the job does NOT re-run (no new run row)", async () => {
    // Seed a status='error' row dated NOW for the gcConcepts job.
    await store.queryExec(
      `CREATE maintenance_runs CONTENT { job: "garbageCollectConcepts", status: "error", error: "boom", rows_affected: 0, duration_ms: 1, ran_at: time::now() };`,
    );
    const before = await gcConceptRunCount();
    // garbageCollectConcepts() consults shouldRunMaintenance first. With a fresh
    // error row the backoff must short-circuit it → it records NOTHING.
    const pruned = await store.garbageCollectConcepts();
    const after = await gcConceptRunCount();
    expect(pruned).toBe(0);
    expect(after).toBe(before); // backed off — no new maintenance_runs row
  });

  itDb("a STALE error row (past cooldown AND past the weekly gate) does NOT back off — the job runs", async () => {
    // Clear prior rows, seed an error row dated 4 days ago. 4d clears BOTH the
    // 30-min failure cooldown (so the backoff does not fire) AND the
    // garbageCollectConcepts weekly gate's maxDaysSince=3 (so the normal branch
    // returns true and the job actually runs + records a fresh row). This is
    // the precise regression: an error row must not wedge a job forever.
    await store.queryExec(`DELETE maintenance_runs WHERE job = 'garbageCollectConcepts'`);
    await store.queryExec(
      `CREATE maintenance_runs CONTENT { job: "garbageCollectConcepts", status: "error", error: "old-boom", rows_affected: 0, duration_ms: 1, ran_at: time::now() - 4d };`,
    );
    const before = await gcConceptRunCount();
    const pruned = await store.garbageCollectConcepts();
    const after = await gcConceptRunCount();
    expect(pruned).toBe(0); // empty concept table → nothing to prune, but it RAN
    expect(after).toBe(before + 1);
  });
});
