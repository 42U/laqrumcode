/**
 * Observability — trend computation, daily rollups, and anomaly detection
 * for the substrate. Surfaces both an `introspect trends` action (E2) and
 * an anomaly-only injection on UserPromptSubmit (E3).
 *
 * Architecture:
 *   - Raw `orchestrator_metrics` rows are written per-turn by postflight().
 *   - rollupDailyMetrics() — runs once per day from maintenance, writes one
 *     row to `orchestrator_metrics_daily` summarizing the prior day.
 *   - computeTrends() — reads `orchestrator_metrics_daily` for E2 reports
 *     (cheap, indexed lookup, no scan of raw rows).
 *   - detectAnomalies() — reads recent raw + trailing daily rollups to
 *     check absolute-threshold conditions. Statistical z-score flags are
 *     deferred to 0.5.1 once enough daily rows exist to calibrate.
 *
 * Why daily rollups instead of querying raw on demand: standard APM
 * pattern (continuous aggregates in TimescaleDB / materialized views in
 * ClickHouse). Raw rows grow unboundedly; rollups stay O(days). E2/E3
 * queries hit small tables, stay fast, and don't block the hot path.
 */
import type { SurrealStore } from "./surreal.js";
export interface DailyRollup {
    day: string;
    turn_count: number;
    mean_tool_calls: number;
    mean_turn_duration_ms: number;
    mean_tokens_in: number;
    mean_tokens_out: number;
    p95_turn_duration_ms: number;
    p95_tokens_in: number;
    fast_path_rate: number;
    mean_retrieval_util: number;
    tool_failure_rate: number;
    retrieval_outcome_count: number;
}
export interface TrendReport {
    window_days: number;
    rollups: DailyRollup[];
    summary: {
        avg_turns_per_day: number;
        avg_tool_calls: number;
        avg_retrieval_util: number;
        avg_tokens_in: number;
        avg_tokens_out: number;
    };
}
export interface AnomalyFlag {
    code: string;
    severity: "critical" | "warn" | "info";
    message: string;
    evidence: string;
    suggestion?: string;
}
export interface CooldownState {
    lastFired: Map<string, number>;
}
/**
 * Roll up a single day's worth of orchestrator_metrics + retrieval_outcome
 * into one orchestrator_metrics_daily row. Idempotent — uses UPSERT keyed
 * on `day`, so re-running for the same day overwrites with fresh aggregates.
 */
export declare function rollupDailyMetrics(store: SurrealStore, day: string): Promise<void>;
/**
 * Prune raw orchestrator_metrics rows older than the retention window.
 * Daily rollups preserve the aggregate signal; raw rows are operational.
 */
export declare function pruneRawMetrics(store: SurrealStore, retentionDays?: number): Promise<void>;
export declare function computeTrends(store: SurrealStore, windowDays?: number): Promise<TrendReport>;
export declare function resetAnomalyCache(): void;
export declare function detectAnomalies(store: SurrealStore, cooldown: CooldownState): Promise<AnomalyFlag[]>;
export declare function makeCooldownState(): CooldownState;
export declare function formatAnomalyBlock(flags: AnomalyFlag[]): string;
