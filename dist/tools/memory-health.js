/**
 * memory_health MCP tool — machine-readable substrate self-audit.
 *
 * Returns a structured JSON report covering connectivity, record counts,
 * embedding coverage gaps, pending-work backlog, and the quality signals
 * used for soul graduation. Bots can consume this to self-diagnose, and
 * the response is compact enough to inject into a hook turn if things go
 * sideways.
 *
 * This is the programmatic counterpart to the skills/kongcode-health
 * text-based skill — same data, structured output.
 */
import { statSync } from "node:fs";
import { swallow } from "../engine/errors.js";
import { probeEmbeddingService } from "../engine/embeddings.js";
// v0.7.96 W2-6 dist-drift detection. The running daemon loads dist/ files at
// startup and keeps them in memory. After `npm run build` lands a new
// dist/, the daemon STILL runs the old code until restarted. The v0.7.96
// incident logged this: PID 34196 ran pre-Phase-X code for 12+ hours and
// continually produced supersede corruption. Capturing the daemon-entrypoint
// mtime at module-load (which runs once when the daemon imports this file
// at startup) gives a snapshot; comparing against the current on-disk mtime
// at call-time surfaces drift. memory:p5s9vfihd65pnffomztp.
const DAEMON_ENTRYPOINT_PATH = process.argv[1] ?? "";
let distMtimeAtStartup = 0;
try {
    if (DAEMON_ENTRYPOINT_PATH) {
        distMtimeAtStartup = statSync(DAEMON_ENTRYPOINT_PATH).mtimeMs;
    }
}
catch { /* startup-time stat may fail in test contexts; drift detection silently disabled */ }
async function probeEmbeddings(embeddings) {
    const probed = await probeEmbeddingService(embeddings);
    // memory-health omits the detail field on the "ok" path. Mapping `message`
    // → `detail` here preserves that convention so the JSON output shape stays
    // backwards-compatible with existing memory_health consumers.
    if (probed.status === "ok")
        return { status: "ok" };
    return { status: probed.status, detail: probed.message };
}
/** null = the count query FAILED (connection wobble, bad table, cast error) —
 *  deliberately distinct from 0 = "ran fine, table is empty". An empty result
 *  set from GROUP ALL (no rows at all) is a legitimate 0. */
