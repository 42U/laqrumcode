import { describe, it, expect, vi } from "vitest";
import {
  checkGraduation, computeQualityScore, seedSoulAsCoreMemory,
  formatGraduationReport,
} from "../src/engine/soul.js";
import type { QualitySignals, SoulDocument, GraduationReport } from "../src/engine/soul.js";

// Mock SurrealStore that returns configurable signal counts + quality data.
//
// 8-gate model: 7 volume thresholds (sessions, reflections, causalChains,
// concepts, skills, monologues, spanDays) + 1 quality gate (composite ≥ 0.85).
// There is no `totalMemories` gate — quality is the 8th.
function mockStore(signals: Partial<{
  sessions: number;
  reflections: number;
  causalChains: number;
  concepts: number;
  skills: number;
  monologues: number;
  spanDays: number;
  // Quality signals
  avgUtil: number;
  retrievalCount: number;
  skillSuccess: number;
  skillFailure: number;
  criticalReflections: number;
  toolFailRate: number;
}> = {}) {
  const earliest = signals.spanDays
    ? new Date(Date.now() - signals.spanDays * 86400000).toISOString()
    : undefined;

  return {
    isAvailable: () => true,
    queryFirst: async (sql: string) => {
      // Volume signals
      if (sql.includes("FROM session GROUP ALL")) return [{ count: signals.sessions ?? 0 }];
      // v0.7.93: SQL now carries a WHERE (active = true OR active IS NONE)
      // clause between `FROM reflection` and `GROUP ALL`, so the literal
      // substring check used to fail. Accept both shapes.
      if (/FROM\s+reflection\b/.test(sql) && sql.includes("GROUP ALL") && !sql.includes("severity")) {
        return [{ count: signals.reflections ?? 0 }];
      }
      if (sql.includes("FROM causal_chain GROUP ALL")) return [{ count: signals.causalChains ?? 0 }];
      if (sql.includes("FROM concept GROUP ALL")) return [{ count: signals.concepts ?? 0 }];
      if (sql.includes("FROM skill GROUP ALL")) return [{ count: signals.skills ?? 0 }];
      if (sql.includes("FROM monologue GROUP ALL")) return [{ count: signals.monologues ?? 0 }];
      if (sql.includes("FROM session ORDER BY started_at")) return earliest ? [{ earliest }] : [];

      // Quality signals
      // The retrieval-util query was windowed to last 14d in 0.4.4
      // (added `WHERE created_at > time::now() - 14d`); match either form.
      if (sql.includes("FROM retrieval_outcome") && sql.includes("avgUtil")) {
        return [{ avgUtil: signals.avgUtil ?? 0, cnt: signals.retrievalCount ?? 0 }];
      }
      if (sql.includes("FROM skill WHERE")) {
        return [{ totalSuccess: signals.skillSuccess ?? 0, totalFailure: signals.skillFailure ?? 0 }];
      }
      if (sql.includes("severity = \"critical\"")) {
        return [{ count: signals.criticalReflections ?? 0 }];
      }
      if (sql.includes("FROM retrieval_outcome WHERE tool_success")) {
        return [{ failRate: signals.toolFailRate ?? 0 }];
      }

      return [];
    },
  };
}

describe("computeQualityScore", () => {
  it("perfect quality scores 1.0 with sufficient data", () => {
    const q: QualitySignals = {
      avgRetrievalUtilization: 1.0,
      skillSuccessRate: 1.0,
      criticalReflectionRate: 0,
      toolFailureRate: 0,
      sampleSize: 50,
    };
    expect(computeQualityScore(q)).toBe(1);
  });

  it("zero quality scores 0", () => {
    const q: QualitySignals = {
      avgRetrievalUtilization: 0,
      skillSuccessRate: 0,
      criticalReflectionRate: 1,
      toolFailureRate: 1,
      sampleSize: 50,
    };
    expect(computeQualityScore(q)).toBe(0);
  });

  it("penalizes low sample size", () => {
    const fullData: QualitySignals = {
      avgRetrievalUtilization: 0.8,
      skillSuccessRate: 0.9,
      criticalReflectionRate: 0.1,
      toolFailureRate: 0.1,
      sampleSize: 50,
    };
    const lowData = { ...fullData, sampleSize: 3 };
    const fullScore = computeQualityScore(fullData);
    const lowScore = computeQualityScore(lowData);
    expect(lowScore).toBeLessThan(fullScore);
    expect(lowScore).toBeCloseTo(fullScore * 0.3, 2);
  });

  it("weights are balanced — mediocre across all signals", () => {
    const q: QualitySignals = {
      avgRetrievalUtilization: 0.5,
      skillSuccessRate: 0.5,
      criticalReflectionRate: 0.5,
      toolFailureRate: 0.5,
      sampleSize: 50,
    };
    const score = computeQualityScore(q);
    expect(score).toBeCloseTo(0.5, 1);
  });
});

