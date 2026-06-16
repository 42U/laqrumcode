/**
 * Introspect tool — inspect the memory database.
 * Ported from kongbrain with SurrealStore injection.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { assertRecordId } from "../surreal.js";
import { migrateWorkspace } from "../workspace-migrate.js";
import { checkGraduation, formatGraduationReport, hasSoul } from "../soul.js";
import { computeTrends } from "../observability.js";
import { recoverProjectIdRows, recoverDaemonOrphans } from "../recovery.js";
import { SECRET_PATTERNS } from "../redact.js";
import { probeEmbeddingService as probeEmbeddingsRaw } from "../embeddings.js";
import { pickPort, LEGACY_MANAGED_SURREAL_PORT } from "../bootstrap.js";
const ALLOWED_TABLES = new Set([
    "agent", "project", "task", "artifact", "concept",
    "turn", "identity_chunk", "session", "memory",
    "core_memory", "monologue", "skill", "reflection",
    "retrieval_outcome", "orchestrator_metrics",
    "causal_chain", "compaction_checkpoint", "subagent",
    "memory_utility_cache", "soul", "graduation_event", "maturity_stage", "pending_work",
    "turn_score",
]);
const VECTOR_TABLES = new Set([
    "concept", "memory", "artifact", "identity_chunk", "turn", "monologue", "skill", "reflection",
]);
const COUNT_FILTERS = {
    active: "WHERE active = true",
    inactive: "WHERE active = false",
    recent_24h: "WHERE created_at > time::now() - 24h",
    with_embedding: "WHERE embedding != NONE AND array::len(embedding) > 0",
    unresolved: "WHERE status != 'resolved' OR status IS NONE",
};
// Per-table overrides where the generic filter has the wrong semantics for
// that table's status vocabulary. Without this, `count filter=unresolved`
// against pending_work used memory-table semantics ('!= resolved') and
// reported every row as unresolved — including completed/failed/skipped.
// Now it reports only the truly-claimable backlog (status='pending').
const TABLE_FILTER_OVERRIDES = {
    pending_work: {
        // W2-04: + active filter (matches fetch_pending_work) so soft-archived
        // forensic rows don't read as claimable backlog.
        unresolved: "WHERE status = 'pending' AND (active = true OR active IS NONE)",
    },
};
const QUERY_TEMPLATES = {
    recent: {
        sql: "SELECT id, text, content, description, created_at FROM type::table($t) ORDER BY created_at DESC LIMIT 5",
        description: "Last 5 records by creation time",
        needsTable: true,
    },
    sessions: {
        sql: "SELECT id, started_at, turn_count, total_input_tokens, total_output_tokens, last_active FROM session ORDER BY started_at DESC LIMIT 10",
        description: "Last 10 sessions with stats",
    },
    core_by_category: {
        sql: "SELECT category, count() AS count FROM core_memory WHERE active = true GROUP BY category",
        description: "Core memory entries grouped by category (always queries core_memory table; ignores table param)",
    },
    memory_status: {
        sql: "SELECT status, count() AS count FROM memory GROUP BY status",
        description: "Memory counts grouped by status (always queries memory table; ignores table param)",
    },
    status_breakdown: {
        sql: "SELECT status, count() AS count FROM type::table($t) GROUP BY status",
        description: "Generic status breakdown for any status-bearing table — pass table=<name>",
        needsTable: true,
    },
    pending_work_summary: {
        sql: "SELECT work_type, status, count() AS count FROM pending_work GROUP BY work_type, status ORDER BY work_type, status",
        description: "pending_work queue: row counts grouped by work_type AND status",
    },
    embedding_coverage: {
        sql: "",
        description: "Per-table embedding vs total counts",
    },
    turn_scores: {
        sql: `SELECT session_id, context_util, rules_compliance, curation, composite, created_at
          FROM turn_score ORDER BY created_at DESC LIMIT 10`,
        description: "Recent turn scores with three-bucket breakdown",
    },
    turn_score_summary: {
        sql: `SELECT count() AS total,
           count(composite IS NOT NONE) AS scored,
           count(composite IS NONE) AS pending
          FROM turn_score GROUP ALL`,
        description: "Turn score counts: total, scored (composite filled), pending (awaiting backfill)",
    },
    orphan_concepts: {
        // Concepts older than 1h with no derived_from edge — flags provenance
        // gaps from the kind of silent edge-write failure that 0.7.23 fixed.
        // 0.7.33: exclude `ingest:turn` source. Per-turn extractions don't write
        // `derived_from` edges (the turn IS their provenance, traversable via
        // the existing `mentions` edge from turn→concept). They were dominating
        // the result set with hundreds of false-positive "orphans" per active
        // session. The detector should fire only for missing-edge bugs in
        // gem/causal extraction, where derived_from is the canonical link.
        sql: `SELECT id, content, created_at, source
          FROM concept
          WHERE created_at < time::now() - 1h
            AND array::len(->derived_from->?) = 0
            AND (source IS NONE OR source != 'ingest:turn')
          ORDER BY created_at DESC
          LIMIT 25`,
        description: "Concepts >1h old with no derived_from provenance edge (excludes ingest:turn — those use the turn->concept mentions edge instead)",
    },
};
const introspectSchema = Type.Object({
    action: Type.Union([
        Type.Literal("status"),
        Type.Literal("count"),
        Type.Literal("verify"),
        Type.Literal("query"),
        Type.Literal("migrate"),
        Type.Literal("trends"),
        Type.Literal("stats"),
    ], { description: "Action: status (health overview), count (row counts), verify (confirm record), query (predefined reports), migrate (default: ingest workspace .md files; filter=backfill_derived_from for pre-0.7.23 orphan provenance, filter=backfill_project_id for pre-0.7.26 unscoped concepts/memories — ask user first), trends (daily rolling means + anomaly flags from orchestrator_metrics_daily), stats (usage/cost report: 7d/30d sessions+turns+tokens+extractions, auto-drain spawns vs daily budget, graph counts, DB size on disk)." }),
    table: Type.Optional(Type.String({ description: "Table name for count/query actions." })),
    filter: Type.Optional(Type.String({ description: "For count: active, inactive, recent_24h, with_embedding, unresolved. For query: template name. For migrate: backfill_derived_from (pre-0.7.23 orphan edges) or backfill_project_id (pre-0.7.26 missing project scope on concepts/memories)." })),
    record_id: Type.Optional(Type.String({ description: "Record ID for verify action (e.g. memory:abc123)." })),
});
export function createIntrospectToolDef(state, session) {
    return {
        name: "introspect",
        label: "Memory Introspect",
        description: "Inspect your memory database. Use for ALL database queries — NEVER use curl or bash to access SurrealDB directly. Actions: status (health + table counts), count (filtered row counts), verify (confirm record exists), query (predefined reports).",
        parameters: introspectSchema,
        execute: async (_toolCallId, params) => {
            const { store } = state;
            if (!store.isAvailable()) {
                return { content: [{ type: "text", text: "Database unavailable." }], details: null };
            }
            try {
                switch (params.action) {
                    case "status": return await statusAction(store, session.sessionId, state.embeddings);
                    case "count": return await countAction(store, params.table, params.filter);
                    case "verify": return await verifyAction(store, params.record_id);
                    case "query": return await queryAction(store, params.table, params.filter);
                    case "migrate": return await migrateAction(state, params.filter);
                    case "trends": return await trendsAction(state);
                    case "stats": return await statsAction(state);
                }
            }
            catch (err) {
                return { content: [{ type: "text", text: `Introspect failed: ${err}` }], details: null };
            }
        },
    };
}
// ── Actions ──────────────────────────────────────────────────────────────
async function statusAction(store, sessionId, embeddings) {
    const info = store.getInfo();
    const alive = await store.ping();
    const embStatus = await probeEmbeddingService(embeddings);
    // Strip embedded user:pass from the connection URL before printing — the
    // statusAction output frequently ends up in shared session logs, and a
    // surreal://user:pass@host/ form would otherwise leak credentials. Matches
    // any scheme://userinfo@ prefix and replaces the userinfo portion.
    const rawUrl = info?.url ?? "unknown";
    const safeUrl = typeof rawUrl === "string"
        ? rawUrl.replace(/^(\w+:\/\/)[^:@/]+:[^@/]+@/, "$1[credentials-redacted]@")
        : "unknown";
    const lines = [];
    lines.push("MEMORY DATABASE STATUS");
    lines.push("═══════════════════════════════════");
    lines.push(`Connection:  ${safeUrl}`);
    lines.push(`Namespace:   ${info?.ns ?? "unknown"}`);
    lines.push(`Database:    ${info?.db ?? "unknown"}`);
    lines.push(`Ping:        ${alive ? "OK" : "FAILED"}`);
    lines.push(`Embeddings:  ${embStatus.label}`);
    lines.push(`Session:     ${sessionId}`);
    lines.push("");
    const counts = {};
    const embCounts = {};
    for (const t of ALLOWED_TABLES) {
        try {
            const rows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) GROUP ALL`, { t });
            counts[t] = rows[0]?.count ?? 0;
        }
        catch {
            counts[t] = -1;
        }
    }
    for (const t of VECTOR_TABLES) {
        try {
            const rows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL`, { t });
            embCounts[t] = rows[0]?.count ?? 0;
        }
        catch {
            embCounts[t] = 0;
        }
    }
    for (const t of ALLOWED_TABLES) {
        const c = counts[t];
        const label = (t + ":").padEnd(28);
        const countStr = c === -1 ? "error" : String(c).padStart(5);
        const embStr = VECTOR_TABLES.has(t) ? `  (${embCounts[t] ?? 0} embedded)` : "";
        lines.push(`  ${label}${countStr}${embStr}`);
    }
    const totalNodes = Object.values(counts).filter(c => c >= 0).reduce((a, b) => a + b, 0);
    const totalEmb = Object.values(embCounts).reduce((a, b) => a + b, 0);
    lines.push("");
    lines.push(`Total records:     ${totalNodes}`);
    lines.push(`Total embeddings:  ${totalEmb}`);
    // Graduation status
    lines.push("");
    lines.push("SOUL GRADUATION");
    lines.push("═══════════════════════════════════");
    try {
        const soulExists = await hasSoul(store);
        if (soulExists) {
            lines.push("Status: GRADUATED (soul document exists)");
        }
        else {
            const report = await checkGraduation(store);
            lines.push(formatGraduationReport(report));
        }
    }
    catch {
        lines.push("Status: Unable to check graduation");
    }
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { counts, embCounts, alive, totalNodes, totalEmb, embeddings: embStatus },
    };
}
// Probe the in-process BGE-M3 service. isAvailable() only checks the `ready`
// flag; a real one-token embed proves the runtime path actually works (catches
// native-binding crashes that leave `ready=true` but throw on use). When down,
// pull from getDiagnostics() to name the actual init failure instead of just
// reporting `isAvailable=false`.
async function probeEmbeddingService(embeddings) {
    const { status, message } = await probeEmbeddingsRaw(embeddings);
    const prefix = status === "ok" ? "OK" : status === "degraded" ? "DEGRADED" : "DOWN";
    const sep = status === "ok" ? " (" : " — ";
    const suffix = status === "ok" ? ")" : "";
    return { status, label: `${prefix}${sep}${message}${suffix}` };
}
async function countAction(store, table, filter) {
    if (!table || !ALLOWED_TABLES.has(table)) {
        return {
            content: [{ type: "text", text: `Error: valid 'table' required. Available: ${[...ALLOWED_TABLES].sort().join(", ")}` }],
            details: null,
        };
    }
    let whereClause = "";
    if (filter) {
        if (!COUNT_FILTERS[filter]) {
            return {
                content: [{ type: "text", text: `Error: unknown filter "${filter}". Available: ${Object.keys(COUNT_FILTERS).join(", ")}` }],
                details: null,
            };
        }
        const tableOverride = TABLE_FILTER_OVERRIDES[table]?.[filter];
        whereClause = " " + (tableOverride ?? COUNT_FILTERS[filter]);
    }
    const rows = await store.queryFirst(`SELECT count() AS count FROM type::table($t)${whereClause} GROUP ALL`, { t: table });
    const count = rows[0]?.count ?? 0;
    return {
        content: [{ type: "text", text: `${table}: ${count} rows${filter ? ` (filter: ${filter})` : ""}` }],
        details: { table, count, filter },
    };
}
// Fields stripped from `verify` output regardless of table — secrets, claim
// tokens, and anything else that would be an authority bypass if printed back
// to a session log. Add new names here when the schema adds new sensitive
// columns. The strip happens AFTER `SELECT *` so we can't accidentally rely on
// schema-defined defaults to keep them out.
const VERIFY_SENSITIVE_FIELDS = new Set([
    "cleanup_claim_token",
    "auth_token",
    "credentials",
    "password",
]);
// Fields that hold user-pasted content. The same payload that a user might
// paste a paragraph of prose into is also where an accidentally-pasted API
// key or secret would land. The defence-in-depth posture:
//   1. Tighter visible truncation (80 chars) so a long secret prefix can't
//      ride out in the SELECT projection.
//   2. Pattern-mask known secret formats anywhere inside the visible window.
//      This catches secrets shorter than the truncation limit (e.g. a
//      stray ghp_ token at the head of a memory.text).
// Patterns are conservative — only common provider prefixes we can match with
// high precision. The full record is still available through the regular
// recall/grounding pipeline; introspect is an operator tool whose output
// frequently ends up in shared session logs.
const USER_CONTENT_FIELDS = new Set([
    "text", // memory.text, reflection.text
    "content", // monologue.content, concept.content
    "description", // artifact.description
    "summary", // task.summary
    "llm_reason", // retrieval_outcome.llm_reason
    "rationale", // decision / finding rationale
    "reason", // generic reason fields
    "name", // concept.name / record name fields
    "preconditions", // skill.preconditions — user-authored prose
    "postconditions", // skill.postconditions — user-authored prose
    "payload", // pending_work.payload — may include pasted content
]);
const USER_CONTENT_TRUNCATE_LEN = 80;
// SECRET_PATTERNS is the single source of truth in src/engine/redact.ts
// (shared with ingestion-time redaction, GH #16). Imported above.
/** Mask secret-looking substrings and truncate to USER_CONTENT_TRUNCATE_LEN.
 *  Applied to memory.text, monologue.content, concept.content, reflection.text
 *  before any operator-facing serialization. */
