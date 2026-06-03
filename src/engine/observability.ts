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
import { swallow } from "./errors.js";
import { log } from "./log.js";
import { getTransformErrorRate } from "./graph-context.js";

// ── Types ──

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
  // Per-flag last-fired timestamp (epoch ms). In-memory; resets on MCP
  // restart, which is fine — restart is rare relative to cooldown windows.
  lastFired: Map<string, number>;
}

const COOLDOWN_MS: Record<AnomalyFlag["severity"], number> = {
  critical: 60 * 60 * 1000, // 1h
  warn: 24 * 60 * 60 * 1000, // 24h
  info: 7 * 24 * 60 * 60 * 1000, // 7d (one-shot-ish)
};

// ── Daily rollup ──

/**
 * Roll up a single day's worth of orchestrator_metrics + retrieval_outcome
 * into one orchestrator_metrics_daily row. Idempotent — uses UPSERT keyed
 * on `day`, so re-running for the same day overwrites with fresh aggregates.
 */
export async function rollupDailyMetrics(
  store: SurrealStore,
  day: string, // YYYY-MM-DD
): Promise<void> {
  if (!store.isAvailable()) return;
  try {
    const start = `d"${day}T00:00:00Z"`;
    const end = `d"${day}T23:59:59.999Z"`;

    // Aggregate orchestrator_metrics for the day
    const mRows = await store.queryFirst<{
      n: number; mean_tc: number; mean_dur: number; mean_in: number; mean_out: number;
      p95_dur: number; p95_in: number; fast_n: number;
    }>(
      `SELECT
         count() AS n,
         math::mean(actual_tool_calls) AS mean_tc,
         math::mean(turn_duration_ms) AS mean_dur,
         math::mean(actual_tokens_in) AS mean_in,
         math::mean(actual_tokens_out) AS mean_out,
         math::percentile(turn_duration_ms, 95) AS p95_dur,
         math::percentile(actual_tokens_in, 95) AS p95_in,
         count(fast_path = true) AS fast_n
       FROM orchestrator_metrics
       WHERE created_at >= ${start} AND created_at <= ${end}
       GROUP ALL`,
    ).catch(() => []);

    // Aggregate retrieval_outcome for the day
    const rRows = await store.queryFirst<{
      n: number; mean_util: number; tool_fails: number; tool_total: number;
    }>(
      `SELECT
         count() AS n,
         math::mean(utilization) AS mean_util,
         count(tool_success = false) AS tool_fails,
         count(tool_success != NONE) AS tool_total
       FROM retrieval_outcome
       WHERE created_at >= ${start} AND created_at <= ${end}
       GROUP ALL`,
    ).catch(() => []);

    // Three-bucket composite from turn_score (when available)
    const tsRows = await store.queryFirst<{ mean_composite: number; ts_count: number }>(
      `SELECT math::mean(composite) AS mean_composite, count() AS ts_count
       FROM turn_score
       WHERE created_at >= ${start} AND created_at <= ${end} AND composite IS NOT NONE
       GROUP ALL`,
    ).catch(() => []);

    const m = (mRows as { n: number; mean_tc: number; mean_dur: number; mean_in: number; mean_out: number; p95_dur: number; p95_in: number; fast_n: number }[])[0];
    const r = (rRows as { n: number; mean_util: number; tool_fails: number; tool_total: number }[])[0];
    let ts = (tsRows as { mean_composite: number; ts_count: number }[])[0];
    // Fallback: if math::mean returned non-finite (SurrealDB float coercion), compute in JS
    if (ts && !Number.isFinite(ts.mean_composite) && (ts.ts_count ?? 0) > 0) {
      const rawTs = await store.queryFirst<{ composite: number }>(
        `SELECT composite FROM turn_score WHERE created_at >= ${start} AND created_at <= ${end} AND composite IS NOT NONE`,
      ).catch(() => []);
      const vals = (rawTs as { composite: number }[]).filter(r => Number.isFinite(r.composite));
      if (vals.length > 0) {
        ts = { mean_composite: vals.reduce((s, r) => s + r.composite, 0) / vals.length, ts_count: vals.length };
      }
    }
    if (!m || m.n === 0) {
      log.debug(`[observability] rollupDailyMetrics: no orchestrator_metrics rows for ${day}, skipping`);
      return;
    }

    const turn_count = m.n;
    const fast_path_rate = m.fast_n / Math.max(1, m.n);
    const tool_failure_rate = (r?.tool_total ?? 0) > 0 ? (r!.tool_fails / r!.tool_total) : 0;

    // math::percentile() in surrealdb returns the input array (often all-NONE)
    // when it can't compute a scalar — coerce to a real float before write.
    const asFloat = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

    const meanComposite = ts?.ts_count ? asFloat(ts.mean_composite) : null;

    // UPSERT keyed on day
    await store.queryExec(
      `UPDATE orchestrator_metrics_daily SET
         turn_count = $turn_count,
         mean_tool_calls = $mean_tc,
         mean_turn_duration_ms = $mean_dur,
         mean_tokens_in = $mean_in,
         mean_tokens_out = $mean_out,
         p95_turn_duration_ms = $p95_dur,
         p95_tokens_in = $p95_in,
         fast_path_rate = $fast_path_rate,
         mean_retrieval_util = $mean_util,
         mean_composite = $mean_composite,
         tool_failure_rate = $tool_failure_rate,
         retrieval_outcome_count = $rcount,
         created_at = time::now()
       WHERE day = $day;
       LET $exists = (SELECT id FROM orchestrator_metrics_daily WHERE day = $day LIMIT 1);
       IF array::len($exists) = 0 THEN
         CREATE orchestrator_metrics_daily CONTENT {
           day: $day,
           turn_count: $turn_count,
           mean_tool_calls: $mean_tc,
           mean_turn_duration_ms: $mean_dur,
           mean_tokens_in: $mean_in,
           mean_tokens_out: $mean_out,
           p95_turn_duration_ms: $p95_dur,
           p95_tokens_in: $p95_in,
           fast_path_rate: $fast_path_rate,
           mean_retrieval_util: $mean_util,
           mean_composite: $mean_composite,
           tool_failure_rate: $tool_failure_rate,
           retrieval_outcome_count: $rcount
         }
       END;`,
      {
        day,
        turn_count,
        mean_tc: asFloat(m.mean_tc),
        mean_dur: asFloat(m.mean_dur),
        mean_in: asFloat(m.mean_in),
        mean_out: asFloat(m.mean_out),
        p95_dur: asFloat(m.p95_dur),
        p95_in: asFloat(m.p95_in),
        fast_path_rate,
        mean_util: asFloat(r?.mean_util),
        mean_composite: meanComposite,
        tool_failure_rate,
        rcount: r?.n ?? 0,
      },
    );
    log.info(`[observability] rolled up ${day}: ${turn_count} turns, ${r?.n ?? 0} outcomes${meanComposite != null ? `, composite=${(meanComposite * 100).toFixed(1)}%` : ""}`);
  } catch (e) {
    swallow.warn("observability:rollupDailyMetrics", e);
  }
}