describe("checkGraduation", () => {
  it("nascent with zero signals", async () => {
    const result = await checkGraduation(mockStore() as any);
    expect(result.ready).toBe(false);
    expect(result.stage).toBe("nascent");
    expect(result.volumeScore).toBe(0);
    // 7 unmet volume gates + 1 unmet quality gate = 8 unmet, 0 met
    expect(result.unmet.length).toBe(8);
    expect(result.met.length).toBe(0);
  });

  it("nascent when unavailable", async () => {
    const store = { isAvailable: () => false, queryFirst: async () => [] };
    const result = await checkGraduation(store as any);
    expect(result.ready).toBe(false);
    expect(result.stage).toBe("nascent");
    expect(result.volumeScore).toBe(0);
  });

  it("developing at 5/8 — 5 volume met, quality short", async () => {
    // 5 volume met (sessions, reflections, causalChains, concepts, monologues);
    // unmet: skills, spanDays + quality. New 8-gate boundary: developing >= 5.
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      skills: 0,
      monologues: 10,
      spanDays: 0,
    }) as any);

    expect(result.ready).toBe(false);
    expect(result.stage).toBe("developing");
    expect(result.met.length).toBe(5);
    expect(result.unmet.length).toBe(3); // skills + spanDays + quality
    expect(result.qualityScore).toBeLessThan(0.85);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("emerging at 6/8 — 6 volume met, quality short", async () => {
    // 6 volume met; unmet: spanDays + quality. emerging >= 6.
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      skills: 35,
      monologues: 10,
      spanDays: 1,      // below threshold (3)
    }) as any);

    expect(result.ready).toBe(false);
    expect(result.stage).toBe("emerging");
    expect(result.met.length).toBe(6);
    expect(result.unmet.length).toBe(2); // spanDays + quality
  });

  it("maturing at 7/8 — all volume met but quality short", async () => {
    // All 7 volume gates met, quality fails: 7 met, 1 unmet (quality), stage=maturing.
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      skills: 35,
      monologues: 10,
      spanDays: 7,
      // Bad quality blocks "ready"
      avgUtil: 0.05,
      retrievalCount: 50,
      skillSuccess: 2,
      skillFailure: 20,
      criticalReflections: 12,
      toolFailRate: 0.8,
    }) as any);

    expect(result.ready).toBe(false);
    expect(result.stage).toBe("maturing");
    expect(result.met.length).toBe(7);
    expect(result.unmet.length).toBe(1);
    expect(result.unmet[0]).toContain("quality");
  });

  it("NOT ready at 7/8 volume if quality is too low", async () => {
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      skills: 35,
      monologues: 10,
      spanDays: 7,
      // Terrible quality
      avgUtil: 0.05,
      retrievalCount: 50,
      skillSuccess: 2,
      skillFailure: 20,
      criticalReflections: 12,
      toolFailRate: 0.8,
    }) as any);

    expect(result.met.length).toBe(7);   // 7 volume, quality unmet
    expect(result.ready).toBe(false);
    expect(result.stage).toBe("maturing"); // volume complete but quality blocks "ready"
    expect(result.volumeScore).toBe(1);
    expect(result.qualityScore).toBeLessThan(0.6);
    expect(result.diagnostics.some(d => d.area === "quality:composite")).toBe(true);
  });

  it("ready at 8/8 — all volume + quality met", async () => {
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      skills: 35,
      monologues: 10,
      spanDays: 7,
      // Good quality — composite must be >= 0.85
      avgUtil: 0.8,
      retrievalCount: 30,
      skillSuccess: 15,
      skillFailure: 3,
      criticalReflections: 1,
      toolFailRate: 0.05,
    }) as any);

    expect(result.ready).toBe(true);
    expect(result.stage).toBe("ready");
    expect(result.met.length).toBe(8); // 7 volume + 1 quality
    expect(result.unmet.length).toBe(0);
    expect(result.volumeScore).toBe(1);
    expect(result.qualityScore).toBeGreaterThanOrEqual(0.85);
    expect(result.met.some(s => s.includes("quality"))).toBe(true);
  });

  it("reports exact threshold values in met/unmet strings", async () => {
    const result = await checkGraduation(mockStore({
      sessions: 5,
      concepts: 50,
    }) as any);

    expect(result.unmet.some(s => s.includes("sessions: 5/15"))).toBe(true);
    expect(result.met.some(s => s.includes("concepts: 50/30"))).toBe(true);
  });

  it("diagnostics include suggestions for unmet thresholds", async () => {
    const result = await checkGraduation(mockStore({
      sessions: 2,
      reflections: 0,
      concepts: 50,
    }) as any);

    const sessionDiag = result.diagnostics.find(d => d.area === "volume:sessions");
    expect(sessionDiag).toBeDefined();
    expect(sessionDiag!.suggestion).toContain("session(s) needed");

    const reflDiag = result.diagnostics.find(d => d.area === "volume:reflections");
    expect(reflDiag).toBeDefined();
    expect(reflDiag!.status).toBe("critical"); // 0/10 = 0%
  });

  it("quality diagnostics flag poor retrieval utilization", async () => {
    // 5 volume met (sessions, reflections, causalChains, concepts, monologues)
    // — needed to clear nascent so quality diagnostics fire.
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      monologues: 10,
      avgUtil: 0.1,
      retrievalCount: 30,
    }) as any);

    // Stage must be at least "developing" for quality diagnostics
    expect(result.stage).not.toBe("nascent");
    const retrievalDiag = result.diagnostics.find(d => d.area === "quality:retrieval");
    expect(retrievalDiag).toBeDefined();
    expect(retrievalDiag!.status).toBe("critical");
  });

  it("quality diagnostics flag high tool failure rate", async () => {
    const result = await checkGraduation(mockStore({
      sessions: 20,
      reflections: 15,
      causalChains: 10,
      concepts: 50,
      monologues: 10,   // 5 volume met — needed for non-nascent stage
      toolFailRate: 0.5,
    }) as any);

    const toolDiag = result.diagnostics.find(d => d.area === "quality:tools");
    expect(toolDiag).toBeDefined();
    expect(toolDiag!.status).toBe("critical");
  });
});