function redactUserContent(value) {
    if (typeof value !== "string")
        return JSON.stringify(value);
    let masked = value;
    for (const pat of SECRET_PATTERNS) {
        masked = masked.replace(pat, "[redacted-secret-pattern]");
    }
    if (masked.length > USER_CONTENT_TRUNCATE_LEN) {
        return masked.slice(0, USER_CONTENT_TRUNCATE_LEN) + "...";
    }
    return masked;
}
/** Apply secret-pattern masking + operator-diagnostic 300-char truncation to a
 *  non-user-content string. The 80-char USER_CONTENT_TRUNCATE_LEN path is for
 *  fields where pasted secrets are most likely; non-content fields still
 *  benefit from masking because nested records (e.g. payload subfields)
 *  occasionally carry tokens. */
function maskAndTruncate(value, len = 300) {
    let masked = value;
    for (const pat of SECRET_PATTERNS) {
        masked = masked.replace(pat, "[redacted-secret-pattern]");
    }
    return masked.length > len ? masked.slice(0, len - 3) + "..." : masked;
}
/** Walk `value` recursively and redact every string leaf. Used for
 *  `details.record` in verifyAction so nested objects/arrays don't leak
 *  unredacted strings (a SELECT * row can return embedded JSON or arrays
 *  of objects depending on the table). Depth-capped at 4 to bound
 *  pathological cycles / deeply-nested payloads.
 *
 *  - String leaves: `parentKey` decides whether USER_CONTENT-tight (80 chars)
 *    or operator-loose (300 chars). Either way SECRET_PATTERNS masking runs
 *    first.
 *  - Number/boolean/null: passthrough.
 *  - Array: map element-wise.
 *  - Object: recurse with the entry's key as parentKey.
 *  - Beyond depth cap: stringify + redact to bound recursion. */
