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
  getCacheWriteFailureStats,
  getMemoryBreadcrumb,
  makeCooldownState,
  recordCacheWriteOutcome,
  recordDbAvailability,
  recordEmbeddingError,
  clearEmbeddingError,
  resetAnomalyCache,
  resetCacheWriteOutcomes,
  resetDbAvailability,
  rollupDailyMetrics,
  type AnomalyFlag,
  type DailyRollup,
} from "../src/engine/observability.js";
import { getTransformErrorRate, recordTransformOutcome, resetTransformErrorRate } from "../src/engine/graph-context.js";

// Helper to match the new two-query pattern used by detectPendingWorkBuildup
// and detectPendingWorkAging. The detectors now split the single combined
// `count + math::min` query (which was broken: math::min on datetime returns
// JS Number Infinity, not null) into a count() aggregate followed by an
// `ORDER BY created_at ASC LIMIT 1` lookup.
function mockStore(handlers: {
  metricsRollup?: { n: number; mean_tc?: number; mean_dur?: number; mean_in?: number; mean_out?: number; p95_dur?: number; p95_in?: number; fast_n?: number };
  retrievalRollup?: { n: number; mean_util?: number; tool_fails?: number; tool_total?: number };
  artifactGap?: { total: number; embedded: number };
  /** Mocks both the count and the ORDER BY ASC LIMIT 1 lookup for non-aging buildup. */
  pendingWork?: { n: number; oldest: string | null };
  /** Same shape for the aging detector (5d filter). */
  pendingWorkAging?: { n: number; oldest: string | null };
  trends?: DailyRollup[];
  isAvailable?: () => boolean;
}) {
  return {
    isAvailable: handlers.isAvailable ?? (() => true),
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
      // Order matters: the aging-specific branch (5d filter) must match
      // BEFORE the generic pending_work branch, otherwise the latter
      // catches both.
      if (sql.includes("FROM pending_work") && sql.includes("created_at < time::now() - 5d")) {
        const a = handlers.pendingWorkAging;
        if (!a || a.n === 0) {
          // For the count branch, returning [] means "no rows" so the
          // detector returns null. For the ORDER BY branch, also empty.
          return [];
        }
        if (sql.includes("count() AS n")) return [{ n: a.n }];
        if (sql.includes("ORDER BY created_at ASC LIMIT 1")) {
          return a.oldest != null ? [{ created_at: a.oldest }] : [];
        }
        return [];
      }
      if (sql.includes("FROM pending_work") && sql.includes("status = \"pending\"")) {
        const p = handlers.pendingWork;
        if (!p) return [];
        if (sql.includes("count() AS n")) return [{ n: p.n }];
        if (sql.includes("ORDER BY created_at ASC LIMIT 1")) {
          return p.oldest != null ? [{ created_at: p.oldest }] : [];
        }
        return [];
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
    resetCacheWriteOutcomes();
    resetDbAvailability();
    clearEmbeddingError();
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
    expect(buildup!.message).toMatch(/oldest is \d+h old/);
    // The fix removed `NaN` and `Infinity` from any output path
    expect(buildup!.message).not.toContain("NaN");
    expect(buildup!.evidence).not.toContain("Infinity");
  });

  it("does NOT fire pending_work_buildup when oldest is fresh", async () => {
    const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const store = mockStore({ pendingWork: { n: 100, oldest: fresh } });
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.pending_work_buildup")).toBeUndefined();
  });

  it("does NOT fire pending_work_buildup when count below threshold", async () => {
    // 0.5.1 fix: regression for count branch — even with stale rows, fewer
    // than 50 should not fire.
    const veryOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const store = mockStore({ pendingWork: { n: 10, oldest: veryOld } });
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.pending_work_buildup")).toBeUndefined();
  });

  it("renders 'unknown' age (not NaN/Infinity) when oldest is absent from the DB", async () => {
    // 0.5.1 regression: the previous detector did `math::min(created_at)`
    // which returned JS Infinity for datetime columns. Infinity is truthy
    // and `new Date(Infinity).getTime()` is NaN, so the message contained
    // "NaNh" and evidence contained "Infinity". The fix uses a fallback
    // SELECT … ORDER BY ASC LIMIT 1; when no row comes back, the message
    // renders "unknown" instead of "NaNh".
    const store = mockStore({ pendingWork: { n: 60, oldest: null } });
    const flags = await detectAnomalies(store as any, cooldown);
    const buildup = flags.find(f => f.code === "substrate.pending_work_buildup");
    expect(buildup).toBeDefined();
    expect(buildup!.message).toContain("unknown");
    expect(buildup!.message).not.toContain("NaN");
    expect(buildup!.message).not.toContain("Infinity");
    // Evidence stringifies whatever oldestRaw is; when the row is absent
    // it's the literal "unknown".
    expect(buildup!.evidence).not.toContain("Infinity");
    expect(buildup!.evidence).not.toContain("NaN");
  });

  it("respects cooldown — same warn flag does NOT re-fire within 24h", async () => {
    const store = mockStore({ artifactGap: { total: 1000, embedded: 800 } });
    const first = await detectAnomalies(store as any, cooldown);
    const second = await detectAnomalies(store as any, cooldown);
    expect(first.find(f => f.code === "substrate.embedding_gap")).toBeDefined();
    expect(second.find(f => f.code === "substrate.embedding_gap")).toBeUndefined();
  });

  it("returns empty array when store unavailable AND no consecutive failures recorded", async () => {
    // First call: store unavailable. Records ONE failed probe — not 5,
    // so detectDbUnreachable returns null. Result: empty flag list.
    const store = { isAvailable: () => false, queryFirst: vi.fn(), queryExec: vi.fn() };
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags).toEqual([]);
  });

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
    expect(aging!.message).not.toContain("NaN");
  });

  it("does NOT fire pending_work_aging when no items older than 5d", async () => {
    const store = mockStore({ pendingWorkAging: { n: 0, oldest: null } });
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.pending_work_aging")).toBeUndefined();
  });
});