// ── seedSoulAsCoreMemory ────────────────────────────────────────────────────

describe("seedSoulAsCoreMemory", () => {
  function mockSoulStore() {
    const records: { text: string; category: string; priority: number; tier: number }[] = [];
    const deleted: string[] = [];
    return {
      isAvailable: () => true,
      queryExec: async (_sql: string, params?: any) => {
        // v0.7.93 append-only: was DELETE — now UPDATE...SET active=false with
        // matching archive_reason. Mock the soft-archive shape so the existing
        // test contract (deleted array contains the cleared category) keeps
        // working without coupling tests to the exact SQL form.
        if ((_sql.includes("DELETE") || /UPDATE\s+core_memory[\s\S]+active\s*=\s*false/.test(_sql))
            && params?.cat) {
          deleted.push(params.cat);
        }
      },
      createCoreMemory: async (text: string, category: string, priority: number, tier: number) => {
        records.push({ text, category, priority, tier });
        return `core_memory:${records.length}`;
      },
      _records: records,
      _deleted: deleted,
    };
  }

  const fakeSoul: SoulDocument = {
    id: "soul:kongbrain",
    agent_id: "kongbrain",
    working_style: ["I verify before acting", "I prefer small incremental changes"],
    emotional_dimensions: [{ dimension: "patience", rationale: "waited for tests", adopted_at: "2026-01-01" }],
    self_observations: ["I tend to over-plan", "I'm good at debugging"],
    earned_values: [{ value: "correctness over speed", grounded_in: "caught a bug by double-checking" }],
    revisions: [],
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };

  it("seeds 4 core memory entries from soul", async () => {
    const store = mockSoulStore();
    const count = await seedSoulAsCoreMemory(fakeSoul, store as any);
    expect(count).toBe(4);
    expect(store._records.length).toBe(4);
  });

  it("all entries are Tier 0 with category 'soul'", async () => {
    const store = mockSoulStore();
    await seedSoulAsCoreMemory(fakeSoul, store as any);
    for (const r of store._records) {
      expect(r.tier).toBe(0);
      expect(r.category).toBe("soul");
    }
  });

  it("working style has priority 90", async () => {
    const store = mockSoulStore();
    await seedSoulAsCoreMemory(fakeSoul, store as any);
    const ws = store._records.find(r => r.text.startsWith("Working style:"));
    expect(ws).toBeDefined();
    expect(ws!.priority).toBe(90);
    expect(ws!.text).toContain("I verify before acting");
  });

  it("earned values include grounding evidence", async () => {
    const store = mockSoulStore();
    await seedSoulAsCoreMemory(fakeSoul, store as any);
    const ev = store._records.find(r => r.text.startsWith("Earned values:"));
    expect(ev).toBeDefined();
    expect(ev!.text).toContain("caught a bug by double-checking");
  });

  it("clears old soul entries before seeding", async () => {
    const store = mockSoulStore();
    await seedSoulAsCoreMemory(fakeSoul, store as any);
    expect(store._deleted).toContain("soul");
  });

  it("returns 0 when store unavailable", async () => {
    const store = { ...mockSoulStore(), isAvailable: () => false };
    const count = await seedSoulAsCoreMemory(fakeSoul, store as any);
    expect(count).toBe(0);
  });
});