function deepRedact(value, depth = 0, parentKey) {
    if (depth > 4) {
        const s = typeof value === "string" ? value : JSON.stringify(value);
        return maskAndTruncate(s, 300);
    }
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string") {
        if (parentKey && USER_CONTENT_FIELDS.has(parentKey)) {
            return redactUserContent(value);
        }
        return maskAndTruncate(value, 300);
    }
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value)) {
        return value.map(v => deepRedact(v, depth + 1, parentKey));
    }
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (VERIFY_SENSITIVE_FIELDS.has(k)) {
                out[k] = "[redacted]";
                continue;
            }
            if (Array.isArray(v) && v.length > 100 && typeof v[0] === "number") {
                out[k] = `[${v.length} dims]`;
                continue;
            }
            out[k] = deepRedact(v, depth + 1, k);
        }
        return out;
    }
    return value;
}
async function verifyAction(store, recordId) {
    if (!recordId) {
        return { content: [{ type: "text", text: "Error: 'record_id' is required." }], details: null };
    }
    try {
        assertRecordId(recordId);
    }
    catch {
        return { content: [{ type: "text", text: `Error: invalid record ID "${recordId}".` }], details: null };
    }
    // Direct interpolation safe: assertRecordId validates format above
    const rows = await store.queryFirst(`SELECT * FROM ${recordId}`);
    if (rows.length === 0) {
        return { content: [{ type: "text", text: `Record not found: ${recordId}` }], details: { exists: false } };
    }
    const record = rows[0];
    const cleaned = {};
    for (const [key, val] of Object.entries(record)) {
        // Strip sensitive columns BEFORE the dims-collapse / serialization path so
        // they never appear in the returned text or details.record. Replace with a
        // placeholder so the operator can see the field exists without leaking it.
        if (VERIFY_SENSITIVE_FIELDS.has(key)) {
            cleaned[key] = "[redacted]";
            continue;
        }
        if (Array.isArray(val) && val.length > 100 && typeof val[0] === "number") {
            cleaned[key] = `[${val.length} dims]`;
            continue;
        }
        // User-content fields (memory.text, monologue.content, concept.content,
        // reflection.text) can hold pasted secrets. Mask known secret patterns
        // and tighten the visible window to 80 chars before they hit any caller-
        // visible serialization.
        if (USER_CONTENT_FIELDS.has(key) && typeof val === "string") {
            cleaned[key] = redactUserContent(val);
            continue;
        }
        // Nested objects/arrays — recurse so embedded strings are pattern-masked
        // and length-bounded. `details.record` is consumed by tooling that may
        // surface it back into operator-visible logs; an unredacted nested
        // structure would defeat the same defence the top-level loop provides.
        if (val !== null && typeof val === "object") {
            cleaned[key] = deepRedact(val, 0, key);
            continue;
        }
        cleaned[key] = val;
    }
    const lines = Object.entries(cleaned)
        .map(([k, v]) => {
        // User-content fields were already redacted+truncated above; emit as-is.
        // Other strings: mask known secret patterns BEFORE the 300-char slice so
        // a token sitting at offset 0-50 of a longer string cannot survive the
        // truncation. Non-string values are JSON-stringified.
        if (USER_CONTENT_FIELDS.has(k) && typeof v === "string")
            return `  ${k}: ${v}`;
        if (typeof v === "string") {
            let masked = v;
            for (const pat of SECRET_PATTERNS)
                masked = masked.replace(pat, "[redacted-secret-pattern]");
            return `  ${k}: ${masked.length > 300 ? masked.slice(0, 297) + "..." : masked}`;
        }
        return `  ${k}: ${JSON.stringify(v)}`;
    })
        .join("\n");
    return {
        content: [{ type: "text", text: `Record ${recordId}:\n${lines}` }],
        details: { exists: true, id: recordId, record: cleaned },
    };
}
async function migrateAction(state, filter) {
    if (filter === "backfill_derived_from") {
        return await backfillDerivedFromAction(state);
    }
    if (filter === "backfill_project_id") {
        return await backfillProjectIdAction(state);
    }
    const { store, embeddings, workspaceDir } = state;
    if (!workspaceDir) {
        return {
            content: [{ type: "text", text: "No workspace directory configured — cannot migrate." }],
            details: null,
        };
    }
    const result = await migrateWorkspace(workspaceDir, store, embeddings);
    const lines = [];
    lines.push("WORKSPACE MIGRATION REPORT");
    lines.push("═══════════════════════════════════");
    lines.push(`Files ingested:  ${result.ingested}`);
    lines.push(`Files skipped:   ${result.skipped}`);
    lines.push(`Archived:        ${result.archived ? "Yes" : "No"}`);
    if (result.archivePath)
        lines.push(`Archive path:    ${result.archivePath}`);
    lines.push("");
    lines.push("Details:");
    for (const detail of result.details) {
        lines.push(`  ${detail}`);
    }
    if (result.ingested > 0) {
        lines.push("");
        lines.push("SOUL.md was left in place — it will be read as a nudge during soul graduation.");
    }
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
    };
}
// Repairs concepts orphaned by silent edge-write failures. Two classes:
// 1. Pre-0.7.23 gem-source orphans: schema mismatch dropped concept→artifact.
//    Repair via concept.source = "gem:<X>" → artifact.path = "<X>".
// 2. v0.7.38 daemon-source orphans: when a session's taskId was empty at
//    extraction time, daemon-extracted concepts got no derived_from edge.
//    Repair via concept.source = "daemon:<sessionId>" → session.kc_session_id
//    matches → traverse ->session_task->task to find the task.
// Idempotent: skips concepts that already have a derived_from edge.
async function backfillDerivedFromAction(state) {
    // 0.7.40: delegates to engine/recovery.ts:recoverDaemonOrphans. The
    // migrate handler is now a thin reporting wrapper; helpers are
    // independently callable for maintenance / post-import / cron use.
    const r = await recoverDaemonOrphans(state.store);
    const lines = [];
    lines.push("BACKFILL derived_from");
    lines.push("═══════════════════════════════════");
    lines.push(`Gem orphans found:         ${r.gemOrphans}`);
    lines.push(`Gem edges created:         ${r.gemEdgesCreated}`);
    lines.push(`Missing source artifact:   ${r.missingArtifact}`);
    lines.push(`Daemon orphans found:      ${r.daemonOrphans}`);
    lines.push(`Daemon edges (resolved):   ${r.daemonEdgesResolved}`);
    lines.push(`Daemon edges (synth task): ${r.daemonEdgesSynthesized}`);
    lines.push(`Synthesized placeholders:  ${r.synthesizedPlaceholders}`);
    lines.push(`Missing source task:       ${r.missingTask}`);
    lines.push(`RELATE failed (total):     ${r.relateFailed}`);
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: r,
    };
}
// 0.7.40: this handler now delegates to engine/recovery.ts for the actual
// work. The migrate-tool reporting layer just unwraps the result struct
// and formats the lines. Keeps the introspect API stable while the
// helpers are reusable from other call sites (maintenance, periodic
// auto-run, post-import).
async function backfillProjectIdAction(state) {
    const { store } = state;
    const r = await recoverProjectIdRows(store);
    const lines = [];
    lines.push("BACKFILL project_id");
    lines.push("═══════════════════════════════════");
    lines.push(`Task rows backfilled:        ${r.tasks.fixed} / ${r.tasks.found}`);
    lines.push(`Session rows backfilled:     ${r.sessions.fixed} / ${r.sessions.found}`);
    lines.push(`Concept rows backfilled:     ${r.concepts.fixed} / ${r.concepts.found}`);
    lines.push(`Memory rows backfilled:      ${r.memories.fixed} / ${r.memories.found}`);
    lines.push(`Reflection rows backfilled:  ${r.reflections.fixed} / ${r.reflections.found}`);
    lines.push(`Skill rows backfilled:       ${r.skills.fixed} / ${r.skills.found}`);
    lines.push(`Centroid-assigned:           ${r.centroidAssigned} / ${r.centroidScanned} (threshold 0.5)`);
    lines.push(`Unrecoverable → scope=global: ${r.globalsTagged}`);
    lines.push("");
    lines.push("Re-runnable: only updates rows where project_id IS NONE.");
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: r,
    };
}
async function trendsAction(state) {
    const trends = await computeTrends(state.store, 7);
    const lines = [];
    lines.push(`SUBSTRATE TRENDS — last ${trends.window_days} days`);
    lines.push("═══════════════════════════════════");
    if (trends.rollups.length === 0) {
        lines.push("No daily rollups yet. The maintenance pass writes one row per day at the");
        lines.push("first turn after midnight UTC. Check back tomorrow, or wait for substrate");
        lines.push("activity to accumulate (orchestrator_metrics_daily is keyed on YYYY-MM-DD).");
        return { content: [{ type: "text", text: lines.join("\n") }], details: trends };
    }
    lines.push("");
    lines.push("Daily rollups:");
    lines.push("  day         | turns | tools | dur(ms) | tok_in  | tok_out | retr_util | tool_fail | fast%");
    for (const r of trends.rollups) {
        lines.push(`  ${r.day}  | ${pad(r.turn_count, 5)} | ${pad(r.mean_tool_calls.toFixed(1), 5)} | `
            + `${pad(r.mean_turn_duration_ms.toFixed(0), 7)} | ${pad(r.mean_tokens_in.toFixed(0), 7)} | `
            + `${pad(r.mean_tokens_out.toFixed(0), 7)} | ${pad((r.mean_retrieval_util * 100).toFixed(1) + "%", 9)} | `
            + `${pad((r.tool_failure_rate * 100).toFixed(1) + "%", 9)} | ${(r.fast_path_rate * 100).toFixed(0)}%`);
    }
    lines.push("");
    lines.push("Window summary:");
    lines.push(`  avg turns/day:       ${trends.summary.avg_turns_per_day.toFixed(1)}`);
    lines.push(`  avg tool calls:      ${trends.summary.avg_tool_calls.toFixed(2)}`);
    lines.push(`  avg retrieval util:  ${(trends.summary.avg_retrieval_util * 100).toFixed(1)}%`);
    lines.push(`  avg tokens in:       ${trends.summary.avg_tokens_in.toFixed(0)}`);
    lines.push(`  avg tokens out:      ${trends.summary.avg_tokens_out.toFixed(0)}`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: trends };
}
function pad(s, w) {
    return String(s).padStart(w, " ");
}
// ── stats action (usage/cost visibility — GH #16 item 3) ──────────────────
//
// LAYERING NOTE: src/engine/tools/ must NOT import from src/daemon/. The
// auto-drain spending ledger lives at <cacheDir>/auto-drain-spending.ndjson
// and is WRITTEN by src/daemon/auto-drain.ts. Rather than reach across the
// layer boundary into the daemon module, we re-implement a minimal READ-ONLY
// parser here that mirrors auto-drain.ts's on-disk format exactly:
//   - append-only ndjson, one {date, ts, pid} object per spawn (UTC YYYY-MM-DD)
//   - a legacy single-object {date, count} JSON file (auto-drain-spending.json)
//     that predates the ndjson migration; its count is authoritative only for
//     its own recorded date.
// This is a pure consumer — it never writes — so there is no race with the
// daemon's appends. If the on-disk schema in auto-drain.ts changes, this
// reader must change in lockstep (the test fixture pins the current shape).
/** Default DB-size alert threshold in GB. Override via KONGCODE_DB_SIZE_ALERT_GB. */
const DEFAULT_DB_SIZE_ALERT_GB = 2;
/** Default auto-drain daily budget — mirrors daemon/index.ts drainMaxDaily. */
const DEFAULT_DRAIN_MAX_DAILY = 50;
/** Read the auto-drain spending ledger and bucket spawns into today / 7d / 30d.
 *  Tolerant of a missing dir/file (returns all-zero) and of malformed lines
 *  (skipped). Counts only entries with the full {date, ts, pid} shape so a
 *  stray hand-written marker can't inflate the totals — same strictness as
 *  auto-drain.ts:readSpending. The legacy {date,count} file contributes to
 *  today's bucket only (its count has no per-spawn timestamps to bucket by). */
