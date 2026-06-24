/**
 * G1 KEYSTONE — the single audited content-DELETE choke point.
 *
 * DELETION POLICY (core_memory:hoj8fvmbt7d14mskciba): hard-deleting graph
 * CONTENT is permitted ONLY through this QA-gated primitive — never
 * blind/ad-hoc. Every content DELETE in the codebase MUST flow through
 * gcHardDelete; the D4 lint (test/lint-no-delete-content-tables.test.ts)
 * fails CI on any `DELETE <content_table>` outside this file, and only
 * permits the sites here because each carries a `// GATED-GC:` marker.
 *
 * The five QA-gate primitives (all REAL — no stubs):
 *   (1) blast-radius      — co-delete EVERY incident edge across all 26
 *                           relation tables; NULL the COMPLETE set of scalar
 *                           back-pointers (4× superseded_by, resolved_by,
 *                           causal_chain trigger/outcome_memory, and the
 *                           *.memory_id refs) on surviving rows so nothing is
 *                           left dangling. after-verify re-checks every one.
 *   (2) genuinely-dead    — caller supplies the dead-set; this helper
 *                           additionally REFUSES to delete a correction
 *                           memory (defense in depth — a correction is
 *                           never garbage).
 *   (3) reversible        — per-batch in-process SELECT-and-write snapshot
 *                           of the target rows AND all incident edges to a
 *                           timestamped re-importable file under
 *                           <cacheDir>/gc-backups/. (The master full-DB
 *                           export is the separate disaster net.)
 *   (4) after-verify      — throw (and DO NOT claim success) unless: targets
 *                           are gone, NO surviving edge has in/out ∈ ids,
 *                           and no surviving row has superseded_by ∈ ids.
 *   (5) audit trail       — a maintenance_runs row records the op.
 *
 * BINDING NOTE (load-bearing — verified against surreal.ts:1468 +
 * what-is-missing.ts:123): this SurrealDB engine silently NO-OPs
 * `WHERE id IN $list` when $list is a string array — it treats the strings
 * as literals, not record references. The established idiom (bumpAccessCounts,
 * fetchAccessDeltas) is to VALIDATE each id with RECORD_ID_RE and then
 * DIRECTLY INTERPOLATE the canonical `table:key` tokens as a Thing list
 * (`IN [concept:a, concept:b]`). We do the same — every interpolated token is
 * RECORD_ID_RE-validated first, so interpolation is injection-safe.
 *
 * CARDINAL: this primitive is the ONLY place a content DELETE may live. Do
 * not loosen the D4 regex to permit DELETEs elsewhere — that re-opens the
 * 2026-04-06 silent-data-loss class (LaqrumBrain fork commit 5b93d73 destroyed
 * user memory for ~6 weeks). Add new gated sites here with a `// GATED-GC:`
 * marker, never by blanket-whitelisting a file.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { GlobalPluginState } from "./state.js";
import { RECORD_ID_RE, swallow } from "./errors.js";
import { parseDatetimeMs } from "./observability.js";

/**
 * Content-bearing tables. MUST stay in lockstep with CONTENT_TABLES in
 * test/lint-no-delete-content-tables.test.ts (the D4 lint). A table absent
 * here cannot be hard-deleted through this keystone.
 */
export const GC_CONTENT_TABLES = [
  "memory",
  "concept",
  "skill",
  "reflection",
  "monologue",
  "identity_chunk",
  "core_memory",
  "artifact",
  "turn_archive",
  "pending_work",
] as const;

export type GcContentTable = (typeof GC_CONTENT_TABLES)[number];

/**
 * Every RELATION table declared in src/engine/schema.surql (lines 240–636,
 * enumerated 2026-06-21). An edge row has `in` and `out` record fields; an
 * incident edge is any row whose `in` OR `out` is in the deleted id set.
 * ALL of these are swept on every hard delete so no dangling edge survives.
 *
 * Turn-level:   responds_to, part_of, mentions
 * 5-pillar:     performed, owns, task_part_of, session_task, produced,
 *               derived_from, relevant_to, used_in
 * knowledge:    narrower, broader, related_to, caused_by, supports,
 *               contradicts, describes, supersedes, about_concept,
 *               artifact_mentions
 * skill:        skill_from_task, skill_uses_concept
 * reflection:   reflects_on
 * subagent:     spawned, spawned_from
 */
