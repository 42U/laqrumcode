import { Surreal, RecordId } from "surrealdb";
import { randomUUID } from "node:crypto";
import type { SurrealConfig } from "./config.js";
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
function isTransactionConflict(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as { kind?: unknown; name?: unknown; message?: unknown };
  if (typeof o.kind === "string" && /tx|conflict|retry|busy/i.test(o.kind)) return true;
  if (typeof o.name === "string" && /tx|conflict|retry|busy|rpcerror/i.test(o.name)) return true;
  if (typeof o.message !== "string") return false;
  return /tx|transaction|conflict|lock|versionstamp|rpcerror|busy|retryable/i.test(o.message);
}

/** Record with a vector similarity score from SurrealDB search */
export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
  role?: string;
  timestamp?: string;
  importance?: number;
  accessCount?: number;
  source?: string;
  sessionId?: string;
  table: string;
  embedding?: number[];
  category?: string;
}

export interface TurnRecord {
  session_id: string;
  role: string;
  text: string;
  embedding: number[] | null;
  token_count?: number;
  tool_name?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface CoreMemoryEntry {
  id: string;
  text: string;
  category: string;
  priority: number;
  tier: number;
  active: boolean;
  session_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface UtilityCacheEntry {
  avg_utilization: number;
  retrieval_count: number;
}

/** Phase 3: provenance attached to every concept write so drift audit,
 * supersede-stale, and "where did this come from" debugging are possible. */
export interface ConceptProvenance {
  session_id?: string;
  turn_id?: string;
  skill_name?: string;
  prompt_hash?: string;
  source_kind?: "daemon" | "skill" | "user" | "gem" | "synthesis";
}


function assertRecordId(id: string): void {
  if (!RECORD_ID_RE.test(id)) {
    throw new Error(`Invalid record ID format: ${id.slice(0, 40)}`);
  }
}

/** Parse a `"table:key"` string into a SurrealDB RecordId for binding into
 *  parameters of typed `record<...>` fields. Throws if the input is not a
 *  well-formed record id. */
function toRecordId(id: string): RecordId {
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

function assertValidEdge(edge: string): void {
  if (!VALID_EDGES.has(edge)) throw new Error(`Invalid edge name: ${edge}`);
}

function patchOrderByFields(sql: string): string {
  const s = sql.trim();
  if (!/^\s*SELECT\b/i.test(s) || !/\bORDER\s+BY\b/i.test(s)) return sql;
  if (/^\s*SELECT\s+\*/i.test(s)) return sql;

  const selectMatch = s.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\b/i);
  if (!selectMatch) return sql;
  const selectClause = selectMatch[1];

  const orderMatch = s.match(
    /\bORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\b|\s+GROUP\b|\s+HAVING\b|$)/i,
  );
  if (!orderMatch) return sql;

  const orderFields = orderMatch[1]
    .split(",")
    .map((f) => f.trim().replace(/\s+(ASC|DESC)\s*$/i, "").trim())
    .filter(Boolean);

  const selectedFields = selectClause
    .split(",")
    .map((f) => f.trim().split(/\s+AS\s+/i)[0].trim())
    .map((f) => f.split(".").pop()!)
    .filter(Boolean)
    .map((f) => f.toLowerCase());

  const missing = orderFields.filter(
    (f) => !selectedFields.includes(f.split(".").pop()!.toLowerCase()),
  );

  if (missing.length === 0) return sql;

  return sql.replace(
    /(\bSELECT\s+)([\s\S]+?)(\s+FROM\b)/i,
    (_, pre, fields, post) => `${pre}${fields}, ${missing.join(", ")}${post}`,
  );
}

/**
 * SurrealDB store — wraps all database operations for the KongCode plugin.
 * Replaces the module-level singleton pattern from standalone KongCode.
 */
export class SurrealStore {
  private db: Surreal;
  private config: SurrealConfig;
  private reconnecting: Promise<void> | null = null;
  private shutdownFlag = false;
  private initialized = false;

  constructor(config: SurrealConfig) {
    this.config = config;
    this.db = new Surreal();
  }

  /** Connect and run schema. Returns true if a new connection was made, false if already initialized. */
  async initialize(): Promise<boolean> {
    // Only connect once — subsequent calls are no-ops.
    // This prevents register()/factory re-invocations from disrupting
    // in-flight operations (deferred cleanup, daemon extraction).
    // Don't check isConnected — ensureConnected() handles reconnection.
    if (this.initialized) return false;
    await this.db.connect(this.config.url, {
      namespace: this.config.ns,
      database: this.config.db,
      authentication: { username: this.config.user, password: this.config.pass },
    });
    await this.runSchema();
    this.initialized = true;
    return true;
  }

  markShutdown(): void {
    this.shutdownFlag = true;
  }

