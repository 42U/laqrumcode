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
/**
 * Record the outcome of a write attempt under `~/.kongcode/cache/`. Call
 * sites: bootstrap.ts (auth token, daemon.pid), auto-drain.ts (spending
 * ledger), any other code path that persists state into the cache dir.
 * Each call appends an outcome to a 10-minute sliding window.
 */
export declare function recordCacheWriteOutcome(ok: boolean): void;
export declare function resetCacheWriteOutcomes(): void;
export declare function getCacheWriteFailureStats(): {
    total: number;
    failures: number;
    rate: number;
};
/**
 * Record an isAvailable() probe outcome. The detector flips critical only
 * after 5 consecutive failures within a 60s window — single transient
 * disconnects should not page the operator. Call sites that already hold
 * a store reference (orchestrator pre-flight, maintenance loop, hook
 * handlers) should call this each time they consult availability.
 */
export declare function recordDbAvailability(ok: boolean): void;
export declare function resetDbAvailability(): void;
/**
 * Contract for the embedding-service-down detector. Until EmbeddingService
 * exposes a public `lastError` getter, call sites that catch an embedding
 * error should forward it here. The detector treats the error as "fresh"
 * for 5 minutes; if a subsequent embed succeeds, callers should
 * `clearEmbeddingError()` to drop the flag.
 */
export declare function recordEmbeddingError(err: unknown): void;
export declare function clearEmbeddingError(): void;
/**
 * Memory-pressure breadcrumb for inclusion in meta.health responses.
 * Returns heap and RSS in MB plus the delta since the last call. Callers
 * (introspect, health endpoint, anomaly format) get a stable shape without
 * pulling `process` directly.
 */
export declare function getMemoryBreadcrumb(): {
    heapUsedMB: number;
    rssMB: number;
    heapDeltaMB: number;
    externalMB: number;
};
export declare function detectAnomalies(store: SurrealStore, cooldown: CooldownState): Promise<AnomalyFlag[]>;
export declare function makeCooldownState(): CooldownState;
/**
 * Helper: parse a value that should be a datetime into epoch ms, or null
 * if it's not a finite timestamp.
 *
 * Defensive against TWO observed SurrealDB return shapes:
 *
 *   1. `math::min(datetime)` returns the JS Number `Infinity` (math min
 *      identity element). `Infinity` is truthy and `new Date(Infinity)`
 *      is NaN, so the previous code path emitted "NaNh"/"Infinity" in
 *      messages. We reject non-finite Numbers explicitly.
 *
 *   2. Plain `SELECT created_at` returns a SurrealDB `DateTime` class
 *      instance — `typeof v === "object"` but `v instanceof Date === false`
 *      and `Object.keys(v).length === 0`. Its `toString()` and
 *      `toISOString()` both yield the RFC 3339 string. `new Date(v)`
 *      passes through Symbol.toPrimitive and produces a valid JS Date,
 *      so the universal path is: try the Date constructor, accept only
 *      a finite getTime().
 */
export declare function parseDatetimeMs(v: unknown): number | null;
export declare function formatAnomalyBlock(flags: AnomalyFlag[]): string;
