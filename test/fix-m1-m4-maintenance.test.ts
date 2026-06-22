/**
 * M1 + M4 maintenance-completeness lane.
 *
 * M1 — embedding backfill was hard-capped at LIMIT 50/table/6h, so a 100k
 * backlog (after restore-jsonl / bulk import / embedder-down) took
 * weeks-to-months to converge, during which those rows are invisible to vector
 * search. Fix: the per-cycle batch is ADAPTIVE to the live unembedded backlog —
 * a big backlog scales the LIMIT up (bounded by a safety ceiling), while the
 * steady-state trickle keeps the small LIMIT.
 *
 * M4 — compaction_checkpoint (one row per compaction per session) had NO
 * retention + no created_at index, so it grew forever on a long-lived per-host
 * daemon. Fix: purgeOldCompactionCheckpoints (telemetry DELETE-ok, retain by
 * created_at, mirrors purgeOldMaintenanceRuns) + a cc_created_idx index, wired
 * into the 6h Group-1 maintenance Promise.all.
 *
 * M1 is driven LIVE through runEmbeddingBackfills against a mock store/embedder
 * so we observe the actual LIMIT chosen per backlog. M4 mixes a live
 * runBootstrapMaintenance call (asserting the purge is invoked) with
 * static-source assertions for the DELETE shape + schema index (the store
 * method lives on SurrealStore, which needs a real SurrealDB to instantiate —
 * exactly the pattern fix-db1-indexes-retention.test.ts uses).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { GlobalPluginState } from "../src/engine/state.js";

const maintenanceSrc = readFileSync(new URL("../src/engine/maintenance.ts", import.meta.url), "utf8");
const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");

async function importMaintenance() {
  return await import("../src/engine/maintenance.js");
}

/** Pull the integer LIMIT out of a backfill SELECT against a given table. */
function limitForTable(calls: Array<[string, ...unknown[]]>, table: string): number | null {
  for (const c of calls) {
    const sql = typeof c[0] === "string" ? c[0] : "";
    if (sql.includes(`FROM ${table}\n`) && /LIMIT\s+(\d+)/.test(sql) && sql.includes("embedding IS NONE")) {
      return Number(sql.match(/LIMIT\s+(\d+)/)![1]);
    }
  }
  return null;
}

/**
 * Build a mock state whose `concept` table reports `gap` unembedded rows and
 * whose backfill SELECT returns `returned` rows once then nothing (so the
 * adaptive loop terminates). The other six backfilled tables report 0 backlog.
 * Captures every queryFirst SELECT so the test can read the LIMIT actually used.
 */
function makeState(opts: { gap: number; returned: number }) {
  const selectCalls: Array<[string, ...unknown[]]> = [];
  let conceptServed = false;
  const queryFirst = vi.fn(async (sql: string) => {
    selectCalls.push([sql]);
    // Adaptive backlog count (countUnembedded): GROUP ALL count() for concept.
    if (sql.includes("FROM concept") && sql.includes("count() AS n") && sql.includes("GROUP ALL")) {
      // Report the backlog the first time; after the batch "drains", report 0
      // so runBackfillBatched's loop exits.
      return conceptServed ? [{ n: 0 }] : [{ n: opts.gap }];
    }
    // Concept backfill row SELECT — serve `returned` rows once, then empty.
    if (sql.includes("SELECT id, content, name, embedding_target FROM concept")) {
      if (conceptServed) return [];
      conceptServed = true;
      return Array.from({ length: opts.returned }, (_, i) => ({
        id: `concept:row${i}`,
        content: `c${i}`,
      }));
    }
    // Every other table reports an empty backlog so its backfill no-ops fast.
    return [];
  });
  const queryExec = vi.fn(async () => undefined);
  const state = {
    store: { isAvailable: () => true, queryFirst, queryExec },
    embeddings: { isAvailable: () => true, embed: async () => [0.1, 0.2, 0.3] },
  } as unknown as GlobalPluginState;
  return { state, selectCalls, queryFirst, queryExec };
}

describe("M1 — adaptive embedding backfill batch size", () => {
  it("uses a LARGE LIMIT when the backlog is large (scales up past the steady 50)", async () => {
    const { runEmbeddingBackfills } = await importMaintenance();
    // 100k backlog — the exact restore-jsonl / bulk-import scenario M1 targets.
    const { state, selectCalls } = makeState({ gap: 100_000, returned: 2_000 });
    await runEmbeddingBackfills(state);
    const limit = limitForTable(selectCalls, "concept");
    expect(limit, "concept backfill SELECT must have run").not.toBeNull();
    // Must be far above the old hard-coded 50 — otherwise a big backlog still
    // takes months. (The adaptive ceiling is 2000.)
    expect(limit!).toBeGreaterThan(50);
    expect(limit!).toBe(2_000);
  });

  it("keeps the SMALL steady-state LIMIT when the backlog is a trickle", async () => {
    const { runEmbeddingBackfills } = await importMaintenance();
    // 7 unembedded rows — the normal steady-state (a few swallowed embed fails).
    const { state, selectCalls } = makeState({ gap: 7, returned: 7 });
    await runEmbeddingBackfills(state);
    const limit = limitForTable(selectCalls, "concept");
    expect(limit, "concept backfill SELECT must have run").not.toBeNull();
    // Small backlog → batch == backlog (<= steady 50), never inflated to the cap.
    expect(limit!).toBeLessThanOrEqual(50);
    expect(limit!).toBe(7);
  });

  it("is BOUNDED — never exceeds the adaptive ceiling even for an enormous backlog", async () => {
    const { runEmbeddingBackfills } = await importMaintenance();
    // 5 million backlog — a single unbounded batch would block the cycle.
    const { state, selectCalls } = makeState({ gap: 5_000_000, returned: 2_000 });
    await runEmbeddingBackfills(state);
    const limit = limitForTable(selectCalls, "concept");
    expect(limit, "concept backfill SELECT must have run").not.toBeNull();
    // Capped at ADAPTIVE_MAX (2000): the LIMIT must NOT be the raw 5M backlog.
    expect(limit!).toBe(2_000);
    expect(limit!).toBeLessThan(5_000_000);
  });

  it("the steady-state floor (50) and adaptive ceiling (2000) are the documented constants", () => {
    // Guard the two knobs so a future edit can't silently regress the steady
    // trickle to a huge batch or drop the ceiling that keeps a cycle bounded.
    expect(/const STEADY_BATCH = 50;/.test(maintenanceSrc)).toBe(true);
    expect(/const ADAPTIVE_MAX = 2_000;/.test(maintenanceSrc)).toBe(true);
    // The sizer must clamp to ADAPTIVE_MAX (Math.min(gap, ADAPTIVE_MAX)).
    expect(/Math\.min\(gap,\s*ADAPTIVE_MAX\)/.test(maintenanceSrc)).toBe(true);
  });
});

