/**
 * Workspace Migration — ingest OpenClaw's workspace files into SurrealDB.
 *
 * When a user switches from the default context engine to KongCode, their
 * workspace may contain .md files, skill definitions, session transcripts,
 * and memory logs created by OpenClaw. This module:
 *
 *  1. Collects ONLY known OpenClaw workspace files (allowlist, not recursive)
 *  2. Scans skills/ and .agents/skills/ for SKILL.md → proper `skill` records
 *  3. Scans memory/ for daily logs → `memory` records
 *  4. Ingests identity/user/agent files as memories + artifacts
 *  5. Archives originals into .kongbrain-archive/ so the workspace is clean
 *
 * IMPORTANT: This module NEVER touches user project files. A user's README.md,
 * package.json, docs/, test fixtures, scripts, etc. are left completely alone.
 * We only collect files that OpenClaw's default context engine created.
 *
 * SOUL.md is deliberately left in place — it serves as a "nudge" during
 * soul graduation and is read at that time, not ingested.
 *
 * Cross-platform: uses path.join/path.sep throughout, no shell commands,
 * copyFile+unlink instead of rename (cross-filesystem safe).
 */
import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
export interface MigrationResult {
    ingested: number;
    skills: number;
    memories: number;
    skipped: number;
    archived: boolean;
    archivePath?: string;
    details: string[];
}
/**
 * Check whether a workspace has OpenClaw files that could be migrated.
 * Fast — only checks for known indicators, never recurses into user dirs.
 */
export declare function hasMigratableFiles(workspaceDir: string): Promise<boolean>;
/**
 * Ingest OpenClaw workspace files into SurrealDB, then archive originals.
 *
 * Call this after the user confirms migration. Idempotent — checks for
 * a migration marker in the DB before running.
 *
 * Only touches files that belong to OpenClaw. User project files
 * (README.md, package.json, src/, docs/, etc.) are never touched.
 */
export declare function migrateWorkspace(workspaceDir: string, store: SurrealStore, embeddings: EmbeddingService): Promise<MigrationResult>;
/** True if a SKILL.md is already a DB-resident stub (body points at get_skill_body). */
export declare function isSkillStub(content: string): boolean;
/** Write the canonical 5-line DB-resident stub for a skill, idempotently.
 *  Matches the committed format so slash discovery and get_skill_body agree. */
export declare function writeSkillStub(skillMdPath: string, name: string, description: string): Promise<void>;
