/**
 * Tests for src/engine/observability.ts — E2 trends + E3 anomaly detection
 * shipped in v0.5.0.
 *
 * Coverage:
 *   - rollupDailyMetrics: idempotent UPSERT keyed on day, handles empty days
 *   - computeTrends: aggregates rollups + computes window summary
 *   - detectAnomalies: each absolute-threshold detector + cooldown behavior
 *   - formatAnomalyBlock: emits a [kongcode-alert] block when flags exist
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeTrends,
  detectAnomalies,
  formatAnomalyBlock,
  makeCooldownState,
  resetAnomalyCache,
  rollupDailyMetrics,
  type AnomalyFlag,
  type DailyRollup,
} from "../src/engine/observability.js";
import { getTransformErrorRate, recordTransformOutcome, resetTransformErrorRate } from "../src/engine/graph-context.js";

function mockStore(handlers: {
  metricsRollup?: { n: number; mean_tc?: number; mean_dur?: number; mean_in?: number; mean_out?: number; p95_dur?: number; p95_in?: number; fast_n?: number };
  retrievalRollup?: { n: number; mean_util?: number; tool_fails?: number; tool_total?: number };
  artifactGap?: { total: number; embedded: number };
  pendingWork?: { n: number; oldest: string };
  pendingWorkPurged?: { total_purged: number };
  pendingWorkAging?: { n: number; oldest: string | null };
  trends?: DailyRollup[];
  graduation?: { ready: boolean; qualityScore: number; volumeScore: number; stage: string; diagnostics: { suggestion?: string }[] };
}) {
  return {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql: string) => {
      if (sql.includes("FROM orchestrator_metrics") && sql.includes("math::mean(actual_tool_calls)")) {
        const m = handlers.metricsRollup;
        return m ? [m] : [];
      }
      if (sql.includes("FROM retrieval_outcome") && sql.includes("count(tool_success = false)")) {
        const r = handlers.retrievalRollup;
        return r ? [r] : [];
      }
      if (sql.includes("FROM orchestrator_metrics_daily") && sql.includes("ORDER BY day")) {
        return handlers.trends ?? [];
      }
      if (sql.includes("FROM artifact") && sql.includes("count(embedding != NONE)")) {
        return handlers.artifactGap ? [handlers.artifactGap] : [];
      }
      if (sql.includes("FROM pending_work") && sql.includes("status = \"pending\"") && sql.includes("created_at < time::now() - 5d")) {
        const a = handlers.pendingWorkAging;
        if (!a || a.n === 0) return [];
        return [{ n: a.n, oldest: a.oldest }];
      }
      if (sql.includes("FROM pending_work") && sql.includes("status = \"pending\"")) {
        return handlers.pendingWork ? [handlers.pendingWork] : [];
      }
      if (sql.includes("FROM maintenance_runs") && sql.includes("purgeStalePendingWork")) {
        return handlers.pendingWorkPurged ? [handlers.pendingWorkPurged] : [];
      }
      return [];
    }),
    queryExec: vi.fn(async () => {}),
  };
}

describe("rollupDailyMetrics", () => {
  it("writes a daily row when raw metrics exist", async () => {
    const store = mockStore({
      metricsRollup: { n: 10, mean_tc: 5.5, mean_dur: 2000, mean_in: 1200, mean_out: 400, p95_dur: 4000, p95_in: 3000, fast_n: 6 },
      retrievalRollup: { n: 25, mean_util: 0.21, tool_fails: 1, tool_total: 22 },
    });
    await rollupDailyMetrics(store as any, "2026-04-25");
    expect(store.queryExec).toHaveBeenCalled();
    const sql = store.queryExec.mock.calls[0][0];
    expect(sql).toContain("orchestrator_metrics_daily");
    expect(sql).toContain("UPDATE");
  });

  it("skips when no raw metrics for the day", async () => {
    const store = mockStore({ metricsRollup: { n: 0 } });
    await rollupDailyMetrics(store as any, "2026-04-20");
    expect(store.queryExec).not.toHaveBeenCalled();
  });

  it("returns silently when store is unavailable", async () => {
    const store = { isAvailable: () => false, queryFirst: vi.fn(), queryExec: vi.fn() };
    await rollupDailyMetrics(store as any, "2026-04-25");
    expect(store.queryFirst).not.toHaveBeenCalled();
  });
});

describe("computeTrends", () => {
  it("returns empty report when no daily rollups exist", async () => {
    const store = mockStore({ trends: [] });
    const t = await computeTrends(store as any, 7);
    expect(t.window_days).toBe(7);
    expect(t.rollups).toEqual([]);
    expect(t.summary.avg_turns_per_day).toBe(0);
  });

  it("computes window summary from rollups", async () => {
    const rollups: DailyRollup[] = [
      { day: "2026-04-24", turn_count: 10, mean_tool_calls: 5, mean_turn_duration_ms: 1000, mean_tokens_in: 800, mean_tokens_out: 200, p95_turn_duration_ms: 2000, p95_tokens_in: 1500, fast_path_rate: 0.6, mean_retrieval_util: 0.2, tool_failure_rate: 0.05, retrieval_outcome_count: 20 },
      { day: "2026-04-25", turn_count: 20, mean_tool_calls: 7, mean_turn_duration_ms: 1500, mean_tokens_in: 1200, mean_tokens_out: 400, p95_turn_duration_ms: 3000, p95_tokens_in: 2500, fast_path_rate: 0.7, mean_retrieval_util: 0.3, tool_failure_rate: 0.02, retrieval_outcome_count: 40 },
    ];
    const store = mockStore({ trends: rollups });
    const t = await computeTrends(store as any, 7);
    expect(t.rollups.length).toBe(2);
    expect(t.summary.avg_turns_per_day).toBe(15);
    expect(t.summary.avg_tool_calls).toBe(6);
    expect(t.summary.avg_retrieval_util).toBeCloseTo(0.25, 2);
  });
});

describe("detectAnomalies", () => {
  let cooldown: ReturnType<typeof makeCooldownState>;

  beforeEach(() => {
    cooldown = makeCooldownState();
    resetAnomalyCache();
  });

  it("fires substrate.embedding_gap when gap > 10%", async () => {
    const store = mockStore({
      artifactGap: { total: 1000, embedded: 800 }, // 20% gap
    });
    const flags = await detectAnomalies(store as any, cooldown);
    const gap = flags.find(f => f.code === "substrate.embedding_gap");
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("warn");
    expect(gap!.message).toContain("20.0%");
  });

  it("does NOT fire embedding_gap when gap ≤ 10%", async () => {
    const store = mockStore({ artifactGap: { total: 1000, embedded: 950 } }); // 5%
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.embedding_gap")).toBeUndefined();
  });

  it("fires substrate.pending_work_buildup when count >50 AND oldest >24h", async () => {
    const oldEnough = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const store = mockStore({ pendingWork: { n: 75, oldest: oldEnough } });
    const flags = await detectAnomalies(store as any, cooldown);
    const buildup = flags.find(f => f.code === "substrate.pending_work_buildup");
    expect(buildup).toBeDefined();
    expect(buildup!.message).toContain("75");
  });

  it("does NOT fire pending_work_buildup when oldest is fresh", async () => {
    const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const store = mockStore({ pendingWork: { n: 100, oldest: fresh } });
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.pending_work_buildup")).toBeUndefined();
  });

  it("respects cooldown — same warn flag does NOT re-fire within 24h", async () => {
    const store = mockStore({ artifactGap: { total: 1000, embedded: 800 } });
    const first = await detectAnomalies(store as any, cooldown);
    const second = await detectAnomalies(store as any, cooldown);
    expect(first.find(f => f.code === "substrate.embedding_gap")).toBeDefined();
    expect(second.find(f => f.code === "substrate.embedding_gap")).toBeUndefined();
  });

  it("returns empty array when store unavailable", async () => {
    const store = { isAvailable: () => false, queryFirst: vi.fn(), queryExec: vi.fn() };
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags).toEqual([]);
  });

  // 0.7.37: replaced post-mortem `pending_work_purged` with pre-purge
  // `pending_work_aging`. The old detector fired AFTER data was deleted,
  // which gave the user no actionable runway. The new detector fires
  // when items are 5+ days old, ~2 days before the 7d purge runs.
  it("fires substrate.pending_work_aging when items older than 5d exist", async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const store = mockStore({ pendingWorkAging: { n: 8, oldest: sixDaysAgo } });
    const flags = await detectAnomalies(store as any, cooldown);
    const aging = flags.find(f => f.code === "substrate.pending_work_aging");
    expect(aging).toBeDefined();
    expect(aging!.severity).toBe("warn");
    expect(aging!.message).toContain("8 pending_work");
    expect(aging!.message).toMatch(/will purge in [\d.]+d/);
    expect(aging!.evidence).toContain("count=8");
  });

  it("does NOT fire pending_work_aging when no items older than 5d", async () => {
    const store = mockStore({ pendingWorkAging: { n: 0, oldest: null } });
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.pending_work_aging")).toBeUndefined();
  });
});

describe("getTransformErrorRate", () => {
  beforeEach(() => { resetTransformErrorRate(); });

  it("returns zero rate when no calls recorded", () => {
    const r = getTransformErrorRate();
    expect(r.total).toBe(0);
    expect(r.failures).toBe(0);
    expect(r.rate).toBe(0);
  });

  it("tracks successes and failures", () => {
    recordTransformOutcome(true);
    recordTransformOutcome(true);
    recordTransformOutcome(false);
    const r = getTransformErrorRate();
    expect(r.total).toBe(3);
    expect(r.failures).toBe(1);
    expect(r.rate).toBeCloseTo(1 / 3, 2);
  });

  it("100% failure rate when all calls fail", () => {
    for (let i = 0; i < 5; i++) recordTransformOutcome(false);
    const r = getTransformErrorRate();
    expect(r.total).toBe(5);
    expect(r.failures).toBe(5);
    expect(r.rate).toBe(1);
  });
});

describe("detectContextTransformFailures", () => {
  let cooldown: ReturnType<typeof makeCooldownState>;

  beforeEach(() => {
    cooldown = makeCooldownState();
    resetTransformErrorRate();
    resetAnomalyCache();
  });

  it("fires substrate.context_transform_failures at high failure rate", async () => {
    for (let i = 0; i < 10; i++) recordTransformOutcome(false);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    const ctf = flags.find(f => f.code === "substrate.context_transform_failures");
    expect(ctf).toBeDefined();
    expect(ctf!.severity).toBe("critical");
    expect(ctf!.message).toContain("100%");
  });

  it("does NOT fire when failure rate is low", async () => {
    for (let i = 0; i < 8; i++) recordTransformOutcome(true);
    recordTransformOutcome(false);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.context_transform_failures")).toBeUndefined();
  });

  it("does NOT fire with fewer than 3 total calls", async () => {
    recordTransformOutcome(false);
    recordTransformOutcome(false);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.context_transform_failures")).toBeUndefined();
  });

  it("fires as warn when rate is between 30-80%", async () => {
    for (let i = 0; i < 4; i++) recordTransformOutcome(true);
    for (let i = 0; i < 4; i++) recordTransformOutcome(false);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    const ctf = flags.find(f => f.code === "substrate.context_transform_failures");
    expect(ctf).toBeDefined();
    expect(ctf!.severity).toBe("warn");
  });
});

describe("formatAnomalyBlock", () => {
  it("returns empty string when no flags", () => {
    expect(formatAnomalyBlock([])).toBe("");
  });

  it("emits a kongcode-alert block with severity markers", () => {
    const flags: AnomalyFlag[] = [
      { code: "substrate.x", severity: "critical", message: "broken", evidence: "n=0", suggestion: "restart" },
      { code: "gate.close", severity: "info", message: "close", evidence: "q=0.84" },
    ];
    const block = formatAnomalyBlock(flags);
    expect(block).toContain("<kongcode-alert>");
    expect(block).toContain("</kongcode-alert>");
    expect(block).toContain("[!!] substrate.x: broken");
    expect(block).toContain("[info] gate.close: close");
    expect(block).toContain("suggestion: restart");
  });
});