  private async ensureConnected(): Promise<void> {
    if (this.shutdownFlag) return;
    if (this.db.isConnected) return;
    if (this.reconnecting) return this.reconnecting;

    this.reconnecting = (async () => {
      const MAX_ATTEMPTS = 3;
      const BACKOFF_MS = [500, 1500, 4000];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          log.warn(
            `SurrealDB disconnected — reconnecting (attempt ${attempt}/${MAX_ATTEMPTS})...`,
          );
          try { await this.db?.close(); } catch { /* drain stale socket */ }
          this.db = new Surreal();
          const CONNECT_TIMEOUT_MS = 5_000;
          let connectTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.db.connect(this.config.url, {
                namespace: this.config.ns,
                database: this.config.db,
                authentication: { username: this.config.user, password: this.config.pass },
              }),
              new Promise<never>((_, reject) => {
                connectTimer = setTimeout(
                  () => reject(new Error(`SurrealDB connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
                  CONNECT_TIMEOUT_MS,
                );
              }),
            ]);
          } finally {
            // Clear on every exit path. The prior code leaked a pending
            // Timeout when connect() resolved fast; the daemon process would
            // be kept alive for CONNECT_TIMEOUT_MS after each connect attempt.
            if (connectTimer !== undefined) clearTimeout(connectTimer);
          }
          log.warn("SurrealDB reconnected successfully.");
          return;
        } catch (e) {
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          } else {
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

  private async runSchema(): Promise<void> {
    const schema = loadSchema();
    await this.db.query(schema);
  }

  isConnected(): boolean {
    return this.db?.isConnected ?? false;
  }

  getInfo(): { url: string; ns: string; db: string; connected: boolean } {
    return {
      url: this.config.url,
      ns: this.config.ns,
      db: this.config.db,
      connected: this.db?.isConnected ?? false,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      await this.db.query("RETURN 'ok'");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.markShutdown();
      await this.db?.close();
    } catch (e) {
      swallow("surreal:close", e);
    }
  }

  /** Returns true if an error is a connection-level failure worth retrying. */
  private isConnectionError(e: unknown): boolean {
    const msg = String((e as { message?: string })?.message ?? e);
    return msg.includes("must be connected") || msg.includes("ConnectionUnavailable");
  }

  /** Run a query function with one retry on connection errors.
   *  Reconnection is routed through ensureConnected() so concurrent
   *  callers share a single reconnection attempt instead of racing. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!this.isConnectionError(e)) throw e;
      this.initialized = false;
      await this.ensureConnected();
      return await fn();
    }
  }

  // ── Query helpers ──────────────────────────────────────────────────────

  async queryFirst<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
      const result = await this.db.query<[T[]]>(fullSql, bindings);
      const rows = Array.isArray(result) ? result[result.length - 1] : result;
      return (Array.isArray(rows) ? rows : []).filter(Boolean);
    });
  }

  async queryMulti<T = unknown>(
    sql: string,
    bindings?: Record<string, unknown>,
  ): Promise<T | undefined> {
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const fullSql = `USE NS ${ns} DB ${dbName}; ${patchOrderByFields(sql)}`;
      const raw = await this.db.query(fullSql, bindings);
      const flat = (raw as unknown[]).flat();
      return flat[flat.length - 1] as T | undefined;
    });
  }

  async queryExec(sql: string, bindings?: Record<string, unknown>): Promise<void> {
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
  async queryBatch<T = any>(statements: string[], bindings?: Record<string, unknown>): Promise<T[][]> {
    if (statements.length === 0) return [];
    await this.ensureConnected();
    return this.withRetry(async () => {
      const ns = this.config.ns;
      const dbName = this.config.db;
      const joined = statements.map(s => patchOrderByFields(s)).join(";\n");
      const fullSql = `USE NS ${ns} DB ${dbName};\n${joined}`;
      const raw = await this.db.query(fullSql, bindings) as unknown[];
      // First result is the USE statement (empty), skip it
      return raw.slice(1).map(r => (Array.isArray(r) ? r : []).filter(Boolean)) as T[][];
    });
  }

  private async safeQuery(
    sql: string,
    bindings: Record<string, unknown>,
  ): Promise<VectorSearchResult[]> {
    try {
      return await this.queryFirst<VectorSearchResult>(sql, bindings);
    } catch (e) {
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
  async vectorSearch(
    vec: number[],
    sessionId: string,
    limits: {
      turn?: number;
      identity?: number;
      concept?: number;
      memory?: number;
      artifact?: number;
      monologue?: number;
    } = {},
    withEmbeddings = false,
    projectId?: string,
  ): Promise<VectorSearchResult[]> {
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
       FROM concept WHERE embedding != NONE AND array::len(embedding) > 0
         AND superseded_at IS NONE${projectFilter}
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
         AND (active = true OR active IS NONE)
       ORDER BY score DESC LIMIT ${lim.identity}`,
    ];

    let batchResults: unknown[][];
    try {
      const bindings: Record<string, unknown> = { vec, sid: sessionId };
      if (projectId) bindings.pid = projectId;
      batchResults = await this.queryBatch<unknown>(stmts, bindings);
    } catch (e) {
      swallow.warn("surreal:vectorSearch:batch", e);
      return [];
    }
    // Destructure with explicit per-bucket type assertion. The batch shape is
    // a positional tuple of VectorSearchResult arrays (one per statement); the
    // SurrealDB response is `unknown[][]` and each bucket carries the same
    // row shape from the SELECT — assert per bucket rather than blanket-cast
    // the outer array so a future statement-order change can't silently mis-type.
    const sessionTurns = (batchResults[0] ?? []) as VectorSearchResult[];
    const crossTurns = (batchResults[1] ?? []) as VectorSearchResult[];
    const archiveTurns = (batchResults[2] ?? []) as VectorSearchResult[];
    const concepts = (batchResults[3] ?? []) as VectorSearchResult[];
    const memories = (batchResults[4] ?? []) as VectorSearchResult[];
    const artifacts = (batchResults[5] ?? []) as VectorSearchResult[];
    const monologues = (batchResults[6] ?? []) as VectorSearchResult[];
    const identityChunks = (batchResults[7] ?? []) as VectorSearchResult[];
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

  async upsertTurn(turn: TurnRecord): Promise<string> {
    const { embedding, ...rest } = turn;
    const record = embedding?.length ? { ...rest, embedding } : rest;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE turn CONTENT $turn RETURN id`,
      { turn: record },
    );
    return String(rows[0]?.id ?? "");
  }

  async getSessionTurns(
    sessionId: string,
    limit = 50,
  ): Promise<{ role: string; text: string }[]> {
    return this.queryFirst<{ role: string; text: string }>(
      `SELECT role, text, timestamp FROM turn WHERE session_id = $sid ORDER BY timestamp ASC LIMIT $lim`,
      { sid: sessionId, lim: limit },
    );
  }

  async getSessionTurnsRich(
    sessionId: string,
    limit = 20,
  ): Promise<{ turnId: string; role: string; text: string; tool_name?: string; tool_result?: string; file_paths?: string[] }[]> {
    // `id` MUST be in the projection. Downstream callers (writeExtractionResults
    // → linkToRelevantConcepts) gate on `turnId` truthiness to write
    // mentions(turn→concept) edges. Drop it and the filter rejects every row
    // → daemon extraction silently never writes turn-mentions, even though
    // both transcript text and turn rows exist. We map the SurrealDB `id`
    // field to `turnId` here so the rest of the codebase sees the existing
    // TurnData.turnId shape unchanged. R5 regression fix: R4 added the
    // tool_name/tool_result/file_paths columns to this SELECT but dropped
    // `id` from the projection silently.
    const rows = await this.queryFirst<{ id: string; role: string; text: string; tool_name?: string; tool_result?: string; file_paths?: string[] }>(
      `SELECT id, role, text, tool_name, tool_result, file_paths, timestamp FROM turn WHERE session_id = $sid ORDER BY timestamp ASC LIMIT $lim`,
      { sid: sessionId, lim: limit },
    );
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

  async relate(fromId: string, edge: string, toId: string): Promise<void> {
    assertRecordId(fromId);
    assertRecordId(toId);
    const safeName = edge.replace(/[^a-zA-Z0-9_]/g, "");
    assertValidEdge(safeName);
    await this.queryExec(`RELATE ${fromId}->${safeName}->${toId}`);
  }

  // ── 5-Pillar entity operations ─────────────────────────────────────────

  async ensureAgent(name: string, model?: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `SELECT id FROM agent WHERE name = $name LIMIT 1`,
      { name },
    );
    if (rows.length > 0) return String(rows[0].id);
    const created = await this.queryFirst<{ id: string }>(
      `CREATE agent CONTENT { name: $name, model: $model } RETURN id`,
      { name, ...(model != null ? { model } : {}) },
    );
    return String(created[0]?.id ?? "");
  }

  async ensureProject(name: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `SELECT id FROM project WHERE name = $name LIMIT 1`,
      { name },
    );
    if (rows.length > 0) return String(rows[0].id);
    const created = await this.queryFirst<{ id: string }>(
      `CREATE project CONTENT { name: $name } RETURN id`,
      { name },
    );
    return String(created[0]?.id ?? "");
  }

  async createTask(description: string, projectId?: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE task CONTENT { description: $desc, status: "in_progress", project_id: $pid } RETURN id`,
      { desc: description, pid: projectId ?? null },
    );
    return String(rows[0]?.id ?? "");
  }

  async createSession(agentId = "default", kcSessionId?: string, projectId?: string): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE session CONTENT { agent_id: $agent_id, kc_session_id: $kc_session_id, project_id: $pid } RETURN id`,
      { agent_id: agentId, kc_session_id: kcSessionId ?? null, pid: projectId ?? null },
    );
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
  async ensureSessionRow(kcSessionId: string, agentId = "default", projectId?: string): Promise<string> {
    if (!kcSessionId) return this.createSession(agentId, undefined, projectId);
    const existing = await this.queryFirst<{ id: string }>(
      `SELECT id FROM session WHERE kc_session_id = $kc LIMIT 1`,
      { kc: kcSessionId },
    );
    if (existing[0]?.id) {
      const id = String(existing[0].id);
      assertRecordId(id);
      if (projectId) {
        await this.queryExec(
          `UPDATE ${id} SET project_id = IF project_id IS NONE THEN $pid ELSE project_id END`,
          { pid: projectId },
        ).catch(() => { /* non-critical */ });
      }
      return id;
    }
    return this.createSession(agentId, kcSessionId, projectId);
  }

  /** Increment turn_count by 1 and bump last_active. Called from
   *  UserPromptSubmit (0.7.12+) — the reliable hook that fires at turn
   *  start. Earlier versions did this from Stop, which is dropped/timed-out
   *  often enough to leave session.turn_count chronically undercounted. */
  async bumpSessionTurn(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET turn_count += 1, last_active = time::now()`,
    );
  }

  /** Add the per-turn input/output token deltas to the session row's
   *  cumulative totals. Called from Stop (when the assistant response
   *  has been transcribed and token usage is known) and PreCompact (to
   *  flush any tokens accrued mid-compaction). No-op when both deltas
   *  are zero, which is the common-no-tokens-accrued path. */
  async addSessionTokens(sessionId: string, inputTokens: number, outputTokens: number): Promise<void> {
    if (!inputTokens && !outputTokens) return;
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET
         total_input_tokens += $input,
         total_output_tokens += $output,
         last_active = time::now()`,
      { input: inputTokens, output: outputTokens },
    );
  }

  async markSessionActive(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET cleanup_completed = false, last_active = time::now()`,
    );
  }

  async markSessionEnded(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET ended_at = time::now(), cleanup_completed = true`,
    );
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
  async claimSessionForCleanup(sessionId: string): Promise<boolean> {
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
    const rows = await this.queryFirst<{
      cleanup_completed?: boolean | null;
      cleanup_claim_token?: string | null;
    }>(sql, { myToken });
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
  async releaseSessionClaim(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET cleanup_completed = false, ended_at = NONE,
       cleanup_claim_token = NONE`,
    );
  }

  /**
   * Clear the cleanup_claim_token after successful cleanup completion. Leaves
   * cleanup_completed = true so the session stays "done"; only the token is
   * reset so it does not accumulate across re-runs on the same record. Safe
   * to call multiple times (idempotent on the NONE write).
   */
  async clearSessionClaim(sessionId: string): Promise<void> {
    assertRecordId(sessionId);
    await this.queryExec(
      `UPDATE ${sessionId} SET cleanup_claim_token = NONE`,
    );
  }

  async getOrphanedSessions(limit = 20): Promise<{ id: string; started_at: string; kc_session_id: string | null }[]> {
    return this.queryFirst<{ id: string; started_at: string; kc_session_id: string | null }>(
      `SELECT id, started_at, kc_session_id FROM session
       WHERE cleanup_completed != true
         AND started_at < time::now() - 2m
       ORDER BY started_at DESC LIMIT $lim`,
      { lim: limit },
    );
  }

  async countTurnsForSession(kcSessionId: string): Promise<number> {
    if (!kcSessionId) return 0;
    const rows = await this.queryFirst<{ count: number }>(
      `SELECT count() AS count FROM turn WHERE session_id = $sid GROUP ALL`,
      { sid: kcSessionId },
    );
    return rows[0]?.count ?? 0;
  }

  async linkSessionToTask(sessionId: string, taskId: string): Promise<void> {
    assertRecordId(sessionId);
    assertRecordId(taskId);
    await this.queryExec(
      `RELATE ${sessionId}->session_task->${taskId}`,
    );
  }

  async linkTaskToProject(taskId: string, projectId: string): Promise<void> {
    assertRecordId(taskId);
    assertRecordId(projectId);
    await this.queryExec(
      `RELATE ${taskId}->task_part_of->${projectId}`,
    );
  }

  async linkAgentToTask(agentId: string, taskId: string): Promise<void> {
    assertRecordId(agentId);
    assertRecordId(taskId);
    await this.queryExec(
      `RELATE ${agentId}->performed->${taskId}`,
    );
  }

  async linkAgentToProject(agentId: string, projectId: string): Promise<void> {
    assertRecordId(agentId);
    assertRecordId(projectId);
    await this.queryExec(
      `RELATE ${agentId}->owns->${projectId}`,
    );
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
  async tagBoostedConcepts(
    queryText: string,
    queryVec: number[],
    limit = 10,
  ): Promise<VectorSearchResult[]> {
    // Extract candidate tags from query — lowercase, deduplicate. Same
    // expanded stopword set as the rationale-display path in context-assembler.ts
    // (kept in sync to prevent the tag-boost from triggering on conversational
    // noise like "completely", "incorrect", "search", "context" — words that
    // would otherwise pull unrelated concepts via tag match).
    const stopwords = new Set([
      "the","a","an","is","are","was","were","be","been","being","have","has","had",
      "do","does","did","will","would","could","should","may","might","can","shall",
      "to","of","in","for","on","with","at","by","from","as","into","about","between",
      "through","during","it","its","this","that","these","those","i","you","we","they",
      "my","your","our","their","what","which","who","how","when","where","why","not",
      "no","and","or","but","if","so","any","all","some","more","just","also","than",
      "very","too","much","many",
      "completely","incorrect","correct","wrong","right","broken","working","missing",
      "really","actually","probably","maybe","perhaps","clearly","obviously","exactly",
      "again","still","even","well","good","bad","great","fine","okay","yeah","yes",
      "basically","mostly","kind","sort","like","want","need","make","made",
      "take","took","give","gave","tell","told","show","shown","said","says","know",
      "knew","think","thought","going","doing","done","got","get","getting","find",
      "found","look","looks","looking","seem","seems","mean","means","meant",
      "thing","things","stuff","way","ways","time","times","place","places","part",
      "parts","point","points","case","issue","issues","problem","problems","fix",
      "fixes","bug","bugs","error","errors","change","changes","update","updates",
      "version","versions","question","questions","answer","answers","reason","reasons",
      "context","search","report","reports","check","checks","status","state","states",
      "running","runs","ran","start","started","stop","stopped","keep","kept",
      "work","works","worked","help","helps","helped","needs","needed",
      "wanted","wants","tried","trying","using","used","uses",
      "such","then","over","under","both","each","every",
      "before","after","above","below","while","other","others","same","different","new","old",
    ]);
    const words = queryText.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));
    if (words.length === 0) return [];

    const tagWords = words.slice(0, 8);

    try {
      const rows = await this.queryFirst<any>(
        `SELECT id, content AS text, stability AS importance, access_count AS accessCount,
                created_at AS timestamp, 'concept' AS table,
                vector::similarity::cosine(embedding, $vec) AS score
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND superseded_at IS NONE
           AND tags CONTAINSANY $tags
         ORDER BY score DESC
         LIMIT $limit`,
        { vec: queryVec, limit, tags: tagWords },
      );
      return rows as VectorSearchResult[];
    } catch (e) {
      swallow.warn("surreal:tagBoostedConcepts", e);
      return [];
    }
  }

  async graphExpand(
    nodeIds: string[],
    queryVec: number[],
    hops = 1,
  ): Promise<VectorSearchResult[]> {
    if (nodeIds.length === 0) return [];

    const MAX_FRONTIER_SEEDS = 5;   // max seed nodes to start BFS from
    const MAX_FRONTIER_PER_HOP = 3; // max nodes carried forward per hop (by score)

    const forwardEdgeList = "responds_to, mentions, related_to, narrower, broader, about_concept, reflects_on, skill_from_task, skill_uses_concept, owns, performed, task_part_of, session_task, produced, derived_from, relevant_to, used_in, artifact_mentions";
    const reverseEdgeList = "reflects_on, skill_from_task, produced, derived_from, performed, owns";
    const FORWARD_LIMIT = 25;
    const REVERSE_LIMIT = 10;

    const scoreExpr =
      ", IF embedding != NONE AND array::len(embedding) > 0 THEN vector::similarity::cosine(embedding, $vec) ELSE 0 END AS score";
    const bindings = { vec: queryVec };
    const selectFields = `SELECT id, text, content, description, importance, stability,
                  access_count AS accessCount, created_at AS timestamp,
                  IF id IS NOT NONE THEN meta::tb(id) ELSE 'unknown' END AS table${scoreExpr}`;

    const seen = new Set<string>(nodeIds);
    const allNeighbors: VectorSearchResult[] = [];
    let frontier = nodeIds.slice(0, MAX_FRONTIER_SEEDS).filter((id) => RECORD_ID_RE.test(id));

    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      // 2 stmts per seed (forward + reverse multi-edge) instead of 25
      const stmts: string[] = [];
      for (const id of frontier) {
        stmts.push(`${selectFields} FROM ${id}->(${forwardEdgeList})->? LIMIT ${FORWARD_LIMIT}`);
        stmts.push(`${selectFields} FROM ${id}<-(${reverseEdgeList})<-? LIMIT ${REVERSE_LIMIT}`);
      }

      // GraphExpand rows are heterogeneous (turn / concept / memory / artifact /
       // monologue) projected to a shared {id, text|content|description,
       // importance, accessCount, timestamp, table, score} shape. Type as
       // unknown[][] at the wire and narrow per-row at the read site.
      type ExpandedRow = {
        id?: unknown;
        text?: unknown;
        content?: unknown;
        description?: unknown;
        importance?: unknown;
        stability?: unknown;
        accessCount?: unknown;
        timestamp?: unknown;
        table?: unknown;
        score?: unknown;
      };
      let queryResults: unknown[][];
      try {
        queryResults = await this.queryBatch<unknown>(stmts, bindings);
      } catch (e) {
        swallow.warn("surreal:graphExpand:batch", e);
        break;
      }
      const nextFrontier: { id: string; score: number }[] = [];

      for (const rawRows of queryResults) {
        const rows = rawRows as ExpandedRow[];
        for (const row of rows) {
          if (row.id == null) continue;
          const nodeId = String(row.id);
          if (seen.has(nodeId)) continue;
          seen.add(nodeId);

          const text = (row.text ?? row.content ?? row.description ?? null) as string | null;
          if (text) {
            const score = typeof row.score === "number" ? row.score : 0;
            allNeighbors.push({
              text,
              importance: (row.importance ?? row.stability) as number | undefined,
              accessCount: row.accessCount as number | undefined,
              timestamp: row.timestamp as string | undefined,
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

  async bumpAccessCounts(ids: string[]): Promise<void> {
    const validated = ids.filter(id => { try { assertRecordId(id); return true; } catch { return false; } });
    if (validated.length === 0) return;
    try {
      // Direct interpolation (safe: assertRecordId validates format above).
      // Cannot use `UPDATE $ids` binding — SurrealDB treats string arrays as
      // literal strings, not record references, causing silent no-ops.
      const stmts = validated.map(id =>
        `UPDATE ${id} SET access_count += 1, last_accessed = time::now()`,
      );
      await this.queryBatch(stmts);
    } catch (e) {
      swallow.warn("surreal:bumpAccessCounts", e);
    }
  }

  // ── Concept / Memory / Artifact CRUD ───────────────────────────────────

  async upsertConcept(
    content: string,
    embedding: number[] | null,
    source?: string,
    provenance?: ConceptProvenance,
    projectId?: string,
  ): Promise<string> {
    if (!content?.trim()) return "";
    content = content.trim();
    // Two-stage dedup. Stage 1 (fast, sub-linear): KNN pre-filter on the
    // `concept_vec_idx` HNSW index (schema.surql:62) — top-10 nearest
    // candidates by embedding cosine, plus exact-similarity match for
    // ">0.92 means same concept, even if labels differ slightly".
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
    let existingId: string | null = null;
    if (embedding?.length) {
      const candidates = await this.queryFirst<{ id: string; content: string; score: number }>(
        `SELECT id, content, vector::similarity::cosine(embedding, $vec) AS score
         FROM concept
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND superseded_at IS NONE
         ORDER BY score DESC
         LIMIT 10`,
        { vec: embedding },
      );
      const target = content.toLowerCase();
      // High-similarity dedup branch: even if labels disagree, cosine >0.92
      // on the new content's embedding vs an existing concept's embedding
      // means they describe the same thing. Mirrors createMemory's dedup.
      // We check this AFTER the exact-label scan so an exact match wins,
      // but BEFORE creating a new row.
      let highSimId: string | null = null;
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
      if (!existingId && highSimId) existingId = highSimId;
    } else {
      const rows = await this.queryFirst<{ id: string }>(
        `SELECT id FROM concept WHERE string::lowercase(content) = string::lowercase($content) AND superseded_at IS NONE LIMIT 1`,
        { content },
      );
      if (rows.length > 0) existingId = String(rows[0].id);
    }
    if (existingId) {
      const id = existingId;
      assertRecordId(id);
      if (embedding?.length) {
        await this.queryExec(
          `UPDATE ${id} SET access_count += 1, last_accessed = time::now(), embedding = IF embedding IS NONE OR array::len(embedding) = 0 THEN $emb ELSE embedding END${projectId ? ", project_id = IF project_id IS NONE THEN $pid ELSE project_id END" : ""}`,
          projectId ? { emb: embedding, pid: projectId } : { emb: embedding },
        );
      } else if (projectId) {
        await this.queryExec(
          `UPDATE ${id} SET access_count += 1, last_accessed = time::now(), project_id = IF project_id IS NONE THEN $pid ELSE project_id END`,
          { pid: projectId },
        );
      } else {
        await this.queryExec(
          `UPDATE ${id} SET access_count += 1, last_accessed = time::now()`,
        );
      }
      return id;
    }
    const emb = embedding?.length ? embedding : undefined;
    const record: Record<string, unknown> = { content, source: source ?? undefined };
    if (emb) record.embedding = emb;
    if (provenance) record.provenance = provenance;
    if (projectId) record.project_id = projectId;
    // M5 race surfacer: SELECT-then-CREATE has a TOCTOU window. Two concurrent
    // upserts can both observe the SELECT-miss above and race into CREATE.
    // The schema-level UNIQUE on lowercased content (out of scope here —
    // needs a migration) is the durable fix. Until then, catch any unique-
    // violation from the CREATE, log it via swallow.warn so we can measure
    // how often it actually fires in production, and re-SELECT to return the
    // sibling-created row's id. This keeps the API contract (returns an id)
    // intact instead of throwing.
    try {
      const created = await this.queryFirst<{ id: string }>(
        `CREATE concept CONTENT $record RETURN id`,
        { record },
      );
      return String(created[0]?.id ?? "");
    } catch (createErr) {
      if (isUniqueViolation(createErr)) {
        swallow.warn("upsertConcept:dedupRace", createErr);
        // Stage A: lowercase-exact rematch. Cheap, covers the common case
        // where two callers wrote the same content string concurrently.
        const existing = await this.queryFirst<{ id: string }>(
          `SELECT id FROM concept WHERE string::lowercase(content) = string::lowercase($content) AND superseded_at IS NONE LIMIT 1`,
          { content },
        ).catch(e => { swallow.warn("upsertConcept:selectAfterRace", e); return [] as { id: string }[]; });
        if (existing[0]?.id) return String(existing[0].id);
        // Stage B (R7 F1): when the race winner deduped via KNN cosine
        // (>0.92 sim, different content text — synonym/paraphrase), the
        // lowercase rematch above won't find it. Replay the same KNN
        // similarity match the initial dedup pass would have done so the
        // caller still receives the correct id instead of the empty string.
        if (embedding?.length) {
          const knn = await this.queryFirst<{ id: string; score: number }>(
            `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
             FROM concept
             WHERE embedding != NONE AND array::len(embedding) > 0
               AND superseded_at IS NONE
             ORDER BY score DESC
             LIMIT 1`,
            { vec: embedding },
          ).catch(e => { swallow.warn("upsertConcept:knnAfterRace", e); return [] as { id: string; score: number }[]; });
          if (knn[0] && typeof knn[0].score === "number" && knn[0].score > 0.92 && knn[0].id) {
            return String(knn[0].id);
          }
        }
      }
      throw createErr;
    }
  }

  async createArtifact(
    path: string,
    type: string,
    description: string,
    embedding: number[] | null,
    projectId?: string,
  ): Promise<string> {
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
    const record: Record<string, unknown> = { path, type, description };
    if (embedding?.length) record.embedding = embedding;
    if (projectId) record.project_id = projectId;
    try {
      const rows = await this.queryFirst<{ id: string }>(
        `CREATE artifact CONTENT $record RETURN id`,
        { record },
      );
      return String(rows[0]?.id ?? "");
    } catch (createErr) {
      if (path && isUniqueViolation(createErr)) {
        // Sibling already wrote the row — fetch its id and return.
        const existing = await this.queryFirst<{ id: string }>(
          `SELECT id FROM artifact WHERE path = $path LIMIT 1`,
          { path },
        ).catch(e => { swallow.warn("createArtifact:selectAfterUnique", e); return [] as { id: string }[]; });
        if (existing[0]?.id) return String(existing[0].id);
        // TOCTOU close-out: the sibling row was deleted between our CREATE
        // rejection and our SELECT, so the path is no longer occupied. Retry
        // CREATE once — succeeds in the normal case, only re-fails if a third
        // racer slipped in. The double-disappearing-row case is so unlikely we
        // wrap it as a distinct error rather than infinite-looping.
        try {
          const retried = await this.queryFirst<{ id: string }>(
            `CREATE artifact CONTENT $record RETURN id`,
            { record },
          );
          return String(retried[0]?.id ?? "");
        } catch (retryErr) {
          if (isUniqueViolation(retryErr)) {
            const existingAgain = await this.queryFirst<{ id: string }>(
              `SELECT id FROM artifact WHERE path = $path LIMIT 1`,
              { path },
            ).catch(() => [] as { id: string }[]);
            if (existingAgain[0]?.id) return String(existingAgain[0].id);
            // isUniqueViolation accepts non-Error inputs (plain-object errors
            // from raw RPC layers), so retryErr may not be an Error instance.
            // Cast unconditionally would produce `cause=undefined` and a
            // useless wrapper. Build a faithful message + chain instead.
            const retryMsg = retryErr instanceof Error
              ? retryErr.message
              : String(retryErr);
            const retryCause: Error = retryErr instanceof Error
              ? retryErr
              : new Error(String(retryErr));
            throw new Error(
              `createArtifact: UNIQUE conflict with disappearing row (cause=${retryMsg})`,
              { cause: retryCause },
            );
          }
          throw retryErr;
        }
      }
      throw createErr;
    }
  }

  async createMemory(
    text: string,
    embedding: number[] | null,
    importance: number,
    category?: string,
    sessionId?: string,
    projectId?: string,
  ): Promise<string> {
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
      const exact = await this.queryFirst<{ id: string; importance: number }>(
        `SELECT id, importance FROM memory
         WHERE string::lowercase(text) = string::lowercase($text)
           AND category = $cat
           AND (status = 'active' OR status IS NONE)
         LIMIT 1`,
        { text, cat: source },
      );
      if (exact.length > 0) {
        const existingId = String(exact[0]!.id);
        assertRecordId(existingId);
        const newImp = Math.max(exact[0]!.importance ?? 0, importance);
        await this.queryExec(
          `UPDATE ${existingId} SET access_count += 1, importance = $imp, last_accessed = time::now()`,
          { imp: newImp },
        );
        return existingId;
      }
    }

    const record: Record<string, unknown> = { text, importance, category: source, source };
    if (embedding?.length) record.embedding = embedding;
    if (sessionId) record.session_id = sessionId;
    if (projectId) record.project_id = projectId;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE memory CONTENT $record RETURN id`,
      { record },
    );
    return String(rows[0]?.id ?? "");
  }

  async createMonologue(
    sessionId: string,
    category: string,
    content: string,
    embedding: number[] | null,
  ): Promise<string> {
    const record: Record<string, unknown> = { session_id: sessionId, category, content };
    if (embedding?.length) record.embedding = embedding;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE monologue CONTENT $record RETURN id`,
      { record },
    );
    return String(rows[0]?.id ?? "");
  }

  // ── Core Memory (Tier 0/1) ─────────────────────────────────────────────

  async getAllCoreMemory(tier?: number): Promise<CoreMemoryEntry[]> {
    try {
      if (tier != null) {
        return await this.queryFirst<CoreMemoryEntry>(
          `SELECT * FROM core_memory WHERE active = true AND tier = $tier ORDER BY priority DESC`,
          { tier },
        );
      }
      return await this.queryFirst<CoreMemoryEntry>(
        `SELECT * FROM core_memory WHERE active = true ORDER BY tier ASC, priority DESC`,
      );
    } catch (e) {
      swallow.warn("surreal:getAllCoreMemory", e);
      return [];
    }
  }

  async createCoreMemory(
    text: string,
    category: string,
    priority: number,
    tier: number,
    sessionId?: string,
  ): Promise<string> {
    const record: Record<string, unknown> = { text, category, priority, tier, active: true };
    if (sessionId) record.session_id = sessionId;
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE core_memory CONTENT $record RETURN id`,
      { record },
    );
    const id = String(rows[0]?.id ?? "");
    if (!id) throw new Error("createCoreMemory: CREATE returned no ID");
    return id;
  }

  async updateCoreMemory(
    id: string,
    fields: Partial<Pick<CoreMemoryEntry, "text" | "category" | "priority" | "tier" | "active">>,
  ): Promise<boolean> {
    assertRecordId(id);
    const ALLOWED_FIELDS = new Set(["text", "category", "priority", "tier", "active"]);
    const sets: string[] = [];
    const bindings: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined && ALLOWED_FIELDS.has(key)) {
        sets.push(`${key} = $${key}`);
        bindings[key] = val;
      }
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = time::now()");
    const rows = await this.queryFirst<{ id: string }>(
      `UPDATE ${id} SET ${sets.join(", ")} RETURN id`,
      bindings,
    );
    return rows.length > 0;
  }

  async deleteCoreMemory(id: string): Promise<void> {
    assertRecordId(id);
    await this.queryExec(
      `UPDATE ${id} SET active = false, updated_at = time::now()`,
    );
  }

  // ── Wakeup & lifecycle queries ─────────────────────────────────────────

  async getLatestHandoff(): Promise<{ text: string; created_at: string } | null> {
    try {
      const rows = await this.queryFirst<{ text: string; created_at: string }>(
        `SELECT text, created_at FROM memory WHERE category = "handoff" ORDER BY created_at DESC LIMIT 1`,
      );
      return rows[0] ?? null;
    } catch (e) {
      swallow.warn("surreal:getLatestHandoff", e);
      return null;
    }
  }

  async countResolvedSinceHandoff(handoffCreatedAt: string): Promise<number> {
    try {
      const rows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM memory WHERE status = 'resolved' AND resolved_at > $ts GROUP ALL`,
        { ts: handoffCreatedAt },
      );
      return rows[0]?.count ?? 0;
    } catch (e) {
      swallow.warn("surreal:countResolvedSinceHandoff", e);
      return 0;
    }
  }

  async getAllIdentityChunks(): Promise<{ text: string }[]> {
    try {
      return await this.queryFirst<{ text: string }>(
        `SELECT text, chunk_index FROM identity_chunk
         WHERE active = true OR active IS NONE
         ORDER BY chunk_index ASC`,
      );
    } catch (e) {
      swallow.warn("surreal:getAllIdentityChunks", e);
      return [];
    }
  }

  async getRecentMonologues(
    limit = 5,
  ): Promise<{ category: string; content: string; timestamp: string }[]> {
    try {
      return await this.queryFirst<{ category: string; content: string; timestamp: string }>(
        `SELECT category, content, timestamp FROM monologue ORDER BY timestamp DESC LIMIT $lim`,
        { lim: limit },
      );
    } catch (e) {
      swallow.warn("surreal:getRecentMonologues", e);
      return [];
    }
  }

  async getPreviousSessionTurns(
    currentSessionId?: string,
    limit = 10,
  ): Promise<{ role: string; text: string; tool_name?: string; timestamp: string }[]> {
    try {
      let prevSessionQuery: string;
      const bindings: Record<string, unknown> = { lim: limit };

      if (currentSessionId) {
        prevSessionQuery = `SELECT id, started_at FROM session WHERE id != $current ORDER BY started_at DESC LIMIT 1`;
        bindings.current = currentSessionId;
      } else {
        prevSessionQuery = `SELECT id, started_at FROM session ORDER BY started_at DESC LIMIT 1`;
      }

      const sessionRows = await this.queryFirst<{ id: string }>(prevSessionQuery, bindings);
      if (sessionRows.length === 0) return [];

      const prevSessionId = String(sessionRows[0].id);
      const turns = await this.queryFirst<{
        role: string;
        text: string;
        tool_name?: string;
        timestamp: string;
      }>(
        `SELECT role, text, tool_name, timestamp FROM turn
         WHERE id IN (SELECT VALUE in FROM part_of WHERE out = $sid)
           AND text != NONE AND text != ""
         ORDER BY timestamp DESC LIMIT $lim`,
        { sid: prevSessionId, lim: limit },
      );

      return turns.reverse();
    } catch (e) {
      swallow.warn("surreal:getPreviousSessionTurns", e);
      return [];
    }
  }

  async getUnresolvedMemories(
    limit = 5,
  ): Promise<{ id: string; text: string; importance: number; category: string }[]> {
    try {
      return await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
      }>(
        `SELECT id, text,
                math::max([importance - math::min([math::floor(duration::days(time::now() - created_at) / 7), 3]), 0]) AS importance,
                category
         FROM memory
         WHERE (status IS NONE OR status = 'active')
           AND category NOT IN ['handoff', 'monologue', 'reflection', 'compaction', 'consolidation']
           AND importance >= 6
         ORDER BY importance DESC
         LIMIT $lim`,
        { lim: limit },
      );
    } catch (e) {
      swallow.warn("surreal:getUnresolvedMemories", e);
      return [];
    }
  }

  async getRecentFailedCausal(
    limit = 3,
  ): Promise<{ description: string; chain_type: string }[]> {
    try {
      return await this.queryFirst<{ description: string; chain_type: string }>(
        `SELECT description, chain_type, created_at FROM causal_chain WHERE success = false ORDER BY created_at DESC LIMIT $lim`,
        { lim: limit },
      );
    } catch (e) {
      swallow.warn("surreal:getRecentFailedCausal", e);
      return [];
    }
  }

  async resolveMemory(memoryId: string): Promise<boolean> {
    try {
      assertRecordId(memoryId);
      await this.queryFirst(
        `UPDATE ${memoryId} SET status = 'resolved', resolved_at = time::now()`,
      );
      return true;
    } catch (e) {
      swallow.warn("surreal:resolveMemory", e);
      return false;
    }
  }

  // ── Utility cache ──────────────────────────────────────────────────────

  async updateUtilityCache(memoryId: string, utilization: number): Promise<void> {
    try {
      // memory_id is typed `option<record<memory>>` (was `string` pre-migration).
      // Bind as a RecordId so SurrealDB stores it as a Thing, not as a string.
      const mid = toRecordId(memoryId);
      await this.queryExec(
        `UPSERT memory_utility_cache SET
          memory_id = $mid,
          retrieval_count = (retrieval_count ?? 0) + 1,
          avg_utilization = IF (retrieval_count ?? 0) > 0
            THEN (avg_utilization * (retrieval_count ?? 0) + $util) / ((retrieval_count ?? 0) + 1)
            ELSE $util
          END,
          last_updated = time::now()
         WHERE memory_id = $mid`,
        { mid, util: utilization },
      );
    } catch (e) {
      swallow.warn("surreal:updateUtilityCache", e);
    }
  }

  async getUtilityFromCache(ids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    try {
      const recIds = ids.map(id => { try { return toRecordId(id); } catch { return null; } }).filter((x): x is RecordId => x !== null);
      if (recIds.length === 0) return result;
      const rows = await this.queryFirst<{
        memory_id: { tb: string; id: string } | string;
        avg_utilization: number;
      }>(
        `SELECT memory_id, avg_utilization FROM memory_utility_cache WHERE memory_id IN $ids`,
        { ids: recIds },
      );
      for (const row of rows) {
        if (row.avg_utilization != null) result.set(String(row.memory_id), row.avg_utilization);
      }
    } catch (e) {
      swallow.warn("surreal:getUtilityFromCache", e);
    }
    return result;
  }

  async getUtilityCacheEntries(ids: string[]): Promise<Map<string, UtilityCacheEntry>> {
    const result = new Map<string, UtilityCacheEntry>();
    if (ids.length === 0) return result;
    try {
      const recIds = ids.map(id => { try { return toRecordId(id); } catch { return null; } }).filter((x): x is RecordId => x !== null);
      if (recIds.length === 0) return result;
      const rows = await this.queryFirst<{
        memory_id: { tb: string; id: string } | string;
        avg_utilization: number;
        retrieval_count: number;
      }>(
        `SELECT memory_id, avg_utilization, retrieval_count FROM memory_utility_cache WHERE memory_id IN $ids`,
        { ids: recIds },
      );
      for (const row of rows) {
        if (row.avg_utilization != null) {
          result.set(String(row.memory_id), {
            avg_utilization: row.avg_utilization,
            retrieval_count: row.retrieval_count ?? 0,
          });
        }
      }
    } catch (e) {
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
  private async shouldRunMaintenance(
    job: string,
    countFloor: number,
    maxDaysSince: number,
    currentCount: number,
  ): Promise<boolean> {
    try {
      const rows = await this.queryFirst<{ ran_at: string }>(
        `SELECT ran_at FROM maintenance_runs WHERE job = $job ORDER BY ran_at DESC LIMIT 1`,
        { job },
      );
      if (rows.length === 0) return true; // baseline
      // parseDatetimeMs (NaN-safe) over Date.parse: SurrealDB DateTime values
      // that come back as objects (newer driver versions) yield NaN through
      // Date.parse, which then makes ageDays = NaN and `>=` false, silently
      // skipping all maintenance runs. parseDatetimeMs returns null in that
      // case and we treat unknown age as "stale" (run it) rather than fresh.
      const lastRanAt = parseDatetimeMs(rows[0].ran_at);
      if (lastRanAt == null) return true; // unknown age — re-run
      const ageDays = (Date.now() - lastRanAt) / (1000 * 60 * 60 * 24);
      if (ageDays >= maxDaysSince) return true;
      return currentCount > countFloor;
    } catch (e) {
      // On query failure, fall back to absolute-count behavior so we're
      // never worse than the pre-0.4.0 gate.
      swallow("surreal:shouldRunMaintenance", e);
      return currentCount > countFloor;
    }
  }

  private async recordMaintenanceRun(
    job: string,
    rowsAffected: number,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.queryExec(
        `CREATE maintenance_runs CONTENT $data`,
        { data: { job, rows_affected: rowsAffected, duration_ms: durationMs } },
      );
    } catch (e) {
      swallow("surreal:recordMaintenanceRun", e);
    }
  }

  async runMemoryMaintenance(): Promise<void> {
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
    } catch (e) {
      // Transaction conflicts expected when daemon writes concurrently — silent.
      // Anything else (syntax error, missing field, NaN poison from
      // parseDatetimeMs upstream) is a real bug and must surface via
      // swallow.warn so we don't lose visibility on broken maintenance.
      if (isTransactionConflict(e)) {
        swallow("surreal:runMemoryMaintenance", e);
      } else {
        swallow.warn("surreal:runMemoryMaintenance", e);
      }
    }
  }

  async garbageCollectMemories(): Promise<number> {
    const started = Date.now();
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM memory GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      // Floor lowered to 50 and scheduled weekly so new installs benefit.
      if (!(await this.shouldRunMaintenance("garbageCollectMemories", 50, 7, count))) return 0;

      // v0.7.93 append-only: was DELETE — now soft-deactivates via
      // status='archived' + archived_at + archive_reason. Memory rows are
      // permanent; readers already filter `status = 'active' OR status IS NONE`
      // (surreal.ts:447, 2019), so archived rows naturally drop out of recall
      // while remaining recoverable for forensic inspection.
      const pruned = await this.db.query(
        `LET $stale = (
          SELECT id FROM memory
          WHERE created_at < time::now() - 14d
            AND importance <= 2.0
            AND (access_count = 0 OR access_count IS NONE)
            AND (status = 'active' OR status IS NONE)
            AND string::concat("memory:", id) NOT IN (
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
        RETURN array::len($stale);`,
      );
      const n = Number(pruned ?? 0);
      await this.recordMaintenanceRun("garbageCollectMemories", n, Date.now() - started);
      return n;
    } catch (e) {
      swallow.warn("surreal:garbageCollectMemories", e);
      return 0;
    }
  }

  async garbageCollectConcepts(): Promise<number> {
    const started = Date.now();
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM concept GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      if (!(await this.shouldRunMaintenance("garbageCollectConcepts", 200, 3, count))) return 0;

      // v0.7.93 append-only: was DELETE — now soft-deactivates via
      // superseded_at + archive_reason. Concept readers already filter
      // `superseded_at IS NONE` (surreal.ts:441 vectorSearch), so archived
      // concepts naturally drop out of recall while remaining auditable.
      const pruned = await this.db.query(
        `LET $stale = (
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
        RETURN array::len($stale);`,
      );
      const n = Number(pruned ?? 0);
      await this.recordMaintenanceRun("garbageCollectConcepts", n, Date.now() - started);
      return n;
    } catch (e) {
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
  async purgeStalePendingWork(): Promise<number> {
    const started = Date.now();
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM pending_work GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      if (!(await this.shouldRunMaintenance("purgeStalePendingWork", 10, 1, count))) return 0;

      const purged = await this.queryMulti<number>(
        `LET $stale = (SELECT id FROM pending_work WHERE created_at < time::now() - 7d);
         FOR $p IN $stale { DELETE $p.id; };
         RETURN array::len($stale);`,
      );
      const n = Number(purged ?? 0);
      await this.recordMaintenanceRun("purgeStalePendingWork", n, Date.now() - started);
      return n;
    } catch (e) {
      swallow.warn("surreal:purgeStalePendingWork", e);
      return 0;
    }
  }

  async archiveOldTurns(): Promise<number> {
    const started = Date.now();
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM turn GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      // Floor lowered to 500 and scheduled weekly — new installs archive
      // after week 1 regardless of volume.
      if (!(await this.shouldRunMaintenance("archiveOldTurns", 500, 7, count))) return 0;

      const staleRows = await this.queryFirst<{ id: string }>(
        `SELECT id FROM turn WHERE timestamp < time::now() - 7d AND id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn') LIMIT 500`,
      );
      if (!staleRows.length) return 0;
      for (const row of staleRows as { id: string }[]) {
        try {
          assertRecordId(String(row.id));
          const rid = String(row.id);
          // Direct interpolation safe: assertRecordId validated above
          await this.queryExec(
            `LET $data = (SELECT * FROM ONLY ${rid});
             IF $data != NONE { INSERT INTO turn_archive $data; DELETE ${rid}; };`,
          );
        } catch { /* row already archived or deleted by concurrent call */ }
      }
      const archived = staleRows.length;
      const n = Number(archived ?? 0);
      await this.recordMaintenanceRun("archiveOldTurns", n, Date.now() - started);
      return n;
    } catch (e) {
      swallow.warn("surreal:archiveOldTurns", e);
      return 0;
    }
  }

