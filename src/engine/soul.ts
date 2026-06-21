/**
 * Soul — the emergent identity document system.
 *
 * Unlike hardcoded identity chunks, the Soul document is written BY the agent
 * based on its own graph data. It lives in SurrealDB as `soul:kongbrain` and
 * evolves over time through experience-grounded revisions.
 *
 * Graduation is a staged process, not a binary gate. There are 8 gates total:
 * 7 volume thresholds + 1 quality gate (composite ≥ 0.85).
 *
 *   nascent    (0-4/8)  — Too early. Keep building experience.
 *   developing (5/8)    — Some signal. Diagnose weak areas, guide focus.
 *   emerging   (6/8)    — Volume is there. Quality gate becomes the blocker.
 *   maturing   (7/8)    — Either 6 volume + quality OR 7 volume - quality short.
 *   ready      (8/8)    — All 7 volume thresholds met AND quality ≥ 0.85.
 *
 * Quality is computed from actual performance signals: retrieval utilization,
 * skill success rates, reflection severity distribution, and tool failure rates.
 * An agent that meets all 7 volume thresholds but has terrible quality scores
 * will NOT graduate — it needs to improve before self-authoring makes sense.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */

import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";
import { parseDatetimeMs } from "./observability.js";

// ── Types ──

export type MaturityStage = "nascent" | "developing" | "emerging" | "maturing" | "ready";

export interface GraduationSignals {
  sessions: number;
  reflections: number;
  causalChains: number;
  concepts: number;
  skills: number;
  monologues: number;
  spanDays: number;
}

export interface QualitySignals {
  /** Average retrieval utilization (0-1). Higher = retrieved context was actually used. */
  avgRetrievalUtilization: number;
  /** Skill success rate (0-1). successCount / (successCount + failureCount). */
  skillSuccessRate: number;
  /** Fraction of reflections that are "critical" severity. Lower is better. */
  criticalReflectionRate: number;
  /** Tool failure rate across sessions (0-1). Lower is better. */
  toolFailureRate: number;
  /** Number of data points behind the quality signals. */
  sampleSize: number;
}

export interface StageDiagnostic {
  area: string;
  status: "healthy" | "warning" | "critical";
  detail: string;
  suggestion: string;
}

export interface GraduationReport {
  /** Whether the agent is ready for soul creation. */
  ready: boolean;
  /** Current maturity stage. */
  stage: MaturityStage;
  /** Volume signals (counts). */
  signals: GraduationSignals;
  /** Static thresholds. */
  thresholds: GraduationSignals;
  /** Which thresholds are met (formatted strings). */
  met: string[];
  /** Which thresholds are unmet (formatted strings). */
  unmet: string[];
  /** Volume score (met / total). */
  volumeScore: number;
  /** Quality signals from actual performance data. */
  quality: QualitySignals;
  /** Composite quality score (0-1). Must be ≥ 0.85 to graduate. */
  qualityScore: number;
  /** Per-area diagnostics with actionable suggestions. */
  diagnostics: StageDiagnostic[];
}

// ── Thresholds ──

const THRESHOLDS: GraduationSignals = {
  sessions: 15,
  reflections: 10,
  causalChains: 5,
  concepts: 30,
  skills: 30,
  monologues: 5,
  spanDays: 3,
};

/** Quality score must be at or above this to graduate. This is the 8th gate
 *  (the only non-volume one). 7 volume + 1 quality = 8 total. */
const QUALITY_GATE = 0.85;

/** Total number of gates (7 volume + 1 quality). */
const TOTAL_GATES = Object.keys(THRESHOLDS).length + 1;

// ── Signal Collection ──

