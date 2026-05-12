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

import type { SurrealStore } from "./surreal.js";
import { swallow } from "./errors.js";
import { assertRecordId } from "./surreal.js";

// --- Types ---

export interface SkillStep {
  tool: string;
  description: string;
  argsPattern?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  preconditions?: string;
  steps: SkillStep[];
  postconditions?: string;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  confidence: number;
  active: boolean;
  score?: number;
}

// --- Supersession ---

/**
 * After saving a new skill, fade similar existing skills above similarity threshold.
 */
export async function supersedeOldSkills(
  newSkillId: string,
  newEmb: number[],
  store: SurrealStore,
): Promise<void> {
  if (!newEmb.length || !store.isAvailable()) return;
  try {
    const rows = await store.queryFirst<{ id: string; score: number }>(
      `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE id != $sid
         AND (active = NONE OR active = true)
         AND embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT 5`,
      { vec: newEmb, sid: newSkillId },
    );
    for (const row of rows) {
      if ((row.score ?? 0) >= 0.82) {
        try {
          assertRecordId(String(row.id));
          await store.queryExec(
            `UPDATE ${row.id} SET active = false, superseded_by = $newId`,
            { newId: newSkillId },
          );
        } catch (e) {
          swallow("skills:supersede", e);
        }
      }
    }
  } catch (e) { swallow.warn("skills:supersedeOld", e); }
}

// --- Skill Retrieval ---

/**
 * Vector search on the skill table. Called from graphTransformContext
 * when the intent is code-write, code-debug, or multi-step.
 */
export async function findRelevantSkills(
  queryVec: number[],
  limit = 3,
  store?: SurrealStore,
): Promise<Skill[]> {
  if (!store?.isAvailable()) return [];

  try {
    const rows = await store.queryFirst<any>(
      `SELECT id, name, description, preconditions, steps, postconditions,
              success_count AS successCount, failure_count AS failureCount,
              avg_duration_ms AS avgDurationMs, confidence,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE embedding != NONE AND array::len(embedding) > 0 AND (active = NONE OR active = true)
       ORDER BY score DESC LIMIT $lim`,
      { vec: queryVec, lim: limit },
    );

    return rows
      .filter((r: any) => (r.score ?? 0) > 0.4)
      .map((r: any) => ({
        id: String(r.id),
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
      }));
  } catch (e) {
    swallow.warn("skills:find", e);
    return [];
  }
}

/**
 * Format matched skills as a structured context block for the LLM.
 */
export function formatSkillContext(skills: Skill[]): string {
  if (skills.length === 0) return "";

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
export async function recordSkillOutcome(
  skillId: string,
  success: boolean,
  durationMs: number,
  store: SurrealStore,
): Promise<void> {
  if (!store.isAvailable()) return;

  try {
    const field = success ? "success_count" : "failure_count";
    assertRecordId(skillId);
    // Direct interpolation safe: assertRecordId validates format above
    await store.queryExec(
      `UPDATE ${skillId} SET
        ${field} += 1,
        avg_duration_ms = (avg_duration_ms * (success_count + failure_count - 1) + $dur) / (success_count + failure_count),
        last_used = time::now()`,
      { dur: durationMs },
    );
  } catch (e) { swallow("skills:non-critical", e); }
}