  async consolidateMemories(embedFn: (text: string) => Promise<number[]>): Promise<number> {
    const started = Date.now();
    try {
      const countRows = await this.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM memory GROUP ALL`,
      );
      const count = countRows[0]?.count ?? 0;
      // Floor lowered to 10 and scheduled weekly — consolidation runs even
      // on small graphs to keep near-duplicates from compounding.
      if (!(await this.shouldRunMaintenance("consolidateMemories", 10, 7, count))) return 0;

      let merged = 0;
      const seen = new Set<string>();

      // Pass 1: Vector similarity dedup
      const embMemories = await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
        access_count: number;
        embedding: number[];
      }>(
        `SELECT id, text, importance, category, access_count, embedding, created_at
         FROM memory
         WHERE embedding != NONE AND array::len(embedding) > 0
         ORDER BY created_at ASC
         LIMIT 50`,
      );

      for (const mem of embMemories) {
        if (seen.has(String(mem.id))) continue;

        const dupes = await this.queryFirst<{
          id: string;
          importance: number;
          access_count: number;
          score: number;
        }>(
          `SELECT id, importance, access_count,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM memory
           WHERE id != $mid
             AND category = $cat
             AND (status = 'active' OR status IS NONE)
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`,
          { vec: mem.embedding, mid: mem.id, cat: mem.category },
        );

        for (const dupe of dupes) {
          if (dupe.score < 0.88) break;
          if (seen.has(String(dupe.id))) continue;

          const keepMem =
            mem.importance > dupe.importance ||
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
          await this.queryExec(
            `BEGIN TRANSACTION;
             UPDATE ${String(keep)} SET
               access_count += 1,
               importance = math::max([importance, $imp]);
             UPDATE ${String(drop)} SET
               status = 'archived',
               archived_at = time::now(),
               archive_reason = 'dedup_consolidate_pass1',
               superseded_by = type::record($kid);
             COMMIT TRANSACTION;`,
            { imp: dupe.importance, kid: String(keep) },
          );
          seen.add(String(drop));
          merged++;
        }
      }

      // Pass 2: Backfill embeddings for memories missing them
      const unembedded = await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
        access_count: number;
      }>(
        `SELECT id, text, importance, category, access_count
         FROM memory
         WHERE embedding IS NONE OR array::len(embedding) = 0
         LIMIT 20`,
      );

      for (const mem of unembedded) {
        if (seen.has(String(mem.id))) continue;
        try {
          // 0.7.70: BGE-M3 has an 8192-token context window. Long memory texts
          // (e.g. transcript-style entries that slipped through) throw
          // "Input is longer than the context size" and we lose the whole
          // backfill pass. Truncate at 6000 chars (safely below ~7800 tokens
          // worst case for English) and tag the warn so it's distinguishable
          // from embed errors.
          const safeText = mem.text.length > 6000 ? mem.text.slice(0, 6000) : mem.text;
          if (safeText.length < mem.text.length) {
            swallow.warn(
              "surreal:consolidate-backfill:truncated",
              new Error(`memory ${String(mem.id)} text len=${mem.text.length} truncated to 6000 chars before embed`),
            );
          }
          const emb = await embedFn(safeText);
          if (!emb) continue;
          await this.queryExec(
            `UPDATE ${String(mem.id)} SET embedding = $emb`,
            { emb },
          );

          const dupes = await this.queryFirst<{
            id: string;
            importance: number;
            access_count: number;
            score: number;
          }>(
            `SELECT id, importance, access_count,
                    vector::similarity::cosine(embedding, $vec) AS score
             FROM memory
             WHERE id != $mid
               AND category = $cat
               AND (status = 'active' OR status IS NONE)
               AND embedding != NONE AND array::len(embedding) > 0
             ORDER BY score DESC
             LIMIT 3`,
            { vec: emb, mid: mem.id, cat: mem.category },
          );
          for (const dupe of dupes) {
            if (dupe.score < 0.88) break;
            if (seen.has(String(dupe.id))) continue;
            const keepMem =
              mem.importance > dupe.importance ||
              (mem.importance === dupe.importance &&
                (mem.access_count ?? 0) >= (dupe.access_count ?? 0));
            const [keep, drop] = keepMem ? [mem.id, dupe.id] : [dupe.id, mem.id];
            assertRecordId(String(keep));
            assertRecordId(String(drop));
            // v0.7.93 append-only — same shape as Pass 1.
            await this.queryExec(
              `BEGIN TRANSACTION;
               UPDATE ${String(keep)} SET
                 access_count += 1,
                 importance = math::max([importance, $imp]);
               UPDATE ${String(drop)} SET
                 status = 'archived',
                 archived_at = time::now(),
                 archive_reason = 'dedup_consolidate_pass2',
                 superseded_by = type::record($kid);
               COMMIT TRANSACTION;`,
              { imp: dupe.importance, kid: String(keep) },
            );
            seen.add(String(drop));
            merged++;
          }
        } catch (e) {
          swallow.warn("surreal:consolidate-backfill", e);
        }
      }

      // Pass 3: Vector similarity dedup for reflections
      const embReflections = await this.queryFirst<{
        id: string;
        text: string;
        importance: number;
        category: string;
        embedding: number[];
      }>(
        `SELECT id, text, importance, category, embedding, created_at
         FROM reflection
         WHERE embedding != NONE AND array::len(embedding) > 0
           AND (active = true OR active IS NONE)
         ORDER BY created_at ASC
         LIMIT 50`,
      );

      for (const ref of embReflections) {
        if (seen.has(String(ref.id))) continue;

        const dupes = await this.queryFirst<{
          id: string;
          importance: number;
          score: number;
        }>(
          `SELECT id, importance,
                  vector::similarity::cosine(embedding, $vec) AS score
           FROM reflection
           WHERE id != $rid
             AND category = $cat
             AND (active = true OR active IS NONE)
             AND embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC
           LIMIT 3`,
          { vec: ref.embedding, rid: ref.id, cat: ref.category },
        );

        for (const dupe of dupes) {
          if (dupe.score < 0.88) break;
          if (seen.has(String(dupe.id))) continue;

          const keepRef = ref.importance > dupe.importance;
          const [keep, drop] = keepRef ? [ref.id, dupe.id] : [dupe.id, ref.id];
          assertRecordId(String(keep));
          assertRecordId(String(drop));
          // v0.7.93 append-only: was DELETE — now soft-archives the loser
          // with superseded_by pointing at keeper. Also added category guard
          // to SELECT so different-category reflections don't collide.
          await this.queryExec(
            `UPDATE ${String(drop)} SET
              active = false,
              archived_at = time::now(),
              archive_reason = 'dedup_consolidate_pass3_reflection',
              superseded_by = type::record($kid);`,
            { kid: String(keep) },
          );
          seen.add(String(drop));
          merged++;
        }
      }

      await this.recordMaintenanceRun("consolidateMemories", merged, Date.now() - started);
      return merged;
    } catch (e) {
      swallow.warn("surreal:consolidateMemories", e);
      return 0;
    }
  }

  // ── Retrieval session memory ───────────────────────────────────────────

  async getSessionRetrievedMemories(
    sessionId: string,
  ): Promise<{ id: string; text: string }[]> {
    try {
      const rows = await this.queryFirst<{ memory_id: string }>(
        `SELECT memory_id FROM retrieval_outcome WHERE session_id = $sid AND memory_table = 'memory' GROUP BY memory_id`,
        { sid: sessionId },
      );
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.memory_id).filter(Boolean);
      if (ids.length === 0) return [];
      // Direct interpolation — SurrealDB treats string-array bindings as
      // literal strings, not record references, causing silent empty results.
      const validated = ids.filter(id => { try { assertRecordId(String(id)); return true; } catch { return false; } });
      if (validated.length === 0) return [];
      const idList = validated.join(", ");
      return this.queryFirst<{ id: string; text: string }>(
        `SELECT id, text FROM memory WHERE id IN [${idList}] AND (status = 'active' OR status IS NONE)`,
      );
    } catch (e) {
      swallow.warn("surreal:getSessionRetrievedMemories", e);
      return [];
    }
  }

  // ── Fibonacci resurfacing ──────────────────────────────────────────────

  async markSurfaceable(memoryId: string): Promise<void> {
    assertRecordId(memoryId);
    // Direct interpolation safe: assertRecordId validates format above.
    // SurrealDB rejects `UPDATE $id` with a string param.
    await this.queryExec(
      `UPDATE ${memoryId} SET surfaceable = true, fib_index = 0, surface_count = 0, next_surface_at = time::now() + 1d`,
    );
  }

  async getDueMemories(
    limit = 5,
  ): Promise<
    {
      id: string;
      text: string;
      importance: number;
      fib_index: number;
      surface_count: number;
      created_at: string;
    }[]
  > {
    return (
      (await this.queryFirst<any>(
        `SELECT id, text, importance, fib_index, surface_count, created_at
         FROM memory
         WHERE surfaceable = true
           AND next_surface_at <= time::now()
           AND (status = 'active' OR status IS NONE)
         ORDER BY importance DESC
         LIMIT $lim`,
        { lim: limit },
      )) ?? []
    );
  }

  // ── Compaction checkpoints ─────────────────────────────────────────────

  async createCompactionCheckpoint(
    sessionId: string,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<string> {
    const rows = await this.queryFirst<{ id: string }>(
      `CREATE compaction_checkpoint CONTENT $data RETURN id`,
      {
        data: {
          session_id: sessionId,
          msg_range_start: rangeStart,
          msg_range_end: rangeEnd,
          status: "pending",
        },
      },
    );
    return String(rows[0]?.id ?? "");
  }

  async completeCompactionCheckpoint(
    checkpointId: string,
    memoryId: string,
  ): Promise<void> {
    assertRecordId(checkpointId);
    await this.queryExec(
      `UPDATE ${checkpointId} SET status = "complete", memory_id = $mid`,
      { mid: memoryId },
    );
  }

  async getPendingCheckpoints(
    sessionId: string,
  ): Promise<{ id: string; msg_range_start: number; msg_range_end: number }[]> {
    return this.queryFirst<{
      id: string;
      msg_range_start: number;
      msg_range_end: number;
    }>(
      `SELECT id, msg_range_start, msg_range_end FROM compaction_checkpoint WHERE session_id = $sid AND (status = "pending" OR status = "failed")`,
      { sid: sessionId },
    );
  }

  // ── Availability check ────────────────────────────────────────────────

  isAvailable(): boolean {
    try {
      return this.db?.isConnected ?? false;
    } catch {
      return false;
    }
  }

  // ── Reflection session lookup ─────────────────────────────────────────

  private _reflectionSessions: Set<string> | null = null;

  clearReflectionCache(): void {
    this._reflectionSessions = null;
  }

  async getReflectionSessionIds(): Promise<Set<string>> {
    if (this._reflectionSessions) return this._reflectionSessions;
    try {
      const rows = await this.queryFirst<{ session_id: string }>(
        `SELECT session_id FROM reflection GROUP BY session_id`,
      );
      this._reflectionSessions = new Set(rows.map(r => r.session_id).filter(Boolean));
    } catch (e) {
      swallow.warn("surreal:getReflectionSessionIds", e);
      this._reflectionSessions = new Set();
    }
    return this._reflectionSessions;
  }

  // ── Fibonacci resurfacing: advance ────────────────────────────────────

  private static readonly FIB_DAYS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

  async advanceSurfaceFade(memoryId: string): Promise<void> {
    assertRecordId(memoryId);
    const current = await this.queryFirst<{ fib_index: number }>(
      `SELECT fib_index FROM ${memoryId}`,
    );
    const idx = (current as { fib_index: number }[] | undefined)?.[0]?.fib_index ?? 0;
    const nextIdx = Math.min(idx + 1, SurrealStore.FIB_DAYS.length - 1);
    const days = nextIdx < SurrealStore.FIB_DAYS.length
      ? SurrealStore.FIB_DAYS[nextIdx]
      : SurrealStore.FIB_DAYS[SurrealStore.FIB_DAYS.length - 1];
    await this.queryExec(
      `UPDATE ${memoryId} SET fib_index = $nextIdx, surface_count += 1, last_surfaced = time::now(), next_surface_at = time::now() + type::duration($dur)`,
      { nextIdx, dur: `${days}d` },
    );
  }

  async resolveSurfaceMemory(memoryId: string, outcome: "engaged" | "dismissed"): Promise<void> {
    assertRecordId(memoryId);
    await this.queryExec(
      `UPDATE ${memoryId} SET surfaceable = false, last_engaged = time::now(), surface_outcome = $outcome`,
      { outcome },
    );
  }

  // ── Dispose ───────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    try {
      await this.close();
    } catch (e) {
      swallow("surreal:dispose", e);
    }
  }
}

export { assertRecordId, assertValidEdge, VALID_EDGES };