export const RELATION_TABLES = [
  "responds_to",
  "part_of",
  "mentions",
  "performed",
  "owns",
  "task_part_of",
  "session_task",
  "produced",
  "derived_from",
  "relevant_to",
  "used_in",
  "narrower",
  "broader",
  "related_to",
  "caused_by",
  "supports",
  "contradicts",
  "describes",
  "supersedes",
  "about_concept",
  "artifact_mentions",
  "skill_from_task",
  "skill_uses_concept",
  "reflects_on",
  "spawned",
  "spawned_from",
] as const;

/**
 * Tables carrying a scalar (non-edge) RECORD back-pointer that can reference
 * a deleted id. When a target is deleted, any SURVIVING row of these tables
 * whose back-pointer points at a deleted id is reconciled (set to NONE) so
 * no scalar dangling reference survives.
 *
 * COMPLETE set (cross-checked against schema.surql 2026-06-21 — every scalar
 * RECORD reference to a content id). After-verify asserts each is NONE post-delete.
 *
 *   memory.superseded_by         → record<memory>      (schema.surql:193)
 *   concept.superseded_by        → record (any)         (schema.surql:972)
 *   skill.superseded_by          → record<skill>       (schema.surql:539)
 *   reflection.superseded_by     → record<reflection>  (schema.surql:570)
 *   memory_utility_cache.memory_id → option<record> (any) (schema.surql:444)
 */
const RECORD_BACKPOINTERS: Array<{ table: string; field: string }> = [
  { table: "memory", field: "superseded_by" },
  { table: "concept", field: "superseded_by" },
  { table: "skill", field: "superseded_by" },
  { table: "reflection", field: "superseded_by" },
  // option<record> ANY — a deleted id of ANY content table (not just memory)
  // can dangle here, so this is reconciled on every delete. (GAP-1 fix)
  { table: "memory_utility_cache", field: "memory_id" },
];

/**
 * STRING-typed back-pointers (stored as the `table:key` string, not a Thing).
 * Reconciled with a string-membership comparison against the deleted ids —
 * string binding via $param is correct for these (unlike record-id IN $list).
 * COMPLETE set (cross-checked against schema.surql 2026-06-21).
 *
 *   memory.resolved_by               → string         (schema.surql:186)
 *   causal_chain.trigger_memory      → string         (schema.surql:496)
 *   causal_chain.outcome_memory      → string         (schema.surql:497)
 *   retrieval_outcome.memory_id      → string         (schema.surql:312)
 *   compaction_checkpoint.memory_id  → option<string> (schema.surql:420)
 */
const STRING_BACKPOINTERS: Array<{ table: string; field: string }> = [
  { table: "memory", field: "resolved_by" },
  // causal_chain is DURABLE synthesized knowledge (feeds skill graduation) and
  // holds memory: ids as strings; causal.ts:249-256 already sweeps these on the
  // SOFT path, so a hard delete MUST reconcile them too or it dangles. (GAP-1)
  { table: "causal_chain", field: "trigger_memory" },
  { table: "causal_chain", field: "outcome_memory" },
  // Volatile telemetry/checkpoint string refs — NULL'd so the "nothing
  // dangling" after-verify is honest (rows regenerate downstream). (GAP-1)
  { table: "retrieval_outcome", field: "memory_id" },
  { table: "compaction_checkpoint", field: "memory_id" },
];

export interface GcHardDeleteResult {
  /** Number of target content rows actually removed. */
  deleted: number;
  /** Number of incident edge rows co-deleted across all relation tables. */
  edgesRemoved: number;
  /** Absolute path of the reversible per-batch snapshot file ("" on no-op). */
  snapshot: string;
}

export interface GcHardDeleteOpts {
  /** Required human-readable reason — recorded in the snapshot + audit row. */
  reason: string;
}

/** Resolve the gc-backups directory under the configured cache dir. */
function gcBackupDir(state: GlobalPluginState): string {
  const cacheDir =
    state.config?.paths?.cacheDir ?? join(homedir(), ".laqrumcode", "cache");
  return join(cacheDir, "gc-backups");
}

/** A filename-safe slug of the reason for the snapshot filename. */
function slugifyReason(reason: string): string {
  const slug = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "gc";
}