export function readSpendingStats(cacheDir, now = Date.now()) {
    const todayKey = new Date(now).toISOString().slice(0, 10);
    const day7Ms = now - 7 * 86_400_000;
    const day30Ms = now - 30 * 86_400_000;
    let today = 0;
    let last7d = 0;
    let last30d = 0;
    // Legacy single-object file: only its same-day count is meaningful (no ts to
    // window). Add it to today/7d/30d when its date matches today.
    try {
        const legacyRaw = readFileSync(join(resolve(cacheDir), "auto-drain-spending.json"), "utf-8");
        const parsed = JSON.parse(legacyRaw);
        if (parsed && parsed.date === todayKey && Number.isFinite(parsed.count)) {
            const c = parsed.count;
            today += c;
            last7d += c;
            last30d += c;
        }
    }
    catch { /* absent or unreadable */ }
    try {
        const raw = readFileSync(join(resolve(cacheDir), "auto-drain-spending.ndjson"), "utf-8");
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const d = JSON.parse(trimmed);
                if (!d || typeof d.date !== "string" || !Number.isFinite(d.ts) || !Number.isFinite(d.pid))
                    continue;
                const ts = d.ts;
                if (d.date === todayKey)
                    today++;
                if (ts >= day7Ms)
                    last7d++;
                if (ts >= day30Ms)
                    last30d++;
            }
            catch { /* skip malformed line */ }
        }
    }
    catch { /* file absent → zeros */ }
    return { today, last7d, last30d, today_key: todayKey };
}
/** Recursively sum file sizes under `dir`. SurrealKV stores the managed DB as
 *  a directory tree (manifest/, sstables/, vlog/, wal/), so a single statSync
 *  of the dir reports only the inode size, not the data. Walk it. Returns
 *  null if the dir doesn't exist or can't be read. Depth-capped to bound
 *  pathological trees / symlink loops (the surrealkv layout is shallow). */
