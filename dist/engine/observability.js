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
import { swallow } from "./errors.js";
import { log } from "./log.js";
const COOLDOWN_MS = {
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
export async function rollupDailyMetrics(store, day) {
    if (!store.isAvailable())
        return;
    try {
        const start = `d"${day}T00:00:00Z"`;
        const end = `d"${day}T23:59:59.999Z"`;
        // Aggregate orchestrator_metrics for the day
        const mRows = await store.queryFirst(`SELECT
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
       GROUP ALL`).catch(() => []);
        // Aggregate retrieval_outcome for the day
        const rRows = await store.queryFirst(`SELECT
         count() AS n,
         math::mean(utilization) AS mean_util,
         count(tool_success = false) AS tool_fails,
         count(tool_success != NONE) AS tool_total
       FROM retrieval_outcome
       WHERE created_at >= ${start} AND created_at <= ${end}
       GROUP ALL`).catch(() => []);
        const m = mRows[0];
        const r = rRows[0];
        if (!m || m.n === 0) {
            log.debug(`[observability] rollupDailyMetrics: no orchestrator_metrics rows for ${day}, skipping`);
            return;
        }
        const turn_count = m.n;
        const fast_path_rate = m.fast_n / Math.max(1, m.n);
        const tool_failure_rate = (r?.tool_total ?? 0) > 0 ? (r.tool_fails / r.tool_total) : 0;
        // math::percentile() in surrealdb returns the input array (often all-NONE)
        // when it can't compute a scalar — coerce to a real float before write.
        const asFloat = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        // UPSERT keyed on day
        await store.queryExec(`UPDATE orchestrator_metrics_daily SET
         turn_count = $turn_count,
         mean_tool_calls = $mean_tc,
         mean_turn_duration_ms = $mean_dur,
         mean_tokens_in = $mean_in,
         mean_tokens_out = $mean_out,
         p95_turn_duration_ms = $p95_dur,
         p95_tokens_in = $p95_in,
         fast_path_rate = $fast_path_rate,
         mean_retrieval_util = $mean_util,
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
           tool_failure_rate: $tool_failure_rate,
           retrieval_outcome_count: $rcount
         }
       END;`, {
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
            tool_failure_rate,
            rcount: r?.n ?? 0,
        });
        log.info(`[observability] rolled up ${day}: ${turn_count} turns, ${r?.n ?? 0} outcomes`);
    }
    catch (e) {
        swallow.warn("observability:rollupDailyMetrics", e);
    }
}
/**
 * Prune raw orchestrator_metrics rows older than the retention window.
 * Daily rollups preserve the aggregate signal; raw rows are operational.
 */
export async function pruneRawMetrics(store, retentionDays = 30) {
    if (!store.isAvailable())
        return;
    try {
        await store.queryExec(`DELETE orchestrator_metrics WHERE created_at < time::now() - ${retentionDays}d`);
    }
    catch (e) {
        swallow.warn("observability:pruneRawMetrics", e);
    }
}
// ── E2: Trend report ──
export async function computeTrends(store, windowDays = 7) {
    const empty = {
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
    if (!store.isAvailable())
        return empty;
    try {
        const rows = await store.queryFirst(`SELECT day, turn_count, mean_tool_calls, mean_turn_duration_ms,
              mean_tokens_in, mean_tokens_out, p95_turn_duration_ms,
              p95_tokens_in, fast_path_rate, mean_retrieval_util,
              tool_failure_rate, retrieval_outcome_count
       FROM orchestrator_metrics_daily
       WHERE day >= time::format(time::now() - ${windowDays}d, "%Y-%m-%d")
       ORDER BY day ASC`);
        const rollups = rows ?? [];
        if (rollups.length === 0)
            return empty;
        const summary = {
            avg_turns_per_day: mean(rollups.map(r => r.turn_count)),
            avg_tool_calls: mean(rollups.map(r => r.mean_tool_calls)),
            avg_retrieval_util: mean(rollups.map(r => r.mean_retrieval_util)),
            avg_tokens_in: mean(rollups.map(r => r.mean_tokens_in)),
            avg_tokens_out: mean(rollups.map(r => r.mean_tokens_out)),
        };
        return { window_days: windowDays, rollups, summary };
    }
    catch (e) {
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
export async function detectAnomalies(store, cooldown) {
    if (!store.isAvailable())
        return [];
    const flags = [];
    const now = Date.now();
    for (const detector of [
        detectEmbeddingGap,
        detectPendingWorkBuildup,
        detectPendingWorkAging,
        detectGraduationReady,
        detectGraduationClose,
    ]) {
        try {
            const flag = await detector(store);
            if (!flag)
                continue;
            const last = cooldown.lastFired.get(flag.code) ?? 0;
            if (now - last < COOLDOWN_MS[flag.severity])
                continue;
            cooldown.lastFired.set(flag.code, now);
            flags.push(flag);
        }
        catch (e) {
            swallow.warn(`observability:detector:${detector.name}`, e);
        }
    }
    return flags;
}
export function makeCooldownState() {
    return { lastFired: new Map() };
}
// ── Individual detectors ──
async function detectEmbeddingGap(store) {
    const rows = await store.queryFirst(`SELECT count() AS total, count(embedding != NONE) AS embedded FROM artifact GROUP ALL`);
    const r = rows[0];
    if (!r || r.total === 0)
        return null;
    const gapPct = ((r.total - r.embedded) / r.total) * 100;
    if (gapPct < 10)
        return null;
    return {
        code: "substrate.embedding_gap",
        severity: "warn",
        message: `Artifact embedding gap is ${gapPct.toFixed(1)}% — vector search will miss recent files`,
        evidence: `${r.total - r.embedded} of ${r.total} artifacts unembedded`,
        suggestion: "Trigger embedding backfill via maintenance, or wait for the daemon to catch up",
    };
}
async function detectPendingWorkBuildup(store) {
    const rows = await store.queryFirst(`SELECT count() AS n, math::min(created_at) AS oldest
     FROM pending_work WHERE status = "pending" GROUP ALL`);
    const r = rows[0];
    if (!r || r.n < 50)
        return null;
    const oldestMs = r.oldest ? new Date(r.oldest).getTime() : Date.now();
    const ageH = (Date.now() - oldestMs) / 3_600_000;
    if (ageH < 24)
        return null;
    return {
        code: "substrate.pending_work_buildup",
        severity: "warn",
        message: `pending_work queue has ${r.n} items, oldest is ${ageH.toFixed(0)}h old`,
        evidence: `count=${r.n}, oldest=${r.oldest}`,
        suggestion: "Spawn a memory-extractor subagent to drain the queue (background, opus model)",
    };
}
async function detectPendingWorkAging(store) {
    // 0.7.37: replaced post-mortem `pending_work_purged` (which fired AFTER
    // items were already deleted — useless tombstone) with a pre-purge
    // warning. Purge runs at age > 7 days; this alert fires at 5+ days,
    // giving ~2 days of actionable runway to drain the queue before data
    // loss. Threshold was chosen to be loud enough to motivate action but
    // not so chatty it nags during normal multi-day idle periods.
    const rows = await store.queryFirst(`SELECT count() AS n, math::min(created_at) AS oldest
     FROM pending_work
     WHERE status = "pending"
       AND created_at < time::now() - 5d
     GROUP ALL`);
    const r = rows[0];
    if (!r || r.n === 0)
        return null;
    const oldestMs = r.oldest ? new Date(r.oldest).getTime() : Date.now();
    const ageDays = ((Date.now() - oldestMs) / 86_400_000).toFixed(1);
    const daysToPurge = Math.max(0, 7 - parseFloat(ageDays)).toFixed(1);
    return {
        code: "substrate.pending_work_aging",
        severity: "warn",
        message: `${r.n} pending_work item${r.n === 1 ? "" : "s"} aging — oldest is ${ageDays}d, will purge in ${daysToPurge}d if not processed`,
        evidence: `count=${r.n}, oldest=${r.oldest}`,
        suggestion: "Drain the queue NOW before the 7-day purge runs. Spawn a memory-extractor subagent (background, opus model) — call fetch_pending_work in a loop and commit_work_results until empty.",
    };
}
async function detectGraduationReady(store) {
    // One-shot announcement when both volume AND quality are green.
    const { checkGraduation } = await import("./soul.js");
    const report = await checkGraduation(store);
    if (!report.ready)
        return null;
    return {
        code: "gate.graduation_ready",
        severity: "info",
        message: `Soul graduation criteria met (volume 7/7, quality ${report.qualityScore.toFixed(2)} ≥ 0.85)`,
        evidence: `stage=${report.stage}`,
        suggestion: "Soul graduation fires automatically via the pending_work pipeline at session end",
    };
}
async function detectGraduationClose(store) {
    const { checkGraduation } = await import("./soul.js");
    const report = await checkGraduation(store);
    if (report.ready)
        return null; // already covered by graduation_ready
    if (report.qualityScore < 0.80)
        return null;
    const gap = (0.85 - report.qualityScore).toFixed(3);
    return {
        code: "gate.graduation_close",
        severity: "info",
        message: `Quality score ${report.qualityScore.toFixed(2)} is within ${gap} of graduation gate (0.85)`,
        evidence: `volumeScore=${report.volumeScore.toFixed(2)}, qualityScore=${report.qualityScore.toFixed(2)}`,
        suggestion: report.diagnostics[0]?.suggestion,
    };
}
// ── Format anomalies as injection block ──
export function formatAnomalyBlock(flags) {
    if (flags.length === 0)
        return "";
    const lines = ["<kongcode-alert>"];
    for (const f of flags) {
        const sev = f.severity === "critical" ? "[!!]" : f.severity === "warn" ? "[!]" : "[info]";
        lines.push(`${sev} ${f.code}: ${f.message}`);
        lines.push(`     evidence: ${f.evidence}`);
        if (f.suggestion)
            lines.push(`     suggestion: ${f.suggestion}`);
    }
    lines.push("</kongcode-alert>");
    return lines.join("\n") + "\n\n";
}
// ── Helpers ──
function mean(xs) {
    if (xs.length === 0)
        return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}