/**
 * H2 — gc-backups retention sweep.
 *
 * Every destructive keystone op (gcHardDelete + gcSweepOrphanedEdges) writes a
 * timestamped `.surql` snapshot under <cacheDir>/gc-backups/ for reversibility.
 * The 6h maintenance cycle's monologue/turn_archive purges fire up to 100
 * batches each, and each batch is one snapshot — so on a long-lived single-host
 * install the directory accumulates FOREVER. Nothing pruned it before this.
 *
 * These snapshot files are BACKUP ARTIFACTS, NOT graph content (they are not a
 * content-table row and not swept by the orphaned-edge sweep), so pruning them
 * is a plain `unlinkSync` — it does NOT and MUST NOT route through the
 * gcHardDelete keystone (that is for content-table ROWS).
 *
 * Retention policy (keep the SMALLER of two windows, then a total-size cap):
 *   - COUNT cap: keep the newest {@link GC_BACKUP_KEEP_COUNT} (50) snapshots.
 *   - AGE cap:   keep snapshots newer than {@link GC_BACKUP_KEEP_DAYS} (30d).
 *   - SIZE cap:  if the surviving set still exceeds {@link GC_BACKUP_MAX_BYTES}
 *                (500MB), delete oldest-first until under it.
 * "Whichever is smaller" = a snapshot is a deletion CANDIDATE if it is BOTH
 * beyond the count window AND older than the age window is NOT required — we
 * delete a file if it fails EITHER the count test OR the age test (the union of
 * the two prune sets = the smaller surviving set). Then size trims further.
 *
 * SAFETY FLOOR (paramount — never destroy a just-made backup): a snapshot
 * younger than {@link GC_BACKUP_MIN_AGE_MS} (24h) is NEVER deleted, regardless
 * of count/size pressure. So the reversibility net for any recent destructive op
 * is always intact. (If a flood of recent deletes blows past the size cap inside
 * 24h, we let the dir exceed the cap rather than delete a fresh backup — disk is
 * cheaper than an un-restorable delete.)
 *
 * Returns the number of snapshot files deleted (so runJob records it as
 * rows_affected). Store-guard is NOT needed (pure filesystem) but we keep the
 * dir-missing case a clean 0. Errors per-file are swallowed; a single bad stat
 * never aborts the sweep.
 */
export const GC_BACKUP_KEEP_COUNT = 50;
export const GC_BACKUP_KEEP_DAYS = 30;
export const GC_BACKUP_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h hard floor
export const GC_BACKUP_MAX_BYTES = 500 * 1024 * 1024; // 500MB total-size cap

export async function sweepGcBackups(state: GlobalPluginState): Promise<number> {
  const dir = gcBackupDir(state);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Dir doesn't exist yet (no destructive op has ever run) → nothing to prune.
    return 0;
  }

  const now = Date.now();
  // Collect our own snapshot files only (gc-*.surql), with size + mtime. Ignore
  // anything else a user might have dropped in the dir.
  type Snap = { path: string; mtimeMs: number; size: number };
  const snaps: Snap[] = [];
  for (const name of entries) {
    if (!name.startsWith("gc-") || !name.endsWith(".surql")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      snaps.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* vanished/raced — skip */ }
  }
  if (snaps.length === 0) return 0;

  // Newest first so index < KEEP_COUNT == "within the count window".
  snaps.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const ageCutoff = now - GC_BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;

  // Phase 1: a file is a delete candidate if it fails the count window OR the
  // age window — but ONLY if it is also past the 24h safety floor.
  const toDelete = new Set<string>();
  snaps.forEach((s, i) => {
    if (now - s.mtimeMs < GC_BACKUP_MIN_AGE_MS) return; // protected: too fresh
    const overCount = i >= GC_BACKUP_KEEP_COUNT;
    const tooOld = s.mtimeMs < ageCutoff;
    if (overCount || tooOld) toDelete.add(s.path);
  });

  // Phase 2: total-size cap on the SURVIVING set. Delete oldest-first (still
  // respecting the 24h floor) until under GC_BACKUP_MAX_BYTES.
  let survivingBytes = 0;
  for (const s of snaps) if (!toDelete.has(s.path)) survivingBytes += s.size;
  if (survivingBytes > GC_BACKUP_MAX_BYTES) {
    // Oldest-first among survivors that are past the floor.
    const survivorsOldestFirst = snaps
      .filter((s) => !toDelete.has(s.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const s of survivorsOldestFirst) {
      if (survivingBytes <= GC_BACKUP_MAX_BYTES) break;
      if (now - s.mtimeMs < GC_BACKUP_MIN_AGE_MS) continue; // protected
      toDelete.add(s.path);
      survivingBytes -= s.size;
    }
  }

  let removed = 0;
  for (const path of toDelete) {
    try {
      unlinkSync(path);
      removed++;
    } catch (e) {
      swallow("gc:sweepGcBackups:unlink", e);
    }
  }
  // No explicit log line here (gc.ts deliberately doesn't import the logger).
  // The runJob wrapper in maintenance.ts records `removed` as rows_affected,
  // which is the observable signal memory_health/operators read.
  return removed;
}

