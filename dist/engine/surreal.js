import { Surreal, RecordId } from "surrealdb";
import { randomUUID } from "node:crypto";
import { swallow, isUniqueViolation, safeId, RECORD_ID_RE } from "./errors.js";
import { log } from "./log.js";
import { loadSchema } from "./schema-loader.js";
import { parseDatetimeMs } from "./observability.js";
/** SurrealDB transaction-conflict detector. Used to differentiate expected
 *  contention (silent retry/swallow) from real errors that should surface
 *  via swallow.warn. Structured-field check first (err.kind/err.name) before
 *  the message regex so the driver's typed errors are recognized without
 *  string parsing. Regex covers "tx", "transaction", "conflict", "lock",
 *  plus SurrealDB-specific retry shapes: versionstamp (KV-version mismatch),
 *  rpcerror, busy, retryable. */
function isTransactionConflict(e) {
    if (!e || typeof e !== "object")
        return false;
    const o = e;
    if (typeof o.kind === "string" && /tx|conflict|retry|busy/i.test(o.kind))
        return true;
    if (typeof o.name === "string" && /tx|conflict|retry|busy|rpcerror/i.test(o.name))
        return true;
    if (typeof o.message !== "string")
        return false;
    return /tx|transaction|conflict|lock|versionstamp|rpcerror|busy|retryable/i.test(o.message);
}
function assertRecordId(id) {
    if (!RECORD_ID_RE.test(id)) {
        // String() so a non-string id (e.g. an object passed by mistake) produces
        // the intended error instead of crashing the error path itself.
        throw new Error(`Invalid record ID format: ${String(id).slice(0, 40)}`);
    }
}
/** Parse a `"table:key"` string into a SurrealDB RecordId for binding into
 *  parameters of typed `record<...>` fields. Throws if the input is not a
 *  well-formed record id. */
function toRecordId(id) {
    assertRecordId(id);
    const colon = id.indexOf(":");
    return new RecordId(id.slice(0, colon), id.slice(colon + 1));
}
/** Whitelist of valid SurrealDB edge table names — prevents SQL injection via edge interpolation. */
const VALID_EDGES = new Set([
    // Semantic edges
    "responds_to", "mentions", "related_to",
    "narrower", "broader", "about_concept", "reflects_on",
    // Skill edges
    "skill_from_task", "skill_uses_concept",
    // Structural pillar edges
    "owns", "performed", "task_part_of", "session_task",
    "produced", "derived_from", "relevant_to", "used_in", "artifact_mentions",
    // Causal edges
    "caused_by", "supports", "contradicts", "describes",
    // Evolution edges
    "supersedes",
    // Session edges
    "part_of",
    // Subagent provenance
    "spawned", "spawned_from",
]);
function assertValidEdge(edge) {
    if (!VALID_EDGES.has(edge))
        throw new Error(`Invalid edge name: ${edge}`);
}
/** 0.7.118: hard ceiling on any single SDK query round-trip. Generous by
 *  default (60s — only genuine zombies blow it, not slow CPU-tier queries);
 *  env-overridable for constrained machines. Clamped to [1s, 10min]. */
export const QUERY_DEADLINE_MS = (() => {
    const n = Number(process.env.KONGCODE_DB_QUERY_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 1_000), 600_000) : 60_000;
})();
/** Race a promise against a deadline. The losing arm's rejection is consumed
 *  by the race; the timer is cleared on every exit path. Exported for unit
 *  tests (test/surreal-deadline.test.ts). */