// ── formatGraduationReport ──

describe("formatGraduationReport", () => {
  const baseReport: GraduationReport = {
    stage: "developing",
    met: ["sessions: 20/15", "concepts: 50/30"],
    unmet: ["reflections: 3/10", "causal_chains: 2/5"],
    volumeScore: 0.4,
    qualityScore: 0.55,
    quality: { avgRetrievalUtilization: 0.6, skillSuccessRate: 0.8, criticalReflectionRate: 0.2, toolFailureRate: 0.1 },
    ready: false,
    diagnostics: [],
  };

  it("includes stage in uppercase", () => {
    const text = formatGraduationReport(baseReport);
    expect(text).toContain("DEVELOPING");
  });

  it("shows met and unmet thresholds", () => {
    const text = formatGraduationReport(baseReport);
    expect(text).toContain("2/8 met");
    expect(text).toContain("sessions: 20/15");
    expect(text).toContain("reflections: 3/10");
  });

  it("shows quality scores for non-nascent stages", () => {
    const text = formatGraduationReport(baseReport);
    expect(text).toContain("Quality");
    expect(text).toContain("Retrieval util: 60%");
  });

  it("skips quality for nascent stage", () => {
    const nascent = { ...baseReport, stage: "nascent" as const };
    const text = formatGraduationReport(nascent);
    expect(text).not.toContain("Retrieval util");
  });

  it("includes diagnostics when present", () => {
    const withDiag = {
      ...baseReport,
      diagnostics: [{ area: "volume:reflections", status: "critical" as const, suggestion: "Run more sessions" }],
    };
    const text = formatGraduationReport(withDiag);
    expect(text).toContain("Diagnostics");
    expect(text).toContain("Run more sessions");
  });
});

describe("getQualitySignals — 14-day window (v0.4.4)", () => {
  it("retrieval-util query restricts to last 14 days", async () => {
    // Pin the SQL shape so the windowing can't be silently dropped. The
    // pre-0.4.4 query was `FROM retrieval_outcome GROUP ALL` (all-time);
    // the post-0.4.4 query adds `WHERE created_at > time::now() - 14d`.
    let capturedSql = "";
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM retrieval_outcome") && sql.includes("avgUtil")) {
          capturedSql = sql;
          return [{ avgUtil: 0.2, cnt: 50 }];
        }
        return [];
      }),
    };
    const { getQualitySignals } = await import("../src/engine/soul.js");
    await getQualitySignals(store as any);
    expect(capturedSql).toContain("FROM retrieval_outcome");
    expect(capturedSql).toContain("created_at > time::now() - 14d");
  });
});
