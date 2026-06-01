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
import { swallow, safeId } from "./errors.js";
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
 * After saving a new skill, fade similar existing skills above similarity
 * threshold — but ONLY same-named ones. Supersession means "this row REPLACES
 * the old one"; different-named skills are coexistent siblings even when their
 * embeddings are close. Without the name guard, long procedural-skill bodies
 * routinely cleared the 0.82 cosine threshold and unrelated skills nuked each
 * other (verified 2026-05-17: dockex-docker-build had wrongly deactivated
 * kongcode-health, extract-pdf-gems, and kongcode-backup-semantic).
 */
export async function supersedeOldSkills(
  newSkillId: string,
  newName: string,
  newEmb: number[],
  store: SurrealStore,
): Promise<void> {
  if (!newEmb.length || !newName || !store.isAvailable()) return;
  try {
    const rows = await store.queryFirst<{ id: string; score: number }>(
      `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE id != type::record($sid)
         AND name = $newName
         AND (active = NONE OR active = true)
         AND embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT 5`,
      { vec: newEmb, sid: newSkillId, newName },
    );
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
          await store.queryExec(
            `UPDATE ${row.id} SET active = false, superseded_by = type::record($newId)`,
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

/** Local cosine (avoids a circular import of graph-context.cosineSimilarity,
 *  since graph-context imports from this module). Full cosine — does not assume
 *  unit-normalized vectors. */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// v0.8.x: HARD novelty gate for skill retrieval diversity.
// Soft MMR (λ·rel − (1−λ)·sim) was insufficient: live `recall(scope=skills)`
// for a focused query returned 8 variants of ONE "drain queue via subagent"
// procedure, because near-dups are all maximally relevant, so the soft penalty
// never demotes a 0.91-rel dup below a genuinely-distinct 0.55-rel skill.
// Instead: pick candidates by relevance, but REFUSE any candidate within
// SKILL_NOVELTY_MAX cosine of one already selected — a guarantee that no two
// injected skills are near-identical, regardless of relevance.
// Threshold measured on the live graph (2026-05-31). The corpus carries large
// REDUNDANT FAMILIES: the top 30 skills by cosine to "Drain pending work via
// subagent" are ALL drain-via-subagent rephrasings, spanning 0.82→1.0 to the
// canonical with internal pairwise spread down to ~0.70. Genuinely distinct
// skills are FAR below — the same drain skill is only 0.49–0.66 to JSON-parsing
// / version-bump / cache / embedding skills, and NOTHING distinct sits in the
// 0.66→1.0 band for that theme. So 0.72 cuts deep enough to collapse a redundant
// family to ~1–2 members (vs 8 before) while keeping a margin over the 0.66
// distinct ceiling. Returning fewer than `limit` is correct — better 2 distinct
// procedures than 8 phrasings of one. NOTE: this is a band-aid over a corpus
// problem (the families shouldn't exist); the real fix is a lower-threshold
// consolidation pass — see memory on skill redundancy.
const SKILL_NOVELTY_MAX = 0.72;

// v0.8.x step 2: cross-encoder rerank of the skill candidate pool, mirroring the
// memory/concept path's 60/40 vector·cross blend (graph-context RERANK_BLEND_*).
const SKILL_RERANK_BLEND_VECTOR = 0.6;
const SKILL_RERANK_BLEND_CROSS = 0.4;

// v0.8.x step 3: proven-utility nudge. Laplace-smoothed success rate with a
// NEUTRAL prior — (s+1)/(s+f+2) → 0.5 at zero observations — so a brand-new
// skill is neither rewarded nor penalized (deterministic cold-start handling;
// no ε-randomness). Folded into relevance as a small centered bonus so it only
// nudges: relevance (cosine⊕cross) dominates. INERT until the attribution fix
// (retrieval-quality.ts) accrues real success/failure data — today
// failure_count=0 corpus-wide so every skill sits at ~0.67 (uniform, ~no-op).
const SKILL_UTILITY_WEIGHT = 0.1;
/** Minimum CE engagement (skill-text × response-text) to attribute a turn
 *  outcome to a skill — the "supporting" band. Below this the response didn't
 *  engage the skill, so it earns neither success nor failure. */
export const SKILL_ENGAGEMENT_MIN = 0.3;

/** Laplace-smoothed success rate, neutral (0.5) prior. */
export function smoothedSkillUtility(successCount: number, failureCount: number): number {
  const s = Math.max(0, successCount);
  const f = Math.max(0, failureCount);
  return (s + 1) / (s + f + 2);
}

/** Attribution gate (step 3a): decide whether a turn's outcome should be
 *  recorded against a skill, given the cross-encoder engagement of the skill
 *  against the response and the turn's tool outcome. Pure/deterministic so it
 *  is unit-testable without the model. Returns null = record nothing (no
 *  signal — better than the old blanket `success ?? true` that credited every
 *  injected skill on every OK turn). */
export function shouldRecordSkillOutcome(
  engagement: number | null,
  toolSuccess: boolean | null,
): { success: boolean } | null {
  if (toolSuccess === null) return null;            // no tool outcome to judge
  if (engagement === null) return null;             // reranker offline — can't attribute
  if (engagement < SKILL_ENGAGEMENT_MIN) return null; // response didn't engage this skill
  return { success: toolSuccess };
}

export interface SkillRetrievalOpts {
  /** The user's prompt text — the cross-encoder anchor. */
  queryText?: string;
  /** Cross-encoder scorer, injected to avoid a circular import (graph-context
   *  imports this module). Signature matches graph-context.crossEncoderScorePairs:
   *  returns a sigmoid relevance [0,1] per doc, or null if the reranker is offline. */
  rerank?: (anchor: string, docs: string[]) => Promise<number[] | null>;
}

/**
 * Vector search on the skill table → optional cross-encoder rerank → utility
 * nudge → relevance-ordered selection with a HARD novelty gate. Called from
 * graphTransformContext when the intent is code-write/code-debug/multi-step/
 * code-read. Over-fetches a cosine candidate pool; if a reranker is supplied
 * (opts.rerank + opts.queryText) blends its score into relevance (0.6 cosine /
 * 0.4 cross); applies the proven-utility nudge; then selects `limit` items in
 * relevance order, skipping any candidate within SKILL_NOVELTY_MAX of one
 * already chosen so the injected set spans distinct procedures, not N phrasings
 * of one. Cross-encoder offline (null) / opts omitted → pure cosine relevance.
 */
export async function findRelevantSkills(
  queryVec: number[],
  limit = 3,
  store?: SurrealStore,
  opts?: SkillRetrievalOpts,
): Promise<Skill[]> {
  if (!store?.isAvailable()) return [];

  try {
    // Over-fetch a candidate pool (>= limit) so the novelty gate has room to
    // reach past a dense near-dup cluster and still find `limit` distinct skills.
    const poolSize = Math.min(Math.max(limit * 5, 24), 48);
    // COSINE_GUARD_OK: read-only retrieval ranking (no destructive op on this SELECT) — MMR-diversified below; skills are a flat namespace with no name/category identity axis to scope by.
    const rows = await store.queryFirst<any>(
      `SELECT id, name, description, preconditions, steps, postconditions,
              success_count AS successCount, failure_count AS failureCount,
              avg_duration_ms AS avgDurationMs, confidence, embedding,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM skill
       WHERE embedding != NONE AND array::len(embedding) > 0 AND (active = NONE OR active = true)
       ORDER BY score DESC LIMIT $lim`,
      { vec: queryVec, lim: poolSize },
    );

    // Relevance gate only (unchanged from pre-MMR). Embedding may be absent in
    // edge cases (backfill lag, test mocks); default to [] so cosineSim returns
    // 0 — such a candidate incurs no diversity penalty and ranks by relevance
    // rather than vanishing from retrieval.
    const pool = rows
      .filter((r: any) => (r.score ?? 0) > 0.4)
      .map((r: any) => ({ row: r, emb: (Array.isArray(r.embedding) ? r.embedding : []) as number[], rel: Number(r.score) }));

    // Cross-encoder rerank (step 2): rescore each candidate's relevance with the
    // bge-reranker (query-text × skill-text), blended 0.6 cosine / 0.4 cross so
    // MMR then diversifies on the sharper signal. Reuses the same model the
    // memory/concept path uses. Null (reranker offline) or opts absent → keep
    // pure cosine relevance. Errors are swallowed to the cosine fallback.
    if (opts?.queryText && opts?.rerank && pool.length > 1) {
      try {
        const docs = pool.map(({ row: r }) => `${r.name ?? ""}: ${r.description ?? ""}`);
        const cross = await opts.rerank(opts.queryText, docs);
        if (cross && cross.length === pool.length) {
          for (let i = 0; i < pool.length; i++) {
            pool[i]!.rel = SKILL_RERANK_BLEND_VECTOR * pool[i]!.rel + SKILL_RERANK_BLEND_CROSS * (cross[i] ?? 0);
          }
        }
      } catch (e) { swallow("skills:rerank", e); }
    }

    // Proven-utility nudge (step 3): centered, smoothed success rate. Neutral
    // (0.5) for unobserved skills → no cold-start penalty; demotes skills with
    // a real failure history, mildly boosts proven ones. Small weight so
    // relevance still dominates.
    for (const c of pool) {
      const sc = Number(c.row.successCount ?? 1);
      const fc = Number(c.row.failureCount ?? 0);
      c.rel += SKILL_UTILITY_WEIGHT * (smoothedSkillUtility(sc, fc) - 0.5);
    }

    // Relevance-ordered selection with a HARD novelty gate: walk candidates by
    // descending relevance and take each one ONLY if it isn't within
    // SKILL_NOVELTY_MAX cosine of a skill already chosen. Near-dups of a
    // selected skill are skipped outright (not merely penalized), so the result
    // can never be N phrasings of one procedure. Returning fewer than `limit`
    // distinct skills is correct and intended when the corpus lacks that many.
    pool.sort((a, b) => b.rel - a.rel);
    const selected: typeof pool = [];
    for (const c of pool) {
      if (selected.length >= limit) break;
      const isNearDup = selected.some(sk => cosineSim(c.emb, sk.emb) >= SKILL_NOVELTY_MAX);
      if (!isNearDup) selected.push(c);
    }

    return selected
      .map(({ row: r }) => ({
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

