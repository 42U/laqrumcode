import { Surreal } from "surrealdb";
import { swallow } from "./errors.js";
import { log } from "./log.js";
import { loadSchema } from "./schema-loader.js";
const RECORD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-]+$/;
function assertRecordId(id) {
    if (!RECORD_ID_RE.test(id)) {
        throw new Error(`Invalid record ID format: ${id.slice(0, 40)}`);
    }
}
/** Whitelist of valid SurrealDB edge table names — prevents SQL injection via edge interpolation. */
const VALID_EDGES = new Set([
    // Semantic edges
    "responds_to", "tool_result_of", "summarizes", "mentions", "related_to",
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
function patchOrderByFields(sql) {
    const s = sql.trim();
    if (!/^\s*SELECT\b/i.test(s) || !/\bORDER\s+BY\b/i.test(s))
        return sql;
    if (/^\s*SELECT\s+\*/i.test(s))
        return sql;
    const selectMatch = s.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i);
    if (!selectMatch)
        return sql;
    const selectClause = selectMatch[1];
    const orderMatch = s.match(/\bORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\b|\s+GROUP\b|\s+HAVING\b|$)/i);
    if (!orderMatch)
        return sql;
    const orderFields = orderMatch[1]
        .split(",")
        .map((f) => f.trim().replace(/\s+(ASC|DESC)\s*$/i, "").trim())
        .filter(Boolean);
    const selectedFields = selectClause
        .split(",")
        .map((f) => f.trim().split(/\s+AS\s+/i)[0].trim())
        .map((f) => f.split(".").pop())
        .filter(Boolean)
        .map((f) => f.toLowerCase());
    const missing = orderFields.filter((f) => !selectedFields.includes(f.split(".").pop().toLowerCase()));
    if (missing.length === 0)
        return sql;
    return sql.replace(/(\bSELECT\s+)([\s\S]+?)(\s+FROM\b)/i, (_, pre, fields, post) => `${pre}${fields}, ${missing.join(", ")}${post}`);
}
/**
 * SurrealDB store — wraps all database operations for the KongBrain plugin.
 * Replaces the module-level singleton pattern from standalone KongBrain.
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
        if (this.db.isConnected)
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
                    await Promise.race([
                        this.db.connect(this.config.url, {
                            namespace: this.config.ns,
                            database: this.config.db,
                            authentication: { username: this.config.user, password: this.config.pass },
                        }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error(`SurrealDB connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)),
                    ]);
                    log.warn("SurrealDB reconnected successfully.");
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
        await this.db.query(schema);
    }
    getConnection() {
        return this.db;
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
            await this.db.query("RETURN 'ok'");
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
    /** Returns true if an error is a connection-level failure worth retrying. */
    isConnectionError(e) {
        const msg = String(e?.message ?? e);
        return msg.includes("must be connected") || msg.includes("ConnectionUnavailable");
    }
    /** Run a query function with one retry on connection errors.
     *  Reconnection is routed through ensureConnected() so concurrent
     *  callers share a single reconnection attempt instead of racing. */
    async withRetry(fn) {
        try {
            return await fn();
        }
        catch (e) {
            if (!this.isConnectionError(e))
                throw e;
            this.initialized = false;
            await this.ensureConnected();
            return await fn();
        }
    }
    // ── Query helpers ──────────────────────────────────────────────────────
    async queryFirst(sql, bindings) {
        await this.ensureConnected();
        return this.withRetry(async () => {
            const ns = this.config.ns;
            const dbName = this.config.db;
            const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
            const result = await this.db.query(fullSql, bindings);
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
            const raw = await this.db.query(fullSql, bindings);
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
            await this.db.query(fullSql, bindings);
        });
    }
    /**
     * Execute N SQL statements in a single SurrealDB round-trip.
     * Returns one result array per statement; bindings are shared across all statements.
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
            const raw = await this.db.query(fullSql, bindings);
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
        const stmts = [
            `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM turn WHERE embedding != NONE AND array::len(embedding) > 0
         AND session_id = $sid ORDER BY score DESC LIMIT ${sessionTurnLim}`,
            `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM turn WHERE embedding != NONE AND array::len(embedding) > 0
         AND session_id != $sid ORDER BY score DESC LIMIT ${crossTurnLim}`,
            // Archived turns: surfaced at a smaller budget so old content stays
            // reachable after archiveOldTurns drains the live turn table. Without
            // this, mass archival would silently make historical conversation
            // content un-recallable via turn-scope queries.
            `SELECT id, text, role, timestamp, 0 AS accessCount, 'turn' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM turn_archive WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${archiveTurnLim}`,
            `SELECT id, content AS text, stability AS importance, access_count AS accessCount,
              created_at AS timestamp, 'concept' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM concept WHERE embedding != NONE AND array::len(embedding) > 0${projectFilter}
       ORDER BY score DESC LIMIT ${lim.concept}`,
            `SELECT id, text, importance, access_count AS accessCount,
              created_at AS timestamp, session_id AS sessionId, category, 'memory' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM memory WHERE embedding != NONE AND array::len(embedding) > 0
         AND (status = 'active' OR status IS NONE)${projectFilter} ORDER BY score DESC LIMIT ${lim.memory}`,
            `SELECT id, description AS text, 0 AS accessCount,
              created_at AS timestamp, 'artifact' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM artifact WHERE embedding != NONE AND array::len(embedding) > 0${projectFilter}
       ORDER BY score DESC LIMIT ${lim.artifact}`,
            `SELECT id, content AS text, category AS source, 0.5 AS importance, 0 AS accessCount,
              timestamp, 'monologue' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM monologue WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${lim.monologue}`,
            `SELECT id, text, importance, 0 AS accessCount,
              'identity_chunk' AS table,
              vector::similarity::cosine(embedding, $vec) AS score${emb}
       FROM identity_chunk WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT ${lim.identity}`,
        ];
        let batchResults;
        try {
            const bindings = { vec, sid: sessionId };
            if (projectId)
                bindings.pid = projectId;
            batchResults = await this.queryBatch(stmts, bindings);
        }
        catch (e) {
            swallow.warn("surreal:vectorSearch:batch", e);
            return [];
        }
        const [sessionTurns = [], crossTurns = [], archiveTurns = [], concepts = [], memories = [], artifacts = [], monologues = [], identityChunks = [],] = batchResults;
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
        return this.queryFirst(`SELECT role, text, timestamp FROM turn WHERE session_id = $sid ORDER BY timestamp ASC LIMIT $lim`, { sid: sessionId, lim: limit });
    }
    async getSessionTurnsRich(sessionId, limit = 20) {
        return this.queryFirst(`SELECT role, text, tool_name, timestamp FROM turn WHERE session_id = $sid ORDER BY timestamp ASC LIMIT $lim`, { sid: sessionId, lim: limit });
    }
    // ── Relation helpers ───────────────────────────────────────────────────
    async relate(fromId, edge, toId) {
        assertRecordId(fromId);
        assertRecordId(toId);
        const safeName = edge.replace(/[^a-zA-Z0-9_]/g, "");
        assertValidEdge(safeName);
        await this.queryExec(`RELATE ${fromId}->${safeName}->${toId}`);
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
        const rows = await this.queryFirst(`CREATE task CONTENT { description: $desc, status: "in_progress", project_id: $pid } RETURN id`, { desc: description, pid: projectId ?? null });
        return String(rows[0]?.id ?? "");
    }
    async createSession(agentId = "default", kcSessionId, projectId) {
        const rows = await this.queryFirst(`CREATE session CONTENT { agent_id: $agent_id, kc_session_id: $kc_session_id, project_id: $pid } RETURN id`, { agent_id: agentId, kc_session_id: kcSessionId ?? null, pid: projectId ?? null });
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
    /** @deprecated since 0.7.12 — split into bumpSessionTurn + addSessionTokens.
     *  Kept as a backward-compat shim for any external caller; new code should
     *  call the split methods directly. Will be removed in 0.8.x. */
    async updateSessionStats(sessionId, inputTokens, outputTokens) {
        await this.bumpSessionTurn(sessionId);
        await this.addSessionTokens(sessionId, inputTokens, outputTokens);
    }
    async endSession(sessionId, summary) {
        assertRecordId(sessionId);
        if (summary) {
            await this.queryExec(`UPDATE ${sessionId} SET ended_at = time::now(), summary = $summary`, { summary });
        }
        else {
            await this.queryExec(`UPDATE ${sessionId} SET ended_at = time::now()`);
        }
    }
    async markSessionActive(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET cleanup_completed = false, last_active = time::now()`);
    }
    async markSessionEnded(sessionId) {
        assertRecordId(sessionId);
        await this.queryExec(`UPDATE ${sessionId} SET ended_at = time::now(), cleanup_completed = true`);
    }
    async getOrphanedSessions(limit = 20) {
        return this.queryFirst(`SELECT id, started_at, kc_session_id FROM session
       WHERE cleanup_completed != true
         AND started_at < time::now() - 2m
       ORDER BY started_at DESC LIMIT $lim`, { lim: limit });
    }
    /** One-shot: for sessions created before 0.5.5 that lack kc_session_id,
     * walk their `part_of` turn edges and copy the kc id from any turn row.
     * Idempotent — only updates rows where kc_session_id is currently NONE.
     * Bounded per call so a backlog of hundreds chips down across SessionStarts. */
    async backfillOrphanKcSessionIds(limit = 50) {
        const missing = await this.queryFirst(`SELECT id FROM session
       WHERE kc_session_id = NONE
         AND cleanup_completed != true
       LIMIT $lim`, { lim: limit });
        if (missing.length === 0)
            return 0;
        let backfilled = 0;
        for (const s of missing) {
            try {
                assertRecordId(s.id);
                const turn = await this.queryFirst(`SELECT session_id FROM turn
           WHERE id IN (SELECT VALUE in FROM part_of WHERE out = $sid)
             AND session_id != NONE AND session_id != ""
           LIMIT 1`, { sid: s.id });
                const kcSid = turn[0]?.session_id;
                if (typeof kcSid === "string" && kcSid.length > 0) {
                    await this.queryExec(`UPDATE ${s.id} SET kc_session_id = $kc`, { kc: kcSid });
                    backfilled++;
                }
            }
            catch (e) {
                // Best-effort per row; swallow continues
            }
        }
        return backfilled;
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
            const rows = await this.queryFirst(`SELECT id, content AS text, stability AS importance, access_count AS accessCount,
                created_at AS timestamp, 'concept' AS table,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
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
        const forwardEdgeList = "responds_to, tool_result_of, summarizes, mentions, related_to, narrower, broader, about_concept, reflects_on, skill_from_task, skill_uses_concept, owns, performed, task_part_of, session_task, produced, derived_from, relevant_to, used_in, artifact_mentions";
        const reverseEdgeList = "reflects_on, skill_from_task, produced, derived_from, performed, owns";
        const FORWARD_LIMIT = 25;
        const REVERSE_LIMIT = 10;
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
            for (const rows of queryResults) {
                for (const row of rows) {
                    if (row.id == null)
                        continue;
                    const nodeId = String(row.id);
                    if (seen.has(nodeId))
                        continue;
                    seen.add(nodeId);
                    const text = row.text ?? row.content ?? row.description ?? null;
                    if (text) {
                        const score = row.score ?? 0;
                        allNeighbors.push({
                            text,
                            importance: row.importance ?? row.stability,
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
    async bumpAccessCounts(ids) {
        const validated = ids.filter(id => { try {
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
            const stmts = validated.map(id => `UPDATE ${id} SET access_count += 1, last_accessed = time::now()`);
            await this.queryBatch(stmts);
        }
        catch (e) {
            swallow.warn("surreal:bumpAccessCounts", e);
        }
    }
    // ── Concept / Memory / Artifact CRUD ───────────────────────────────────
    async upsertConcept(content, embedding, source, provenance, projectId) {
        if (!content?.trim())
            return "";
        content = content.trim();
        const rows = await this.queryFirst(`SELECT id FROM concept WHERE string::lowercase(content) = string::lowercase($content) LIMIT 1`, { content });
        if (rows.length > 0) {
            const id = String(rows[0].id);
            assertRecordId(id);
            if (embedding?.length) {
                await this.queryExec(`UPDATE ${id} SET access_count += 1, last_accessed = time::now(), embedding = IF embedding IS NONE OR array::len(embedding) = 0 THEN $emb ELSE embedding END${projectId ? ", project_id = IF project_id IS NONE THEN $pid ELSE project_id END" : ""}`, projectId ? { emb: embedding, pid: projectId } : { emb: embedding });
            }
            else if (projectId) {
                await this.queryExec(`UPDATE ${id} SET access_count += 1, last_accessed = time::now(), project_id = IF project_id IS NONE THEN $pid ELSE project_id END`, { pid: projectId });
            }
            else {
                await this.queryExec(`UPDATE ${id} SET access_count += 1, last_accessed = time::now()`);
            }
            return id;
        }
        const emb = embedding?.length ? embedding : undefined;
        const record = { content, source: source ?? undefined };
        if (emb)
            record.embedding = emb;
        if (provenance)
            record.provenance = provenance;
        if (projectId)
            record.project_id = projectId;
        const created = await this.queryFirst(`CREATE concept CONTENT $record RETURN id`, { record });
        return String(created[0]?.id ?? "");
    }
    async createArtifact(path, type, description, embedding, projectId) {
        const record = { path, type, description };
        if (embedding?.length)
            record.embedding = embedding;
        if (projectId)
            record.project_id = projectId;
        const rows = await this.queryFirst(`CREATE artifact CONTENT $record RETURN id`, { record });
        return String(rows[0]?.id ?? "");
    }
    async createMemory(text, embedding, importance, category, sessionId, projectId) {
        const source = category ?? "general";
        if (embedding?.length) {
            const dupes = await this.queryFirst(`SELECT id, importance,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM memory
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND category = $cat
         ORDER BY score DESC
         LIMIT 1`, { vec: embedding, cat: source });
            if (dupes.length > 0 && dupes[0].score > 0.92) {
                const existing = dupes[0];
                const existingId = String(existing.id);
                assertRecordId(existingId);
                const newImp = Math.max(existing.importance ?? 0, importance);
                await this.queryExec(`UPDATE ${existingId} SET access_count += 1, importance = $imp, last_accessed = time::now()`, { imp: newImp });
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
    async deactivateSessionMemories(sessionId) {
        try {
            await this.queryExec(`UPDATE core_memory SET active = false, updated_at = time::now() WHERE session_id = $sid AND tier = 1`, { sid: sessionId });
        }
        catch (e) {
            swallow.warn("surreal:deactivateSessionMemories", e);
        }
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
            return await this.queryFirst(`SELECT text, chunk_index FROM identity_chunk ORDER BY chunk_index ASC`);
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
                prevSessionQuery = `SELECT id, started_at FROM session WHERE id != $current ORDER BY started_at DESC LIMIT 1`;
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
         WHERE id IN (SELECT VALUE in FROM part_of WHERE out = $sid)
           AND text != NONE AND text != ""
         ORDER BY timestamp DESC LIMIT $lim`, { sid: prevSessionId, lim: limit });
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
         WHERE (status IS NONE OR status != 'resolved')
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
            await this.queryExec(`UPSERT memory_utility_cache SET
          memory_id = $mid,
          retrieval_count = (retrieval_count ?? 0) + 1,
          avg_utilization = IF (retrieval_count ?? 0) > 0
            THEN (avg_utilization * (retrieval_count ?? 0) + $util) / ((retrieval_count ?? 0) + 1)
            ELSE $util
          END,
          last_updated = time::now()
         WHERE memory_id = $mid`, { mid: memoryId, util: utilization });
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
            const rows = await this.queryFirst(`SELECT memory_id, avg_utilization FROM memory_utility_cache WHERE memory_id IN $ids`, { ids });
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
            const rows = await this.queryFirst(`SELECT memory_id, avg_utilization, retrieval_count FROM memory_utility_cache WHERE memory_id IN $ids`, { ids });
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
            const lastRanAt = Date.parse(rows[0].ran_at);
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
            await this.queryExec(`
        UPDATE memory SET importance = math::max([importance * 0.95, 5.0])
          WHERE importance > 5.0 AND category IN ["correction", "decision", "preference", "fact"];
        UPDATE memory SET importance = math::max([importance * 0.95, 2.0])
          WHERE importance > 2.0 AND category NOT IN ["correction", "decision", "preference", "fact"];
        UPDATE memory SET importance = math::max([importance, 3 + ((
          SELECT VALUE avg_utilization FROM memory_utility_cache WHERE memory_id = string::concat(meta::tb(id), ":", meta::id(id)) LIMIT 1
        )[0] ?? 0) * 4]) WHERE importance < 7;
      `);
            await this.recordMaintenanceRun("runMemoryMaintenance", 0, Date.now() - started);
        }
        catch (e) {
            // Transaction conflicts expected when daemon writes concurrently — silent
            swallow("surreal:runMemoryMaintenance", e);
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
            const pruned = await this.db.query(`LET $stale = (
          SELECT id FROM memory
          WHERE created_at < time::now() - 14d
            AND importance <= 2.0
            AND (access_count = 0 OR access_count IS NONE)
            AND string::concat("memory:", id) NOT IN (
              SELECT VALUE memory_id FROM (
                SELECT memory_id FROM retrieval_outcome
                WHERE utilization > 0.2
                GROUP BY memory_id
              )
            )
          LIMIT 50
        );
        FOR $m IN $stale { DELETE $m.id; };
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
            const pruned = await this.db.query(`LET $stale = (
          SELECT id FROM concept
          WHERE created_at < time::now() - 1d
            AND string::len(content) <= 12
            AND content = string::uppercase(content)
            AND array::len(<-about_concept<-memory) = 0
            AND array::len(<-mentions<-turn) <= 2
            AND array::len(->narrower->?) = 0
            AND array::len(->broader->?) = 0
          LIMIT 100
        );
        FOR $c IN $stale { DELETE $c.id; };
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
            const purged = await this.queryMulti(`LET $stale = (SELECT id FROM pending_work WHERE created_at < time::now() - 7d);
         FOR $p IN $stale { DELETE $p.id; };
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
            const staleRows = await this.queryFirst(`SELECT id FROM turn WHERE timestamp < time::now() - 7d AND id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn') LIMIT 500`);
            if (!staleRows.length)
                return 0;
            for (const row of staleRows) {
                try {
                    assertRecordId(String(row.id));
                    const rid = String(row.id);
                    // Direct interpolation safe: assertRecordId validated above
                    await this.queryExec(`LET $data = (SELECT * FROM ONLY ${rid});
             IF $data != NONE { INSERT INTO turn_archive $data; DELETE ${rid}; };`);
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
           WHERE id != $mid
             AND category = $cat
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
                    await this.queryExec(`UPDATE ${String(keep)} SET access_count += 1, importance = math::max([importance, $imp])`, { imp: dupe.importance });
                    await this.queryExec(`DELETE ${String(drop)}`);
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
                    const emb = await embedFn(mem.text);
                    if (!emb)
                        continue;
                    await this.queryExec(`UPDATE ${String(mem.id)} SET embedding = $emb`, { emb });
                    const dupes = await this.queryFirst(`SELECT id, importance, access_count,
                    vector::similarity::cosine(embedding, $vec) AS score
             FROM memory
             WHERE id != $mid
               AND category = $cat
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
                        await this.queryExec(`UPDATE ${String(keep)} SET access_count += 1, importance = math::max([importance, $imp])`, { imp: dupe.importance });
                        await this.queryExec(`DELETE ${String(drop)}`);
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
         ORDER BY created_at ASC
         LIMIT 50`);
            for (const ref of embReflections) {
                if (seen.has(String(ref.id)))
                    continue;
                const dupes = await this.queryFirst(`SELECT id, importance,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM reflection
           WHERE id != $rid
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`, { vec: ref.embedding, rid: ref.id });
                for (const dupe of dupes) {
                    if (dupe.score < 0.88)
                        break;
                    if (seen.has(String(dupe.id)))
                        continue;
                    const keepRef = ref.importance > dupe.importance;
                    const [keep, drop] = keepRef ? [ref.id, dupe.id] : [dupe.id, ref.id];
                    assertRecordId(String(keep));
                    assertRecordId(String(drop));
                    await this.queryExec(`DELETE ${String(drop)}`);
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
           AND status = 'active'
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
