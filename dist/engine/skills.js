/**
 * Procedural Memory (Skill Library)
 *
 * When the agent successfully completes a multi-step task, extract the procedure
 * as a reusable skill (preconditions, steps, postconditions, outcome).
 * Next time a similar task is requested, inject the proven procedure as context.
 * Skills earn success/failure counts from outcomes — RL-like reinforcement.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */
import { swallow, safeId } from "./errors.js";
import { assertRecordId } from "./surreal.js";
// --- Supersession ---
/**
 * After saving a new skill, fade similar existing skills above similarity
 * threshold — but ONLY same-named ones. Supersession means "this row REPLACES
 * the old one"; different-named skills are coexistent siblings even when their
 * embeddings are close. Without the name guard, long procedural-skill bodies
 * routinely cleared the 0.82 cosine threshold and unrelated skills nuked each
 * other (verified 2026-05-17: dockex-docker-build had wrongly deactivated
 * kongcode-health, extract-pdf-gems, and kongcode-backup-semantic).
 */
export async function supersedeOldSkills(newSkillId, newName, newEmb, store) {
    if (!newEmb.length || !newName || !store.isAvailable())
        return;
    try {
        const rows = await store.queryFirst(`SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE id != type::record($sid)
         AND name = $newName
         AND (active = NONE OR active = true)
         AND embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT 5`, { vec: newEmb, sid: newSkillId, newName });
        for (const row of rows) {
            if ((row.score ?? 0) >= 0.82) {
                try {
                    assertRecordId(String(row.id));
                    assertRecordId(newSkillId);
                    // skill.superseded_by is `option<record<skill>>` — SurrealDB's
                    // type coercer rejects bare strings against record-typed fields,
                    // so use type::record($val) to parse the string id back into a
                    // Thing on the server side. Same pattern as supersedes.ts for
                    // concept.superseded_by after the 2026-05-13 retype migration.
                    await store.queryExec(`UPDATE ${row.id} SET active = false, superseded_by = type::record($newId)`, { newId: newSkillId });
                }
                catch (e) {
                    swallow("skills:supersede", e);
                }
            }
        }
    }
    catch (e) {
        swallow.warn("skills:supersedeOld", e);
    }
}
// --- Skill Retrieval ---
/**
 * Vector search on the skill table. Called from graphTransformContext
 * when the intent is code-write, code-debug, or multi-step.
 */
export async function findRelevantSkills(queryVec, limit = 3, store) {
    if (!store?.isAvailable())
        return [];
    try {
        const rows = await store.queryFirst(`SELECT id, name, description, preconditions, steps, postconditions,
              success_count AS successCount, failure_count AS failureCount,
              avg_duration_ms AS avgDurationMs, confidence,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE embedding != NONE AND array::len(embedding) > 0 AND (active = NONE OR active = true)
       ORDER BY score DESC LIMIT $lim`, { vec: queryVec, lim: limit });
        return rows
            .filter((r) => (r.score ?? 0) > 0.4)
            .map((r) => ({
            id: safeId(r.id),
            name: r.name ?? "",
            description: r.description ?? "",
            preconditions: r.preconditions,
            steps: Array.isArray(r.steps) ? r.steps : [],
            postconditions: r.postconditions,
            successCount: Number(r.successCount ?? 1),
            failureCount: Number(r.failureCount ?? 0),
            avgDurationMs: Number(r.avgDurationMs ?? 0),
            confidence: Number(r.confidence ?? 1.0),
            active: r.active !== false,
            score: r.score,
        }))
            .filter((r) => r.id);
    }
    catch (e) {
        swallow.warn("skills:find", e);
        return [];
    }
}
/**
 * Format matched skills as a structured context block for the LLM.
 */
export function formatSkillContext(skills) {
    if (skills.length === 0)
        return "";
    const lines = skills.map((s) => {
        const total = s.successCount + s.failureCount;
        const rate = total > 0 ? `${s.successCount}/${total} successful` : "new";
        const stepsStr = s.steps
            .map((step, i) => `  ${i + 1}. [${step.tool}] ${step.description}`)
            .join("\n");
        return `### ${s.name} (${rate})\n${s.description}\n${s.preconditions ? `Pre: ${s.preconditions}\n` : ""}Steps:\n${stepsStr}${s.postconditions ? `\nPost: ${s.postconditions}` : ""}`;
    });
    return `\n<skill_context>\n[Previously successful procedures — adapt as needed, don't follow blindly]\n${lines.join("\n\n")}\n</skill_context>`;
}
/**
 * Record skill outcome when a retrieved skill is used in a turn.
 */
export async function recordSkillOutcome(skillId, success, durationMs, store) {
    if (!store.isAvailable())
        return;
    try {
        const field = success ? "success_count" : "failure_count";
        assertRecordId(skillId);
        // Direct interpolation safe: assertRecordId validates format above
        await store.queryExec(`UPDATE ${skillId} SET
        ${field} += 1,
        avg_duration_ms = (avg_duration_ms * (success_count + failure_count - 1) + $dur) / (success_count + failure_count),
        last_used = time::now()`, { dur: durationMs });
    }
    catch (e) {
        swallow("skills:non-critical", e);
    }
}