async function countRow(state, sql) {
    try {
        const rows = await state.store.queryFirst(sql);
        const n = Number(rows[0]?.n ?? 0);
        return Number.isFinite(n) ? n : null;
    }
    catch (e) {
        swallow("memoryHealth:count", e);
        return null;
    }
}
export async function handleMemoryHealth(state, _session, _args) {
    const diagnostics = [];
    // Probe by actual query, not by db.isConnected — the SurrealDB v2 client's
    // isConnected property can lag reality after transient reconnects, leading
    // memory_health to incorrectly report RED while introspect (which uses
    // store.ping()) reports the connection healthy. Discovered on a Windows
    // install where the two tools disagreed on the same store reference.
    let connection = "down";
    try {
        if (typeof state.store.ping === "function") {
            const alive = await state.store.ping();
            connection = alive ? "ok" : "down";
        }
        else {
            connection = state.store.isAvailable() ? "ok" : "down";
        }
    }
    catch {
        connection = "down";
    }
    const embProbe = await probeEmbeddings(state.embeddings);
    if (connection === "down") {
        const report = {
            status: "red",
            connection,
            embedding_service: embProbe.status,
            // Connection down ⇒ counts are UNKNOWN, not zero (T5 null-sentinel).
            metrics: {
                concept_count: null, concept_embedded: null,
                memory_count: null, memory_embedded: null,
                turn_count: null, turn_embedded: null,
                artifact_count: null, artifact_embedded: null,
                retrieval_outcome_count: null, pending_work_count: null,
                embedding_gap_pct: null,
            },
            diagnostics: [
                { severity: "error", area: "connection", message: "SurrealDB store is not available." },
            ],
        };
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
    // Parallel counts where possible.
    const [concept_count, concept_embedded, memory_count, memory_embedded, turn_count, turn_embedded, artifact_count, artifact_embedded, retrieval_outcome_count, pending_work_count,] = await Promise.all([
        countRow(state, "SELECT count() AS n FROM concept GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM concept WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM memory GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM memory WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM turn GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM turn WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM artifact GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM artifact WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL"),
        countRow(state, "SELECT count() AS n FROM retrieval_outcome GROUP ALL"),
        // W2-04: active filter matches fetch_pending_work's claim filter — without
        // it, soft-archived forensic rows (active=false) count as phantom backlog.
        countRow(state, "SELECT count() AS n FROM pending_work WHERE status = 'pending' AND (active = true OR active IS NONE) GROUP ALL"),
    ]);
    // Surface failed counts loudly — a null is a broken probe, not an empty table.
    const failedCounts = [
        ["concept_count", concept_count], ["concept_embedded", concept_embedded],
        ["memory_count", memory_count], ["memory_embedded", memory_embedded],
        ["turn_count", turn_count], ["turn_embedded", turn_embedded],
        ["artifact_count", artifact_count], ["artifact_embedded", artifact_embedded],
        ["retrieval_outcome_count", retrieval_outcome_count], ["pending_work_count", pending_work_count],
    ].filter(([, v]) => v === null).map(([k]) => k);
    if (failedCounts.length > 0) {
        diagnostics.push({
            severity: "warn", area: "metrics",
            message: `count queries failed for: ${failedCounts.join(", ")} — reported as null (NOT 0). The store answered the connection probe but not these counts; check daemon stderr.`,
        });
    }
    // Compute an aggregate embedding gap percentage across the main embedded
    // tables — only when every input count actually succeeded.
    const gapInputs = [concept_count, memory_count, turn_count, artifact_count,
        concept_embedded, memory_embedded, turn_embedded, artifact_embedded];
    let embedding_gap_pct = null;
    if (gapInputs.every((v) => v !== null)) {
        const total = concept_count + memory_count + turn_count + artifact_count;
        const totalEmbedded = concept_embedded + memory_embedded + turn_embedded + artifact_embedded;
        embedding_gap_pct = total > 0 ? Math.round(((total - totalEmbedded) / total) * 100) : 0;
    }
    const metrics = {
        concept_count, concept_embedded,
        memory_count, memory_embedded,
        turn_count, turn_embedded,
        artifact_count, artifact_embedded,
        retrieval_outcome_count, pending_work_count,
        embedding_gap_pct,
    };
    // Diagnostics — tuned for the substrate-healthiness framing.
    if (embProbe.status === "down") {
        diagnostics.push({
            severity: "error", area: "embedding_service",
            message: `BGE-M3 embedding service unavailable (${embProbe.detail ?? "unknown"}) — recall, cluster_scan, supersede, and any query-time vector ops will fail. Check EMBED_MODEL_PATH and the MCP server stderr for initialize() errors.`,
        });
    }
    else if (embProbe.status === "degraded") {
        diagnostics.push({
            severity: "warn", area: "embedding_service",
            message: `BGE-M3 probe degraded (${embProbe.detail ?? "unknown"}) — embed flag is OK but a live embed call did not return a vector.`,
        });
    }
    if (embedding_gap_pct !== null && embedding_gap_pct > 15) {
        diagnostics.push({
            severity: "warn", area: "embedding",
            message: `embedding gap is ${embedding_gap_pct}% across concept/memory/turn/artifact — embedder may be lagging`,
        });
    }
    if (pending_work_count !== null && pending_work_count > 50) {
        diagnostics.push({
            severity: "warn", area: "pending_work",
            message: `${pending_work_count} items in pending_work queue — subagent drainer may be slow`,
        });
    }
    // null < 100 would coerce to 0 < 100 = true and fire this spuriously on a
    // failed count — require both probes to have actually succeeded.
    if (retrieval_outcome_count !== null && turn_count !== null &&
        retrieval_outcome_count < 100 && turn_count > 200) {
        diagnostics.push({
            severity: "warn", area: "acan",
            message: "retrieval_outcome count is low relative to turn count — ACAN may not have enough training data",
        });
    }
    // W2-6: detect daemon dist-drift. If the dist file on disk has a newer
    // mtime than when this module first loaded, the daemon is running stale
    // code (the v0.7.96 PID-34196 incident). Push a warn-level diagnostic so
    // operators see it in the next memory_health call.
    if (distMtimeAtStartup > 0 && DAEMON_ENTRYPOINT_PATH) {
        try {
            const currentMtime = statSync(DAEMON_ENTRYPOINT_PATH).mtimeMs;
            if (currentMtime > distMtimeAtStartup + 1000 /* 1s slack */) {
                const ageHours = ((Date.now() - distMtimeAtStartup) / 3_600_000).toFixed(1);
                diagnostics.push({
                    severity: "warn",
                    area: "daemon_dist_drift",
                    message: `daemon dist drift detected: ${DAEMON_ENTRYPOINT_PATH} mtime advanced ` +
                        `since daemon startup (${ageHours}h ago). The running daemon is on ` +
                        `stale code; restart it to pick up changes. Pattern: ` +
                        `\`ps aux | grep kongcode/dist/daemon\` then \`kill <PID>\` ` +
                        `(auto-respawns on next IPC connect). See memory:p5s9vfihd65pnffomztp.`,
                });
            }
        }
        catch (e) {
            swallow("memoryHealth:distMtime", e);
        }
    }
    // Overall status.
    let status = "green";
    if (diagnostics.some(d => d.severity === "error"))
        status = "red";
    else if (diagnostics.some(d => d.severity === "warn"))
        status = "yellow";
    const report = { status, connection, embedding_service: embProbe.status, metrics, diagnostics };
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
}