/**
 * Tag raw orchestrator_metrics rows older than the retention window as
 * pruned. Daily rollups preserve the aggregate signal; raw rows are
 * operational. v0.7.96 (core_memory:hoj8fvmbt7d14mskciba): was DELETE,
 * now soft-tag with `pruned_at` + `prune_reason` so any unique signal
 * remains recallable. Idempotent: `AND pruned_at IS NONE` avoids
 * re-tagging on every run.
 */
export async function pruneRawMetrics(store: SurrealStore, retentionDays = 30): Promise<void> {
  if (!store.isAvailable()) return;
  try {
    await store.queryExec(
      `UPDATE orchestrator_metrics SET
         pruned_at = time::now(),
         prune_reason = "retention_${retentionDays}d"
       WHERE created_at < time::now() - ${retentionDays}d
         AND pruned_at IS NONE`,
    );
  } catch (e) {
    swallow.warn("observability:pruneRawMetrics", e);
  }
}

// ── E2: Trend report ──

export async function computeTrends(
  store: SurrealStore,
  windowDays = 7,
): Promise<TrendReport> {
  const empty: TrendReport = {
    window_days: windowDays,
    rollups: [],
    summary: {
      avg_turns_per_day: 0,
      avg_tool_calls: 0,
      avg_retrieval_util: 0,
      avg_tokens_in: 0,
      avg_tokens_out: 0,
    },
  };
  if (!store.isAvailable()) return empty;

  try {
    const rows = await store.queryFirst<DailyRollup>(
      `SELECT day, turn_count, mean_tool_calls, mean_turn_duration_ms,
              mean_tokens_in, mean_tokens_out, p95_turn_duration_ms,
              p95_tokens_in, fast_path_rate, mean_retrieval_util,
              tool_failure_rate, retrieval_outcome_count
       FROM orchestrator_metrics_daily
       WHERE day >= time::format(time::now() - ${windowDays}d, "%Y-%m-%d")
       ORDER BY day ASC`,
    );
    const rollups = (rows as DailyRollup[]) ?? [];
    if (rollups.length === 0) return empty;

    const summary = {
      avg_turns_per_day: mean(rollups.map(r => r.turn_count)),
      avg_tool_calls: mean(rollups.map(r => r.mean_tool_calls)),
      avg_retrieval_util: mean(rollups.map(r => r.mean_retrieval_util)),
      avg_tokens_in: mean(rollups.map(r => r.mean_tokens_in)),
      avg_tokens_out: mean(rollups.map(r => r.mean_tokens_out)),
    };
    return { window_days: windowDays, rollups, summary };
  } catch (e) {
    swallow.warn("observability:computeTrends", e);
    return empty;
  }
}

