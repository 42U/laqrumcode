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
 *                           relation tables; NULL third-party scalar
 *                           back-pointers (superseded_by/resolved_by) on
 *                           surviving rows so nothing is left dangling.
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
 * 2026-04-06 silent-data-loss class (KongBrain fork commit 5b93d73 destroyed
 * user memory for ~6 weeks). Add new gated sites here with a `// GATED-GC:`
 * marker, never by blanket-whitelisting a file.
 */
import type { GlobalPluginState } from "./state.js";
/**
 * Content-bearing tables. MUST stay in lockstep with CONTENT_TABLES in
 * test/lint-no-delete-content-tables.test.ts (the D4 lint). A table absent
 * here cannot be hard-deleted through this keystone.
 */
export declare const GC_CONTENT_TABLES: readonly ["memory", "concept", "skill", "reflection", "monologue", "identity_chunk", "core_memory", "artifact", "turn_archive", "pending_work"];
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
export declare const RELATION_TABLES: readonly ["responds_to", "part_of", "mentions", "performed", "owns", "task_part_of", "session_task", "produced", "derived_from", "relevant_to", "used_in", "narrower", "broader", "related_to", "caused_by", "supports", "contradicts", "describes", "supersedes", "about_concept", "artifact_mentions", "skill_from_task", "skill_uses_concept", "reflects_on", "spawned", "spawned_from"];
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
export declare function gcHardDelete(state: GlobalPluginState, table: string, ids: string[], opts: GcHardDeleteOpts): Promise<GcHardDeleteResult>;
/**
 * NEVER-DELETE-A-CORRECTION guard, extracted so the G1 unit test can exercise
 * it directly. Returns the subset of `ids` that are correction memories.
 *
 * Corrections are tagged category="correction" (record-finding.ts:76 composes
 * `[${TYPE}] text`; commit.ts:1114 sets category="correction"). A correction
 * is the highest-signal memory and is never garbage. Only the `memory` table
 * carries corrections; other content tables return [].
 */
export declare function findCorrectionIds(state: GlobalPluginState, table: string, ids: string[]): Promise<string[]>;