export function raceWithDeadline(p, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} deadline exceeded after ${ms}ms`)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
/** Errors worth one reconnect+retry (0.7.118 widened from connection-drop
 *  only). Three production-observed classes on 2026-06-10:
 *  - connection drop: "must be connected" / "ConnectionUnavailable"
 *  - blown deadline: zombie WS whose queries never settle (no error event)
 *  - auth drop: the SDK auto-reconnects WITHOUT re-signin after a WS blip,
 *    so the next statement runs anonymous ("Anonymous access not allowed" /
 *    "Not enough permissions") — a fresh connect+signin fixes it; if creds
 *    are genuinely wrong the retry fails identically and throws.
 *  Exported for unit tests. */
export function isRetryableSurrealError(e) {
    const msg = String(e?.message ?? e);
    return (msg.includes("must be connected") ||
        msg.includes("ConnectionUnavailable") ||
        msg.includes("deadline exceeded") ||
        /anonymous access|not enough permissions/i.test(msg));
}
/** Split a SELECT/ORDER clause on top-level commas only — commas nested in
 *  (), [], {} (function args, array literals, subqueries) do not split.
 *  Quote-awareness is deliberately omitted: every caller is an internal query
 *  and none put string literals with unbalanced brackets in these clauses. */
function splitTopLevel(clause) {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of clause) {
        if (ch === "(" || ch === "[" || ch === "{")
            depth++;
        else if (ch === ")" || ch === "]" || ch === "}")
            depth = Math.max(0, depth - 1);
        if (ch === "," && depth === 0) {
            parts.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
}
/** SurrealDB 3.x requires every ORDER BY field to appear in the selection.
 *  Auto-append missing ones rather than chasing each call site.
 *
 *  W2/T5 hardening (the original was alias-blind and paren-blind):
 *  - `SELECT count() AS c … ORDER BY c` previously appended a phantom raw `c`
 *    (it recorded the pre-AS *expression*, not the alias ORDER BY sees).
 *  - Naive split(",") sheared `math::max([a, b])`-style args into garbage
 *    fields. Both now handled; non-identifier ORDER terms (e.g. rand()) are
 *    left alone instead of being appended as fake columns.
 *
 *  Exported for unit tests (test/patch-order-by.test.ts). */
/** Length-preserving paren mask: every character inside (), at any depth, is
 *  replaced by a space (parens themselves kept). Structural keywords (FROM /
 *  ORDER BY / LIMIT) are then located on the masked string so subquery
 *  internals can't be mistaken for the outer query's — but clause TEXT is
 *  sliced from the ORIGINAL by index, so expressions like `rand()` survive
 *  intact (0.7.118; previously the patcher appended a subquery's inner ORDER
 *  field to the outer selection). */
function maskParens(s) {
    let depth = 0;
    let out = "";
    for (const ch of s) {
        if (ch === "(") {
            depth++;
            out += "(";
            continue;
        }
        if (ch === ")") {
            depth = Math.max(0, depth - 1);
            out += ")";
            continue;
        }
        out += depth > 0 ? " " : ch;
    }
    return out;
}
export function patchOrderByFields(sql) {
    const s = sql.trim();
    if (!/^\s*SELECT\b/i.test(s) || !/\bORDER\s+BY\b/i.test(s))
        return sql;
    if (/^\s*SELECT\s+\*/i.test(s))
        return sql;
    // Locate structure on the masked string; slice clause TEXT from the
    // original via match indices (the mask is length-preserving, so indices
    // line up exactly). The `d` flag exposes per-group [start, end].
    const masked = maskParens(s);
    const selectMatch = /^\s*SELECT\s+([\s\S]+?)\s+FROM\b/id.exec(masked);
    if (!selectMatch)
        return sql;
    const selIdx = selectMatch.indices[1];
    const selectClause = s.slice(selIdx[0], selIdx[1]);
    const orderMatch = /\bORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\b|\s+GROUP\b|\s+HAVING\b|$)/id.exec(masked);
    if (!orderMatch)
        return sql; // the only ORDER BY lives inside a subquery — outer query needs nothing
    const ordIdx = orderMatch.indices[1];
    const orderClause = s.slice(ordIdx[0], ordIdx[1]);
    const orderFields = splitTopLevel(orderClause)
        .map((f) => f.replace(/\s+(?:COLLATE|NUMERIC|ASC|DESC)(?=\s|$)/gi, "").trim())
        .filter(Boolean);
    // What ORDER BY can legally reference: output aliases first, then plain
    // selected field names (last dotted segment, matching prior behavior).
    const selectedFields = new Set();
    for (const part of splitTopLevel(selectClause)) {
        const aliasMatch = part.match(/\s+AS\s+([a-z_][a-z0-9_]*)\s*$/i);
        if (aliasMatch)
            selectedFields.add(aliasMatch[1].toLowerCase());
        const expr = (aliasMatch ? part.slice(0, aliasMatch.index) : part).trim();
        const last = expr.split(".").pop().trim().toLowerCase();
        if (/^[a-z_][a-z0-9_]*$/i.test(last))
            selectedFields.add(last);
    }
    const missing = [
        ...new Set(orderFields.filter((f) => 
        // Only plain field paths can be appended to the selection; function
        // calls / expressions in ORDER BY are valid as-is and must not become
        // fake columns.
        /^[a-z_][a-z0-9_.]*$/i.test(f) &&
            !selectedFields.has(f.split(".").pop().toLowerCase()))),
    ];
    if (missing.length === 0)
        return sql;
    // Index-based rebuild: insert at the end of the OUTER select clause. A
    // regex replace with non-greedy FROM would re-find an inner subquery's
    // FROM for `SELECT (SELECT … FROM t) AS x, …` shapes.
    const lead = sql.length - sql.trimStart().length; // s = sql.trim() offset
    const insertAt = lead + selIdx[1];
    return `${sql.slice(0, insertAt)}, ${missing.join(", ")}${sql.slice(insertAt)}`;
}
/**
 * SurrealDB store — wraps all database operations for the KongCode plugin.
 * Replaces the module-level singleton pattern from standalone KongCode.
 */
export class SurrealStore {
    db;
    config;
    reconnecting = null;
    shutdownFlag = false;
    initialized = false;
    constructor(config) {
        this.config = config;
        this.db = new Surreal();
    }
    /** Connect and run schema. Returns true if a new connection was made, false if already initialized. */
    async initialize() {
        // Only connect once — subsequent calls are no-ops.
        // This prevents register()/factory re-invocations from disrupting
        // in-flight operations (deferred cleanup, daemon extraction).
        // Don't check isConnected — ensureConnected() handles reconnection.
        if (this.initialized)
            return false;
        await this.db.connect(this.config.url, {
            namespace: this.config.ns,
            database: this.config.db,
            authentication: { username: this.config.user, password: this.config.pass },
        });
        await this.runSchema();
        this.initialized = true;
        return true;
    }
    markShutdown() {
        this.shutdownFlag = true;
    }
    async ensureConnected() {
        if (this.shutdownFlag)
            return;
        // zombieSuspect overrides isConnected: a wedged WS still REPORTS
        // connected while its queries never settle (0.7.118 incident) — without
        // the override this early-return made the zombie state permanent.
        if (this.db.isConnected && !this.zombieSuspect)
            return;
        if (this.reconnecting)
            return this.reconnecting;
        this.reconnecting = (async () => {
            const MAX_ATTEMPTS = 3;
            const BACKOFF_MS = [500, 1500, 4000];
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    log.warn(`SurrealDB disconnected — reconnecting (attempt ${attempt}/${MAX_ATTEMPTS})...`);
                    try {
                        await this.db?.close();
                    }
                    catch { /* drain stale socket */ }
                    this.db = new Surreal();
                    const CONNECT_TIMEOUT_MS = 5_000;
                    let connectTimer;
                    try {
                        await Promise.race([
                            this.db.connect(this.config.url, {
                                namespace: this.config.ns,
                                database: this.config.db,
                                authentication: { username: this.config.user, password: this.config.pass },
                            }),
                            new Promise((_, reject) => {
                                connectTimer = setTimeout(() => reject(new Error(`SurrealDB connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
                            }),
                        ]);
                    }
                    finally {
                        // Clear on every exit path. The prior code leaked a pending
                        // Timeout when connect() resolved fast; the daemon process would
                        // be kept alive for CONNECT_TIMEOUT_MS after each connect attempt.
                        if (connectTimer !== undefined)
                            clearTimeout(connectTimer);
                    }
                    log.warn("SurrealDB reconnected successfully.");
                    this.zombieSuspect = false;
                    return;
                }
                catch (e) {
                    if (attempt < MAX_ATTEMPTS) {
                        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
                    }
                    else {
                        log.error(`SurrealDB reconnection failed after ${MAX_ATTEMPTS} attempts.`);
                        throw new Error("SurrealDB reconnection failed");
                    }
                }
            }
        })().finally(() => {
            this.reconnecting = null;
        });
        return this.reconnecting;
    }
    async runSchema() {
        const schema = loadSchema();
        // SurrealDB 3.1.x no longer lazily creates a namespace/database on first
        // write OR DDL — 3.0.x did. connect() only SELECTS the ns/db context, it
        // does not create them, so a fresh install (or a 2nd OS user's brand-new
        // UID-offset managed instance, GH #13) would fail the schema apply below
        // with "The namespace '<ns>' does not exist". Provision idempotently first.
        // Best-effort: a restricted user on a shared external instance may lack
        // DEFINE perms while the ns/db already exist — the schema apply remains the
        // authoritative gate, so we log and proceed rather than hard-fail here.
        // (ns/db are operator config, interpolated bare to match the existing
        // `USE NS ${ns} DB ${db}` sites in this file.)
        const provision = `DEFINE NAMESPACE IF NOT EXISTS ${this.config.ns}; ` +
            `DEFINE DATABASE IF NOT EXISTS ${this.config.db};`;
        try {
            await raceWithDeadline(this.db.query(provision), 30_000, "SurrealDB ns/db provision");
        }
        catch (e) {
            log.warn(`[surreal] ns/db provision (DEFINE IF NOT EXISTS) failed; proceeding to schema apply: ${e.message}`);
        }
        // Generous fixed deadline so schema DDL over a wedged server fails this
        // step loudly (degraded mode) instead of hanging it. (initialize()'s
        // first db.connect() is a separate, still-undeadlined step — the
        // reconnect path has its own 5s connect timeout.)
        await raceWithDeadline(this.db.query(schema), 60_000, "SurrealDB schema apply");
    }
    isConnected() {
        return this.db?.isConnected ?? false;
    }
    getInfo() {
        return {
            url: this.config.url,
            ns: this.config.ns,
            db: this.config.db,
            connected: this.db?.isConnected ?? false,
        };
    }
    async ping() {
        try {
            await this.ensureConnected();
            // Tight 3s deadline so a zombie turns ping into a fast `false` instead
            // of hanging the health probe. flagZombie=false (QA 0.7.118 A1): on the
            // CPU tier a merely-busy server (consolidate, HNSW build) can blow 3s,
            // and a spurious zombie flag would tear down a healthy connection and
            // kill in-flight queries. The 60s default deadline on real queries is
            // the authoritative zombie detector.
            await this.deadlineQuery("RETURN 'ok'", undefined, 3_000, { flagZombie: false });
            return true;
        }
        catch {
            return false;
        }
    }
    async close() {
        try {
            this.markShutdown();
            await this.db?.close();
        }
        catch (e) {
            swallow("surreal:close", e);
        }
    }
    /** 0.7.118: a zombie WS (queries never settle, no error event, isConnected
     *  still true) was observed in production — rpcsInFlight grew unboundedly
     *  while meta.health stayed green and every DB-touching tool hung. Set by
     *  deadlineQuery() on a blown deadline; ensureConnected() treats it as
     *  disconnected even though the SDK disagrees. */
    zombieSuspect = false;
    /** Run a query function with one retry on retryable failures (connection
     *  drops, blown deadlines, auth-dropped reconnects). Reconnection is routed
     *  through ensureConnected() so concurrent callers share a single
     *  reconnection attempt instead of racing.
     *
     *  Retry-once safety note (0.7.118): a deadline'd write MAY have executed
     *  server-side, so the retry can double-fire. Post-W2 this is acceptable —
     *  edges carry UNIQUE (in,out) indexes, concepts/memories carry content
     *  seals, subagents carry correlation keys — and the alternative (hanging
     *  forever on a zombie connection) is strictly worse. */
    async withRetry(fn) {
        try {
            return await fn();
        }
        catch (e) {
            if (!isRetryableSurrealError(e))
                throw e;
            this.initialized = false;
            await this.ensureConnected();
            return await fn();
        }
    }
    /** All SDK query round-trips route through here. The Promise.race deadline
     *  converts a never-settling zombie query into a typed, retryable error —
     *  withRetry() then forces a reconnect (fresh Surreal instance) and the
     *  daemon self-heals on the next traffic instead of wedging forever. */
    async deadlineQuery(fullSql, bindings, ms = QUERY_DEADLINE_MS, opts = {}) {
        const { flagZombie = true } = opts;
        try {
            return await raceWithDeadline(this.db.query(fullSql, bindings), ms, "SurrealDB query");
        }
        catch (e) {
            if (flagZombie && e instanceof Error && e.message.includes("deadline exceeded")) {
                this.zombieSuspect = true;
                log.error(`[surreal] query deadline exceeded after ${ms}ms — connection flagged zombie; ` +
                    `forcing reconnect on retry. SQL head: ${fullSql.slice(0, 90)}`);
            }
            throw e;
        }
    }
    // ── Query helpers ──────────────────────────────────────────────────────
    async queryFirst(sql, bindings) {
        await this.ensureConnected();
        return this.withRetry(async () => {
            const ns = this.config.ns;
            const dbName = this.config.db;
            const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
            const result = await this.deadlineQuery(fullSql, bindings);
            const rows = Array.isArray(result) ? result[result.length - 1] : result;
            return (Array.isArray(rows) ? rows : []).filter(Boolean);
        });
    }
    async queryMulti(sql, bindings) {
        await this.ensureConnected();
        return this.withRetry(async () => {
            const ns = this.config.ns;
            const dbName = this.config.db;
            const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
            const raw = await this.deadlineQuery(fullSql, bindings);
            const flat = raw.flat();
            return flat[flat.length - 1];
        });
    }
    async queryExec(sql, bindings) {
        await this.ensureConnected();
        return this.withRetry(async () => {
            const ns = this.config.ns;
            const dbName = this.config.db;
            const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
            await this.deadlineQuery(fullSql, bindings);
        });
    }
    /**
     * Execute N SQL statements in a single SurrealDB round-trip.
     * Returns one result array per statement; bindings are shared across all statements.
     *
     * CONTRACT (QA-0.7.121 A2): result-index alignment assumes ONE statement
     * per array element. An element containing embedded ';' statements (e.g.
     * bumpAccessCounts' LET+UPDATE pairs) makes the server return MORE results
     * than elements — fine only when the caller discards the return value.
     * Do not read positional results after passing multi-statement elements.
     */
    async queryBatch(statements, bindings) {
        if (statements.length === 0)
            return [];
        await this.ensureConnected();
        return this.withRetry(async () => {
            const ns = this.config.ns;
            const dbName = this.config.db;
            const joined = statements.map(s => patchOrderByFields(s)).join(";\n");
            const fullSql = `USE NS ${ns} DB ${dbName};\n${joined}`;
            const raw = await this.deadlineQuery(fullSql, bindings);
            // First result is the USE statement (empty), skip it
            return raw.slice(1).map(r => (Array.isArray(r) ? r : []).filter(Boolean));
        });
    }
    async safeQuery(sql, bindings) {
        try {
            return await this.queryFirst(sql, bindings);
        }
        catch (e) {
            swallow.warn("surreal:safeQuery", e);
            return [];
        }
    }
    // ── Vector search ──────────────────────────────────────────────────────
    /** Multi-table cosine similarity search across turns, concepts, memories, artifacts, monologues, and identity chunks. Returns merged results sorted by score.
     *
     * 0.7.26: optional projectId scopes concept/memory/artifact retrieval. Soft
     * filter: rows without project_id (pre-migration) still surface, items with
     * scope='global' always surface, items with project_id matching $pid surface.
     * Pass undefined for cross-project retrieval (legacy behavior). */
    async vectorSearch(vec, sessionId, limits = {}, withEmbeddings = false, projectId) {
        const lim = {
            turn: limits.turn ?? 20,
            identity: limits.identity ?? 10,
            concept: limits.concept ?? 15,
            memory: limits.memory ?? 15,
            artifact: limits.artifact ?? 10,
            monologue: limits.monologue ?? 8,
        };
        // Split the turn budget: 50% current session, 30% cross-session live,
        // 20% cross-session archived. Archive fraction is intentionally small —
        // archived turns are older/colder, so they back-stop rather than dominate.
        const sessionTurnLim = Math.ceil(lim.turn * 0.5);
        const crossTurnLim = Math.ceil(lim.turn * 0.3);
        const archiveTurnLim = Math.max(1, lim.turn - sessionTurnLim - crossTurnLim);
        const emb = withEmbeddings ? ", embedding" : "";
        // 0.7.26 project scope filter (soft: NONE allowed for back-compat with
        // pre-migration rows). Empty string when no projectId provided.
        const projectFilter = projectId
            ? ` AND (project_id IS NONE OR project_id = $pid OR scope = 'global')`
            : "";
        // Batch all 8 vector searches into a single round-trip (limits inlined — per-table)
        // HNSW KNN over-fetch (validated against the live DB: ~26x faster than the
        // full linear cosine scan — 18ms vs 474ms at 10K concepts — with recall@10
        // 10/10 at K≈50). The `<|K,EF|>` operator selects K nearest via the index;
        // K is over-fetched (>> limit) so the post-filter WHERE still yields `limit`
        // rows, then we score + sort + LIMIT. Two cases stay LINEAR: current-session
        // turns (session_id = $sid is selective → KNN would under-return; it's also
        // index-cheap per session) and turn_archive (no HNSW index defined).
        const knn = (n) => {
            const k = Math.min(Math.max(n * 8, 80), 256);
            return `embedding <|${k},${k * 2}|> $vec`;
        };
        const linearVec = `embedding != NONE AND array::len(embedding) > 0`;
        const buildStmts = (useKnn) => {
            const vc = (n) => (useKnn ? knn(n) : linearVec);
            return [
                // Current-session turns — selective session_id filter, always linear.
                `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM turn WHERE ${linearVec}
           AND pruned_at IS NONE
           AND session_id = $sid ORDER BY score DESC LIMIT ${sessionTurnLim}`,
                // Cross-session live turns — non-selective → HNSW KNN.
                // COSINE_GUARD_OK: read-only vector retrieval batch — no destructive follow-on.
                `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM turn WHERE ${vc(crossTurnLim)}
           AND pruned_at IS NONE
           AND session_id != $sid ORDER BY score DESC LIMIT ${crossTurnLim}`,
                // Archived turns — turn_archive_vec_idx HNSW index → KNN.
                // COSINE_GUARD_OK: read-only vector retrieval batch.
                `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM turn_archive WHERE ${vc(archiveTurnLim)}
         ORDER BY score DESC LIMIT ${archiveTurnLim}`,
                `SELECT id, content AS text, stability AS importance, access_count AS accessCount,
                created_at AS timestamp, 'concept' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM concept WHERE ${vc(lim.concept)}
           AND superseded_at IS NONE${projectFilter}
         ORDER BY score DESC LIMIT ${lim.concept}`,
                // COSINE_GUARD_OK: read-only vector retrieval batch (memory + artifact).
                `SELECT id, text, importance, access_count AS accessCount,
                created_at AS timestamp, session_id AS sessionId, category, 'memory' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM memory WHERE ${vc(lim.memory)}
           AND (status = 'active' OR status IS NONE)${projectFilter} ORDER BY score DESC LIMIT ${lim.memory}`,
                `SELECT id, description AS text, 0 AS accessCount,
                created_at AS timestamp, 'artifact' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM artifact WHERE ${vc(lim.artifact)}${projectFilter}
         ORDER BY score DESC LIMIT ${lim.artifact}`,
                // COSINE_GUARD_OK: read-only vector retrieval batch (monologue + identity_chunk).
                `SELECT id, content AS text, category AS source, 0.5 AS importance, 0 AS accessCount,
                timestamp, 'monologue' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM monologue WHERE ${vc(lim.monologue)}
         ORDER BY score DESC LIMIT ${lim.monologue}`,
                `SELECT id, text, importance, 0 AS accessCount,
                'identity_chunk' AS table,
                vector::similarity::cosine(embedding, $vec) AS score${emb}
         FROM identity_chunk WHERE ${vc(lim.identity)}
           AND (active = true OR active IS NONE)
         ORDER BY score DESC LIMIT ${lim.identity}`,
            ];
        };
        let batchResults;
        const bindings = { vec, sid: sessionId };
        if (projectId)
            bindings.pid = projectId;
        try {
            batchResults = await this.queryBatch(buildStmts(true), bindings);
        }
        catch (e) {
            // Safety net: any KNN failure (e.g. an HNSW index not yet built on a
            // fresh install) falls back to the full linear scan rather than dropping
            // ALL retrieval for the turn. Worst case equals the prior behavior.
            swallow.warn("surreal:vectorSearch:knn-fallback-to-linear", e);
            try {
                batchResults = await this.queryBatch(buildStmts(false), bindings);
            }
            catch (e2) {
                swallow.warn("surreal:vectorSearch:batch", e2);
                return [];
            }
        }
        // Destructure with explicit per-bucket type assertion. The batch shape is
        // a positional tuple of VectorSearchResult arrays (one per statement); the
        // SurrealDB response is `unknown[][]` and each bucket carries the same
        // row shape from the SELECT — assert per bucket rather than blanket-cast
        // the outer array so a future statement-order change can't silently mis-type.
        const sessionTurns = (batchResults[0] ?? []);
        const crossTurns = (batchResults[1] ?? []);
        const archiveTurns = (batchResults[2] ?? []);
        const concepts = (batchResults[3] ?? []);
        const memories = (batchResults[4] ?? []);
        const artifacts = (batchResults[5] ?? []);
        const monologues = (batchResults[6] ?? []);
        const identityChunks = (batchResults[7] ?? []);
        return [
            ...sessionTurns,
            ...crossTurns,
            ...archiveTurns,
            ...concepts,
            ...memories,
            ...artifacts,
            ...monologues,
            ...identityChunks,
        ];
    }
    // ── Turn operations ────────────────────────────────────────────────────
    async upsertTurn(turn) {
        const { embedding, ...rest } = turn;
        const record = embedding?.length ? { ...rest, embedding } : rest;
        const rows = await this.queryFirst(`CREATE turn CONTENT $turn RETURN id`, { turn: record });
        return String(rows[0]?.id ?? "");
    }
    async getSessionTurns(sessionId, limit = 50) {
        return this.queryFirst(
        // WITH NOINDEX (0.7.120): SurrealDB 3.x's ASC scan over turn_timestamp_idx
        // silently returns ZERO rows for `WHERE session_id = $x ... ORDER BY
        // timestamp ASC` (DESC works, NOINDEX works, REBUILD INDEX does not fix
        // it — engine query-path bug, observed 2026-06-11 across every session).
        // This starved ALL transcript reads → "empty extraction" junk. NOINDEX
        // means a full table scan (~300ms at 6.9k turns; the filter bounds the
        // RESULT, not the scan) — cold-path callers only; revisit if the turn
        // table grows past ~50k rows or the engine bug gets fixed upstream.
        `SELECT role, text, timestamp FROM turn WITH NOINDEX WHERE session_id = $sid AND pruned_at IS NONE ORDER BY timestamp ASC LIMIT $lim`, { sid: sessionId, lim: limit });
    }
    async getSessionTurnsRich(sessionId, limit = 20) {
        // `id` MUST be in the projection. Downstream callers (writeExtractionResults
        // → linkToRelevantConcepts) gate on `turnId` truthiness to write
        // mentions(turn→concept) edges. Drop it and the filter rejects every row
        // → daemon extraction silently never writes turn-mentions, even though
        // both transcript text and turn rows exist. We map the SurrealDB `id`
        // field to `turnId` here so the rest of the codebase sees the existing
        // TurnData.turnId shape unchanged. R5 regression fix: R4 added the
        // tool_name/tool_result/file_paths columns to this SELECT but dropped
        // `id` from the projection silently.
        const rows = await this.queryFirst(
        // WITH NOINDEX: see getSessionTurns above — the ASC-via-index path lies.
        `SELECT id, role, text, tool_name, tool_result, file_paths, timestamp FROM turn WITH NOINDEX WHERE session_id = $sid AND pruned_at IS NONE ORDER BY timestamp ASC LIMIT $lim`, { sid: sessionId, lim: limit });
        // safeId + post-filter: SurrealDB occasionally returns rows where `id`
        // is undefined/null (driver edge case mid-migration, or a projection that
        // accidentally drops the field upstream). `String(undefined)` yields
        // "undefined" — a truthy string that passes the downstream
        // `if (turnId)` gates and then explodes when linkToRelevantConcepts tries
        // to RELATE turn:undefined→concept. safeId returns "" on nullish, and
        // we drop empty-id rows here so callers see a clean list.
        return rows.map(r => ({
            turnId: safeId(r.id),
            role: r.role,
            text: r.text,
            ...(r.tool_name !== undefined ? { tool_name: r.tool_name } : {}),
            ...(r.tool_result !== undefined ? { tool_result: r.tool_result } : {}),
            ...(r.file_paths !== undefined ? { file_paths: r.file_paths } : {}),
        })).filter(r => r.turnId);
    }
    // ── Relation helpers ───────────────────────────────────────────────────
    /** Returns true when a new edge row was written, false when a UNIQUE
     *  (in,out) index reported the edge already exists (idempotent no-op).
     *  W2-06 (2026-06-10): with ensureEdgeIndexes() armed, every duplicate
     *  RELATE — hook re-fires, RPC-timeout retries, per-turn re-linking —
     *  surfaces as a unique violation; treating it as success-without-write
     *  is the central backstop that made 92% of production edge rows
     *  impossible to recreate. Callers that need created-vs-existed (e.g.
     *  decay-once) read the boolean; void-style callers are unaffected. */
    async relate(fromId, edge, toId) {
        assertRecordId(fromId);
        assertRecordId(toId);
        // Self-loop guard (T5, 2026-06-10): writers do occasionally resolve both
        // endpoints to the same record (observed live — 7 fresh related_to
        // self-loops within an hour of the dedup migration deleting 97k of them).
        // A self-pair is still UNIQUE-(in,out)-legal, so the W2-05 indexes don't
        // block it; refuse at the choke point instead. No edge type in this graph
        // has self-loop semantics.
        if (fromId === toId)
            return false;
        const safeName = edge.replace(/[^a-zA-Z0-9_]/g, "");
        assertValidEdge(safeName);
        try {
            await this.queryExec(`RELATE ${fromId}->${safeName}->${toId}`);
            return true;
        }
        catch (e) {
            if (isUniqueViolation(e))
                return false;
            throw e;
        }
    }
    // ── 5-Pillar entity operations ─────────────────────────────────────────
    async ensureAgent(name, model) {
        const rows = await this.queryFirst(`SELECT id FROM agent WHERE name = $name LIMIT 1`, { name });
        if (rows.length > 0)
            return String(rows[0].id);
        const created = await this.queryFirst(`CREATE agent CONTENT { name: $name, model: $model } RETURN id`, { name, ...(model != null ? { model } : {}) });
        return String(created[0]?.id ?? "");
    }
    async ensureProject(name) {
        const rows = await this.queryFirst(`SELECT id FROM project WHERE name = $name LIMIT 1`, { name });
        if (rows.length > 0)
            return String(rows[0].id);
        const created = await this.queryFirst(`CREATE project CONTENT { name: $name } RETURN id`, { name });
        return String(created[0]?.id ?? "");
    }
    async createTask(description, projectId) {
        // W2-23 (2026-06-10): omit absent keys instead of binding null. Stored
        // NULLs poison `project_id IS NONE` backfill predicates (NULL ≠ NONE),
        // making no-project rows permanently un-backfillable.
        const data = { description, status: "in_progress" };
        if (projectId)
            data.project_id = projectId;
        const rows = await this.queryFirst(`CREATE task CONTENT $data RETURN id`, { data });
        return String(rows[0]?.id ?? "");
    }
    async createSession(agentId = "default", kcSessionId, projectId) {
        // W2-23: kc_session_id is option<string> — binding null fails coercion
        // ("found NULL"), so the no-kc-id fallback path this method exists for
        // always failed. Omit absent keys.
        const data = { agent_id: agentId };
        if (kcSessionId)
            data.kc_session_id = kcSessionId;
        if (projectId)
            data.project_id = projectId;
        const rows = await this.queryFirst(`CREATE session CONTENT $data RETURN id`, { data });
        return String(rows[0]?.id ?? "");
    }
    /** Idempotent session-row resolver. If a session row already exists for the
     *  given Claude Code session id, returns it; otherwise creates one. Used by
     *  UserPromptSubmit to backfill resumed conversations that Claude Code's
     *  hook engine doesn't refire SessionStart for — without this, every
     *  resumed session is a graph orphan (turns ingested but unattributable).
     *
     *  0.7.29: also backfills the project_id field on existing rows that
     *  predate project-scope persistence. Idempotent: only sets when NONE. */
    async ensureSessionRow(kcSessionId, agentId = "default", projectId) {
        if (!kcSessionId)
            return this.createSession(agentId, undefined, projectId);
        const existing = await this.queryFirst(`SELECT id FROM session WHERE kc_session_id = $kc LIMIT 1`, { kc: kcSessionId });
        if (existing[0]?.id) {
            const id = String(existing[0].id);
            assertRecordId(id);
            if (projectId) {
                await this.queryExec(`UPDATE ${id} SET project_id = IF project_id IS NONE THEN $pid ELSE project_id END`, { pid: projectId }).catch(() => { });
            }
            return id;
        }
        return this.createSession(agentId, kcSessionId, projectId);
    }
    /** Increment turn_count by 1 and bump last_active. Called from
     *  UserPromptSubmit (0.7.12+) — the reliable hook that fires at turn
     *  start. Earlier versions did this from Stop, which is dropped/timed-out
     *  often enough to leave session.turn_count chronically undercounted. */
    async bumpSessionTurn(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET turn_count += 1, last_active = time::now()`);
    }
    /** Add the per-turn input/output token deltas to the session row's
     *  cumulative totals. Called from Stop (when the assistant response
     *  has been transcribed and token usage is known) and PreCompact (to
     *  flush any tokens accrued mid-compaction). No-op when both deltas
     *  are zero, which is the common-no-tokens-accrued path. */
    async addSessionTokens(sessionId, inputTokens, outputTokens) {
        if (!inputTokens && !outputTokens)
            return;
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET
         total_input_tokens += $input,
         total_output_tokens += $output,
         last_active = time::now()`, { input: inputTokens, output: outputTokens });
    }
    async markSessionActive(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET cleanup_completed = false, last_active = time::now()`);
    }
    async markSessionEnded(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET ended_at = time::now(), cleanup_completed = true`);
    }
    /**
     * Atomically claim a session for cleanup. Only one worker wins per session.
     *
     * Sets cleanup_completed = true and ended_at = time::now() in a single
     * conditional UPDATE. Returns true when this caller won the claim (a row
     * was matched and updated), false when another worker already claimed it
     * (or the record does not exist).
     *
     * Callers MUST roll back via releaseSessionClaim() if the follow-up work
     * (e.g. CREATEing pending_work rows) fails, otherwise the session will
     * never be retried by deferred cleanup. On successful cleanup completion,
     * callers SHOULD call clearSessionClaim() so the cleanup_claim_token does
     * not linger on the row (it accumulates otherwise).
     *
     * Retry idempotency: queryFirst() wraps every call in withRetry(), which
     * retries on connection error. The WHERE clause accepts either "row not
     * yet claimed" OR "row already claimed by us (token matches)". So if the
     * first attempt landed but the response was lost and withRetry re-runs,
     * the second branch fires, RETURN BEFORE is non-empty, and we correctly
     * report won=true on the retry.
     *
     * The cleanup_claim_token field is schemaless — schema rev still pending
     * (Agent F3 owns the schema patch), but SCHEMALESS accepts the field
     * without a definition, so the runtime path can land ahead of schema.
     */
    async claimSessionForCleanup(sessionId) {
        assertRecordId(sessionId);
        const myToken = randomUUID();
        // Single conditional UPDATE that's idempotent on retry. The WHERE clause
        // accepts either "row not yet claimed" (cleanup_completed != true) OR
        // "row already claimed by us" (cleanup_claim_token == myToken). On retry
        // after a lost response, the second branch fires and we still observe
        // RETURN BEFORE non-empty — so we correctly report won=true.
        //
        // Distinguishing the two branches:
        //  - Won on this attempt: the BEFORE row has cleanup_completed != true.
        //  - Already won on a prior attempt: the BEFORE row has
        //    cleanup_claim_token == myToken (and cleanup_completed == true).
        // Either way the caller should treat us as the winner.
        //
        // myToken is parameter-bound (not interpolated) so the SurrealQL parser
        // doesn't have to handle the UUID's hyphens. The session record id is
        // assertRecordId-validated above, so direct interpolation is safe.
        const sql = `UPDATE ${sessionId}
       SET cleanup_completed = true, ended_at = time::now(),
           cleanup_claim_token = $myToken
       WHERE cleanup_completed != true OR cleanup_claim_token = $myToken
       RETURN BEFORE`;
        const rows = await this.queryFirst(sql, { myToken });
        if (rows.length === 0) {
            // No row matched the predicate — either record missing, or someone
            // else's token is on the row already. Loser path.
            return false;
        }
        const before = rows[0];
        // Either we just won (cleanup_completed != true in BEFORE) or we already
        // won on a prior attempt (token matches ours). Both are winner paths.
        if (before.cleanup_completed === true && before.cleanup_claim_token !== myToken) {
            // Defensive: predicate should preclude this, but if a future schema
            // change rewrites cleanup_completed semantics, fall back to false.
            return false;
        }
        return true;
    }
    /**
     * Roll back a prior claimSessionForCleanup() when the follow-up work failed.
     * Resets cleanup_completed = false and clears ended_at so deferredCleanup
     * picks the session up again on next boot. Also clears the claim token so
     * a fresh claim attempt starts from a clean slate.
     */
    async releaseSessionClaim(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET cleanup_completed = false, ended_at = NONE,
       cleanup_claim_token = NONE`);
    }
    /**
     * Clear the cleanup_claim_token after successful cleanup completion. Leaves
     * cleanup_completed = true so the session stays "done"; only the token is
     * reset so it does not accumulate across re-runs on the same record. Safe
     * to call multiple times (idempotent on the NONE write).
     */
    async clearSessionClaim(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET cleanup_claim_token = NONE`);
    }
    async getOrphanedSessions(limit = 20) {
        return this.queryFirst(`SELECT id, started_at, kc_session_id FROM session
       WHERE cleanup_completed != true
         AND started_at < time::now() - 2m
       ORDER BY started_at DESC LIMIT $lim`, { lim: limit });
    }
    async countTurnsForSession(kcSessionId) {
        if (!kcSessionId)
            return 0;
        const rows = await this.queryFirst(`SELECT count() AS count FROM turn WHERE session_id = $sid GROUP ALL`, { sid: kcSessionId });
        return rows[0]?.count ?? 0;
    }
    async linkSessionToTask(sessionId, taskId) {
        assertRecordId(sessionId);
        assertRecordId(taskId);
        await this.queryExec(`RELATE ${sessionId}->session_task->${taskId}`);
    }
    async linkTaskToProject(taskId, projectId) {
        assertRecordId(taskId);
        assertRecordId(projectId);
        await this.queryExec(`RELATE ${taskId}->task_part_of->${projectId}`);
    }
    async linkAgentToTask(agentId, taskId) {
        assertRecordId(agentId);
        assertRecordId(taskId);
        await this.queryExec(`RELATE ${agentId}->performed->${taskId}`);
    }
    async linkAgentToProject(agentId, projectId) {
        assertRecordId(agentId);
        assertRecordId(projectId);
        await this.queryExec(`RELATE ${agentId}->owns->${projectId}`);
    }
    // ── Graph traversal ────────────────────────────────────────────────────
    /**
     * BFS expansion from seed nodes along typed edges, with batched per-hop queries.
     * Uses multi-edge traversal (LIMIT 25 forward, LIMIT 10 reverse) to bound fan-out.
     */
    /**
     * Tag-boosted concept retrieval: extract keywords from query text,
     * find concepts tagged with matching terms, score by cosine similarity.
     * Returns concepts that pure vector search might miss due to embedding mismatch.
     */
    async tagBoostedConcepts(queryText, queryVec, limit = 10) {
        // Extract candidate tags from query — lowercase, deduplicate. Same
        // expanded stopword set as the rationale-display path in context-assembler.ts
        // (kept in sync to prevent the tag-boost from triggering on conversational
        // noise like "completely", "incorrect", "search", "context" — words that
        // would otherwise pull unrelated concepts via tag match).
        const stopwords = new Set([
            "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
            "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall",
            "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "about", "between",
            "through", "during", "it", "its", "this", "that", "these", "those", "i", "you", "we", "they",
            "my", "your", "our", "their", "what", "which", "who", "how", "when", "where", "why", "not",
            "no", "and", "or", "but", "if", "so", "any", "all", "some", "more", "just", "also", "than",
            "very", "too", "much", "many",
            "completely", "incorrect", "correct", "wrong", "right", "broken", "working", "missing",
            "really", "actually", "probably", "maybe", "perhaps", "clearly", "obviously", "exactly",
            "again", "still", "even", "well", "good", "bad", "great", "fine", "okay", "yeah", "yes",
            "basically", "mostly", "kind", "sort", "like", "want", "need", "make", "made",
            "take", "took", "give", "gave", "tell", "told", "show", "shown", "said", "says", "know",
            "knew", "think", "thought", "going", "doing", "done", "got", "get", "getting", "find",
            "found", "look", "looks", "looking", "seem", "seems", "mean", "means", "meant",
            "thing", "things", "stuff", "way", "ways", "time", "times", "place", "places", "part",
            "parts", "point", "points", "case", "issue", "issues", "problem", "problems", "fix",
            "fixes", "bug", "bugs", "error", "errors", "change", "changes", "update", "updates",
            "version", "versions", "question", "questions", "answer", "answers", "reason", "reasons",
            "context", "search", "report", "reports", "check", "checks", "status", "state", "states",
            "running", "runs", "ran", "start", "started", "stop", "stopped", "keep", "kept",
            "work", "works", "worked", "help", "helps", "helped", "needs", "needed",
            "wanted", "wants", "tried", "trying", "using", "used", "uses",
            "such", "then", "over", "under", "both", "each", "every",
            "before", "after", "above", "below", "while", "other", "others", "same", "different", "new", "old",
        ]);
        const words = queryText.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/)
            .filter(w => w.length > 2 && !stopwords.has(w));
        if (words.length === 0)
            return [];
        const tagWords = words.slice(0, 8);
        try {
            // COSINE_GUARD_OK: read-only keyword/tag concept retrieval — no
            // destructive follow-on. (Inline marker replaces a line-pinned
            // whitelist entry that drifted on every edit above it.)
            const rows = await this.queryFirst(`SELECT id, content AS text, stability AS importance, access_count AS accessCount,
                created_at AS timestamp, 'concept' AS table,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND superseded_at IS NONE
           AND tags CONTAINSANY $tags
         ORDER BY score DESC
         LIMIT $limit`, { vec: queryVec, limit, tags: tagWords });
            return rows;
        }
        catch (e) {
            swallow.warn("surreal:tagBoostedConcepts", e);
            return [];
        }
    }
    async graphExpand(nodeIds, queryVec, hops = 1) {
        if (nodeIds.length === 0)
            return [];
        const MAX_FRONTIER_SEEDS = 5; // max seed nodes to start BFS from
        const MAX_FRONTIER_PER_HOP = 3; // max nodes carried forward per hop (by score)
        const forwardEdgeList = "responds_to, mentions, related_to, narrower, broader, about_concept, reflects_on, skill_from_task, skill_uses_concept, owns, performed, task_part_of, session_task, produced, derived_from, relevant_to, used_in, artifact_mentions";
        const reverseEdgeList = "reflects_on, skill_from_task, produced, derived_from, performed, owns";
        const FORWARD_LIMIT = 25;
        const REVERSE_LIMIT = 10;
        // COSINE_GUARD_OK: read-only graph-expansion scoring — traversal only,
        // no destructive follow-on.
        const scoreExpr = ", IF embedding != NONE AND array::len(embedding) > 0 THEN vector::similarity::cosine(embedding, $vec) ELSE 0 END AS score";
        const bindings = { vec: queryVec };
        const selectFields = `SELECT id, text, content, description, importance, stability,
                  access_count AS accessCount, created_at AS timestamp,
                  IF id IS NOT NONE THEN meta::tb(id) ELSE 'unknown' END AS table${scoreExpr}`;
        const seen = new Set(nodeIds);
        const allNeighbors = [];
        let frontier = nodeIds.slice(0, MAX_FRONTIER_SEEDS).filter((id) => RECORD_ID_RE.test(id));
        for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
            // 2 stmts per seed (forward + reverse multi-edge) instead of 25
            const stmts = [];
            for (const id of frontier) {
                stmts.push(`${selectFields} FROM ${id}->(${forwardEdgeList})->? LIMIT ${FORWARD_LIMIT}`);
                stmts.push(`${selectFields} FROM ${id}<-(${reverseEdgeList})<-? LIMIT ${REVERSE_LIMIT}`);
            }
            let queryResults;
            try {
                queryResults = await this.queryBatch(stmts, bindings);
            }
            catch (e) {
                swallow.warn("surreal:graphExpand:batch", e);
                break;
            }
            const nextFrontier = [];
            for (const rawRows of queryResults) {
                const rows = rawRows;
                for (const row of rows) {
                    if (row.id == null)
                        continue;
                    const nodeId = String(row.id);
                    if (seen.has(nodeId))
                        continue;
                    seen.add(nodeId);
                    const text = (row.text ?? row.content ?? row.description ?? null);
                    if (text) {
                        const score = typeof row.score === "number" ? row.score : 0;
                        allNeighbors.push({
                            text,
                            importance: (row.importance ?? row.stability),
                            accessCount: row.accessCount,
                            timestamp: row.timestamp,
                            table: String(row.table ?? "unknown"),
                            id: nodeId,
                            score,
                        });
                        if (RECORD_ID_RE.test(nodeId)) {
                            nextFrontier.push({ id: nodeId, score });
                        }
                    }
                }
            }
            frontier = nextFrontier
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_FRONTIER_PER_HOP)
                .map((n) => n.id);
        }
        return allNeighbors;
    }
    /** 0.7.121 — counter side-table. The old per-retrieval
     *  `UPDATE <row> SET access_count += 1` rewrote the ENTIRE row (embedding
     *  included, 4–12KB) into surrealkv's append-only value log on every bump:
     *  measured production damage was a 63.8GB vlog wrapping ~0.3GB of live
     *  data (~200× write amplification; 2026-06-12 forensics). Bumps now land
     *  in tiny `access_stats` rows (deterministic id = target id with ':'→'_';
     *  ~100B/version). Two safety valves keep legacy readers correct:
     *  - AMORTIZED ROW SYNC: at most once per 7 days per row, the real row's
     *    access_count/last_accessed are refreshed from the side table — the
     *    WHERE gate means a no-op sync writes NO row version. Keeps
     *    maintenance/GC predicates that read row.last_accessed within a week
     *    of truth instead of frozen forever.
     *  - SCORING MERGE: fetchAccessDeltas() lets the hot path see exact
     *    counts (graph-context merges before WMR scoring).
     *  Field is named `hits` (not `count`) — `count` collides with the
     *  SurrealQL function in SET expressions. */
    async bumpAccessCounts(ids) {
        // 0.7.122: coerce FIRST — callers hand over raw result rows whose id can
        // be a RecordId OBJECT, and `.replace` on it threw, failing the entire
        // bump batch (16 silent batch failures post-cutover, daemon.log).
        const validated = ids.map(id => String(id)).filter(id => { try {
            assertRecordId(id);
            return true;
        }
        catch {
            return false;
        } });
        if (validated.length === 0)
            return;
        try {
            // Direct interpolation (safe: assertRecordId validates format above).
            // Cannot use `UPDATE $ids` binding — SurrealDB treats string arrays as
            // literal strings, not record references, causing silent no-ops.
            const stmts = validated.flatMap(id => {
                const key = id.replace(":", "_");
                return [
                    // `hits += 1`, NOT `hits = (hits ?? 0) + 1`: inside UPSERT's SET the
                    // ??-form evaluates against a blank doc on THIS engine (3.0.1) and
                    // the counter never increments (live-probed 2026-06-12); += works.
                    `UPSERT access_stats:⟨${key}⟩ SET hits += 1, last_accessed = time::now(), target = ${id}`,
                    // Amortized sync — fires at most weekly per row (the WHERE gate on a
                    // non-matching row writes NOTHING to the vlog). `synced_hits` on the
                    // row is the watermark of side-table hits already folded into
                    // access_count, so the fold never double-counts.
                    `LET $h = (SELECT VALUE hits FROM ONLY access_stats:⟨${key}⟩) ?? 0;
           UPDATE ${id} SET access_count = (access_count ?? 0) + math::max([$h - (synced_hits ?? 0), 0]), synced_hits = $h, last_accessed = time::now() WHERE last_accessed IS NONE OR last_accessed < time::now() - 7d`,
                ];
            });
            await this.queryBatch(stmts);
        }
        catch (e) {
            swallow.warn("surreal:bumpAccessCounts", e);
        }
    }
    /** 0.7.121 — exact access counts for scoring: row's (possibly week-stale)
     *  access_count + un-synced side-table delta. Direct record fetches, O(1)
     *  per id. Returns Map<targetId, {hits, syncedHits}> for ids that have any
     *  side-table row. */
    async fetchAccessDeltas(ids) {
        const out = new Map();
        const validated = ids.map(id => String(id)).filter(id => { try {
            assertRecordId(id);
            return true;
        }
        catch {
            return false;
        } });
        if (validated.length === 0)
            return out;
        try {
            // Two direct-record point fetches (no table scans, no embedding bytes):
            // side-table totals, then the rows' synced watermarks.
            const statTargets = validated.map(id => `access_stats:⟨${id.replace(":", "_")}⟩`).join(", ");
            const stats = await this.queryFirst(`SELECT <string>target AS target, hits FROM ${statTargets}`);
            if (stats.length === 0)
                return out;
            const hitIds = stats.map(s => String(s.target));
            const watermarks = await this.queryFirst(`SELECT <string>id AS id, synced_hits FROM ${hitIds.join(", ")}`);
            const synced = new Map(watermarks.map(w => [String(w.id), w.synced_hits ?? 0]));
            for (const s of stats) {
                const delta = (s.hits ?? 0) - (synced.get(String(s.target)) ?? 0);
                if (delta > 0)
                    out.set(String(s.target), delta);
            }
        }
        catch (e) {
            swallow("surreal:fetchAccessDeltas", e);
        }
        return out;
    }
    // ── Concept / Memory / Artifact CRUD ───────────────────────────────────
    /** W2-07 (2026-06-10): returns { id, existed } — `existed: true` when the
     *  content resolved to a pre-existing concept (exact or >0.92-cosine dedup,
     *  including race-recovery paths). commitConcept uses the flag to skip
     *  re-running hierarchy/related_to link scans for recurring concepts — the
     *  per-turn re-wiring that produced ×4,541 duplicate edges on hot pairs. */
    async upsertConcept(content, embedding, source, provenance, projectId) {
        if (!content?.trim())
            return { id: "", existed: false };
        content = content.trim();
        // Two-stage dedup. Stage 1: top-10 candidates by embedding cosine.
        // T5 comment-rot fix (2026-06-10): this is a LINEAR scan — a bare
        // similarity-function call + ORDER BY never touches the
        // `concept_vec_idx` HNSW index (schema.surql:78); SurrealDB only uses
        // HNSW via the KNN operator (`embedding <|10|> $vec`). Kept linear
        // deliberately: dedup is a correctness path and approximate-KNN misses
        // would mint duplicate concepts; ~8k rows × cosine is a few ms.
        // Plus exact-similarity match for ">0.92 means same concept, even if
        // labels differ slightly".
        // Stage 2 (precise, in-process): scan those 10 candidates for an exact
        // lowercase-equal content match. This replaces the prior
        // `WHERE string::lowercase(content) = string::lowercase($content)`
        // table scan, which was O(N) over all concept rows on every upsert
        // (4.7k rows in production at the time of the fix).
        //
        // Fallback path: when the caller did not supply an embedding (degraded
        // env / no embeddings service), keep the lowercase-equality scan so
        // dedup remains correct even though it costs a full table scan in
        // that branch. The hot path is the KNN one.
        let existingId = null;
        if (embedding?.length) {
            // COSINE_GUARD_OK: read-only dedup candidate scan — the only follow-on
            // writes are the guarded UPDATE-existing / CREATE-new below.
            const candidates = await this.queryFirst(`SELECT id, content, vector::similarity::cosine(embedding, $vec) AS score
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND superseded_at IS NONE
         ORDER BY score DESC
         LIMIT 10`, { vec: embedding });
            const target = content.toLowerCase();
            // High-similarity dedup branch: even if labels disagree, cosine >0.92
            // on the new content's embedding vs an existing concept's embedding
            // means they describe the same thing. Mirrors createMemory's dedup.
            // We check this AFTER the exact-label scan so an exact match wins,
            // but BEFORE creating a new row.
            let highSimId = null;
            for (const c of candidates) {
                const cContent = (c.content ?? "").toLowerCase();
                if (cContent === target) {
                    existingId = String(c.id);
                    break;
                }
                if (highSimId === null && typeof c.score === "number" && c.score > 0.92) {
                    highSimId = String(c.id);
                }
            }
            if (!existingId && highSimId)
                existingId = highSimId;
        }
        else {
            const rows = await this.queryFirst(`SELECT id FROM concept WHERE string::lowercase(content) = string::lowercase($content) AND superseded_at IS NONE LIMIT 1`, { content });
            if (rows.length > 0)
                existingId = String(rows[0].id);
        }
        if (existingId) {
            const id = existingId;
            assertRecordId(id);
            // 0.7.121: counter goes to the access_stats side table (see
            // bumpAccessCounts) — the old unconditional UPDATE here rewrote the
            // full embedded row on EVERY dedup-hit, i.e. every time turn ingestion
            // re-encountered a known concept: a top write-amplifier behind the
            // 63.8GB vlog. Backfills below are WHERE-gated: a non-matching WHERE
            // writes NO row version, so the fat rewrite only happens when
            // something is genuinely missing (rare).
            await this.bumpAccessCounts([id]);
            if (embedding?.length) {
                await this.queryExec(`UPDATE ${id} SET embedding = $emb WHERE embedding IS NONE OR array::len(embedding) = 0`, { emb: embedding });
            }
            if (projectId) {
                await this.queryExec(`UPDATE ${id} SET project_id = $pid WHERE project_id IS NONE`, { pid: projectId });
            }
            return { id, existed: true };
        }
        const emb = embedding?.length ? embedding : undefined;
        const record = { content, source: source ?? undefined };
        if (emb)
            record.embedding = emb;
        if (provenance)
            record.provenance = provenance;
        if (projectId)
            record.project_id = projectId;
        // M5 race surfacer: SELECT-then-CREATE has a TOCTOU window. Two concurrent
        // upserts can both observe the SELECT-miss above and race into CREATE.
        // The schema-level UNIQUE on lowercased content (out of scope here —
        // needs a migration) is the durable fix. Until then, catch any unique-
        // violation from the CREATE, log it via swallow.warn so we can measure
        // how often it actually fires in production, and re-SELECT to return the
        // sibling-created row's id. This keeps the API contract (returns an id)
        // intact instead of throwing.
        try {
            const created = await this.queryFirst(`CREATE concept CONTENT $record RETURN id`, { record });
            return { id: String(created[0]?.id ?? ""), existed: false };
        }
        catch (createErr) {
            if (isUniqueViolation(createErr)) {
                swallow.warn("upsertConcept:dedupRace", createErr);
                // Stage A: lowercase-exact rematch. Cheap, covers the common case
                // where two callers wrote the same content string concurrently.
                const existing = await this.queryFirst(`SELECT id FROM concept WHERE string::lowercase(content) = string::lowercase($content) AND superseded_at IS NONE LIMIT 1`, { content }).catch(e => { swallow.warn("upsertConcept:selectAfterRace", e); return []; });
                if (existing[0]?.id)
                    return { id: String(existing[0].id), existed: true };
                // Stage B (R7 F1): when the race winner deduped via KNN cosine
                // (>0.92 sim, different content text — synonym/paraphrase), the
                // lowercase rematch above won't find it. Replay the same KNN
                // similarity match the initial dedup pass would have done so the
                // caller still receives the correct id instead of the empty string.
                if (embedding?.length) {
                    // COSINE_GUARD_OK: read-only race-fallback KNN rematch — resolves
                    // the dedup-race winner's id; no destructive follow-on.
                    const knn = await this.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
             FROM concept
             WHERE embedding != NONE AND array::len(embedding) > 0
               AND superseded_at IS NONE
             ORDER BY score DESC
             LIMIT 1`, { vec: embedding }).catch(e => { swallow.warn("upsertConcept:knnAfterRace", e); return []; });
                    if (knn[0] && typeof knn[0].score === "number" && knn[0].score > 0.92 && knn[0].id) {
                        return { id: String(knn[0].id), existed: true };
                    }
                }
            }
            throw createErr;
        }
    }
    /** W2-09 (2026-06-10): returns { id, existed } — `existed: true` when the
     *  path-unique dedup resolved to a pre-existing artifact row. commitArtifact
     *  uses the flag to skip re-running the artifact_mentions link scan on every
     *  re-edit of the same file (~5 duplicate edges + one wasted embed per
     *  Write/Edit before the fix). */
    async createArtifact(path, type, description, embedding, projectId) {
        // Dedup by `path`: PostToolUse re-fires (duplicate-row bug class)
        // would otherwise produce duplicate artifact rows for the same file.
        // The schema has no session_id on artifact (artifacts are global by
        // path, not session-scoped), and content_hash is optional/unpopulated
        // by current callers — so path alone is the correct identity key.
        //
        // Strategy: try the CREATE, and on a UNIQUE-index rejection from the
        // artifact_path_unique constraint, re-SELECT to return the existing
        // row's id. This eliminates the prior SELECT-then-CREATE TOCTOU window
        // (where a sibling could CREATE between our SELECT-miss and our CREATE)
        // and removes the silent `.catch(() => [])` that previously masked a
        // SELECT failure and let a duplicate CREATE land.
        const record = { path, type, description };
        if (embedding?.length)
            record.embedding = embedding;
        if (projectId)
            record.project_id = projectId;
        try {
            const rows = await this.queryFirst(`CREATE artifact CONTENT $record RETURN id`, { record });
            return { id: String(rows[0]?.id ?? ""), existed: false };
        }
        catch (createErr) {
            if (path && isUniqueViolation(createErr)) {
                // Sibling already wrote the row — fetch its id and return.
                const existing = await this.queryFirst(`SELECT id FROM artifact WHERE path = $path LIMIT 1`, { path }).catch(e => { swallow.warn("createArtifact:selectAfterUnique", e); return []; });
                if (existing[0]?.id)
                    return { id: String(existing[0].id), existed: true };
                // TOCTOU close-out: the sibling row was deleted between our CREATE
                // rejection and our SELECT, so the path is no longer occupied. Retry
                // CREATE once — succeeds in the normal case, only re-fails if a third
                // racer slipped in. The double-disappearing-row case is so unlikely we
                // wrap it as a distinct error rather than infinite-looping.
                try {
                    const retried = await this.queryFirst(`CREATE artifact CONTENT $record RETURN id`, { record });
                    return { id: String(retried[0]?.id ?? ""), existed: false };
                }
                catch (retryErr) {
                    if (isUniqueViolation(retryErr)) {
                        const existingAgain = await this.queryFirst(`SELECT id FROM artifact WHERE path = $path LIMIT 1`, { path }).catch(() => []);
                        if (existingAgain[0]?.id)
                            return { id: String(existingAgain[0].id), existed: true };
                        // isUniqueViolation accepts non-Error inputs (plain-object errors
                        // from raw RPC layers), so retryErr may not be an Error instance.
                        // Cast unconditionally would produce `cause=undefined` and a
                        // useless wrapper. Build a faithful message + chain instead.
                        const retryMsg = retryErr instanceof Error
                            ? retryErr.message
                            : String(retryErr);
                        const retryCause = retryErr instanceof Error
                            ? retryErr
                            : new Error(String(retryErr));
                        throw new Error(`createArtifact: UNIQUE conflict with disappearing row (cause=${retryMsg})`, { cause: retryCause });
                    }
                    throw retryErr;
                }
            }
            throw createErr;
        }
    }
    async createMemory(text, embedding, importance, category, sessionId, projectId) {
        const source = category ?? "general";
        // v0.7.93 append-only: was a cosine-≥0.92 dedup that silently DISCARDED
        // the incoming text and bumped the existing row's importance/access_count.
        // That's the family-2 silent-data-loss bug (text never persists).
        // New behavior: tightened to exact lexical text equality on the same
        // category. If a byte-identical row exists, treat it as a re-save (bump
        // access + importance, keep the original text). Otherwise CREATE a new
        // row even when cosine is high — semantically-similar-but-different
        // content is preserved as siblings; consolidation (now soft-archiving)
        // can collapse later, audit trail intact.
        if (text && text.length > 0) {
            const exact = await this.queryFirst(`SELECT id, importance FROM memory
         WHERE string::lowercase(text) = string::lowercase($text)
           AND category = $cat
           AND (status = 'active' OR status IS NONE)
         LIMIT 1`, { text, cat: source });
            if (exact.length > 0) {
                const existingId = String(exact[0].id);
                assertRecordId(existingId);
                // 0.7.121 (QA C1): same amplifier class as the concept dedup-hit —
                // counter to the side table; importance write WHERE-gated so a
                // no-raise rewrite emits no row version.
                await this.bumpAccessCounts([existingId]);
                await this.queryExec(`UPDATE ${existingId} SET importance = $imp WHERE importance IS NONE OR importance < $imp`, { imp: importance });
                return existingId;
            }
        }
        const record = { text, importance, category: source, source };
        if (embedding?.length)
            record.embedding = embedding;
        if (sessionId)
            record.session_id = sessionId;
        if (projectId)
            record.project_id = projectId;
        const rows = await this.queryFirst(`CREATE memory CONTENT $record RETURN id`, { record });
        return String(rows[0]?.id ?? "");
    }
    async createMonologue(sessionId, category, content, embedding) {
        // Exact-content dedup on write, mirroring createMemory above. The daemon
        // re-extracts a session's transcript on retries / re-runs, and a bare CREATE
        // would duplicate every monologue each time. Monologue feeds soul generation
        // (pending-work.ts soul_generate/soul_evolve), so dupes directly skew
        // identity synthesis. A byte-identical (session_id, category, content) row is
        // a re-save → return its id. Semantically-similar-but-different traces remain
        // siblings; consolidation can collapse them later (same philosophy as memory).
        if (content && content.length > 0) {
            const exact = await this.queryFirst(`SELECT id FROM monologue
         WHERE string::lowercase(content) = string::lowercase($content)
           AND session_id = $sid
           AND category = $cat
         LIMIT 1`, { content, sid: sessionId, cat: category });
            if (exact.length > 0) {
                const existingId = String(exact[0].id);
                assertRecordId(existingId);
                return existingId;
            }
        }
        const record = { session_id: sessionId, category, content };
        if (embedding?.length)
            record.embedding = embedding;
        const rows = await this.queryFirst(`CREATE monologue CONTENT $record RETURN id`, { record });
        return String(rows[0]?.id ?? "");
    }
    // ── Core Memory (Tier 0/1) ─────────────────────────────────────────────
    async getAllCoreMemory(tier) {
        try {
            if (tier != null) {
                return await this.queryFirst(`SELECT * FROM core_memory WHERE active = true AND tier = $tier ORDER BY priority DESC`, { tier });
            }
            return await this.queryFirst(`SELECT * FROM core_memory WHERE active = true ORDER BY tier ASC, priority DESC`);
        }
        catch (e) {
            swallow.warn("surreal:getAllCoreMemory", e);
            return [];
        }
    }
    async createCoreMemory(text, category, priority, tier, sessionId) {
        const record = { text, category, priority, tier, active: true };
        if (sessionId)
            record.session_id = sessionId;
        const rows = await this.queryFirst(`CREATE core_memory CONTENT $record RETURN id`, { record });
        const id = String(rows[0]?.id ?? "");
        if (!id)
            throw new Error("createCoreMemory: CREATE returned no ID");
        return id;
    }
    async updateCoreMemory(id, fields) {
        assertRecordId(id);
        const ALLOWED_FIELDS = new Set(["text", "category", "priority", "tier", "active"]);
        const sets = [];
        const bindings = {};
        for (const [key, val] of Object.entries(fields)) {
            if (val !== undefined && ALLOWED_FIELDS.has(key)) {
                sets.push(`${key} = $${key}`);
                bindings[key] = val;
            }
        }
        if (sets.length === 0)
            return false;
        sets.push("updated_at = time::now()");
        const rows = await this.queryFirst(`UPDATE ${id} SET ${sets.join(", ")} RETURN id`, bindings);
        return rows.length > 0;
    }
    async deleteCoreMemory(id) {
        assertRecordId(id);
        await this.queryExec(`UPDATE ${id} SET active = false, updated_at = time::now()`);
    }
    // ── Wakeup & lifecycle queries ─────────────────────────────────────────
    async getLatestHandoff() {
        try {
            const rows = await this.queryFirst(`SELECT text, created_at FROM memory WHERE category = "handoff" ORDER BY created_at DESC LIMIT 1`);
            return rows[0] ?? null;
        }
        catch (e) {
            swallow.warn("surreal:getLatestHandoff", e);
            return null;
        }
    }
    async countResolvedSinceHandoff(handoffCreatedAt) {
        try {
            const rows = await this.queryFirst(`SELECT count() AS count FROM memory WHERE status = 'resolved' AND resolved_at > $ts GROUP ALL`, { ts: handoffCreatedAt });
            return rows[0]?.count ?? 0;
        }
        catch (e) {
            swallow.warn("surreal:countResolvedSinceHandoff", e);
            return 0;
        }
    }
    async getAllIdentityChunks() {
        try {
            return await this.queryFirst(`SELECT text, chunk_index FROM identity_chunk
         WHERE active = true OR active IS NONE
         ORDER BY chunk_index ASC`);
        }
        catch (e) {
            swallow.warn("surreal:getAllIdentityChunks", e);
            return [];
        }
    }
    async getRecentMonologues(limit = 5) {
        try {
            return await this.queryFirst(`SELECT category, content, timestamp FROM monologue ORDER BY timestamp DESC LIMIT $lim`, { lim: limit });
        }
        catch (e) {
            swallow.warn("surreal:getRecentMonologues", e);
            return [];
        }
    }
    async getPreviousSessionTurns(currentSessionId, limit = 10) {
        try {
            let prevSessionQuery;
            const bindings = { lim: limit };
            if (currentSessionId) {
                // currentSessionId is the kc-session UUID (the hook payload's
                // session_id) — NOT a session Thing. The previous form cast it with
                // type::record(), which throws "Could not cast into `record`" on
                // every call (swallowed below → []), silently killing prev-session
                // context since introduction. Compare against kc_session_id instead;
                // rows predating kc ids (NONE) stay eligible as "previous".
                prevSessionQuery = `SELECT id, started_at FROM session WHERE kc_session_id IS NONE OR kc_session_id != $current ORDER BY started_at DESC LIMIT 1`;
                bindings.current = currentSessionId;
            }
            else {
                prevSessionQuery = `SELECT id, started_at FROM session ORDER BY started_at DESC LIMIT 1`;
            }
            const sessionRows = await this.queryFirst(prevSessionQuery, bindings);
            if (sessionRows.length === 0)
                return [];
            const prevSessionId = String(sessionRows[0].id);
            const turns = await this.queryFirst(`SELECT role, text, tool_name, timestamp FROM turn
         WHERE id IN (SELECT VALUE in FROM part_of WHERE out = type::record($sid))
           AND text != NONE AND text != ""
           AND pruned_at IS NONE
         ORDER BY timestamp DESC LIMIT $lim`, 
            // type::record($sid): SurrealDB treats string bindings as literal
            // strings, never record references (same trap as the ACAN fetch,
            // see the interpolation note near queryBatch) — a bare $sid string
            // matches zero part_of.out records.
            { sid: prevSessionId, lim: limit });
            return turns.reverse();
        }
        catch (e) {
            swallow.warn("surreal:getPreviousSessionTurns", e);
            return [];
        }
    }
    async getUnresolvedMemories(limit = 5) {
        try {
            return await this.queryFirst(`SELECT id, text,
                math::max([importance - math::min([math::floor(duration::days(time::now() - created_at) / 7), 3]), 0]) AS importance,
                category
         FROM memory
         WHERE (status IS NONE OR status = 'active')
           AND category NOT IN ['handoff', 'monologue', 'reflection', 'compaction', 'consolidation']
           AND importance >= 6
         ORDER BY importance DESC
         LIMIT $lim`, { lim: limit });
        }
        catch (e) {
            swallow.warn("surreal:getUnresolvedMemories", e);
            return [];
        }
    }
    async getRecentFailedCausal(limit = 3) {
        try {
            return await this.queryFirst(`SELECT description, chain_type, created_at FROM causal_chain WHERE success = false ORDER BY created_at DESC LIMIT $lim`, { lim: limit });
        }
        catch (e) {
            swallow.warn("surreal:getRecentFailedCausal", e);
            return [];
        }
    }
    async resolveMemory(memoryId) {
        try {
            assertRecordId(memoryId);
            await this.queryFirst(`UPDATE ${memoryId} SET status = 'resolved', resolved_at = time::now()`);
            return true;
        }
        catch (e) {
            swallow.warn("surreal:resolveMemory", e);
            return false;
        }
    }
    // ── Utility cache ──────────────────────────────────────────────────────
    async updateUtilityCache(memoryId, utilization) {
        try {
            // memory_id is typed `option<record<memory>>` (was `string` pre-migration).
            // Bind as a RecordId so SurrealDB stores it as a Thing, not as a string.
            const mid = toRecordId(memoryId);
            await this.queryExec(`UPSERT memory_utility_cache SET
          memory_id = $mid,
          retrieval_count = (retrieval_count ?? 0) + 1,
          avg_utilization = IF (retrieval_count ?? 0) > 0
            THEN (avg_utilization * (retrieval_count ?? 0) + $util) / ((retrieval_count ?? 0) + 1)
            ELSE $util
          END,
          last_updated = time::now()
         WHERE memory_id = $mid`, { mid, util: utilization });
        }
        catch (e) {
            swallow.warn("surreal:updateUtilityCache", e);
        }
    }
    async getUtilityFromCache(ids) {
        const result = new Map();
        if (ids.length === 0)
            return result;
        try {
            const recIds = ids.map(id => { try {
                return toRecordId(id);
            }
            catch {
                return null;
            } }).filter((x) => x !== null);
            if (recIds.length === 0)
                return result;
            const rows = await this.queryFirst(`SELECT memory_id, avg_utilization FROM memory_utility_cache WHERE memory_id IN $ids`, { ids: recIds });
            for (const row of rows) {
                if (row.avg_utilization != null)
                    result.set(String(row.memory_id), row.avg_utilization);
            }
        }
        catch (e) {
            swallow.warn("surreal:getUtilityFromCache", e);
        }
        return result;
    }
    async getUtilityCacheEntries(ids) {
        const result = new Map();
        if (ids.length === 0)
            return result;
        try {
            const recIds = ids.map(id => { try {
                return toRecordId(id);
            }
            catch {
                return null;
            } }).filter((x) => x !== null);
            if (recIds.length === 0)
                return result;
            const rows = await this.queryFirst(`SELECT memory_id, avg_utilization, retrieval_count FROM memory_utility_cache WHERE memory_id IN $ids`, { ids: recIds });
            for (const row of rows) {
                if (row.avg_utilization != null) {
                    result.set(String(row.memory_id), {
                        avg_utilization: row.avg_utilization,
                        retrieval_count: row.retrieval_count ?? 0,
                    });
                }
            }
        }
        catch (e) {
            swallow.warn("surreal:getUtilityCacheEntries", e);
        }
        return result;
    }
    // ── Maintenance operations ─────────────────────────────────────────────
    /**
     * Time-relative scheduling gate for maintenance jobs. Returns true when
     * either (a) no prior run is recorded, (b) the last run is older than
     * maxDaysSince, or (c) the row count exceeds the absolute floor.
     *
     * Without this gate, absolute-count floors (count<=200/2000/50) meant
     * brand-new installs got zero maintenance for weeks or months until the
     * graph organically grew large enough to cross the floor. Now a fresh
     * install runs each job once in the first session (baselining), then
     * weekly, plus any time volume crosses the legacy floor.
     */
    async shouldRunMaintenance(job, countFloor, maxDaysSince, currentCount) {
        try {
            const rows = await this.queryFirst(`SELECT ran_at FROM maintenance_runs WHERE job = $job ORDER BY ran_at DESC LIMIT 1`, { job });
            if (rows.length === 0)
                return true; // baseline
            // parseDatetimeMs (NaN-safe) over Date.parse: SurrealDB DateTime values
            // that come back as objects (newer driver versions) yield NaN through
            // Date.parse, which then makes ageDays = NaN and `>=` false, silently
            // skipping all maintenance runs. parseDatetimeMs returns null in that
            // case and we treat unknown age as "stale" (run it) rather than fresh.
            const lastRanAt = parseDatetimeMs(rows[0].ran_at);
            if (lastRanAt == null)
                return true; // unknown age — re-run
            const ageDays = (Date.now() - lastRanAt) / (1000 * 60 * 60 * 24);
            if (ageDays >= maxDaysSince)
                return true;
            return currentCount > countFloor;
        }
        catch (e) {
            // On query failure, fall back to absolute-count behavior so we're
            // never worse than the pre-0.4.0 gate.
            swallow("surreal:shouldRunMaintenance", e);
            return currentCount > countFloor;
        }
    }
    async recordMaintenanceRun(job, rowsAffected, durationMs) {
        try {
            await this.queryExec(`CREATE maintenance_runs CONTENT $data`, { data: { job, rows_affected: rowsAffected, duration_ms: durationMs } });
        }
        catch (e) {
            swallow("surreal:recordMaintenanceRun", e);
        }
    }
    async runMemoryMaintenance() {
        // runMemoryMaintenance is cheap (two UPDATEs) so the floor is 0 — always
        // run, but still record the execution so observability is consistent.
        const started = Date.now();
        try {
            // Single round-trip to reduce transaction conflict window.
            // Structured findings (correction/decision/preference) have a higher
            // decay floor matching their type defaults so they don't erode to noise.
            // memory_id is now record<memory> (was string with `meta::tb(id):meta::id(id)`
            // coercion). The record-ref join is a direct equality check.
            await this.queryExec(`
        UPDATE memory SET importance = math::max([importance * 0.95, 5.0])
          WHERE importance > 5.0 AND category IN ["correction", "decision", "preference", "fact"];
        UPDATE memory SET importance = math::max([importance * 0.95, 2.0])
          WHERE importance > 2.0 AND category NOT IN ["correction", "decision", "preference", "fact"];
        UPDATE memory SET importance = math::max([importance, 3 + (math::min([math::max([(
          SELECT VALUE avg_utilization FROM memory_utility_cache WHERE memory_id = $parent.id LIMIT 1
        )[0] ?? 0, 0]), 1]) * 4)]) WHERE importance < 7;
      `);
            await this.recordMaintenanceRun("runMemoryMaintenance", 0, Date.now() - started);
        }
        catch (e) {
            // Transaction conflicts expected when daemon writes concurrently — silent.
            // Anything else (syntax error, missing field, NaN poison from
            // parseDatetimeMs upstream) is a real bug and must surface via
            // swallow.warn so we don't lose visibility on broken maintenance.
            if (isTransactionConflict(e)) {
                swallow("surreal:runMemoryMaintenance", e);
            }
            else {
                swallow.warn("surreal:runMemoryMaintenance", e);
            }
        }
    }
    async garbageCollectMemories() {
        const started = Date.now();
        try {
            const countRows = await this.queryFirst(`SELECT count() AS count FROM memory GROUP ALL`);
            const count = countRows[0]?.count ?? 0;
            // Floor lowered to 50 and scheduled weekly so new installs benefit.
            if (!(await this.shouldRunMaintenance("garbageCollectMemories", 50, 7, count)))
                return 0;
            // v0.7.93 append-only: was DELETE — now soft-deactivates via
            // status='archived' + archived_at + archive_reason. Memory rows are
            // permanent; readers already filter `status = 'active' OR status IS NONE`
            // (surreal.ts:447, 2019), so archived rows naturally drop out of recall
            // while remaining recoverable for forensic inspection.
            // W2-20 (2026-06-10): raw db.query returns one result per statement —
            // Number([three-element array]) was NaN, so the run count was never
            // recorded and the weekly gate re-ran these jobs every boot. queryMulti
            // takes the last statement's value (the RETURN array::len), exactly as
            // purgeStalePendingWork does for the identical LET+FOR pattern.
            const pruned = await this.queryMulti(`LET $stale = (
          SELECT id FROM memory
          WHERE created_at < time::now() - 14d
            AND importance <= 2.0
            AND (access_count = 0 OR access_count IS NONE)
            AND (status = 'active' OR status IS NONE)
            AND <string>id NOT IN (
              SELECT VALUE memory_id FROM (
                SELECT memory_id FROM retrieval_outcome
                WHERE utilization > 0.2
                GROUP BY memory_id
              )
            )
          LIMIT 50
        );
        FOR $m IN $stale {
          UPDATE $m.id SET
            status = 'archived',
            archived_at = time::now(),
            archive_reason = 'stale_14d_low_importance';
        };
        RETURN array::len($stale);`);
            const n = Number(pruned ?? 0);
            await this.recordMaintenanceRun("garbageCollectMemories", n, Date.now() - started);
            return n;
        }
        catch (e) {
            swallow.warn("surreal:garbageCollectMemories", e);
            return 0;
        }
    }
    async garbageCollectConcepts() {
        const started = Date.now();
        try {
            const countRows = await this.queryFirst(`SELECT count() AS count FROM concept GROUP ALL`);
            const count = countRows[0]?.count ?? 0;
            if (!(await this.shouldRunMaintenance("garbageCollectConcepts", 200, 3, count)))
                return 0;
            // v0.7.93 append-only: was DELETE — now soft-deactivates via
            // superseded_at + archive_reason. Concept readers already filter
            // `superseded_at IS NONE` (surreal.ts:441 vectorSearch), so archived
            // concepts naturally drop out of recall while remaining auditable.
            // W2-20 (2026-06-10): raw db.query returns one result per statement —
            // Number([three-element array]) was NaN, so the run count was never
            // recorded and the weekly gate re-ran these jobs every boot. queryMulti
            // takes the last statement's value (the RETURN array::len), exactly as
            // purgeStalePendingWork does for the identical LET+FOR pattern.
            const pruned = await this.queryMulti(`LET $stale = (
          SELECT id FROM concept
          WHERE created_at < time::now() - 1d
            AND string::len(content) <= 12
            AND content = string::uppercase(content)
            AND superseded_at IS NONE
            AND array::len(<-about_concept<-memory) = 0
            AND array::len(<-mentions<-turn) <= 2
            AND array::len(->narrower->?) = 0
            AND array::len(->broader->?) = 0
          LIMIT 100
        );
        FOR $c IN $stale {
          UPDATE $c.id SET
            superseded_at = time::now(),
            archive_reason = 'stale_orphan_short_uppercase';
        };
        RETURN array::len($stale);`);
            const n = Number(pruned ?? 0);
            await this.recordMaintenanceRun("garbageCollectConcepts", n, Date.now() - started);
            return n;
        }
        catch (e) {
            swallow.warn("surreal:garbageCollectConcepts", e);
            return 0;
        }
    }
    /**
     * True if a pending+active pending_work row of `workType` already exists in
     * ANY session — the enqueue gate for session-end + deferred-cleanup.
     *
     * causal_graduate / soul_* builders run GLOBAL eligibility queries, so ONE
     * pending row of a type drains ALL eligible work; enqueuing one per session
     * just piles up self-completing empties that inflate the DRAIN-NOW banner
     * (the recurring empty-drain report, 2026-06-18). Checks `pending` ONLY (not
     * `processing`): a stuck processing row is recovered by the 10-min stale-
     * recovery in fetch_pending_work, so this gate cannot starve graduation.
     */
    async hasPendingWorkOfType(workType) {
        try {
            const rows = await this.queryFirst(`SELECT count() AS n FROM pending_work
           WHERE work_type = $wt AND status = "pending" AND (active = true OR active IS NONE) GROUP ALL`, { wt: workType });
            return (rows[0]?.n ?? 0) > 0;
        }
        catch {
            return false;
        }
    }
    /**
     * Drop pending_work rows older than 7 days, regardless of status.
     *
     * The queue is consumer-pull (subagents call fetch_pending_work). Without
     * this purge, stale items from long-gone sessions accumulate and pollute
     * health metrics. 7d is well past the useful window — extraction work for
     * a week-old session has missed its tagging window, and graduation work
     * will be re-enqueued by future maintenance if still relevant.
     */
    async purgeStalePendingWork() {
        const started = Date.now();
        try {
            const countRows = await this.queryFirst(`SELECT count() AS count FROM pending_work GROUP ALL`);
            const count = countRows[0]?.count ?? 0;
            if (!(await this.shouldRunMaintenance("purgeStalePendingWork", 10, 1, count)))
                return 0;
            // v0.7.95 append-only: was DELETE — now soft-archives stale pending_work
            // rows so historical queue activity stays auditable. Readers filter on
            // (active = true OR active IS NONE) so archived rows never claim CPU.
            const purged = await this.queryMulti(`LET $stale = (SELECT id FROM pending_work
           WHERE created_at < time::now() - 7d
             AND (active = true OR active IS NONE));
         FOR $p IN $stale {
           UPDATE $p.id SET
             active = false,
             archived_at = time::now(),
             archive_reason = "stale_7d_purge";
         };
         RETURN array::len($stale);`);
            const n = Number(purged ?? 0);
            await this.recordMaintenanceRun("purgeStalePendingWork", n, Date.now() - started);
            return n;
        }
        catch (e) {
            swallow.warn("surreal:purgeStalePendingWork", e);
            return 0;
        }
    }
    async archiveOldTurns() {
        const started = Date.now();
        try {
            const countRows = await this.queryFirst(`SELECT count() AS count FROM turn GROUP ALL`);
            const count = countRows[0]?.count ?? 0;
            // Floor lowered to 500 and scheduled weekly — new installs archive
            // after week 1 regardless of volume.
            if (!(await this.shouldRunMaintenance("archiveOldTurns", 500, 7, count)))
                return 0;
            const staleRows = await this.queryFirst(`SELECT id FROM turn WHERE timestamp < time::now() - 7d AND pruned_at IS NONE AND <string>id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn') LIMIT 500`);
            if (!staleRows.length)
                return 0;
            for (const row of staleRows) {
                try {
                    assertRecordId(String(row.id));
                    const rid = String(row.id);
                    // Direct interpolation safe: assertRecordId validated above
                    // v0.7.96 tag-don't-delete (core_memory:hoj8fvmbt7d14mskciba): was
                    // DELETE after the INSERT, leaving no trace of the row in the turn
                    // table. Now tags `pruned_at` + `prune_reason` so the row stays
                    // searchable in the off-chance some unique signal in it gets
                    // recalled later. Readers on the hot path filter `pruned_at IS NONE`.
                    await this.queryExec(`LET $data = (SELECT * FROM ONLY ${rid});
             IF $data != NONE {
               INSERT INTO turn_archive $data;
               UPDATE ${rid} SET pruned_at = time::now(), prune_reason = "archived_to_turn_archive";
             };`);
                }
                catch { /* row already archived or deleted by concurrent call */ }
            }
            const archived = staleRows.length;
            const n = Number(archived ?? 0);
            await this.recordMaintenanceRun("archiveOldTurns", n, Date.now() - started);
            return n;
        }
        catch (e) {
            swallow.warn("surreal:archiveOldTurns", e);
            return 0;
        }
    }
    async consolidateMemories(embedFn) {
        const started = Date.now();
        try {
            const countRows = await this.queryFirst(`SELECT count() AS count FROM memory GROUP ALL`);
            const count = countRows[0]?.count ?? 0;
            // Floor lowered to 10 and scheduled weekly — consolidation runs even
            // on small graphs to keep near-duplicates from compounding.
            if (!(await this.shouldRunMaintenance("consolidateMemories", 10, 7, count)))
                return 0;
            let merged = 0;
            const seen = new Set();
            // Pass 1: Vector similarity dedup
            const embMemories = await this.queryFirst(`SELECT id, text, importance, category, access_count, embedding, created_at
         FROM memory
         WHERE embedding != NONE AND array::len(embedding) > 0
         ORDER BY created_at ASC
         LIMIT 50`);
            for (const mem of embMemories) {
                if (seen.has(String(mem.id)))
                    continue;
                const dupes = await this.queryFirst(`SELECT id, importance, access_count,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM memory
           WHERE id != type::record($mid)
             AND category = $cat
             AND (status = 'active' OR status IS NONE)
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`, { vec: mem.embedding, mid: mem.id, cat: mem.category });
                for (const dupe of dupes) {
                    if (dupe.score < 0.88)
                        break;
                    if (seen.has(String(dupe.id)))
                        continue;
                    const keepMem = mem.importance > dupe.importance ||
                        (mem.importance === dupe.importance &&
                            (mem.access_count ?? 0) >= (dupe.access_count ?? 0));
                    const [keep, drop] = keepMem ? [mem.id, dupe.id] : [dupe.id, mem.id];
                    assertRecordId(String(keep));
                    assertRecordId(String(drop));
                    // v0.7.93 append-only: was UPDATE-keep + DELETE-drop (silent loss
                    // of the loser's text). Now both rows survive: keeper is enriched,
                    // loser is soft-archived with superseded_by pointing at keeper.
                    // Wrapped in a single transaction so a network blip can't leave
                    // half-done state (keeper updated but loser still active).
                    await this.queryExec(`BEGIN TRANSACTION;
             UPDATE ${String(keep)} SET
               access_count += 1,
               importance = math::max([importance, $imp]);
             UPDATE ${String(drop)} SET
               status = 'archived',
               archived_at = time::now(),
               archive_reason = 'dedup_consolidate_pass1',
               superseded_by = type::record($kid);
             COMMIT TRANSACTION;`, { imp: dupe.importance, kid: String(keep) });
                    seen.add(String(drop));
                    merged++;
                }
            }
            // Pass 2: Backfill embeddings for memories missing them
            const unembedded = await this.queryFirst(`SELECT id, text, importance, category, access_count
         FROM memory
         WHERE embedding IS NONE OR array::len(embedding) = 0
         LIMIT 20`);
            for (const mem of unembedded) {
                if (seen.has(String(mem.id)))
                    continue;
                try {
                    // 0.7.70: BGE-M3 has an 8192-token context window. Long memory texts
                    // (e.g. transcript-style entries that slipped through) throw
                    // "Input is longer than the context size" and we lose the whole
                    // backfill pass. Truncate at 6000 chars (safely below ~7800 tokens
                    // worst case for English) and tag the warn so it's distinguishable
                    // from embed errors.
                    const safeText = mem.text.length > 6000 ? mem.text.slice(0, 6000) : mem.text;
                    if (safeText.length < mem.text.length) {
                        swallow.warn("surreal:consolidate-backfill:truncated", new Error(`memory ${String(mem.id)} text len=${mem.text.length} truncated to 6000 chars before embed`));
                    }
                    const emb = await embedFn(safeText);
                    if (!emb)
                        continue;
                    await this.queryExec(`UPDATE ${String(mem.id)} SET embedding = $emb`, { emb });
                    const dupes = await this.queryFirst(`SELECT id, importance, access_count,
                    vector::similarity::cosine(embedding, $vec) AS score
             FROM memory
             WHERE id != type::record($mid)
               AND category = $cat
               AND (status = 'active' OR status IS NONE)
               AND embedding != NONE AND array::len(embedding) > 0
             ORDER BY score DESC
             LIMIT 3`, { vec: emb, mid: mem.id, cat: mem.category });
                    for (const dupe of dupes) {
                        if (dupe.score < 0.88)
                            break;
                        if (seen.has(String(dupe.id)))
                            continue;
                        const keepMem = mem.importance > dupe.importance ||
                            (mem.importance === dupe.importance &&
                                (mem.access_count ?? 0) >= (dupe.access_count ?? 0));
                        const [keep, drop] = keepMem ? [mem.id, dupe.id] : [dupe.id, mem.id];
                        assertRecordId(String(keep));
                        assertRecordId(String(drop));
                        // v0.7.93 append-only — same shape as Pass 1.
                        await this.queryExec(`BEGIN TRANSACTION;
               UPDATE ${String(keep)} SET
                 access_count += 1,
                 importance = math::max([importance, $imp]);
               UPDATE ${String(drop)} SET
                 status = 'archived',
                 archived_at = time::now(),
                 archive_reason = 'dedup_consolidate_pass2',
                 superseded_by = type::record($kid);
               COMMIT TRANSACTION;`, { imp: dupe.importance, kid: String(keep) });
                        seen.add(String(drop));
                        merged++;
                    }
                }
                catch (e) {
                    swallow.warn("surreal:consolidate-backfill", e);
                }
            }
            // Pass 3: Vector similarity dedup for reflections
            const embReflections = await this.queryFirst(`SELECT id, text, importance, category, embedding, created_at
         FROM reflection
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND (active = true OR active IS NONE)
         ORDER BY created_at ASC
         LIMIT 50`);
            for (const ref of embReflections) {
                if (seen.has(String(ref.id)))
                    continue;
                const dupes = await this.queryFirst(`SELECT id, importance,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM reflection
           WHERE id != type::record($rid)
             AND category = $cat
             AND (active = true OR active IS NONE)
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`, { vec: ref.embedding, rid: ref.id, cat: ref.category });
                for (const dupe of dupes) {
                    if (dupe.score < 0.88)
                        break;
                    if (seen.has(String(dupe.id)))
                        continue;
                    const keepRef = ref.importance > dupe.importance;
                    const [keep, drop] = keepRef ? [ref.id, dupe.id] : [dupe.id, ref.id];
                    assertRecordId(String(keep));
                    assertRecordId(String(drop));
                    // v0.7.93 append-only: was DELETE — now soft-archives the loser
                    // with superseded_by pointing at keeper. Also added category guard
                    // to SELECT so different-category reflections don't collide.
                    await this.queryExec(`UPDATE ${String(drop)} SET
              active = false,
              archived_at = time::now(),
              archive_reason = 'dedup_consolidate_pass3_reflection',
              superseded_by = type::record($kid);`, { kid: String(keep) });
                    seen.add(String(drop));
                    merged++;
                }
            }
            // Pass 4: Vector similarity dedup for skills (v0.8.x).
            // Skills dedup by EXACT NAME on the write path (supersedeOldSkills) but
            // had no semantic pass — so the same insight under different LLM-chosen
            // names (e.g. "diagnose-silent-failure" vs "diagnose-silent-process-
            // failure") accumulated as distinct active rows. That is the duplicate
            // class behind the causal_graduate skill explosion. This pass is the
            // skill-table sibling of Pass 1/Pass 3: it runs OFF the hot path on the
            // weekly cadence, so the v0.7.92 footgun (similarity-collapse on the
            // write path wrongly deactivated 730 rows) is never re-armed. Threshold
            // 0.80 — the maintenance backstop matching the one-time consolidation
            // (2026-05-31) that took the corpus 1342→492 active. Measured separation
            // is wide (distinct skills ≤0.66, redundant families ≥0.80), so 0.80
            // safely collapses re-accumulating redundancy without merging distinct
            // skills. (Was 0.92 — far too lenient; it missed the 0.70–0.91 families
            // that bloated the corpus.) The commitSkill creation-time dedup (0.85)
            // blocks most at the source; this weekly pass sweeps the 0.80–0.85 band.
            // Soft-archive shape mirrors supersedeOldSkills (active=false +
            // superseded_by), so recall's (active=true OR IS NONE) gate hides losers.
            const embSkills = await this.queryFirst(`SELECT id, name, success_count, embedding, created_at
         FROM skill
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND (active = true OR active IS NONE)
         ORDER BY created_at ASC
         LIMIT 50`);
            for (const sk of embSkills) {
                if (seen.has(String(sk.id)))
                    continue;
                // COSINE_GUARD_OK: read-only skill-dedup ranking — flat namespace (no category/name axis; Pass 4 exists to catch DIFFERENT-named near-dupes), so the >=0.92 threshold + per-row soft-archive keep-winner is the safety, mirroring Pass 1/Pass 3.
                const dupes = await this.queryFirst(`SELECT id, success_count,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM skill
           WHERE id != type::record($sid)
             AND (active = true OR active IS NONE)
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`, { vec: sk.embedding, sid: sk.id });
                for (const dupe of dupes) {
                    if (dupe.score < 0.80)
                        break;
                    if (seen.has(String(dupe.id)))
                        continue;
                    // Keep the more-proven skill (higher success_count); on a tie keep
                    // the outer (older, established) row. Mirrors Pass 1's keep-winner.
                    const keepSk = (sk.success_count ?? 0) >= (dupe.success_count ?? 0);
                    const [keep, drop] = keepSk ? [sk.id, dupe.id] : [dupe.id, sk.id];
                    assertRecordId(String(keep));
                    assertRecordId(String(drop));
                    await this.queryExec(`UPDATE ${String(drop)} SET
              active = false,
              archived_at = time::now(),
              archive_reason = 'dedup_consolidate_pass4_skill',
              superseded_by = type::record($kid);`, { kid: String(keep) });
                    seen.add(String(drop));
                    merged++;
                }
            }
            await this.recordMaintenanceRun("consolidateMemories", merged, Date.now() - started);
            return merged;
        }
        catch (e) {
            swallow.warn("surreal:consolidateMemories", e);
            return 0;
        }
    }
    // ── Retrieval session memory ───────────────────────────────────────────
    async getSessionRetrievedMemories(sessionId) {
        try {
            const rows = await this.queryFirst(`SELECT memory_id FROM retrieval_outcome WHERE session_id = $sid AND memory_table = 'memory' GROUP BY memory_id`, { sid: sessionId });
            if (rows.length === 0)
                return [];
            const ids = rows.map((r) => r.memory_id).filter(Boolean);
            if (ids.length === 0)
                return [];
            // Direct interpolation — SurrealDB treats string-array bindings as
            // literal strings, not record references, causing silent empty results.
            const validated = ids.filter(id => { try {
                assertRecordId(String(id));
                return true;
            }
            catch {
                return false;
            } });
            if (validated.length === 0)
                return [];
            const idList = validated.join(", ");
            return this.queryFirst(`SELECT id, text FROM memory WHERE id IN [${idList}] AND (status = 'active' OR status IS NONE)`);
        }
        catch (e) {
            swallow.warn("surreal:getSessionRetrievedMemories", e);
            return [];
        }
    }
    // ── Fibonacci resurfacing ──────────────────────────────────────────────
    async markSurfaceable(memoryId) {
        assertRecordId(memoryId);
        // Direct interpolation safe: assertRecordId validates format above.
        // SurrealDB rejects `UPDATE $id` with a string param.
        await this.queryExec(`UPDATE ${memoryId} SET surfaceable = true, fib_index = 0, surface_count = 0, next_surface_at = time::now() + 1d`);
    }
    async getDueMemories(limit = 5) {
        return ((await this.queryFirst(`SELECT id, text, importance, fib_index, surface_count, created_at
         FROM memory
         WHERE surfaceable = true
           AND next_surface_at <= time::now()
           AND (status = 'active' OR status IS NONE)
         ORDER BY importance DESC
         LIMIT $lim`, { lim: limit })) ?? []);
    }
    // ── Compaction checkpoints ─────────────────────────────────────────────
    async createCompactionCheckpoint(sessionId, rangeStart, rangeEnd) {
        const rows = await this.queryFirst(`CREATE compaction_checkpoint CONTENT $data RETURN id`, {
            data: {
                session_id: sessionId,
                msg_range_start: rangeStart,
                msg_range_end: rangeEnd,
                status: "pending",
            },
        });
        return String(rows[0]?.id ?? "");
    }
    async completeCompactionCheckpoint(checkpointId, memoryId) {
        assertRecordId(checkpointId);
        await this.queryExec(`UPDATE ${checkpointId} SET status = "complete", memory_id = $mid`, { mid: memoryId });
    }
    async getPendingCheckpoints(sessionId) {
        return this.queryFirst(`SELECT id, msg_range_start, msg_range_end FROM compaction_checkpoint WHERE session_id = $sid AND (status = "pending" OR status = "failed")`, { sid: sessionId });
    }
    // ── Availability check ────────────────────────────────────────────────
    isAvailable() {
        try {
            return this.db?.isConnected ?? false;
        }
        catch {
            return false;
        }
    }
    // ── Reflection session lookup ─────────────────────────────────────────
    _reflectionSessions = null;
    clearReflectionCache() {
        this._reflectionSessions = null;
    }
    async getReflectionSessionIds() {
        if (this._reflectionSessions)
            return this._reflectionSessions;
        try {
            const rows = await this.queryFirst(`SELECT session_id FROM reflection GROUP BY session_id`);
            this._reflectionSessions = new Set(rows.map(r => r.session_id).filter(Boolean));
        }
        catch (e) {
            swallow.warn("surreal:getReflectionSessionIds", e);
            this._reflectionSessions = new Set();
        }
        return this._reflectionSessions;
    }
    // ── Fibonacci resurfacing: advance ────────────────────────────────────
    static FIB_DAYS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    async advanceSurfaceFade(memoryId) {
        assertRecordId(memoryId);
        const current = await this.queryFirst(`SELECT fib_index FROM ${memoryId}`);
        const idx = current?.[0]?.fib_index ?? 0;
        const nextIdx = Math.min(idx + 1, SurrealStore.FIB_DAYS.length - 1);
        const days = nextIdx < SurrealStore.FIB_DAYS.length
            ? SurrealStore.FIB_DAYS[nextIdx]
            : SurrealStore.FIB_DAYS[SurrealStore.FIB_DAYS.length - 1];
        await this.queryExec(`UPDATE ${memoryId} SET fib_index = $nextIdx, surface_count += 1, last_surfaced = time::now(), next_surface_at = time::now() + type::duration($dur)`, { nextIdx, dur: `${days}d` });
    }
    async resolveSurfaceMemory(memoryId, outcome) {
        assertRecordId(memoryId);
        await this.queryExec(`UPDATE ${memoryId} SET surfaceable = false, last_engaged = time::now(), surface_outcome = $outcome`, { outcome });
    }
    // ── Dispose ───────────────────────────────────────────────────────────
    async dispose() {
        try {
            await this.close();
        }
        catch (e) {
            swallow("surreal:dispose", e);
        }
    }
}
export { assertRecordId, assertValidEdge, VALID_EDGES };
