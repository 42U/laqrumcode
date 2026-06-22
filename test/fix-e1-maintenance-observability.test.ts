/**
 * E1 / E6 / E7 — maintenance observability + bounded content-table retention.
 *
 * Regression coverage for the enterprise-readiness "observability" lane:
 *
 *  E1: maintenance was SILENTLY invisible. recordMaintenanceRun was the last
 *      statement in each surreal.ts try block (a throw recorded nothing),
 *      maintenance.ts orchestration jobs recorded nothing at all, and
 *      memory_health never READ maintenance_runs — so a job that always-throws
 *      was indistinguishable from never-ran/succeeded and health stayed green.
 *      Fix: runJob(state, name, fn) ALWAYS writes a maintenance_runs row in a
 *      finally (status 'ok'|'error' + error msg, swallows the throw); the schema
 *      gains status+error; memory_health reads the latest row per job and pushes
 *      a red diagnostic for any job whose newest row is status='error'.
 *
 *  E6/E7: monologue + turn_archive grew UNBOUNDED. Both ARE content tables
 *      (gc.ts GC_CONTENT_TABLES + the D4 lint), so the new count-gated retention
 *      purges MUST route through the gcHardDelete keystone (snapshot + edge
 *      co-delete + after-verify), never a plain DELETE — and must be bounded.
 *
 * Pure unit tests (no live SurrealDB): runJob is exported; the purges are
 * exercised through the public runBootstrapMaintenance seam with gc.js mocked,
 * exactly like maintenance-queries.test.ts drives the backfills.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";
import { SurrealStore } from "../src/engine/surreal.js";

// Mock the keystone so we can assert the purges ROUTE THROUGH it (and never a
// plain DELETE). gcSweepOrphanedEdges is also imported by maintenance.ts, so it
// must be present in the mock too.
vi.mock("../src/engine/gc.js", () => ({
  gcHardDelete: vi.fn(async (_state: unknown, _table: string, ids: string[]) => ({
    deleted: ids.length,
    edgesRemoved: 0,
    snapshot: "/tmp/snap.surql",
  })),
  gcSweepOrphanedEdges: vi.fn(async () => ({
    scanned: 0, orphaned: 0, removed: 0, perTable: {}, snapshot: "", dryRun: false,
  })),
}));

async function importMaintenance() {
  return await import("../src/engine/maintenance.js");
}
async function importGc() {
  return await import("../src/engine/gc.js");
}

// ---------------------------------------------------------------------------
// E1 — runJob ALWAYS records, with the right status.
// ---------------------------------------------------------------------------
describe("E1 runJob — always records a maintenance_runs row", () => {
  it("records status='ok' + rows_affected on success", async () => {
    const { runJob } = await importMaintenance();
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const state = {
      store: { isAvailable: () => true, queryExec },
    } as unknown as GlobalPluginState;

    await runJob(state, "myJob", async () => 7);

    expect(queryExec).toHaveBeenCalledTimes(1);
    const [sql, bind] = queryExec.mock.calls[0]!;
    expect(sql).toContain("CREATE maintenance_runs CONTENT");
    const data = (bind as { data: Record<string, unknown> }).data;
    expect(data.job).toBe("myJob");
    expect(data.status).toBe("ok");
    expect(data.rows_affected).toBe(7);
    expect(data.error).toBeUndefined();
    expect(typeof data.duration_ms).toBe("number");
  });

  it("records status='error' + error message on throw, and SWALLOWS the throw", async () => {
    const { runJob } = await importMaintenance();
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const state = {
      store: { isAvailable: () => true, queryExec },
    } as unknown as GlobalPluginState;

    // Must NOT reject — runJob swallows so the cycle continues.
    await expect(
      runJob(state, "throwyJob", async () => { throw new Error("boom-detail"); }),
    ).resolves.toBeUndefined();

    expect(queryExec).toHaveBeenCalledTimes(1);
    const data = (queryExec.mock.calls[0]![1] as { data: Record<string, unknown> }).data;
    expect(data.job).toBe("throwyJob");
    expect(data.status).toBe("error");
    expect(String(data.error)).toContain("boom-detail");
    expect(data.rows_affected).toBe(0);
  });

  it("truncates a very long error to 300 chars", async () => {
    const { runJob } = await importMaintenance();
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const state = {
      store: { isAvailable: () => true, queryExec },
    } as unknown as GlobalPluginState;

    const long = "x".repeat(5000);
    await runJob(state, "longErr", async () => { throw new Error(long); });
    const data = (queryExec.mock.calls[0]![1] as { data: Record<string, unknown> }).data;
    expect(String(data.error).length).toBe(300);
  });

  it("skips the audit write when the store is unavailable (cannot record)", async () => {
    const { runJob } = await importMaintenance();
    const queryExec = vi.fn();
    const state = {
      store: { isAvailable: () => false, queryExec },
    } as unknown as GlobalPluginState;

    await runJob(state, "noStore", async () => 1);
    expect(queryExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E6 / E7 — purges route through the keystone and are bounded.
// ---------------------------------------------------------------------------
describe("E6/E7 — monologue + turn_archive retention via gcHardDelete keystone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Build a fake store whose monologue/turn_archive counts are OVER the
   *  retention target so the purges fire, and whose `SELECT id ... ORDER BY` for
   *  those tables returns one full batch then drains. Everything else returns
   *  []/0 so the rest of bootstrap maintenance no-ops. */
  function makeState() {
    // Track how many id-batches each table has served so it drains.
    const served: Record<string, number> = { monologue: 0, turn_archive: 0 };
    const queryFirst = vi.fn(async (sql: string) => {
      // Counts: report 32k monologue (>30k+5k slack) and 110k turn_archive
      // (>100k+5k slack) so both purges trip.
      if (sql.includes("count() AS n FROM monologue")) return [{ n: 36_000 }];
      if (sql.includes("count() AS n FROM turn_archive")) return [{ n: 110_000 }];
      // Oldest-first id batches for the two purges — serve exactly ONE batch of
      // valid record ids, then [] so the loop terminates.
      if (sql.includes("SELECT id FROM monologue ORDER BY")) {
        if (served.monologue++ > 0) return [];
        return [{ id: "monologue:a1" }, { id: "monologue:a2" }];
      }
      if (sql.includes("SELECT id FROM turn_archive ORDER BY")) {
        if (served.turn_archive++ > 0) return [];
        return [{ id: "turn_archive:b1" }, { id: "turn_archive:b2" }];
      }
      return [];
    });
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const state: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => true,
        queryFirst,
        queryExec,
        runMemoryMaintenance: async () => {},
        purgeStalePendingWork: async () => {},
        purgeOldRetrievalOutcomes: async () => 0,
        purgeOldTurnScores: async () => 0,
        purgeOldMaintenanceRuns: async () => 0,
        archiveOldTurns: async () => 0,
        garbageCollectMemories: async () => 0,
        garbageCollectConcepts: async () => 0,
        consolidateMemories: async () => 0,
      } as any,
      embeddings: { isAvailable: () => true, embed: async () => [] } as any,
      config: { thresholds: { acanTrainingThreshold: 1 }, paths: { cacheDir: "/tmp/kc-cache" } } as any,
    };
    return { state: state as GlobalPluginState, queryFirst, queryExec, served };
  }

  it("routes monologue + turn_archive deletes through gcHardDelete (never a plain DELETE)", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    const { gcHardDelete } = await importGc();
    __resetBootstrapMaintenanceForTests();

    const { state, queryExec } = makeState();
    runBootstrapMaintenance(state);
    // Group 1 fires the purges in a Promise.all; wait for it to settle.
    await new Promise(r => setTimeout(r, 50));

    const calls = (gcHardDelete as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const tables = calls.map(c => c[1]);
    expect(tables).toContain("monologue");
    expect(tables).toContain("turn_archive");

    // The ids passed are well-formed record ids of the right table.
    const monoCall = calls.find(c => c[1] === "monologue")!;
    expect(monoCall[2]).toEqual(["monologue:a1", "monologue:a2"]);
    const archCall = calls.find(c => c[1] === "turn_archive")!;
    expect(archCall[2]).toEqual(["turn_archive:b1", "turn_archive:b2"]);
    // A non-empty reason is supplied (gcHardDelete requires it).
    expect(String(monoCall[3]?.reason ?? "")).not.toBe("");

    // CRITICAL: no plain DELETE on a content table was issued. The purges must
    // go through the keystone, not queryExec(DELETE monologue / turn_archive).
    for (const [sql] of queryExec.mock.calls) {
      if (typeof sql !== "string") continue;
      expect(sql).not.toMatch(/\bDELETE\s+(?:FROM\s+)?monologue\b/);
      expect(sql).not.toMatch(/\bDELETE\s+(?:FROM\s+)?turn_archive\b/);
    }
  });

  it("is a no-op when the table is within the retention target (no keystone call)", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    const { gcHardDelete } = await importGc();
    __resetBootstrapMaintenanceForTests();

    const queryFirst = vi.fn(async (sql: string) => {
      // Both tables comfortably UNDER target+slack → purges must not delete.
      if (sql.includes("count() AS n FROM monologue")) return [{ n: 10 }];
      if (sql.includes("count() AS n FROM turn_archive")) return [{ n: 10 }];
      return [];
    });
    const state: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => true,
        queryFirst,
        queryExec: vi.fn().mockResolvedValue(undefined),
        runMemoryMaintenance: async () => {},
        purgeStalePendingWork: async () => {},
        purgeOldRetrievalOutcomes: async () => 0,
        purgeOldTurnScores: async () => 0,
        purgeOldMaintenanceRuns: async () => 0,
        archiveOldTurns: async () => 0,
        garbageCollectMemories: async () => 0,
        garbageCollectConcepts: async () => 0,
        consolidateMemories: async () => 0,
      } as any,
      embeddings: { isAvailable: () => true, embed: async () => [] } as any,
      config: { thresholds: { acanTrainingThreshold: 1 }, paths: { cacheDir: "/tmp/kc-cache" } } as any,
    };

    runBootstrapMaintenance(state as GlobalPluginState);
    await new Promise(r => setTimeout(r, 50));

    const calls = (gcHardDelete as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.find(c => c[1] === "monologue")).toBeUndefined();
    expect(calls.find(c => c[1] === "turn_archive")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E1 — memory_health surfaces a diagnostic when a job's latest row is 'error'.
// ---------------------------------------------------------------------------
describe("E1 memory_health — reads maintenance_runs and surfaces job failures", () => {
  it("pushes a red/error diagnostic for a job whose newest run is status='error'", async () => {
    const { handleMemoryHealth } = await import("../src/tools/memory-health.js");

    const queryFirst = vi.fn(async (sql: string) => {
      // The maintenance_runs read — newest-first; purgeStaleEmbedCache last
      // failed (and an older ok row exists, which must NOT win).
      if (sql.includes("FROM maintenance_runs ORDER BY ran_at DESC")) {
        return [
          { job: "purgeStaleEmbedCache", status: "error", error: "Unexpected token LIMIT", ran_at: "2026-06-21T10:00:00Z" },
          { job: "purgeStaleEmbedCache", status: "ok", ran_at: "2026-06-20T10:00:00Z" },
          { job: "runMemoryMaintenance", status: "ok", ran_at: "2026-06-21T09:00:00Z" },
        ];
      }
      // Index-sanity probe: indexed vs NOINDEX must AGREE (return same shape).
      if (sql.includes("ORDER BY timestamp ASC LIMIT 1")) return [];
      // All count() queries → 0 (keeps embedding-gap etc. quiet).
      return [{ n: 0 }];
    });

    const state = {
      store: {
        ping: async () => true,
        isAvailable: () => true,
        queryFirst,
      },
      embeddings: { isAvailable: () => true, embed: async () => [0.1, 0.2] },
    } as unknown as GlobalPluginState;

    const res = await handleMemoryHealth(state, {} as SessionState, {});
    const report = JSON.parse(res.content[0]!.text) as {
      status: string;
      diagnostics: Array<{ severity: string; area: string; message: string }>;
    };

    const maint = report.diagnostics.filter(d => d.area === "maintenance" && d.severity === "error");
    expect(maint.length).toBe(1);
    expect(maint[0]!.message).toContain("purgeStaleEmbedCache");
    expect(maint[0]!.message).toContain("Unexpected token LIMIT");
    // An error-severity diagnostic forces overall RED.
    expect(report.status).toBe("red");
  });

  it("stays green when every job's newest run is status='ok'", async () => {
    const { handleMemoryHealth } = await import("../src/tools/memory-health.js");

    const now = new Date().toISOString();
    const queryFirst = vi.fn(async (sql: string) => {
      if (sql.includes("FROM maintenance_runs ORDER BY ran_at DESC")) {
        // Recent 'ok' rows for ALL recurring jobs memory_health watches — so the
        // "no row within ~2x cadence" yellow does not fire. (distMtimeAtStartup
        // in a test points at an old binary, so daemonUpMs is large and the
        // staleness check IS evaluated; a healthy daemon has these rows.)
        return [
          { job: "purgeStaleEmbedCache", status: "ok", ran_at: now },
          { job: "purgeOldMonologue", status: "ok", ran_at: now },
          { job: "purgeOldTurnArchive", status: "ok", ran_at: now },
          { job: "sweepOrphanedEdges", status: "ok", ran_at: now },
          { job: "runEmbeddingBackfills", status: "ok", ran_at: now },
          { job: "runMemoryMaintenance", status: "ok", ran_at: now },
        ];
      }
      if (sql.includes("ORDER BY timestamp ASC LIMIT 1")) return [];
      return [{ n: 0 }];
    });

    const state = {
      store: { ping: async () => true, isAvailable: () => true, queryFirst },
      embeddings: { isAvailable: () => true, embed: async () => [0.1, 0.2] },
    } as unknown as GlobalPluginState;

    const res = await handleMemoryHealth(state, {} as SessionState, {});
    const report = JSON.parse(res.content[0]!.text) as {
      status: string;
      diagnostics: Array<{ severity: string; area: string }>;
    };
    expect(report.diagnostics.some(d => d.area === "maintenance" && d.severity === "error")).toBe(false);
    expect(report.status).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// LIVE-DB smoke (skips without SurrealDB, like observability.test.ts). Proves
// the schema changes APPLY and the exact SurrealQL the purges emit PARSES on a
// real SurrealDB — guarding the silent-parse-error class (GH #17) that the
// LIMIT-on-UPDATE bug was. The vi.mock on gc.js does NOT affect surreal.js, so
// the store is real here.
// ---------------------------------------------------------------------------
const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "kong_test";
const TEST_DB = `e1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let liveStore: SurrealStore;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  liveStore = new SurrealStore({
    url,
    get httpUrl() { return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: process.env.SURREAL_USER ?? "root",
    pass: process.env.SURREAL_PASS ?? "root",
    ns: TEST_NS,
    db: TEST_DB,
  } as any);
  try {
    await Promise.race([
      liveStore.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 10_000)),
    ]);
  } catch {
    liveStore = undefined as any;
  }
}, 15_000);

afterAll(async () => {
  if (!liveStore) return;
  try { await liveStore.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await liveStore.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => { if (SKIP || !liveStore?.isAvailable()) return; await fn(); }, timeout);
}

describe("E1/E6/E7 live-DB smoke", () => {
  itDb("maintenance_runs accepts status+error, and a row without status reads DEFAULT 'ok'", async () => {
    // E1 schema: status + error fields exist (DEFINE applied at initialize()).
    await liveStore.queryExec(
      `CREATE maintenance_runs CONTENT { job: "smokeErr", status: "error", error: "boom", rows_affected: 0, duration_ms: 5 };
       CREATE maintenance_runs CONTENT { job: "smokeOk", rows_affected: 3, duration_ms: 9 };`,
    );
    const err = await liveStore.queryFirst<{ status: string; error: string }>(
      `SELECT status, error FROM maintenance_runs WHERE job = "smokeErr" LIMIT 1`,
    );
    expect(err[0]?.status).toBe("error");
    expect(err[0]?.error).toBe("boom");
    // A row created WITHOUT status must read back DEFAULT 'ok' (so the gc.ts
    // audit rows + legacy rows count as healthy, not as a missing-status anomaly).
    const ok = await liveStore.queryFirst<{ status: string }>(
      `SELECT status FROM maintenance_runs WHERE job = "smokeOk" LIMIT 1`,
    );
    expect(ok[0]?.status).toBe("ok");
  });

  itDb("the purge SELECT (ORDER BY timestamp ASC LIMIT N) parses + works on monologue", async () => {
    // E6: monologue_timestamp_idx serves this. Insert 3 rows, oldest-first
    // selection must return the 2 OLDEST in ascending order.
    await liveStore.queryExec(
      `CREATE monologue CONTENT { session_id: "s", category: "c", content: "old", timestamp: time::now() - 3d };
       CREATE monologue CONTENT { session_id: "s", category: "c", content: "mid", timestamp: time::now() - 2d };
       CREATE monologue CONTENT { session_id: "s", category: "c", content: "new", timestamp: time::now() - 1d };`,
    );
    const rows = await liveStore.queryFirst<{ id: unknown; content: string }>(
      `SELECT id, content FROM monologue ORDER BY timestamp ASC LIMIT 2`,
    );
    expect(rows.map(r => r.content)).toEqual(["old", "mid"]);
  });

  itDb("the purge SELECT parses + works on turn_archive (timestamp index applied)", async () => {
    // E7: turn_archive_timestamp_idx serves this; rows carry `timestamp` (copied
    // verbatim from `turn`). Proves the new index DEFINE applied and the ORDER
    // BY parses (turn_archive is SCHEMALESS so a bad field would silently return
    // nothing rather than error — assert it returns the oldest row).
    await liveStore.queryExec(
      `CREATE turn_archive CONTENT { text: "t-old", timestamp: time::now() - 5d };
       CREATE turn_archive CONTENT { text: "t-new", timestamp: time::now() - 1d };`,
    );
    const rows = await liveStore.queryFirst<{ text: string }>(
      `SELECT text FROM turn_archive ORDER BY timestamp ASC LIMIT 1`,
    );
    expect(rows[0]?.text).toBe("t-old");
  });
});