// ── E3: Anomaly detection (absolute-threshold flags only for v0.5.0) ──

/**
 * Run all enabled anomaly detectors and return only flags that fire AND
 * are out of cooldown. Cooldown state is in-memory on `cooldown` — pass
 * `globalState.observabilityCooldown` from the call site.
 */
let _anomalyCacheRaw: AnomalyFlag[] = [];
let _anomalyCacheAt = 0;
const ANOMALY_CACHE_TTL_MS = 60_000;

export function resetAnomalyCache(): void {
  _anomalyCacheRaw = [];
  _anomalyCacheAt = 0;
}

// ── Substrate-health module state ──
//
// Lightweight in-process counters fed by call sites that own the resource
// (disk writes, DB connect attempts, embedding service calls). Counters are
// process-local; on daemon restart they reset. Cross-restart persistence
// is intentionally out of scope — these are operational health signals,
// not historical metrics. Rollup tables already cover the long-term view.

interface OutcomeStamp { ts: number; ok: boolean }
const CACHE_WRITE_WINDOW_MS = 10 * 60_000;
const _cacheWriteOutcomes: OutcomeStamp[] = [];

const DB_AVAILABILITY_WINDOW_MS = 60_000;
const _dbAvailabilityChecks: OutcomeStamp[] = [];

interface EmbeddingErrorState { ts: number; message: string }
let _lastEmbeddingError: EmbeddingErrorState | null = null;
const EMBEDDING_ERROR_FRESH_MS = 5 * 60_000;

let _lastHeapUsed = 0;

/**
 * Record the outcome of a write attempt under `~/.kongcode/cache/`. Call
 * sites: bootstrap.ts (auth token, daemon.pid), auto-drain.ts (spending
 * ledger), any other code path that persists state into the cache dir.
 * Each call appends an outcome to a 10-minute sliding window.
 */