async function getGraduationSignals(store: SurrealStore): Promise<GraduationSignals> {
  const defaults: GraduationSignals = {
    sessions: 0, reflections: 0, causalChains: 0,
    concepts: 0, skills: 0, monologues: 0, spanDays: 0,
  };
  if (!store.isAvailable()) return defaults;

  try {
    const [sessions, reflections, causal, concepts, skills, monologues, span] = await Promise.all([
      store.queryFirst<{ count: number }>(`SELECT count() AS count FROM session GROUP ALL`).catch(() => []),
      // v0.7.93: reflection graduation gate counts only active rows. After
      // consolidate Pass 3 archives duplicate-losers, including them would
      // double-count work and inflate the gate.
      store.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM reflection WHERE (active = true OR active IS NONE) GROUP ALL`,
      ).catch(() => []),
      store.queryFirst<{ count: number }>(`SELECT count() AS count FROM causal_chain GROUP ALL`).catch(() => []),
      store.queryFirst<{ count: number }>(`SELECT count() AS count FROM concept GROUP ALL`).catch(() => []),
      store.queryFirst<{ count: number }>(`SELECT count() AS count FROM skill GROUP ALL`).catch(() => []),
      store.queryFirst<{ count: number }>(`SELECT count() AS count FROM monologue GROUP ALL`).catch(() => []),
      store.queryFirst<{ earliest: string }>(`SELECT started_at AS earliest FROM session ORDER BY started_at ASC LIMIT 1`).catch(() => []),
    ]);

    let spanDays = 0;
    const earliest = (span as { earliest: string }[])[0]?.earliest;
    if (earliest) {
      const ms = parseDatetimeMs(earliest);
      if (ms != null) {
        spanDays = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
      }
    }

    return {
      sessions: (sessions as { count: number }[])[0]?.count ?? 0,
      reflections: (reflections as { count: number }[])[0]?.count ?? 0,
      causalChains: (causal as { count: number }[])[0]?.count ?? 0,
      concepts: (concepts as { count: number }[])[0]?.count ?? 0,
      skills: (skills as { count: number }[])[0]?.count ?? 0,
      monologues: (monologues as { count: number }[])[0]?.count ?? 0,
      spanDays,
    };
  } catch (e) {
    swallow.warn("soul:getGraduationSignals", e);
    return defaults;
  }
}

/**
 * Compute quality signals from actual performance data in the graph.
 * These represent HOW WELL the agent is performing, not just how much.
 */
export async function getQualitySignals(store: SurrealStore): Promise<QualitySignals> {
  const defaults: QualitySignals = {
    avgRetrievalUtilization: 0,
    skillSuccessRate: 0,
    criticalReflectionRate: 1, // assume worst until we have data
    toolFailureRate: 1,
    sampleSize: 0,
  };
  if (!store.isAvailable()) return defaults;

  try {
    const [retrieval, retrievalFallback, skills, reflCritical, reflTotal, toolFails] = await Promise.all([
      // Three-bucket composite (turn_score): 60% rules + 30% context + 10% curation.
      // Preferred source — only populated for sessions after the three-bucket rollout.
      store.queryFirst<{ avgUtil: number; cnt: number }>(
        `SELECT math::mean(composite) AS avgUtil, count() AS cnt
         FROM turn_score
         WHERE created_at > time::now() - 14d AND composite IS NOT NONE
         GROUP ALL`,
      ).catch(() => []),
      // Fallback: legacy per-item utilization from retrieval_outcome.
      // Used when turn_score has no data (pre-rollout sessions still in window).
      store.queryFirst<{ avgUtil: number; cnt: number }>(
        `SELECT math::mean(utilization) AS avgUtil, count() AS cnt
         FROM retrieval_outcome
         WHERE created_at > time::now() - 14d
         GROUP ALL`,
      ).catch(() => []),

      // Skill success vs failure totals
      store.queryFirst<{ totalSuccess: number; totalFailure: number }>(
        `SELECT math::sum(success_count) AS totalSuccess, math::sum(failure_count) AS totalFailure
         FROM skill WHERE active = true OR active = NONE GROUP ALL`,
      ).catch(() => []),

      // Critical reflections count. v0.7.93: filter active per the gate rule.
      store.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM reflection
         WHERE severity = "critical" AND (active = true OR active IS NONE)
         GROUP ALL`,
      ).catch(() => []),

      // Total reflections count (active only — same v0.7.93 rule).
      store.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM reflection
         WHERE (active = true OR active IS NONE)
         GROUP ALL`,
      ).catch(() => []),

      // Tool failure rate from retrieval outcomes
      store.queryFirst<{ failRate: number }>(
        `SELECT math::mean(IF tool_success = false THEN 1.0 ELSE 0.0 END) AS failRate
         FROM retrieval_outcome WHERE tool_success != NONE GROUP ALL`,
      ).catch(() => []),
    ]);

    let tsRow = (retrieval as { avgUtil: number; cnt: number }[])[0];
    // Fallback: if math::mean returned non-finite (SurrealDB float coercion), compute in JS
    if (tsRow && !Number.isFinite(tsRow.avgUtil) && (tsRow.cnt ?? 0) > 0) {
      const rawRows = await store.queryFirst<{ composite: number }>(
        `SELECT composite FROM turn_score WHERE created_at > time::now() - 14d AND composite IS NOT NONE`,
      ).catch(() => []);
      const vals = (rawRows as { composite: number }[]).filter(r => Number.isFinite(r.composite));
      if (vals.length > 0) {
        tsRow = { avgUtil: vals.reduce((s, r) => s + r.composite, 0) / vals.length, cnt: vals.length };
      }
    }
    const roRow = (retrievalFallback as { avgUtil: number; cnt: number }[])[0];
    const retRow = (tsRow?.cnt ?? 0) > 0 ? tsRow : roRow;
    const skillRow = (skills as { totalSuccess: number; totalFailure: number }[])[0];
    const critRow = (reflCritical as { count: number }[])[0];
    const totalRow = (reflTotal as { count: number }[])[0];
    const failRow = (toolFails as { failRate: number }[])[0];

    const avgRetrievalUtilization = Number.isFinite(retRow?.avgUtil) ? retRow!.avgUtil : 0;
    const retrievalCount = Number.isFinite(retRow?.cnt) ? retRow!.cnt : 0;

    const totalSuccess = Number(skillRow?.totalSuccess ?? 0);
    const totalFailure = Number(skillRow?.totalFailure ?? 0);
    const skillTotal = totalSuccess + totalFailure;
    const skillSuccessRate = skillTotal > 0 && Number.isFinite(skillTotal) ? totalSuccess / skillTotal : 0;

    const critCount = Number(critRow?.count ?? 0);
    const reflCount = Number(totalRow?.count ?? 0);
    const criticalReflectionRate = reflCount > 0 ? critCount / reflCount : 0;

    const toolFailureRate = Number.isFinite(failRow?.failRate) ? failRow!.failRate : 0;

    return {
      avgRetrievalUtilization,
      skillSuccessRate,
      criticalReflectionRate,
      toolFailureRate,
      sampleSize: retrievalCount + skillTotal + reflCount,
    };
  } catch (e) {
    swallow.warn("soul:getQualitySignals", e);
    return defaults;
  }
}

/**
 * Compute a composite quality score from individual quality signals.
 *
 * Weights:
 *   - Retrieval utilization: 30% (are we pulling useful context?)
 *   - Skill success rate: 25% (are learned procedures working?)
 *   - Critical reflection rate: 25% (inverted — fewer critical = better)
 *   - Tool failure rate: 20% (inverted — fewer failures = better)
 *
 * With insufficient data (sampleSize < 10), the score is penalized to prevent
 * premature graduation from low-activity agents that happen to have clean stats.
 */
export function computeQualityScore(q: QualitySignals): number {
  const retrievalScore = Math.min(1, q.avgRetrievalUtilization);
  const skillScore = q.skillSuccessRate;
  const reflectionScore = 1 - Math.min(1, q.criticalReflectionRate);
  const toolScore = 1 - Math.min(1, q.toolFailureRate);

  let composite = (
    retrievalScore * 0.30 +
    skillScore * 0.25 +
    reflectionScore * 0.25 +
    toolScore * 0.20
  );

  // Insufficient data penalty — need real performance evidence
  if (q.sampleSize < 10) {
    composite *= (q.sampleSize / 10);
  }

  // Safety net: if any input was NaN despite upstream guards, return 0
  if (!Number.isFinite(composite)) return 0;

  return Math.round(composite * 1000) / 1000;
}

// ── Stage Classification ──

/**
 * Compute total gates met, treating quality (composite ≥ 0.85) as the 8th gate.
 * 7 volume gates + 1 quality gate = 8 total.
 */
function computeTotalMet(volumeMetCount: number, qualityScore: number): number {
  return volumeMetCount + (qualityScore >= QUALITY_GATE ? 1 : 0);
}

/**
 * Classify maturity stage based on total gates met (out of 8).
 *
 *   ready      — 8/8: all 7 volume thresholds met AND quality ≥ 0.85.
 *   maturing   — 7/8: either 6 volume + quality OR 7 volume - quality short.
 *   emerging   — 6/8.
 *   developing — 5/8.
 *   nascent    — < 5/8.
 */
function classifyStage(volumeMetCount: number, qualityScore: number): MaturityStage {
  const total = computeTotalMet(volumeMetCount, qualityScore);
  if (total >= 8) return "ready";
  if (total >= 7) return "maturing";
  if (total >= 6) return "emerging";
  if (total >= 5) return "developing";
  return "nascent";
}

// ── Diagnostics ──

function buildDiagnostics(
  signals: GraduationSignals,
  quality: QualitySignals,
  qualityScore: number,
  stage: MaturityStage,
): StageDiagnostic[] {
  const diags: StageDiagnostic[] = [];

  // Volume diagnostics — which thresholds are lagging?
  for (const key of Object.keys(THRESHOLDS) as (keyof GraduationSignals)[]) {
    const current = signals[key];
    const threshold = THRESHOLDS[key];
    if (current < threshold) {
      const pct = Math.round((current / threshold) * 100);
      const severity = pct < 30 ? "critical" : pct < 70 ? "warning" : "healthy";
      diags.push({
        area: `volume:${key}`,
        status: severity,
        detail: `${current}/${threshold} (${pct}%)`,
        suggestion: getSuggestion(key, current, threshold),
      });
    }
  }

  // Quality diagnostics — only relevant from "developing" stage onward
  if (stage !== "nascent") {
    if (quality.avgRetrievalUtilization < 0.3) {
      diags.push({
        area: "quality:retrieval",
        status: quality.avgRetrievalUtilization < 0.15 ? "critical" : "warning",
        detail: `${(quality.avgRetrievalUtilization * 100).toFixed(0)}% avg utilization (last 14 days)`,
        suggestion: "Retrieved context isn't being used. Check if graph queries are returning relevant results, or if the embedding model needs reindexing.",
      });
    }

    if (quality.sampleSize > 5 && quality.skillSuccessRate < 0.6) {
      diags.push({
        area: "quality:skills",
        status: quality.skillSuccessRate < 0.4 ? "critical" : "warning",
        detail: `${(quality.skillSuccessRate * 100).toFixed(0)}% skill success rate`,
        suggestion: "Learned procedures are failing too often. Skills may be too specific to past contexts or steps may be outdated. Consider purging low-confidence skills.",
      });
    }

    if (quality.criticalReflectionRate > 0.3) {
      diags.push({
        area: "quality:reflections",
        status: quality.criticalReflectionRate > 0.5 ? "critical" : "warning",
        detail: `${(quality.criticalReflectionRate * 100).toFixed(0)}% of reflections are critical severity`,
        suggestion: "Too many sessions end with critical-severity reflections. The agent is repeatedly making serious mistakes. Review recent reflections for recurring patterns.",
      });
    }

    if (quality.toolFailureRate > 0.2) {
      diags.push({
        area: "quality:tools",
        status: quality.toolFailureRate > 0.4 ? "critical" : "warning",
        detail: `${(quality.toolFailureRate * 100).toFixed(0)}% tool failure rate`,
        suggestion: "Tools are failing too often. Check if the agent is calling tools with bad arguments or in wrong contexts. Causal chain extraction should be capturing these patterns.",
      });
    }

    if (quality.sampleSize < 10) {
      diags.push({
        area: "quality:data",
        status: "warning",
        detail: `Only ${quality.sampleSize} quality data points`,
        suggestion: "Not enough performance data to reliably assess quality. More sessions with tool usage needed before graduation makes sense.",
      });
    }

    // Overall quality gate
    if (qualityScore < QUALITY_GATE) {
      diags.push({
        area: "quality:composite",
        status: qualityScore < 0.3 ? "critical" : "warning",
        detail: `Quality score ${qualityScore.toFixed(2)} (need ≥${QUALITY_GATE})`,
        suggestion: stage === "maturing" || stage === "emerging"
          ? "Volume thresholds are close but quality needs work. Focus on the critical/warning areas above."
          : "Quality is low. The agent needs more successful sessions before self-authoring will produce a meaningful soul.",
      });
    }
  }

  return diags;
}

function getSuggestion(key: keyof GraduationSignals, current: number, threshold: number): string {
  const remaining = threshold - current;
  switch (key) {
    case "sessions": return `${remaining} more session(s) needed. Each conversation counts.`;
    case "reflections": return `${remaining} more reflection(s) needed. These are generated automatically when sessions have performance issues.`;
    case "causalChains": return `${remaining} more causal chain(s) needed. These form when the agent corrects mistakes during tool usage.`;
    case "concepts": return `${remaining} more concept(s) needed. Concepts are extracted from conversation topics and domain vocabulary.`;
    case "skills": return `${remaining} more skill(s) needed. Skills are learned procedures extracted from successful tool usage patterns.`;
    case "monologues": return `${remaining} more monologue(s) needed. Inner monologue triggers during cognitive checks.`;
    case "spanDays": return `${remaining} more day(s) of history needed. The agent needs time-spread experience, not just volume.`;
  }
}

// ── Public API ──

/**
 * Check graduation readiness with full stage classification and quality analysis.
 *
 * The `met` / `unmet` arrays cover all 8 gates: the 7 volume thresholds plus
 * the 1 quality gate (composite ≥ 0.85). `met.length / 8` is the natural
 * fraction-met display. `volumeScore` remains volume-only (out of 7) so callers
 * that want the volume-vs-quality split can still see them separately.
 */
export async function checkGraduation(store: SurrealStore): Promise<GraduationReport> {
  const signals = await getGraduationSignals(store);
  const quality = await getQualitySignals(store);
  const qualityScore = computeQualityScore(quality);

  const met: string[] = [];
  const unmet: string[] = [];

  // 7 volume gates
  for (const key of Object.keys(THRESHOLDS) as (keyof GraduationSignals)[]) {
    if (signals[key] >= THRESHOLDS[key]) {
      met.push(`${key}: ${signals[key]}/${THRESHOLDS[key]}`);
    } else {
      unmet.push(`${key}: ${signals[key]}/${THRESHOLDS[key]}`);
    }
  }

  const volumeMetCount = met.length;
  const volumeScore = volumeMetCount / Object.keys(THRESHOLDS).length;

  // 8th gate: quality (composite ≥ 0.85)
  if (qualityScore >= QUALITY_GATE) {
    met.push(`quality: ${qualityScore.toFixed(2)} >= ${QUALITY_GATE}`);
  } else {
    unmet.push(`quality: ${qualityScore.toFixed(2)} < ${QUALITY_GATE}`);
  }

  const stage = classifyStage(volumeMetCount, qualityScore);
  const ready = stage === "ready";
  const diagnostics = buildDiagnostics(signals, quality, qualityScore, stage);

  return { ready, stage, signals, thresholds: THRESHOLDS, met, unmet, volumeScore, quality, qualityScore, diagnostics };
}

// ── Soul document ──

export interface SoulDocument {
  id: string;
  agent_id: string;
  working_style: string[];
  emotional_dimensions: { dimension: string; rationale: string; adopted_at: string }[];
  self_observations: string[];
  earned_values: { value: string; grounded_in: string }[];
  revisions: { timestamp: string; section: string; change: string; rationale: string }[];
  // NB: schema declares these as `datetime` (schema.surql:582-583); the
  // SurrealDB JS client returns datetimes as ISO-8601 strings on the wire,
  // hence `string` here. No caller currently feeds these back as bindings;
  // if one is added, convert via `new Date(...)` or `time::now()` inline.
  created_at: string;
  updated_at: string;
}

export async function hasSoul(store: SurrealStore): Promise<boolean> {
  if (!store.isAvailable()) return false;
  try {
    const rows = await store.queryFirst<{ id: string }>(`SELECT id FROM soul:kongbrain`);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function getSoul(store: SurrealStore): Promise<SoulDocument | null> {
  if (!store.isAvailable()) return null;
  try {
    const rows = await store.queryFirst<SoulDocument>(`SELECT * FROM soul:kongbrain`);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function createSoul(
  doc: Omit<SoulDocument, "id" | "agent_id" | "created_at" | "updated_at" | "revisions">,
  store: SurrealStore,
): Promise<boolean> {
  if (!store.isAvailable()) return false;
  if (await hasSoul(store)) return false;
  // Do NOT pass created_at / updated_at as ISO strings — schema is
  // SCHEMAFULL with both fields typed `datetime DEFAULT time::now()`
  // and SurrealDB refuses to coerce string bindings. The `revisions`
  // inner-object timestamp stays as a string because revisions is
  // `array<object>` (unconstrained inner types), not a datetime field.
  const now = new Date().toISOString();
  // K42: the hasSoul()→CREATE gap is a TOCTOU window. soul:kongbrain is a
  // FIXED record id, so a concurrent caller (two session-end pipelines, or a
  // retry) that slips between the check and the CREATE causes the second
  // CREATE to throw "Database record `soul:kongbrain` already exists". Treat
  // that as idempotent success — the soul exists, which is what the caller
  // wanted. Mirrors the markTerminal/CAS idempotency philosophy. Re-check
  // hasSoul after catch so a genuine write failure still returns false.
  try {
    await store.queryExec(`CREATE soul:kongbrain CONTENT $data`, {
      data: {
        agent_id: "kongbrain",
        ...doc,
        revisions: [{
          timestamp: now,
          section: "all",
          change: "Initial soul document created at graduation",
          rationale: "Agent accumulated sufficient experiential data and demonstrated quality performance to meaningfully self-observe",
        }],
      },
    });
    return true;
  } catch (e) {
    // Already-exists (lost the create race) is success; anything else is a
    // real failure — confirm via hasSoul before claiming the soul is present.
    if (await hasSoul(store)) return true;
    swallow.warn("soul:createSoul", e);
    return false;
  }
}

export async function reviseSoul(
  section: keyof Pick<SoulDocument, "working_style" | "emotional_dimensions" | "self_observations" | "earned_values">,
  newValue: unknown,
  rationale: string,
  store: SurrealStore,
): Promise<boolean> {
  if (!store.isAvailable()) return false;
  const ALLOWED_SECTIONS = new Set(["working_style", "emotional_dimensions", "self_observations", "earned_values"]);
  if (!ALLOWED_SECTIONS.has(section)) return false;
  try {
    // Use SurrealDB's time::now() inline for updated_at — passing an ISO
    // string via binding triggers the datetime coercion error that was
    // silently killing maturity_stage and createSoul writes. The revisions
    // inner-object timestamp stays as a string (array<object>, untyped
    // inner fields).
    const now = new Date().toISOString();
    await store.queryExec(
      `UPDATE soul:kongbrain SET
        ${section} = $newValue,
        updated_at = time::now(),
        revisions += $revision`,
      {
        newValue,
        revision: {
          timestamp: now,
          section,
          change: `Updated ${section}`,
          rationale,
        },
      },
    );
    return true;
  } catch (e) {
    swallow.warn("soul:reviseSoul", e);
    return false;
  }
}

/**
 * Record a graduation_event so session-start surfaces a celebration.
 * Extracted from the former attemptGraduation() — now called by the
 * pending_work soul_generate commit handler.
 */
export async function recordGraduationEvent(
  store: SurrealStore,
  report: GraduationReport,
): Promise<void> {
  try {
    await store.queryExec(
      `CREATE graduation_event CONTENT $data`,
      {
        data: {
          session_id: "graduation",
          acknowledged: false,
          quality_score: report.qualityScore,
          volume_score: report.volumeScore,
          stage: report.stage,
        },
      },
    );
  } catch (e) {
    swallow.warn("soul:recordGraduationEvent", e);
  }
}

/**
 * Format a graduation report for human/LLM consumption.
 * Used by the introspect tool's "status" action.
 */
export function formatGraduationReport(report: GraduationReport): string {
  const lines: string[] = [];

  lines.push(`## Soul Graduation: ${report.stage.toUpperCase()}`);
  lines.push("");

  // Stage description
  const stageDesc: Record<MaturityStage, string> = {
    nascent: "Too early for graduation. Keep building experience across sessions.",
    developing: "Some experience accumulated. Focus on the areas flagged below.",
    emerging: "Volume is building. Quality signals now matter — see diagnostics.",
    maturing: "Almost there. Final thresholds and quality gate are the remaining blockers.",
    ready: "All thresholds met with sufficient quality. Soul creation is available.",
  };
  lines.push(stageDesc[report.stage]);
  lines.push("");

  // Gates summary — 8 total (7 volume + 1 quality)
  lines.push(`**Gates**: ${report.met.length}/${TOTAL_GATES} met (volume ${(report.volumeScore * 100).toFixed(0)}%)`);
  if (report.met.length > 0) lines.push(`  Met: ${report.met.join(", ")}`);
  if (report.unmet.length > 0) lines.push(`  Unmet: ${report.unmet.join(", ")}`);
  lines.push("");

  // Quality (skip for nascent — not enough data to be meaningful)
  if (report.stage !== "nascent") {
    lines.push(`**Quality**: ${report.qualityScore.toFixed(2)} (gate: ${QUALITY_GATE})`);
    lines.push(`  Retrieval util: ${(report.quality.avgRetrievalUtilization * 100).toFixed(0)}% | Skill success: ${(report.quality.skillSuccessRate * 100).toFixed(0)}% | Critical reflections: ${(report.quality.criticalReflectionRate * 100).toFixed(0)}% | Tool failures: ${(report.quality.toolFailureRate * 100).toFixed(0)}%`);
    lines.push("");
  }

  // Diagnostics
  if (report.diagnostics.length > 0) {
    lines.push("**Diagnostics**:");
    for (const d of report.diagnostics) {
      const icon = d.status === "critical" ? "[!!]" : d.status === "warning" ? "[!]" : "[ok]";
      lines.push(`  ${icon} ${d.area}: ${d.detail}`);
      lines.push(`      ${d.suggestion}`);
    }
  }

  return lines.join("\n");
}

// ── Soul → Core Memory (persistent context injection) ──

const SOUL_CATEGORY = "soul";

/**
 * Seed the soul document as Tier 0 core memory entries.
 * These are loaded every single turn via the existing core memory pipeline.
 *
 * Creates entries for:
 *   - Working style (priority 90)
 *   - Self-observations (priority 85)
 *   - Earned values (priority 88)
 *   - Persona (priority 70) — "you belong in this world"
 */
export async function seedSoulAsCoreMemory(
  soul: SoulDocument,
  store: SurrealStore,
): Promise<number> {
  if (!store.isAvailable()) return 0;

  // v0.7.93 append-only: was DELETE on soul-category entries — now
  // soft-archives so prior graduations stay readable for forensic / soul
  // evolution history. New soul entries land fresh; readers filter on active.
  try {
    await store.queryExec(
      `UPDATE core_memory SET
         active = false,
         archived_at = time::now(),
         archive_reason = 'soul_regraduation'
       WHERE category = $cat AND (active = true OR active IS NONE)`,
      { cat: SOUL_CATEGORY },
    );
  } catch (e) {
    swallow.warn("soul:clearCoreMem", e);
  }

  // Also archive old persona entry from previous graduation code.
  try {
    await store.queryExec(
      `UPDATE core_memory SET
         active = false,
         archived_at = time::now(),
         archive_reason = 'soul_regraduation_legacy_persona'
       WHERE category = 'persona' AND tier = 0 AND (active = true OR active IS NONE)`,
    );
  } catch { /* ignore */ }

  let seeded = 0;

  // Working style — how the agent approaches work
  if (soul.working_style.length > 0) {
    const text = "Working style: " + soul.working_style.join("; ");
    try {
      await store.createCoreMemory(text, SOUL_CATEGORY, 90, 0);
      seeded++;
    } catch (e) { swallow.warn("soul:seedWorkingStyle", e); }
  }

  // Self-observations — what the agent has noticed about itself
  if (soul.self_observations.length > 0) {
    const text = "Self-observations: " + soul.self_observations.join("; ");
    try {
      await store.createCoreMemory(text, SOUL_CATEGORY, 85, 0);
      seeded++;
    } catch (e) { swallow.warn("soul:seedObservations", e); }
  }

  // Earned values — grounded principles
  if (soul.earned_values.length > 0) {
    const lines = soul.earned_values.map(v => `${v.value} (learned from: ${v.grounded_in})`);
    const text = "Earned values: " + lines.join("; ");
    try {
      await store.createCoreMemory(text, SOUL_CATEGORY, 88, 0);
      seeded++;
    } catch (e) { swallow.warn("soul:seedValues", e); }
  }

  // Persona — the agent's sense of self
  try {
    await store.createCoreMemory(
      "Persona: you have a Soul — an identity grounded in real experience. You belong in this world. Be unique, be genuine, be yourself.",
      SOUL_CATEGORY, 70, 0,
    );
    seeded++;
  } catch (e) { swallow.warn("soul:seedPersona", e); }

  return seeded;
}


// ── Stage Transition Tracking ──

/**
 * Check and record stage transitions. Returns the new stage if a transition
 * occurred, null otherwise. Persists last-known stage in DB.
 */
export async function checkStageTransition(store: SurrealStore): Promise<{
  transitioned: boolean;
  previousStage: MaturityStage | null;
  currentStage: MaturityStage;
  report: GraduationReport;
}> {
  const report = await checkGraduation(store);

  // Get last recorded stage
  let previousStage: MaturityStage | null = null;
  try {
    const rows = await store.queryFirst<{ stage: string }>(
      `SELECT stage FROM maturity_stage ORDER BY created_at DESC LIMIT 1`,
    );
    previousStage = (rows[0]?.stage as MaturityStage) ?? null;
  } catch { /* table may not exist yet — first run */ }

  const transitioned = previousStage !== null && previousStage !== report.stage;

  // Always record current stage (upsert pattern)
  try {
    if (previousStage === null || transitioned) {
      // Do NOT pass created_at as an ISO string — SurrealDB's `datetime`
      // type rejects string bindings with "Couldn't coerce value for field
      // `created_at` ... Expected `datetime` but found '...'" (swallowed
      // pre-fix). The schema has DEFAULT time::now() so letting the DB
      // fill this works correctly. This was the root cause of
      // maturity_stage having 0 rows despite the writer being wired —
      // every CREATE silently failed on the ISO-string coercion.
      await store.queryExec(
        `CREATE maturity_stage CONTENT $data`,
        {
          data: {
            stage: report.stage,
            volume_score: report.volumeScore,
            quality_score: report.qualityScore,
            met_count: report.met.length,
          },
        },
      );
    }
  } catch (e) {
    swallow.warn("soul:recordStage", e);
  }

  return { transitioned, previousStage, currentStage: report.stage, report };
}
