/**
 * Procedural Memory (Skill Library)
 *
 * When the agent successfully completes a multi-step task, extract the procedure
 * as a reusable skill (preconditions, steps, postconditions, outcome).
 * Next time a similar task is requested, inject the proven procedure as context.
 * Skills earn success/failure counts from outcomes — RL-like reinforcement.
 *
 * Ported from laqrumbrain — takes SurrealStore/EmbeddingService as params.
 */
import type { SurrealStore } from "./surreal.js";
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
/**
 * After saving a new skill, fade similar existing skills above similarity
 * threshold — but ONLY same-named ones. Supersession means "this row REPLACES
 * the old one"; different-named skills are coexistent siblings even when their
 * embeddings are close. Without the name guard, long procedural-skill bodies
 * routinely cleared the 0.82 cosine threshold and unrelated skills nuked each
 * other (verified 2026-05-17: dockex-docker-build had wrongly deactivated
 * laqrumcode-health, extract-pdf-gems, and laqrumcode-backup-semantic).
 */
export declare function supersedeOldSkills(newSkillId: string, newName: string, newEmb: number[], store: SurrealStore): Promise<void>;
/** Minimum CE engagement (skill-text × response-text) to attribute a turn
 *  outcome to a skill — the "supporting" band. Below this the response didn't
 *  engage the skill, so it earns neither success nor failure. */
export declare const SKILL_ENGAGEMENT_MIN = 0.3;
/** Laplace-smoothed success rate, neutral (0.5) prior. */
export declare function smoothedSkillUtility(successCount: number, failureCount: number): number;
/** Attribution gate (step 3a): decide whether a turn's outcome should be
 *  recorded against a skill, given the cross-encoder engagement of the skill
 *  against the response and the turn's tool outcome. Pure/deterministic so it
 *  is unit-testable without the model. Returns null = record nothing (no
 *  signal — better than the old blanket `success ?? true` that credited every
 *  injected skill on every OK turn). */
export declare function shouldRecordSkillOutcome(engagement: number | null, toolSuccess: boolean | null): {
    success: boolean;
} | null;
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
export declare function findRelevantSkills(queryVec: number[], limit?: number, store?: SurrealStore, opts?: SkillRetrievalOpts): Promise<Skill[]>;
/**
 * Format matched skills as a structured context block for the LLM.
 */
export declare function formatSkillContext(skills: Skill[]): string;
/**
 * Record skill outcome when a retrieved skill is used in a turn.
 */
export declare function recordSkillOutcome(skillId: string, success: boolean, durationMs: number, store: SurrealStore): Promise<void>;