export function recordCacheWriteOutcome(ok: boolean): void {
  const now = Date.now();
  _cacheWriteOutcomes.push({ ts: now, ok });
  while (_cacheWriteOutcomes.length > 0 && _cacheWriteOutcomes[0].ts < now - CACHE_WRITE_WINDOW_MS) {
    _cacheWriteOutcomes.shift();
  }
}

export function resetCacheWriteOutcomes(): void { _cacheWriteOutcomes.length = 0; }

export function getCacheWriteFailureStats(): { total: number; failures: number; rate: number } {
  const now = Date.now();
  const recent = _cacheWriteOutcomes.filter(o => o.ts >= now - CACHE_WRITE_WINDOW_MS);
  const failures = recent.filter(o => !o.ok).length;
  return { total: recent.length, failures, rate: recent.length > 0 ? failures / recent.length : 0 };
}

/**
 * Record an isAvailable() probe outcome. The detector flips critical only
 * after 5 consecutive failures within a 60s window — single transient
 * disconnects should not page the operator. Call sites that already hold
 * a store reference (orchestrator pre-flight, maintenance loop, hook
 * handlers) should call this each time they consult availability.
 */
export function recordDbAvailability(ok: boolean): void {
  const now = Date.now();
  _dbAvailabilityChecks.push({ ts: now, ok });
  while (_dbAvailabilityChecks.length > 0 && _dbAvailabilityChecks[0].ts < now - DB_AVAILABILITY_WINDOW_MS) {
    _dbAvailabilityChecks.shift();
  }
}

export function resetDbAvailability(): void { _dbAvailabilityChecks.length = 0; }

/**
 * Contract for the embedding-service-down detector. Until EmbeddingService
 * exposes a public `lastError` getter, call sites that catch an embedding
 * error should forward it here. The detector treats the error as "fresh"
 * for 5 minutes; if a subsequent embed succeeds, callers should
 * `clearEmbeddingError()` to drop the flag.
 */
export function recordEmbeddingError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  _lastEmbeddingError = { ts: Date.now(), message };
}

export function clearEmbeddingError(): void { _lastEmbeddingError = null; }

/**
 * Memory-pressure breadcrumb for inclusion in meta.health responses.
 * Returns heap and RSS in MB plus the delta since the last call. Callers
 * (introspect, health endpoint, anomaly format) get a stable shape without
 * pulling `process` directly.
 */
export function getMemoryBreadcrumb(): { heapUsedMB: number; rssMB: number; heapDeltaMB: number; externalMB: number } {
  const m = process.memoryUsage();
  const heapUsedMB = Math.round((m.heapUsed / 1024 / 1024) * 10) / 10;
  const rssMB = Math.round((m.rss / 1024 / 1024) * 10) / 10;
  const externalMB = Math.round((m.external / 1024 / 1024) * 10) / 10;
  const heapDeltaMB = _lastHeapUsed === 0 ? 0 : Math.round((heapUsedMB - _lastHeapUsed) * 10) / 10;
  _lastHeapUsed = heapUsedMB;
  return { heapUsedMB, rssMB, heapDeltaMB, externalMB };
}