export function dirSizeBytes(dir, depth = 0) {
    if (depth > 8)
        return 0;
    let total = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return depth === 0 ? null : 0;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            total += dirSizeBytes(full, depth + 1) ?? 0;
        }
        else if (e.isFile()) {
            try {
                total += statSync(full).size;
            }
            catch { /* vanished mid-walk */ }
        }
        // Symlinks/sockets/etc. are skipped — not part of the data footprint.
    }
    return total;
}
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
}
/** Aggregate session-table token/turn counts since `time::now() - <interval>`.
 *  Mirrors the introspect `sessions` query columns. Tolerant of a degraded
 *  store (returns zeros). */
async function windowStats(store, interval) {
    try {
        const rows = await store.queryFirst(`SELECT count() AS sessions,
              math::sum(turn_count) AS turns,
              math::sum(total_input_tokens) AS tokens_in,
              math::sum(total_output_tokens) AS tokens_out
       FROM session WHERE started_at > time::now() - ${interval} GROUP ALL`);
        const r = rows?.[0] ?? {};
        const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        return {
            sessions: num(r.sessions),
            turns: num(r.turns),
            tokens_in: num(r.tokens_in),
            tokens_out: num(r.tokens_out),
        };
    }
    catch {
        return { sessions: 0, turns: 0, tokens_in: 0, tokens_out: 0 };
    }
}
/** Count rows of `table` created since `time::now() - <interval>`. */
async function createdSince(store, table, interval) {
    try {
        const rows = await store.queryFirst(`SELECT count() AS n FROM type::table($t) WHERE created_at > time::now() - ${interval} GROUP ALL`, { t: table });
        return rows?.[0]?.n ?? 0;
    }
    catch {
        return 0;
    }
}
/** Total row count for `table`. */
async function totalCount(store, table) {
    try {
        const rows = await store.queryFirst(`SELECT count() AS n FROM type::table($t) GROUP ALL`, { t: table });
        return rows?.[0]?.n ?? 0;
    }
    catch {
        return 0;
    }
}
/** True when the connected DB is NOT this install's managed instance — so its
 *  on-disk size isn't ours to measure (report n/a). External covers BOTH a
 *  `SURREAL_URL` override AND a DB that bootstrap discovered + adopted on a
 *  non-managed port (e.g. an :8000 Docker container, where no SURREAL_URL is
 *  set — the case the old `!!process.env.SURREAL_URL` check missed). Keyed on
 *  the connected port vs the managed-surface ports (pickPort + legacy 18765),
 *  matching how findExistingKongcodeSurreal decides managed-vs-external. */