/**
 * Serialize one row to a re-importable `CREATE <table:key> CONTENT { ... }`
 * statement. SurrealDB record-id values + datetimes are stringified; the goal
 * is a human-auditable, manually-re-importable artifact (NOT a perfect binary
 * round-trip — the master full export is the lossless disaster net).
 */
function rowToCreateStatement(row: Record<string, unknown>): string | null {
  const id = row.id;
  const idStr = id == null ? "" : String(id);
  if (!idStr) return null;
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "id") continue;
    content[k] = v;
  }
  // JSON replacer stringifies any non-plain value (RecordId objects,
  // Date/DateTime) so the dump is valid for inspection / manual re-import.
  const json = JSON.stringify(content, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
      if (ctor && ctor !== "Object") return String(value);
    }
    return value;
  });
  return `CREATE ${idStr} CONTENT ${json};`;
}

/**
 * G1 KEYSTONE primitive. Hard-delete `ids` from `table` (a content table)
 * with full QA-gate guarantees. See the file header for the contract.
 *
 * Throws (and does NOT claim success) on: invalid table, malformed id, a
 * correction memory in the dead-set, or a failed after-verify (dangling edge
 * or scalar back-pointer would remain). On after-verify failure the snapshot
 * path is logged so the rows can be manually re-imported.
 *
 * No-ops (returns deleted:0, snapshot:"") on an empty id list.
 */