export async function detectAnomalies(
  store: SurrealStore,
  cooldown: CooldownState,
): Promise<AnomalyFlag[]> {
  // Record availability for the db_unreachable detector before the
  // early-exit. The detector reads from the rolling window; if we exit
  // here without recording, the window never updates.
  const available = store.isAvailable();
  recordDbAvailability(available);
  if (!available) {
    // Run only the db-unreachable detector — it doesn't need DB access.
    const f = detectDbUnreachable();
    if (!f) return [];
    const now = Date.now();
    const last = cooldown.lastFired.get(f.code) ?? 0;
    if (now - last < COOLDOWN_MS[f.severity]) return [];
    cooldown.lastFired.set(f.code, now);
    return [f];
  }
  const now = Date.now();

  let rawFlags: AnomalyFlag[];
  if (now - _anomalyCacheAt < ANOMALY_CACHE_TTL_MS) {
    rawFlags = _anomalyCacheRaw;
  } else {
    // Detectors that do NOT need DB access (run synchronously, wrapped in
    // Promise so the Promise.allSettled batch is uniform).
    const syncDetectors: Array<() => AnomalyFlag | null> = [
      detectDbUnreachable,
      detectCacheWriteFailures,
      detectEmbeddingServiceDown,
    ];
    const dbDetectors: Array<(s: SurrealStore) => Promise<AnomalyFlag | null>> = [
      detectContextTransformFailures,
      detectEmbeddingGap,
      detectPendingWorkBuildup,
      detectPendingWorkAging,
      detectGraduationReady,
      detectGraduationClose,
    ];
    const results = await Promise.allSettled([
      ...syncDetectors.map(d => Promise.resolve(d())),
      ...dbDetectors.map(d => d(store)),
    ]);
    rawFlags = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) rawFlags.push(r.value);
    }
    _anomalyCacheRaw = rawFlags;
    _anomalyCacheAt = now;
  }

  const flags: AnomalyFlag[] = [];
  for (const flag of rawFlags) {
    const last = cooldown.lastFired.get(flag.code) ?? 0;
    if (now - last < COOLDOWN_MS[flag.severity]) continue;
    cooldown.lastFired.set(flag.code, now);
    flags.push(flag);
  }
  return flags;
}

export function makeCooldownState(): CooldownState {
  return { lastFired: new Map() };
}

// ── Individual detectors ──