export function isConnectedDbExternal(connectedUrl) {
    if (process.env.SURREAL_URL)
        return true;
    let port = null;
    try {
        port = Number(new URL(connectedUrl).port) || null;
    }
    catch { /* unparseable */ }
    if (port === null)
        return false; // can't tell → assume managed (we only walk our own dataDir)
    return !new Set([pickPort(), LEGACY_MANAGED_SURREAL_PORT]).has(port);
}
export async function statsAction(state) {
    const { store, config } = state;
    // Budget + alert thresholds (env-configurable, mirroring daemon defaults).
    const maxDaily = (() => {
        const env = process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY;
        if (env !== undefined) {
            const n = Number(env);
            return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DRAIN_MAX_DAILY;
        }
        return DEFAULT_DRAIN_MAX_DAILY;
    })();
    const dbSizeAlertGb = (() => {
        const env = process.env.KONGCODE_DB_SIZE_ALERT_GB;
        if (env !== undefined) {
            const n = Number(env);
            return Number.isFinite(n) && n > 0 ? n : DEFAULT_DB_SIZE_ALERT_GB;
        }
        return DEFAULT_DB_SIZE_ALERT_GB;
    })();
    // Token + session windows.
    const [w7, w30] = await Promise.all([windowStats(store, "7d"), windowStats(store, "30d")]);
    // Knowledge extraction windows (concepts/memories/skills) + graph totals.
    const [concepts7, concepts30, memories7, memories30, skills7, skills30, conceptsTotal, memoriesTotal, skillsTotal, turnsTotal, artifactsTotal,] = await Promise.all([
        createdSince(store, "concept", "7d"), createdSince(store, "concept", "30d"),
        createdSince(store, "memory", "7d"), createdSince(store, "memory", "30d"),
        createdSince(store, "skill", "7d"), createdSince(store, "skill", "30d"),
        totalCount(store, "concept"), totalCount(store, "memory"), totalCount(store, "skill"),
        totalCount(store, "turn"), totalCount(store, "artifact"),
    ]);
    // Auto-drain spend from the ledger.
    const spend = readSpendingStats(config.paths.cacheDir);
    // DB size on disk only means something for OUR managed instance (under
    // config.paths.dataDir). The connected DB is external — footprint not ours to
    // measure — when SURREAL_URL is set OR bootstrap discovered+adopted a DB on a
    // non-managed port (e.g. an :8000 Docker container, no SURREAL_URL set).
    const externalDb = isConnectedDbExternal(config.surreal.url);
    let dbSizeBytes = null;
    if (!externalDb) {
        dbSizeBytes = dirSizeBytes(config.paths.dataDir);
    }
    // Alerts.
    const alerts = [];
    if (maxDaily > 0 && spend.today >= Math.ceil(maxDaily * 0.8)) {
        alerts.push({
            code: "drain.budget_near_cap",
            severity: spend.today >= maxDaily ? "critical" : "warn",
            message: `auto-drain spawns today (${spend.today}) are at ${Math.round((spend.today / maxDaily) * 100)}% of the daily budget (${maxDaily}) for ${spend.today_key}`,
        });
    }
    const dbSizeAlertBytes = dbSizeAlertGb * 1024 ** 3;
    if (dbSizeBytes != null && dbSizeBytes > dbSizeAlertBytes) {
        alerts.push({
            code: "db.size_over_threshold",
            severity: "warn",
            message: `DB size on disk (${formatBytes(dbSizeBytes)}) exceeds the ${dbSizeAlertGb}GB alert threshold (KONGCODE_DB_SIZE_ALERT_GB)`,
        });
    }
    const details = {
        window_7d: { ...w7, concepts: concepts7, memories: memories7, skills: skills7 },
        window_30d: { ...w30, concepts: concepts30, memories: memories30, skills: skills30 },
        drain: { spawns_today: spend.today, daily_budget: maxDaily, spawns_7d: spend.last7d, spawns_30d: spend.last30d, today_key: spend.today_key },
        graph_counts: { concept: conceptsTotal, memory: memoriesTotal, skill: skillsTotal, turn: turnsTotal, artifact: artifactsTotal },
        db_size: { bytes: dbSizeBytes, external: externalDb, alert_gb: dbSizeAlertGb },
        alerts,
    };
    const lines = [];
    lines.push("USAGE & COST REPORT");
    lines.push("═══════════════════════════════════");
    lines.push("");
    lines.push("                       last 7d        last 30d");
    lines.push(`  sessions:          ${pad(w7.sessions, 10)}    ${pad(w30.sessions, 10)}`);
    lines.push(`  turns:             ${pad(w7.turns, 10)}    ${pad(w30.turns, 10)}`);
    lines.push(`  tokens in:         ${pad(w7.tokens_in, 10)}    ${pad(w30.tokens_in, 10)}`);
    lines.push(`  tokens out:        ${pad(w7.tokens_out, 10)}    ${pad(w30.tokens_out, 10)}`);
    lines.push(`  concepts:          ${pad(concepts7, 10)}    ${pad(concepts30, 10)}`);
    lines.push(`  memories:          ${pad(memories7, 10)}    ${pad(memories30, 10)}`);
    lines.push(`  skills:            ${pad(skills7, 10)}    ${pad(skills30, 10)}`);
    lines.push("");
    lines.push("AUTO-DRAIN SPEND");
    lines.push("═══════════════════════════════════");
    const budgetStr = maxDaily > 0 ? `${spend.today} / ${maxDaily}` : `${spend.today} / unlimited`;
    lines.push(`  spawns today:      ${budgetStr}  (${spend.today_key})`);
    lines.push(`  spawns last 7d:    ${spend.last7d}`);
    lines.push(`  spawns last 30d:   ${spend.last30d}`);
    lines.push("");
    lines.push("GRAPH COUNTS");
    lines.push("═══════════════════════════════════");
    lines.push(`  concepts:  ${pad(conceptsTotal, 8)}   memories:  ${pad(memoriesTotal, 8)}   skills: ${pad(skillsTotal, 8)}`);
    lines.push(`  turns:     ${pad(turnsTotal, 8)}   artifacts: ${pad(artifactsTotal, 8)}`);
    lines.push("");
    lines.push("DB SIZE ON DISK");
    lines.push("═══════════════════════════════════");
    if (externalDb) {
        lines.push("  n/a (external DB — not managed by this install)");
    }
    else if (dbSizeBytes == null) {
        lines.push(`  n/a (data dir not found: ${config.paths.dataDir})`);
    }
    else {
        lines.push(`  ${formatBytes(dbSizeBytes)}  (${config.paths.dataDir}, alert >${dbSizeAlertGb}GB)`);
    }
    if (alerts.length > 0) {
        lines.push("");
        lines.push("ALERTS");
        lines.push("═══════════════════════════════════");
        for (const a of alerts) {
            const sev = a.severity === "critical" ? "[!!]" : "[!]";
            lines.push(`  ${sev} ${a.code}: ${a.message}`);
        }
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details };
}
async function queryAction(store, table, template) {
    const tmpl = template ?? "";
    if (!QUERY_TEMPLATES[tmpl]) {
        const available = Object.entries(QUERY_TEMPLATES)
            .map(([k, v]) => `  ${k}${v.needsTable ? " (requires table)" : ""}: ${v.description}`)
            .join("\n");
        return {
            content: [{ type: "text", text: `Available query templates:\n${available}` }],
            details: { templates: Object.keys(QUERY_TEMPLATES) },
        };
    }
    const spec = QUERY_TEMPLATES[tmpl];
    if (spec.needsTable && (!table || !ALLOWED_TABLES.has(table))) {
        return {
            content: [{ type: "text", text: `Error: "${tmpl}" requires a valid table.` }],
            details: null,
        };
    }
    // Embedding coverage special case
    if (tmpl === "embedding_coverage") {
        const lines = [];
        for (const t of VECTOR_TABLES) {
            try {
                const totalRows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) GROUP ALL`, { t });
                const embRows = await store.queryFirst(`SELECT count() AS count FROM type::table($t) WHERE embedding != NONE AND array::len(embedding) > 0 GROUP ALL`, { t });
                const total = totalRows[0]?.count ?? 0;
                const emb = embRows[0]?.count ?? 0;
                const pct = total > 0 ? Math.round((emb / total) * 100) : 0;
                lines.push(`  ${(t + ":").padEnd(20)} ${emb}/${total} (${pct}%)`);
            }
            catch { /* skip */ }
        }
        return { content: [{ type: "text", text: `Embedding coverage:\n${lines.join("\n")}` }], details: null };
    }
    // Only pass `t` to queries that actually use it (needsTable). Avoids
    // misleading "(pending_work)" label when the SQL is hardcoded against a
    // different table.
    const rows = await store.queryFirst(spec.sql, spec.needsTable && table ? { t: table } : undefined);
    if (rows.length === 0) {
        return { content: [{ type: "text", text: `No results for "${tmpl}".` }], details: null };
    }
    const formatted = rows.map((r, i) => {
        const fields = Object.entries(r)
            .filter(([k]) => k !== "embedding")
            .map(([k, v]) => {
            // User-content fields can carry pasted secrets. Tighter truncation
            // (80 chars) + pattern-mask before serialization. The recent template
            // SELECTs text + content explicitly, so both routes pass through here.
            if (USER_CONTENT_FIELDS.has(k) && typeof v === "string") {
                return `${k}: ${redactUserContent(v)}`;
            }
            if (typeof v === "string" && v.length > 200)
                return `${k}: ${v.slice(0, 200)}...`;
            return `${k}: ${JSON.stringify(v)}`;
        })
            .join(", ");
        return `${i + 1}. ${fields}`;
    }).join("\n");
    // Show "(table)" suffix only for templates that actually consume the table param.
    const label = spec.needsTable && table ? `${tmpl} (${table})` : tmpl;
    return {
        content: [{ type: "text", text: `${label}:\n${formatted}` }],
        details: { count: rows.length },
    };
}