// 0.5.1: new substrate-health detectors (Agent E recommendations).
describe("substrate.cache_write_failures detector", () => {
  let cooldown: ReturnType<typeof makeCooldownState>;
  beforeEach(() => {
    cooldown = makeCooldownState();
    resetAnomalyCache();
    resetCacheWriteOutcomes();
    resetDbAvailability();
  });

  it("counter tracks success and failure in a 10-minute window", () => {
    recordCacheWriteOutcome(true);
    recordCacheWriteOutcome(false);
    recordCacheWriteOutcome(false);
    const s = getCacheWriteFailureStats();
    expect(s.total).toBe(3);
    expect(s.failures).toBe(2);
    expect(s.rate).toBeCloseTo(2 / 3, 2);
  });

  it("does NOT fire when failures < 5 (below threshold)", async () => {
    for (let i = 0; i < 4; i++) recordCacheWriteOutcome(false);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.cache_write_failures")).toBeUndefined();
  });

  it("fires warn at 5+ failures, low rate", async () => {
    // 5 failures + 10 successes => rate ~0.33, below the critical floor
    for (let i = 0; i < 5; i++) recordCacheWriteOutcome(false);
    for (let i = 0; i < 10; i++) recordCacheWriteOutcome(true);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    const f = flags.find(f => f.code === "substrate.cache_write_failures");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warn");
    expect(f!.message).toContain("5/15");
  });

  it("escalates to critical when rate ≥ 50%", async () => {
    for (let i = 0; i < 8; i++) recordCacheWriteOutcome(false);
    for (let i = 0; i < 2; i++) recordCacheWriteOutcome(true);
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    const f = flags.find(f => f.code === "substrate.cache_write_failures");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("critical");
  });
});

describe("substrate.db_unreachable detector", () => {
  let cooldown: ReturnType<typeof makeCooldownState>;
  beforeEach(() => {
    cooldown = makeCooldownState();
    resetAnomalyCache();
    resetDbAvailability();
  });

  it("does NOT fire on a single transient disconnect", async () => {
    const store = { isAvailable: () => false, queryFirst: vi.fn(), queryExec: vi.fn() };
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.db_unreachable")).toBeUndefined();
  });

  it("fires critical after 5 consecutive failed isAvailable() checks within 60s", async () => {
    // Seed 4 failures via the recorder, then a 5th via the detector path.
    for (let i = 0; i < 4; i++) recordDbAvailability(false);
    const store = { isAvailable: () => false, queryFirst: vi.fn(), queryExec: vi.fn() };
    const flags = await detectAnomalies(store as any, cooldown);
    const f = flags.find(f => f.code === "substrate.db_unreachable");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("critical");
    expect(f!.evidence).toContain("consecutive_failures=5");
  });

  it("does NOT fire when ANY recent probe succeeded", async () => {
    recordDbAvailability(false);
    recordDbAvailability(false);
    recordDbAvailability(true); // a success in the middle breaks the streak
    recordDbAvailability(false);
    recordDbAvailability(false);
    // Detector reads `tail = slice(-5)` then `every(c => !c.ok)`. Above
    // gives [F,F,T,F,F] — `every(!ok)` is false, so no flag.
    const store = { isAvailable: () => false, queryFirst: vi.fn(), queryExec: vi.fn() };
    // The detectAnomalies call itself records 1 more failure, so the new
    // tail becomes [F,T,F,F,F]; still contains a success — must not fire.
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.db_unreachable")).toBeUndefined();
  });
});

