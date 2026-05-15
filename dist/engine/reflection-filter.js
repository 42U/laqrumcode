/**
 * Reflection content filter — the canonical regex set used by every
 * reflection writer to decide whether a reflection should be dropped,
 * downgraded, or persisted as-is.
 *
 * Background: pre-v0.7.73, the reflection prompt invited anti-thoroughness
 * self-critique ("what could improve"), and the writer at
 * pending-work.ts:commitReflection had no filter — pathological reflections
 * (anti-thoroughness, save-summary/audit-log, work-completion status
 * reports) landed at importance 7 and poisoned every future retrieval.
 * v0.7.73 added the inline regex set at pending-work.ts and v0.7.74 cleaned
 * the 14 polluted rows on this workstation. The regex set lived in
 * pending-work.ts as private module-level constants.
 *
 * v0.7.76 extracts the constants here so commitReflection (now living in
 * commit.ts as the canonical write path) and any future writer share one
 * source of truth. Keeping two copies of these regexes in two writers is
 * exactly the drift pattern the campaign exists to close.
 *
 * Loose variants ('over-engineered', 'too verbose', 'burned tool calls',
 * 'keep responses tighter') extend the original strict regex set from the
 * user's v0.7.74 bug report — the manual sweep found multiple rows that
 * bypassed the strict set with these synonyms.
 */
export const REFLECTION_ANTI_THOROUGHNESS_RE = /should have (moved on faster|just acknowledged|rushed|skipped|moved faster)|overthinking it|too detailed|too thorough|rushed it less|acknowledge and move on|over-engineered|too verbose|more concise|shorter, punchier|burned (too many|most of the) tool|keep responses tighter/i;
export const REFLECTION_SAVE_SUMMARY_RE = /\ball saved\.|quoted ids from this turn|session totals:|\d+\s+concept gems across|edges_created\s*=\s*\d+/i;
export const REFLECTION_WORK_COMPLETION_RE = /fix verified end-to-end:|final loop summary|final state:|\d+\/\d+\s*tests|\d+\/\d+\s*postdeploy|calling it done/i;
/**
 * Classify a reflection text against the three pathology regex classes.
 *
 * - `"drop"`: anti-thoroughness match. Caller MUST NOT write the row.
 * - `"downgrade"`: save-summary or work-completion match. Caller writes the
 *   row but at importance 3 with no embedding (so it neither ranks in
 *   retrieval nor competes in dedup).
 * - `"ok"`: clean reflection. Caller writes at normal importance with
 *   embedding.
 */
export function classifyReflection(text) {
    if (REFLECTION_ANTI_THOROUGHNESS_RE.test(text))
        return "drop";
    if (REFLECTION_SAVE_SUMMARY_RE.test(text) || REFLECTION_WORK_COMPLETION_RE.test(text))
        return "downgrade";
    return "ok";
}