export async function gcHardDelete(
  state: GlobalPluginState,
  table: string,
  ids: string[],
  opts: GcHardDeleteOpts,
): Promise<GcHardDeleteResult> {
  const started = Date.now();
  const store = state.store;

  // ---- Guard: reason ----
  const reason = (opts?.reason ?? "").trim();
  if (!reason) {
    throw new Error("gcHardDelete: opts.reason is required (audit + snapshot label).");
  }

  // ---- Guard: table allowlist ----
  if (!(GC_CONTENT_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `gcHardDelete: table "${table}" is not a content table. ` +
        `Allowed: ${GC_CONTENT_TABLES.join(", ")}.`,
    );
  }

  // ---- No-op on empty ----
  const uniqueIds = Array.from(new Set(ids ?? []));
  if (uniqueIds.length === 0) {
    return { deleted: 0, edgesRemoved: 0, snapshot: "" };
  }

  // ---- Guard: every id is a well-formed record id of THIS table ----
  for (const id of uniqueIds) {
    if (typeof id !== "string" || !RECORD_ID_RE.test(id)) {
      throw new Error(`gcHardDelete: "${String(id)}" is not a valid record id.`);
    }
    const tb = id.slice(0, id.indexOf(":"));
    if (tb !== table) {
      throw new Error(
        `gcHardDelete: id "${id}" belongs to table "${tb}", not "${table}".`,
      );
    }
  }

  // ---- Guard (defense in depth): NEVER delete a correction memory ----
  // The caller is responsible for excluding corrections from the dead-set,
  // but a correction is the highest-signal memory and is never garbage —
  // refuse even if the caller mistakenly included one.
  const corrections = await findCorrectionIds(state, table, uniqueIds);
  if (corrections.length > 0) {
    throw new Error(
      `gcHardDelete: refusing to delete correction memory rows (never garbage): ` +
        `${corrections.join(", ")}. Exclude corrections from the dead-set.`,
    );
  }

  // The injection-safe Thing list. Every token passed RECORD_ID_RE above, so
  // direct interpolation is safe AND it is the ONLY binding form that this
  // engine treats as record references (string-array $binds silently no-op —
  // surreal.ts:1468). Used for `id IN [...]`, `in IN [...]`, `out IN [...]`,
  // and `superseded_by IN [...]`.
  const idList = uniqueIds.join(", ");
  const idStrings = uniqueIds; // canonical strings, for the string back-pointer

  // =====================================================================
  // (a) PER-BATCH SNAPSHOT — reversibility. In-process SELECT-and-write of
  //     the target rows AND all incident edges. Do NOT shell out to
  //     `surreal export` per call (the master full export is the disaster
  //     net); this is a bounded re-importable artifact for THIS batch.
  // =====================================================================
  const targetRows = await store.queryFirst<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE id IN [${idList}]`,
  );

  const snapshotLines: string[] = [];
  snapshotLines.push(`-- laqrumcode gcHardDelete snapshot`);
  snapshotLines.push(`-- reason: ${reason}`);
  snapshotLines.push(`-- table: ${table}`);
  snapshotLines.push(`-- ids: ${idStrings.join(", ")}`);
  snapshotLines.push(`-- generated_at: ${new Date().toISOString()}`);
  snapshotLines.push(`-- To restore: import these CREATE statements (and re-RELATE the edges below).`);
  snapshotLines.push(``);
  snapshotLines.push(`-- ===== TARGET ROWS (${table}) =====`);
  for (const row of targetRows) {
    const stmt = rowToCreateStatement(row);
    if (stmt) snapshotLines.push(stmt);
  }

  // Snapshot incident edges across ALL relation tables BEFORE deleting them.
  snapshotLines.push(``);
  snapshotLines.push(`-- ===== INCIDENT EDGES =====`);
  for (const edgeTb of RELATION_TABLES) {
    const edges = await store.queryFirst<Record<string, unknown>>(
      `SELECT * FROM ${edgeTb} WHERE in IN [${idList}] OR out IN [${idList}]`,
    );
    if (edges.length === 0) continue;
    snapshotLines.push(`-- ${edgeTb} (${edges.length})`);
    for (const e of edges) {
      const stmt = rowToCreateStatement(e);
      if (stmt) snapshotLines.push(stmt);
    }
  }

  // Write the snapshot to disk. A snapshot-write failure ABORTS the delete
  // (reversibility is non-negotiable) — throw rather than proceed.
  const dir = gcBackupDir(state);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(dir, `gc-${slugifyReason(reason)}-${ts}.surql`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath, snapshotLines.join("\n") + "\n", "utf-8");
  } catch (e) {
    throw new Error(
      `gcHardDelete: snapshot write failed (${String(e)}). Aborting delete — ` +
        `reversibility is required before any content DELETE.`,
    );
  }

  // =====================================================================
  // (b) BLAST-RADIUS — co-delete every incident edge across ALL relation
  //     tables, then NULL third-party scalar back-pointers on survivors.
  // =====================================================================
  let edgesRemoved = 0;
  for (const edgeTb of RELATION_TABLES) {
    // Count first so the return value is exact (DELETE returns [] by default).
    const before = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${edgeTb} WHERE in IN [${idList}] OR out IN [${idList}] GROUP ALL`,
    );
    const n = before[0]?.n ?? 0;
    if (n === 0) continue;
    // GATED-GC: incident-edge co-delete (blast-radius). Always WHERE-bounded.
    await store.queryExec(
      `DELETE ${edgeTb} WHERE in IN [${idList}] OR out IN [${idList}]`, // GATED-GC: edge sweep
    );
    edgesRemoved += n;
  }

  // NULL scalar RECORD back-pointers on SURVIVING rows pointing at a deleted id.
  for (const { table: bpTable, field } of RECORD_BACKPOINTERS) {
    await store.queryExec(
      `UPDATE ${bpTable} SET ${field} = NONE WHERE ${field} IN [${idList}]`,
    );
  }
  // NULL STRING-typed back-pointers (compared as strings — $bind is correct here).
  for (const { table: bpTable, field } of STRING_BACKPOINTERS) {
    await store.queryExec(
      `UPDATE ${bpTable} SET ${field} = NONE WHERE ${field} IN $idStrings`,
      { idStrings },
    );
  }

  // =====================================================================
  // (c) DELETE — bounded, always WHERE (never trips edit-gates' DELETE-
  //     without-WHERE bash gate). This is the ONE content DELETE site.
  // =====================================================================
  // GATED-GC: the single audited content-table hard delete (the G1 keystone).
  await store.queryExec(
    `DELETE ${table} WHERE id IN [${idList}]`, // GATED-GC: content delete (keystone)
  );
  const deleted = targetRows.length;

  // =====================================================================
  // (d) AFTER-VERIFY — throw + DO NOT claim success if any check fails.
  // =====================================================================
  const verifyFailures: string[] = [];

  // (d1) Targets are gone.
  const survivingTargets = await store.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM ${table} WHERE id IN [${idList}] GROUP ALL`,
  );
  if ((survivingTargets[0]?.n ?? 0) > 0) {
    verifyFailures.push(`${survivingTargets[0]?.n} target row(s) still present in ${table}`);
  }

  // (d2) NO surviving edge references a deleted id (zero dangling).
  for (const edgeTb of RELATION_TABLES) {
    const dangling = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${edgeTb} WHERE in IN [${idList}] OR out IN [${idList}] GROUP ALL`,
    );
    if ((dangling[0]?.n ?? 0) > 0) {
      verifyFailures.push(`${dangling[0]?.n} dangling edge(s) in ${edgeTb}`);
    }
  }

  // (d3) No surviving row has a scalar back-pointer ∈ ids.
  for (const { table: bpTable, field } of RECORD_BACKPOINTERS) {
    const dangling = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${bpTable} WHERE ${field} IN [${idList}] GROUP ALL`,
    );
    if ((dangling[0]?.n ?? 0) > 0) {
      verifyFailures.push(`${dangling[0]?.n} dangling ${bpTable}.${field} back-pointer(s)`);
    }
  }
  for (const { table: bpTable, field } of STRING_BACKPOINTERS) {
    const dangling = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${bpTable} WHERE ${field} IN $idStrings GROUP ALL`,
      { idStrings },
    );
    if ((dangling[0]?.n ?? 0) > 0) {
      verifyFailures.push(`${dangling[0]?.n} dangling ${bpTable}.${field} back-pointer(s)`);
    }
  }

  if (verifyFailures.length > 0) {
    throw new Error(
      `gcHardDelete after-verify FAILED — graph may be in a partial state:\n` +
        verifyFailures.map((f) => `  - ${f}`).join("\n") +
        `\nSnapshot for manual restore: ${snapshotPath}`,
    );
  }

  // =====================================================================
  // (e) AUDIT — record a maintenance_runs row. Best-effort: a logging
  //     failure must not undo a verified-clean delete.
  // =====================================================================
  try {
    await store.queryExec(`CREATE maintenance_runs CONTENT $data`, {
      data: {
        op: "gcHardDelete",
        job: "gcHardDelete",
        table,
        reason,
        deleted,
        edgesRemoved,
        rows_affected: deleted,
        duration_ms: Date.now() - started,
      },
    });
  } catch (e) {
    swallow("gc:recordMaintenanceRun", e);
  }

  return { deleted, edgesRemoved, snapshot: snapshotPath };
}