async function detectEmbeddingGap(store: SurrealStore): Promise<AnomalyFlag | null> {
  const rows = await store.queryFirst<{ total: number; embedded: number }>(
    `SELECT count() AS total, count(embedding != NONE) AS embedded FROM artifact GROUP ALL`,
  );
  const r = (rows as { total: number; embedded: number }[])[0];
  if (!r || r.total === 0) return null;
  const gapPct = ((r.total - r.embedded) / r.total) * 100;
  if (gapPct < 10) return null;
  return {
    code: "substrate.embedding_gap",
    severity: "warn",
    message: `Artifact embedding gap is ${gapPct.toFixed(1)}% — vector search will miss recent files`,
    evidence: `${r.total - r.embedded} of ${r.total} artifacts unembedded`,
    suggestion: "Trigger embedding backfill via maintenance, or wait for the daemon to catch up",
  };
}

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
export function parseDatetimeMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // Final fallback: pass anything else (string, SurrealDB DateTime,
  // native Date, Date-coercible object) through the Date constructor.
  // String() handles the SurrealDB DateTime case where the object
  // doesn't auto-coerce on `new Date(obj)` in all driver versions.
  try {
    let t = new Date(v as any).getTime();
    if (!Number.isFinite(t)) {
      // Try via String() — SurrealDB DateTime's toString() emits RFC 3339.
      t = new Date(String(v)).getTime();
    }
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Format a duration in ms as a human-readable age. Returns "unknown" when input is null. */
function formatAge(ms: number | null, unit: "hours" | "days" = "hours"): string {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  if (unit === "hours") {
    const h = ms / 3_600_000;
    if (!Number.isFinite(h)) return "unknown";
    return `${h.toFixed(0)}h`;
  }
  const d = ms / 86_400_000;
  if (!Number.isFinite(d)) return "unknown";
  return `${d.toFixed(1)}d`;
}

/**
 * Fetch the oldest `created_at` for pending_work rows matching `extraWhere`.
 *
 * Avoids `math::min(created_at)` because SurrealDB returns `Infinity` (the
 * math identity) for that aggregate over datetime columns — a JSON-null
 * masquerading as a non-finite Number that poisons downstream date math.
 * Instead, do an indexed `ORDER BY created_at ASC LIMIT 1`, which returns
 * a real datetime string the driver decodes correctly.
 */
async function queryOldestPending(
  store: SurrealStore,
  extraWhere: string,
): Promise<{ oldestMs: number | null; oldestRaw: string | null }> {
  const rows = await store.queryFirst<{ created_at: unknown }>(
    `SELECT created_at FROM pending_work
     WHERE status = "pending" AND (active = true OR active IS NONE)${extraWhere ? " AND " + extraWhere : ""}
     ORDER BY created_at ASC LIMIT 1`,
  );
  const r = (rows as { created_at: unknown }[])[0];
  if (!r || r.created_at == null) return { oldestMs: null, oldestRaw: null };
  const oldestMs = parseDatetimeMs(r.created_at);
  // SurrealDB DateTime objects stringify to RFC 3339; native Date emits ISO.
  // Use String() so the evidence field always carries the human-readable
  // form even when our parser couldn't extract epoch ms.
  return { oldestMs, oldestRaw: String(r.created_at) };
}

async function detectPendingWorkBuildup(store: SurrealStore): Promise<AnomalyFlag | null> {
  // Count + oldest are split into two queries because `math::min(datetime)`
  // is broken in SurrealDB 3.x — see queryOldestPending() comment.
  const countRows = await store.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM pending_work WHERE status = "pending" AND (active = true OR active IS NONE) GROUP ALL`,
  );
  const c = (countRows as { n: number }[])[0];
  if (!c || c.n < 50) return null;

  const { oldestMs, oldestRaw } = await queryOldestPending(store, "");
  const ageMs = oldestMs != null ? Date.now() - oldestMs : null;
  // Threshold check: skip if we know oldest and it's <24h. If oldestMs is
  // null (unknown), still surface the alert — 50+ items pending is itself
  // a problem worth flagging.
  if (ageMs != null && ageMs / 3_600_000 < 24) return null;

  const ageStr = formatAge(ageMs, "hours");
  return {
    code: "substrate.pending_work_buildup",
    severity: "warn",
    message: `pending_work queue has ${c.n} items, oldest is ${ageStr} old`,
    evidence: `count=${c.n}, oldest=${oldestRaw ?? "unknown"}`,
    suggestion: "Spawn a memory-extractor subagent to drain the queue (background, opus model)",
  };
}

async function detectPendingWorkAging(store: SurrealStore): Promise<AnomalyFlag | null> {
  // 0.7.37: replaced post-mortem `pending_work_purged` (which fired AFTER
  // items were already deleted — useless tombstone) with a pre-purge
  // warning. Purge runs at age > 7 days; this alert fires at 5+ days,
  // giving ~2 days of actionable runway to drain the queue before data
  // loss. Threshold was chosen to be loud enough to motivate action but
  // not so chatty it nags during normal multi-day idle periods.
  //
  // Like detectPendingWorkBuildup, split count + oldest because
  // `math::min(datetime)` returns Infinity in SurrealDB 3.x.
  const countRows = await store.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM pending_work
     WHERE status = "pending" AND (active = true OR active IS NONE) AND created_at < time::now() - 5d GROUP ALL`,
  );
  const c = (countRows as { n: number }[])[0];
  if (!c || c.n === 0) return null;

  const { oldestMs, oldestRaw } = await queryOldestPending(
    store,
    "created_at < time::now() - 5d",
  );
  const ageMs = oldestMs != null ? Date.now() - oldestMs : null;
  const ageStr = formatAge(ageMs, "days");
  const ageDaysNum = ageMs != null ? ageMs / 86_400_000 : null;
  const daysToPurgeStr = ageDaysNum != null && Number.isFinite(ageDaysNum)
    ? Math.max(0, 7 - ageDaysNum).toFixed(1) + "d"
    : "unknown";

  return {
    code: "substrate.pending_work_aging",
    severity: "warn",
    message: `${c.n} pending_work item${c.n === 1 ? "" : "s"} aging — oldest is ${ageStr}, will purge in ${daysToPurgeStr} if not processed`,
    evidence: `count=${c.n}, oldest=${oldestRaw ?? "unknown"}`,
    suggestion: "Drain the queue NOW before the 7-day purge runs. Spawn a memory-extractor subagent (background, opus model) — call fetch_pending_work in a loop and commit_work_results until empty.",
  };
}