describe("M4 — compaction_checkpoint retention", () => {
  it("purgeOldCompactionCheckpoints is invoked by the Group-1 bootstrap maintenance", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests();

    const purgeOldCompactionCheckpoints = vi.fn(async () => 0);
    const fakeState: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => true,
        queryFirst: vi.fn(async () => []),
        queryExec: vi.fn(async () => undefined),
        runMemoryMaintenance: async () => {},
        archiveOldTurns: async () => {},
        consolidateMemories: async () => {},
        garbageCollectMemories: async () => {},
        garbageCollectConcepts: async () => {},
        purgeStalePendingWork: async () => {},
        purgeOldRetrievalOutcomes: async () => 0,
        purgeOldTurnScores: async () => 0,
        purgeOldMaintenanceRuns: async () => 0,
        purgeOldCompactionCheckpoints,
      } as any,
      embeddings: { isAvailable: () => false, embed: async () => [] } as any,
      config: { thresholds: { acanTrainingThreshold: 1 }, paths: { cacheDir: "/tmp/kc-test-cache" } } as any,
    };

    runBootstrapMaintenance(fakeState as GlobalPluginState);
    await new Promise(r => setTimeout(r, 50));

    expect(purgeOldCompactionCheckpoints).toHaveBeenCalledTimes(1);
  });

  it("purgeOldCompactionCheckpoints deletes the OLDEST rows beyond the retain cap, by created_at", () => {
    // The store method lives on SurrealStore (needs a live DB to instantiate),
    // so assert its shape statically — same approach as fix-db1-indexes-retention.
    const m = surrealSrc.match(/async\s+purgeOldCompactionCheckpoints\s*\([\s\S]*?\n {2}}/);
    expect(m, "purgeOldCompactionCheckpoints body not found").not.toBeNull();
    const body = m![0];
    // Oldest-first retention: keep newest RETAIN, find cutoff via DESC + START.
    expect(/ORDER BY created_at DESC/.test(body)).toBe(true);
    expect(/START\s+\$\{RETAIN\}|START\s+RETAIN|START\s+\d/.test(body)).toBe(true);
    // Hard-DELETE older rows by the created_at cutoff (telemetry, D4-exempt).
    expect(/DELETE\s+compaction_checkpoint\s+WHERE\s+created_at\s*<\s*\$cutoff/.test(body)).toBe(true);
    // Only-when-over-target guard so it doesn't churn at the bound.
    expect(/count\s*<=\s*RETAIN/.test(body)).toBe(true);
    // Records the run for the time-relative maintenance gate, like its siblings.
    expect(/recordMaintenanceRun\("purgeOldCompactionCheckpoints"/.test(body)).toBe(true);
  });

  it("purgeOldCompactionCheckpoints is wired into the Group-1 bootstrap Promise.all", () => {
    const groupOne = maintenanceSrc.slice(
      maintenanceSrc.indexOf("Promise.all(["),
      maintenanceSrc.indexOf("]).then("),
    );
    expect(groupOne.length).toBeGreaterThan(0);
    expect(/store\.purgeOldCompactionCheckpoints\(\)/.test(groupOne)).toBe(true);
    // Sits with its telemetry-purge siblings.
    expect(/store\.purgeOldMaintenanceRuns\(\)/.test(groupOne)).toBe(true);
  });

  it("compaction_checkpoint has a created_at index (cc_created_idx)", () => {
    const re = /DEFINE INDEX[^\n]*\bON\s+compaction_checkpoint\s+FIELDS\s+created_at\b/;
    expect(re.test(schemaSrc)).toBe(true);
  });

  it("compaction_checkpoint is NOT a D4 content table, so DELETE is lint-legal", () => {
    // The retention DELETE depends on compaction_checkpoint being telemetry
    // (absent from the no-DELETE-content-tables list), like turn_score /
    // maintenance_runs. Catch a future change that moves it under the keystone.
    const lintSrc = readFileSync(
      new URL("../test/lint-no-delete-content-tables.test.ts", import.meta.url),
      "utf8",
    );
    const m = lintSrc.match(/const CONTENT_TABLES\s*=\s*\[([\s\S]*?)\]/);
    expect(m, "CONTENT_TABLES list not found in D4 lint").not.toBeNull();
    const tables = new Set([...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
    expect(tables.has("compaction_checkpoint")).toBe(false);
  });
});