/** An edge is ORPHANED iff a linked-record id dereferences to NONE — i.e. the
 *  endpoint record is ABSENT (hard-deleted / never-existed). A SOFT-TAGGED
 *  endpoint still EXISTS, so its id resolves and the edge is NOT caught (those
 *  are handled by the graphExpand read-path liveness filter G3, never deleted). */
const ORPHAN_PRED = "in.id IS NONE OR out.id IS NONE";
const BOTH_LIVE_PRED = "in.id IS NOT NONE AND out.id IS NOT NONE";

export interface GcSweepResult {
  /** Relation tables scanned. */
  scanned: number;
  /** Orphaned edges found. */
  orphaned: number;
  /** Orphaned edges removed (0 on dryRun). */
  removed: number;
  /** Per-table orphan counts. */
  perTable: Record<string, number>;
  /** Snapshot path ("" if no orphans). */
  snapshot: string;
  dryRun: boolean;
  /** E13: true when a scheduled sweep was skipped by the weekly throttle
   *  (no scan performed). Distinct from a zero-orphan no-op, which DID scan. */
  throttled?: boolean;
}

/** E13: minimum interval between scheduled (non-forced) full sweeps. The 6h
 *  maintenance cycle calls gcSweepOrphanedEdges every cycle; at a large
 *  per-install graph that is 26 full edge-table scans (each row's
 *  `in.id IS NONE OR out.id IS NONE` fans out to an endpoint lookup) ~4x/day for
 *  what is normally a zero-orphan no-op. The keystone (gcHardDelete) co-deletes
 *  incident edges in the same op and the D4 lint blocks ad-hoc content DELETEs,
 *  so new orphans stay ~0 — there is nothing for a frequent sweep to find.
 *  Throttle the *scheduled* cadence to weekly; the post-content-delete trailing
 *  sweep passes force:true to bypass this (it MUST run right after a delete to
 *  catch any edge that delete just orphaned). */