async function detectGraduationReady(store: SurrealStore): Promise<AnomalyFlag | null> {
  // One-shot announcement when both volume AND quality are green.
  // Soul graduation is a ONE-TIME event tied to the existence of soul:kongbrain.
  // After the soul exists graduation has already happened, so this detector
  // must suppress — otherwise it keeps celebrating an event from months ago.
  const { checkGraduation, hasSoul } = await import("./soul.js");
  if (await hasSoul(store)) return null; // already graduated; no further "ready" alert
  const report = await checkGraduation(store);
  if (!report.ready) return null;
  return {
    code: "gate.graduation_ready",
    severity: "info",
    message: `Soul graduation criteria met (${report.met.length}/8 gates, quality ${report.qualityScore.toFixed(2)} >= 0.85)`,
    evidence: `stage=${report.stage}`,
    suggestion: "Soul graduation fires automatically via the pending_work pipeline at session end",
  };
}

async function detectGraduationClose(store: SurrealStore): Promise<AnomalyFlag | null> {
  // Two modes depending on whether soul already exists:
  //   - Pre-soul: this is a genuine "you're approaching graduation" alert
  //     (gate.graduation_close, info severity).
  //   - Post-soul: graduation already happened. Same metric (quality near
  //     0.85) now means quality is hovering near the floor that originally
  //     qualified the agent — i.e. a regression watch, not a graduation
  //     approach. Reframe under a different code so the language stays
  //     truthful.
  const { checkGraduation, hasSoul } = await import("./soul.js");
  const soulExists = await hasSoul(store);
  const report = await checkGraduation(store);
  if (report.qualityScore < 0.80) return null;

  if (!soulExists) {
    if (report.ready) return null; // already covered by graduation_ready
    const gap = (0.85 - report.qualityScore).toFixed(3);
    return {
      code: "gate.graduation_close",
      severity: "info",
      message: `Quality score ${report.qualityScore.toFixed(2)} is within ${gap} of graduation gate (0.85)`,
      evidence: `volumeScore=${report.volumeScore.toFixed(2)}, qualityScore=${report.qualityScore.toFixed(2)}`,
      suggestion: report.diagnostics[0]?.suggestion,
    };
  }

  // Post-graduation: only fire when quality has slipped under the 0.85 gate.
  // Hovering above 0.85 is normal steady-state for a graduated agent and
  // doesn't deserve an alert.
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

async function detectContextTransformFailures(_store: SurrealStore): Promise<AnomalyFlag | null> {
  const { total, failures, rate } = getTransformErrorRate();
  if (total < 3 || failures < 3) return null;
  if (rate < 0.3) return null;
  return {
    code: "substrate.context_transform_failures",
    severity: rate >= 0.8 ? "critical" : "warn",
    message: `graphTransformContext failing ${failures}/${total} calls (${(rate * 100).toFixed(0)}%) in the last 10 minutes — memory context is not being injected`,
    evidence: `failures=${failures}, total=${total}, rate=${rate.toFixed(2)}`,
    suggestion: "Check daemon.log for timeout/DB errors. Common causes: slow SurrealDB queries, broken embeddings, stale daemon. Try restarting the daemon.",
  };
}

// ── New substrate-health detectors (Agent E recommendations) ──

/**
 * Fires when disk writes to ~/.kongcode/cache/ are failing. Reads from
 * the rolling 10-minute counter populated by recordCacheWriteOutcome().
 * Threshold: 5+ failures in window. Severity escalates to critical when
 * the failure rate exceeds 50%, since at that point essential state
 * (auth token, daemon.pid, spending ledger) is not being persisted.
 */
function detectCacheWriteFailures(): AnomalyFlag | null {
  const { total, failures, rate } = getCacheWriteFailureStats();
  if (failures < 5) return null;
  return {
    code: "substrate.cache_write_failures",
    severity: rate >= 0.5 ? "critical" : "warn",
    message: `~/.kongcode/cache/ writes failing: ${failures}/${total} in the last 10 minutes (${(rate * 100).toFixed(0)}%)`,
    evidence: `failures=${failures}, total=${total}, rate=${rate.toFixed(2)}`,
    suggestion: "Check disk space (`df -h ~/.kongcode/cache`), inode count, and directory permissions. Auth token, daemon.pid, and spending ledger live here — daemon may be running degraded.",
  };
}

/**
 * Fires critical after 5 consecutive failed isAvailable() probes within
 * a 60-second window. Single transient disconnects are tolerated; this
 * detector is for sustained outages (process gone, network partition,
 * disk full preventing SurrealKV flush). detectAnomalies() records each
 * probe inline so the window stays warm even when other detectors are
 * skipped because the DB is down.
 */
function detectDbUnreachable(): AnomalyFlag | null {
  if (_dbAvailabilityChecks.length < 5) return null;
  // Look at the last 5 checks (most recent at end of array).
  const tail = _dbAvailabilityChecks.slice(-5);
  const allFailed = tail.every(c => !c.ok);
  if (!allFailed) return null;
  const span = tail[tail.length - 1].ts - tail[0].ts;
  if (span > DB_AVAILABILITY_WINDOW_MS) return null; // checks too spread out
  return {
    code: "substrate.db_unreachable",
    severity: "critical",
    message: `SurrealDB unreachable: 5 consecutive isAvailable() probes failed within ${Math.round(span / 1000)}s`,
    evidence: `consecutive_failures=5, span_ms=${span}`,
    suggestion: "Check the SurrealDB process (`pgrep -af surreal`) and restart it. The daemon runs in degraded mode without DB — no memory writes, no retrieval.",
  };
}

/**
 * Fires when the embedding service has reported an error within the last
 * 5 minutes. Contract: call recordEmbeddingError(err) from any embed()
 * catch site. Severity is warn rather than critical because the daemon
 * has a circuit breaker that short-circuits without paging on every call.
 */
function detectEmbeddingServiceDown(): AnomalyFlag | null {
  if (!_lastEmbeddingError) return null;
  const ageMs = Date.now() - _lastEmbeddingError.ts;
  if (ageMs > EMBEDDING_ERROR_FRESH_MS) return null;
  const msg = _lastEmbeddingError.message.slice(0, 160);
  return {
    code: "substrate.embedding_service_down",
    severity: "warn",
    message: `Embedding service reported an error ${Math.round(ageMs / 1000)}s ago — embeddings are unavailable`,
    evidence: `last_error="${msg}"`,
    suggestion: "Check daemon.log for the stack. Common causes: model file missing (~/.kongcode/cache/models/bge-m3-Q4_K_M.gguf), node-llama-cpp init failure, repeated embed timeouts tripping the circuit breaker.",
  };
}

// ── Format anomalies as injection block ──

export function formatAnomalyBlock(flags: AnomalyFlag[]): string {
  if (flags.length === 0) return "";
  const lines = ["<kongcode-alert>"];
  for (const f of flags) {
    const sev = f.severity === "critical" ? "[!!]" : f.severity === "warn" ? "[!]" : "[info]";
    lines.push(`${sev} ${f.code}: ${f.message}`);
    lines.push(`     evidence: ${f.evidence}`);
    if (f.suggestion) lines.push(`     suggestion: ${f.suggestion}`);
  }
  lines.push("</kongcode-alert>");
  return lines.join("\n") + "\n\n";
}

// ── Helpers ──

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
