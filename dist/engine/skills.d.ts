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
 * kongcode-health, extract-pdf-gems, and kongcode-backup-semantic).
 */
export declare function supersedeOldSkills(newSkillId: string, newName: string, newEmb: number[], store: SurrealStore): Promise<void>;
/**
 * Vector search on the skill table. Called from graphTransformContext
 * when the intent is code-write, code-debug, or multi-step.
 */
export declare function findRelevantSkills(queryVec: number[], limit?: number, store?: SurrealStore): Promise<Skill[]>;
/**
 * Format matched skills as a structured context block for the LLM.
 */
export declare function formatSkillContext(skills: Skill[]): string;
/**
 * Record skill outcome when a retrieved skill is used in a turn.
 */
export declare function recordSkillOutcome(skillId: string, success: boolean, durationMs: number, store: SurrealStore): Promise<void>;
