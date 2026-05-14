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
/**
 * Compute quality signals from actual performance data in the graph.
 * These represent HOW WELL the agent is performing, not just how much.
 */
export declare function getQualitySignals(store: SurrealStore): Promise<QualitySignals>;
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
export declare function computeQualityScore(q: QualitySignals): number;
/**
 * Check graduation readiness with full stage classification and quality analysis.
 *
 * The `met` / `unmet` arrays cover all 8 gates: the 7 volume thresholds plus
 * the 1 quality gate (composite ≥ 0.85). `met.length / 8` is the natural
 * fraction-met display. `volumeScore` remains volume-only (out of 7) so callers
 * that want the volume-vs-quality split can still see them separately.
 */
export declare function checkGraduation(store: SurrealStore): Promise<GraduationReport>;
export interface SoulDocument {
    id: string;
    agent_id: string;
    working_style: string[];
    emotional_dimensions: {
        dimension: string;
        rationale: string;
        adopted_at: string;
    }[];
    self_observations: string[];
    earned_values: {
        value: string;
        grounded_in: string;
    }[];
    revisions: {
        timestamp: string;
        section: string;
        change: string;
        rationale: string;
    }[];
    created_at: string;
    updated_at: string;
}
export declare function hasSoul(store: SurrealStore): Promise<boolean>;
export declare function getSoul(store: SurrealStore): Promise<SoulDocument | null>;
export declare function createSoul(doc: Omit<SoulDocument, "id" | "agent_id" | "created_at" | "updated_at" | "revisions">, store: SurrealStore): Promise<boolean>;
export declare function reviseSoul(section: keyof Pick<SoulDocument, "working_style" | "emotional_dimensions" | "self_observations" | "earned_values">, newValue: unknown, rationale: string, store: SurrealStore): Promise<boolean>;
/**
 * Record a graduation_event so session-start surfaces a celebration.
 * Extracted from the former attemptGraduation() — now called by the
 * pending_work soul_generate commit handler.
 */
export declare function recordGraduationEvent(store: SurrealStore, report: GraduationReport): Promise<void>;
/**
 * Format a graduation report for human/LLM consumption.
 * Used by the introspect tool's "status" action.
 */
export declare function formatGraduationReport(report: GraduationReport): string;
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
export declare function seedSoulAsCoreMemory(soul: SoulDocument, store: SurrealStore): Promise<number>;
/**
 * Check and record stage transitions. Returns the new stage if a transition
 * occurred, null otherwise. Persists last-known stage in DB.
 */
export declare function checkStageTransition(store: SurrealStore): Promise<{
    transitioned: boolean;
    previousStage: MaturityStage | null;
    currentStage: MaturityStage;
    report: GraduationReport;
}>;