const SWEEP_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * G2 — orphaned-edge sweep. Delete EDGE rows whose `in` OR `out` endpoint
 * record no longer exists (true danglers: residue of pre-v0.7.93 DELETE-based
 * concept GC + bulk imports). Graph hygiene, NOT a content delete — relation
 * tables are not content-bearing, so this is lint-legal — but it still follows
 * the QA gate: snapshot the danglers first, then after-verify.
 *
 * Detector VERIFIED live (2026-06-21, populated DB): orphan + both-endpoints-
 * live == total per table (exhaustive + disjoint, zero false positives; 309
 * orphans concentrated in concept-edge tables). after-verify throws unless every
 * swept table's orphan count is 0 AND its both-live count did NOT DROP (we
 * removed only danglers — robust to concurrent inserts that only raise it).
 *
 * E13: scheduled (non-forced, non-dryRun) calls are throttled to a weekly
 * cadence (SWEEP_MIN_INTERVAL_MS) — pass force:true for the trailing sweep
 * after a content node delete, which must run immediately.
 *
 * Reusable: also the trailing sweep to call after a content node delete.
 */
export async function gcSweepOrphanedEdges(
  state: GlobalPluginState,
  opts: { dryRun?: boolean; reason?: string; force?: boolean } = {},
): Promise<GcSweepResult> {
  const started = Date.now();
  const store = state.store;
  const reason = (opts.reason ?? "orphaned-edge sweep").trim() || "orphaned-edge sweep";
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  // E13 throttle: skip a scheduled sweep if a prior sweep ran within the
  // interval. force:true (post-delete trailing sweep) and dryRun (inspection)
  // always bypass — neither should be gated. Best-effort: a query failure
  // falls through and the sweep runs (never worse than the pre-E13 behavior).
  if (!force && !dryRun) {
    try {
      const last = await store.queryFirst<{ ran_at: string }>(
        `SELECT ran_at FROM maintenance_runs WHERE job = 'gcSweepOrphanedEdges' ORDER BY ran_at DESC LIMIT 1`,
      );
      const lastRanAt = last[0]?.ran_at != null ? parseDatetimeMs(last[0].ran_at) : null;
      if (lastRanAt != null) {
        const ageMs = Date.now() - lastRanAt;
        if (ageMs >= 0 && ageMs < SWEEP_MIN_INTERVAL_MS) {
          return { scanned: 0, orphaned: 0, removed: 0, perTable: {}, snapshot: "", dryRun, throttled: true };
        }
      }
    } catch (e) {
      swallow("gc:sweepOrphanedEdges:throttle", e);
    }
  }

  const perTable: Record<string, number> = {};
  const baselineLive: Record<string, number> = {};
  const snapshotLines: string[] = [
    `-- laqrumcode gcSweepOrphanedEdges snapshot`,
    `-- reason: ${reason}`,
    `-- generated_at: ${new Date().toISOString()}`,
    `-- detector: ${ORPHAN_PRED} (absent endpoint record)`,
    `-- To restore: re-CREATE the edge rows below (they carry in/out).`,
    ``,
  ];
  let orphaned = 0;

  // 1. Detect orphans per table + capture the both-live baseline (after-verify).
  for (const edgeTb of RELATION_TABLES) {
    const orphRows = await store.queryFirst<Record<string, unknown>>(
      `SELECT * FROM ${edgeTb} WHERE ${ORPHAN_PRED}`,
    );
    const live = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${edgeTb} WHERE ${BOTH_LIVE_PRED} GROUP ALL`,
    );
    baselineLive[edgeTb] = live[0]?.n ?? 0;
    if (orphRows.length === 0) continue;
    perTable[edgeTb] = orphRows.length;
    orphaned += orphRows.length;
    snapshotLines.push(`-- ${edgeTb} (${orphRows.length})`);
    for (const row of orphRows) {
      const stmt = rowToCreateStatement(row);
      if (stmt) snapshotLines.push(stmt);
    }
  }

  if (orphaned === 0) {
    // E13 heartbeat: the steady state is zero orphans, and the pre-E13 code
    // wrote an audit row ONLY when it deleted something (step 5). With the
    // weekly throttle reading the last `gcSweepOrphanedEdges` ran_at, a no-op
    // scan MUST leave a row or the throttle never engages and we scan every
    // cycle anyway. Record a lightweight ok/0 row here (skipped on dryRun —
    // inspection must not reset the throttle clock). Best-effort.
    if (!dryRun) {
      try {
        await store.queryExec(`CREATE maintenance_runs CONTENT $data`, {
          data: {
            op: "gcSweepOrphanedEdges",
            job: "gcSweepOrphanedEdges",
            reason,
            removed: 0,
            rows_affected: 0,
            duration_ms: Date.now() - started,
          },
        });
      } catch (e) {
        swallow("gc:sweepOrphanedEdges:heartbeat", e);
      }
    }
    return { scanned: RELATION_TABLES.length, orphaned: 0, removed: 0, perTable, snapshot: "", dryRun };
  }

  // 2. Snapshot (reversibility) — write failure ABORTS before any delete.
  const dir = gcBackupDir(state);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(dir, `gc-orphan-edges-${ts}.surql`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath, snapshotLines.join("\n") + "\n", "utf-8");
  } catch (e) {
    throw new Error(`gcSweepOrphanedEdges: snapshot write failed (${String(e)}). Aborting.`);
  }

  if (dryRun) {
    return { scanned: RELATION_TABLES.length, orphaned, removed: 0, perTable, snapshot: snapshotPath, dryRun };
  }

  // 3. Delete the orphaned edges, table by table.
  let removed = 0;
  for (const edgeTb of Object.keys(perTable)) {
    // Edge table (not content) — lint-legal, but routed through the QA snapshot
    // above + after-verify below. The marker is required because the lint's
    // DYNAMIC_DELETE_RE catches the `DELETE ${edgeTb}` template form.
    await store.queryExec(`DELETE ${edgeTb} WHERE ${ORPHAN_PRED}`); // GATED-GC: orphaned-edge sweep
    removed += perTable[edgeTb];
  }

  // 4. After-verify: orphans gone AND no table's both-live count DROPPED.
  const failures: string[] = [];
  for (const edgeTb of Object.keys(perTable)) {
    const remain = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${edgeTb} WHERE ${ORPHAN_PRED} GROUP ALL`,
    );
    if ((remain[0]?.n ?? 0) > 0) failures.push(`${remain[0]?.n} orphan(s) remain in ${edgeTb}`);
    const liveNow = await store.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM ${edgeTb} WHERE ${BOTH_LIVE_PRED} GROUP ALL`,
    );
    if ((liveNow[0]?.n ?? 0) < baselineLive[edgeTb]) {
      failures.push(
        `${edgeTb} both-live DROPPED ${baselineLive[edgeTb]} -> ${liveNow[0]?.n} (a LIVE edge was wrongly removed!)`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `gcSweepOrphanedEdges after-verify FAILED:\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        `\nSnapshot for manual restore: ${snapshotPath}`,
    );
  }

  // 5. Audit.
  try {
    await store.queryExec(`CREATE maintenance_runs CONTENT $data`, {
      data: {
        op: "gcSweepOrphanedEdges",
        job: "gcSweepOrphanedEdges",
        reason,
        removed,
        rows_affected: removed,
        duration_ms: Date.now() - started,
      },
    });
  } catch (e) {
    swallow("gc:sweepOrphanedEdges:audit", e);
  }

  return { scanned: RELATION_TABLES.length, orphaned, removed, perTable, snapshot: snapshotPath, dryRun };
}

/**
 * NEVER-DELETE-A-CORRECTION guard, extracted so the G1 unit test can exercise
 * it directly. Returns the subset of `ids` that are correction memories.
 *
 * Corrections are tagged category="correction" (record-finding.ts:76 composes
 * `[${TYPE}] text`; commit.ts:1114 sets category="correction"). A correction
 * is the highest-signal memory and is never garbage. Only the `memory` table
 * carries corrections; other content tables return [].
 */
export async function findCorrectionIds(
  state: GlobalPluginState,
  table: string,
  ids: string[],
): Promise<string[]> {
  if (table !== "memory") return [];
  const valid = (ids ?? []).filter((i) => typeof i === "string" && RECORD_ID_RE.test(i));
  if (valid.length === 0) return [];
  const idList = valid.join(", ");
  const rows = await state.store.queryFirst<{ id: unknown }>(
    `SELECT id FROM memory
       WHERE id IN [${idList}]
         AND (category = 'correction' OR string::starts_with(text, '[CORRECTION]'))`,
  );
  return rows.map((r) => String(r.id));
}