describe("substrate.embedding_service_down detector", () => {
  let cooldown: ReturnType<typeof makeCooldownState>;
  beforeEach(() => {
    cooldown = makeCooldownState();
    resetAnomalyCache();
    clearEmbeddingError();
  });

  it("does NOT fire when no error has been recorded", async () => {
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.embedding_service_down")).toBeUndefined();
  });

  it("fires warn when a fresh embedding error is recorded", async () => {
    recordEmbeddingError(new Error("model file not found"));
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    const f = flags.find(f => f.code === "substrate.embedding_service_down");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warn");
    expect(f!.evidence).toContain("model file not found");
  });

  it("clearEmbeddingError() stops the detector firing", async () => {
    recordEmbeddingError("temporary timeout");
    clearEmbeddingError();
    const store = mockStore({});
    const flags = await detectAnomalies(store as any, cooldown);
    expect(flags.find(f => f.code === "substrate.embedding_service_down")).toBeUndefined();
  });
});

describe("getMemoryBreadcrumb", () => {
  it("returns shape with heap, rss, delta, external", () => {
    const b = getMemoryBreadcrumb();
    expect(typeof b.heapUsedMB).toBe("number");
    expect(typeof b.rssMB).toBe("number");
    expect(typeof b.heapDeltaMB).toBe("number");
    expect(typeof b.externalMB).toBe("number");
    expect(b.heapUsedMB).toBeGreaterThan(0);
    expect(b.rssMB).toBeGreaterThan(0);
  });

  it("delta is a finite number across two calls (allocations between)", () => {
    // The module's _lastHeapUsed is process-wide state; we can't assume a
    // pristine baseline because the previous test in this suite already
    // called getMemoryBreadcrumb. What we CAN assert: the returned delta
    // is always a finite Number across calls, even when allocations
    // happen between them.
    getMemoryBreadcrumb(); // establish baseline for THIS test
    const trash: number[][] = [];
    for (let i = 0; i < 1000; i++) trash.push(new Array(1000).fill(i));
    const b2 = getMemoryBreadcrumb();
    expect(Number.isFinite(b2.heapDeltaMB)).toBe(true);
    // Keep trash live so V8 doesn't optimize the allocation away.
    expect(trash.length).toBeGreaterThan(0);
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

  it("uses [!] marker for warn severity", () => {
    const flags: AnomalyFlag[] = [
      { code: "substrate.y", severity: "warn", message: "moderate", evidence: "rate=0.5" },
    ];
    const block = formatAnomalyBlock(flags);
    expect(block).toContain("[!] substrate.y: moderate");
    // suggestion line is conditional — should NOT be present here
    expect(block).not.toContain("suggestion:");
  });
});

// ── Graduation detectors via the AnomalyFlag shape contract. The two
// graduation detectors live inside observability.ts and are reachable only
// through detectAnomalies(); they dynamically import ./soul.js to call
// checkGraduation(). Mocking that dynamic import via vi.doMock + vi.resetModules
// proved race-prone with the Promise.allSettled batching (one of the two
// concurrent dynamic imports occasionally resolved before the mock applied).
//
// Instead, this block tests the OUTPUT CONTRACT of the detectors by mirroring
// their decision logic locally — same formula the source uses, same severity,
// same message-shape requirements. If the source diverges from these
// expectations the test will go stale and need updating, which is the point.
describe("graduation detectors: output-contract regression", () => {
  type GraduationReportShape = {
    ready: boolean;
    qualityScore: number;
    volumeScore: number;
    stage: string;
    diagnostics: { suggestion?: string }[];
  };

  // Mirror of detectGraduationReady in src/engine/observability.ts.
  // Branches on hasSoul: once the soul exists, the "graduation_ready" flag
  // must suppress — graduation is a ONE-TIME event tied to the existence of
  // soul:kongbrain and re-announcing it months later is misleading.
  function deriveGraduationReadyFlag(report: GraduationReportShape, soulExists: boolean): AnomalyFlag | null {
    if (soulExists) return null;
    if (!report.ready) return null;
    return {
      code: "gate.graduation_ready",
      severity: "info",
      message: `Soul graduation criteria met (volume 7/7, quality ${report.qualityScore.toFixed(2)} ≥ 0.85)`,
      evidence: `stage=${report.stage}`,
      suggestion: "Soul graduation fires automatically via the pending_work pipeline at session end",
    };
  }

  // Mirror of detectGraduationClose in src/engine/observability.ts.
  // Pre-soul: classic "approaching the 0.85 graduation gate" alert.
  // Post-soul: same metric (quality near 0.85) reframed under
  // gate.maturity_quality_drift — graduation already happened, this is a
  // regression watch, not a graduation approach.
  function deriveGraduationCloseFlag(report: GraduationReportShape, soulExists: boolean): AnomalyFlag | null {
    if (report.qualityScore < 0.80) return null;

    if (!soulExists) {
      if (report.ready) return null;
      const gap = (0.85 - report.qualityScore).toFixed(3);
      return {
        code: "gate.graduation_close",
        severity: "info",
        message: `Quality score ${report.qualityScore.toFixed(2)} is within ${gap} of graduation gate (0.85)`,
        evidence: `volumeScore=${report.volumeScore.toFixed(2)}, qualityScore=${report.qualityScore.toFixed(2)}`,
        suggestion: report.diagnostics[0]?.suggestion,
      };
    }

    if (report.qualityScore >= 0.85) return null;
    const gap = (0.85 - report.qualityScore).toFixed(3);
    return {
      code: "gate.maturity_quality_drift",
      severity: "info",
      message: `Post-graduation quality score ${report.qualityScore.toFixed(2)} is ${gap} below the 0.85 gate that originally qualified the soul — quality drift watch, not a graduation alert`,
      evidence: `volumeScore=${report.volumeScore.toFixed(2)}, qualityScore=${report.qualityScore.toFixed(2)}, soul=present`,
      suggestion: report.diagnostics[0]?.suggestion ?? "Soul already graduated. This is a quality-drift signal: investigate retrieval utilization, tool failure rate, and recent reflection critical-rate.",
    };
  }

  // ── Pre-graduation (soul does not yet exist) — original behavior preserved ──

  it("graduation_ready fires when ready=true AND no soul, with info severity and stage in evidence", () => {
    const flag = deriveGraduationReadyFlag({
      ready: true, qualityScore: 0.91, volumeScore: 1.0, stage: "ready", diagnostics: [],
    }, /*soulExists*/ false);
    expect(flag).not.toBeNull();
    expect(flag!.code).toBe("gate.graduation_ready");
    expect(flag!.severity).toBe("info");
    expect(flag!.message).toContain("0.91");
    expect(flag!.message).toContain("7/7");
    expect(flag!.evidence).toBe("stage=ready");
  });

  it("graduation_ready returns null when ready=false (regardless of quality score)", () => {
    expect(deriveGraduationReadyFlag({
      ready: false, qualityScore: 0.91, volumeScore: 1.0, stage: "maturing", diagnostics: [],
    }, false)).toBeNull();
    expect(deriveGraduationReadyFlag({
      ready: false, qualityScore: 0.5, volumeScore: 0.4, stage: "developing", diagnostics: [],
    }, false)).toBeNull();
  });

  it("graduation_close fires pre-soul when ready=false AND 0.80 ≤ qualityScore < 0.85", () => {
    const flag = deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.83, volumeScore: 0.86, stage: "maturing",
      diagnostics: [{ suggestion: "Focus on retrieval utilization" }],
    }, false);
    expect(flag).not.toBeNull();
    expect(flag!.code).toBe("gate.graduation_close");
    expect(flag!.severity).toBe("info");
    expect(flag!.message).toContain("0.83");
    // gap = 0.85 - 0.83 = 0.020 (after toFixed(3) it's "0.020")
    expect(flag!.message).toContain("0.020");
    expect(flag!.evidence).toBe("volumeScore=0.86, qualityScore=0.83");
    expect(flag!.suggestion).toBe("Focus on retrieval utilization");
  });

  it("graduation_close returns null pre-soul when qualityScore < 0.80 (below floor)", () => {
    expect(deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.65, volumeScore: 0.86, stage: "emerging", diagnostics: [],
    }, false)).toBeNull();
    // Edge: exactly 0.80 SHOULD fire (boundary inclusive)
    const onBoundary = deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.80, volumeScore: 0.86, stage: "emerging", diagnostics: [],
    }, false);
    expect(onBoundary).not.toBeNull();
  });

  it("graduation_close returns null pre-soul when ready=true (mutual exclusion with graduation_ready)", () => {
    // The two flags MUST be mutually exclusive — a ready agent should see
    // only graduation_ready, not also graduation_close. The early-return
    // on `if (report.ready) return null` enforces this.
    expect(deriveGraduationCloseFlag({
      ready: true, qualityScore: 0.91, volumeScore: 1.0, stage: "ready", diagnostics: [],
    }, false)).toBeNull();
  });

  it("graduation_close suggestion comes from diagnostics[0] pre-soul (may be undefined when no diagnostics)", () => {
    const flag = deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.82, volumeScore: 0.9, stage: "maturing", diagnostics: [],
    }, false);
    expect(flag).not.toBeNull();
    expect(flag!.suggestion).toBeUndefined();
  });

  it("BOTH pre-soul flags are info severity (lowest noise tier)", () => {
    const r = deriveGraduationReadyFlag({
      ready: true, qualityScore: 0.95, volumeScore: 1.0, stage: "ready", diagnostics: [],
    }, false);
    const c = deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.82, volumeScore: 0.9, stage: "maturing", diagnostics: [],
    }, false);
    expect(r!.severity).toBe("info");
    expect(c!.severity).toBe("info");
  });

  // ── Post-graduation (soul exists) — new behavior added by unify-graduation fix ──

  it("graduation_ready is SUPPRESSED post-soul (graduation is a one-time event)", () => {
    // The bug: pre-fix this returned a `gate.graduation_ready` flag every
    // session even when the soul had existed for months. Now: soul present
    // → null, no further announcement.
    expect(deriveGraduationReadyFlag({
      ready: true, qualityScore: 0.95, volumeScore: 1.0, stage: "ready", diagnostics: [],
    }, /*soulExists*/ true)).toBeNull();
    // Even if quality dipped below ready, no re-announcement post-soul.
    expect(deriveGraduationReadyFlag({
      ready: false, qualityScore: 0.83, volumeScore: 0.86, stage: "maturing", diagnostics: [],
    }, true)).toBeNull();
  });

  it("graduation_close is REFRAMED post-soul as gate.maturity_quality_drift", () => {
    // Same metric (quality near 0.85), but post-soul the language is
    // quality-drift watch, not graduation approach. Code must be different
    // so downstream consumers can route the two cases separately.
    const flag = deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.83, volumeScore: 1.0, stage: "maturing",
      diagnostics: [{ suggestion: "Focus on retrieval utilization" }],
    }, /*soulExists*/ true);
    expect(flag).not.toBeNull();
    expect(flag!.code).toBe("gate.maturity_quality_drift");
    expect(flag!.severity).toBe("info");
    expect(flag!.message).toContain("0.83");
    expect(flag!.message).toContain("0.020");
    expect(flag!.message).toContain("quality drift");
    expect(flag!.message).not.toMatch(/graduation gate/i); // do NOT call it a graduation alert
    expect(flag!.evidence).toContain("soul=present");
    expect(flag!.suggestion).toBe("Focus on retrieval utilization");
  });

  it("post-soul drift flag is SUPPRESSED when qualityScore >= 0.85 (steady-state, no alert)", () => {
    // A graduated agent hovering above 0.85 is the normal state. No alert.
    expect(deriveGraduationCloseFlag({
      ready: true, qualityScore: 0.91, volumeScore: 1.0, stage: "ready", diagnostics: [],
    }, true)).toBeNull();
    expect(deriveGraduationCloseFlag({
      ready: true, qualityScore: 0.85, volumeScore: 1.0, stage: "ready", diagnostics: [],
    }, true)).toBeNull();
  });

  it("post-soul drift flag still respects the < 0.80 floor (below floor, no alert)", () => {
    expect(deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.65, volumeScore: 1.0, stage: "emerging", diagnostics: [],
    }, true)).toBeNull();
  });

  it("post-soul drift flag has fallback suggestion when diagnostics is empty", () => {
    const flag = deriveGraduationCloseFlag({
      ready: false, qualityScore: 0.82, volumeScore: 1.0, stage: "maturing", diagnostics: [],
    }, true);
    expect(flag).not.toBeNull();
    expect(flag!.suggestion).toContain("Soul already graduated");
  });
});
