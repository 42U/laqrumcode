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
import { readFile, readdir, stat, lstat, copyFile, unlink, mkdir, writeFile, rmdir } from "node:fs/promises";
import { join, basename, extname, relative, dirname, sep } from "node:path";
import { swallow } from "./errors.js";
import { commitKnowledge } from "./commit.js";
// ── Allowlists ───────────────────────────────────────────────────────────────
// Only files and directories OpenClaw's default engine creates.
/** Top-level files that belong to OpenClaw and are safe to migrate. */
const OPENCLAW_ROOT_FILES = new Set([
    "IDENTITY.md",
    "USER.md",
    "AGENTS.md",
    "TOOLS.md",
    "MEMORY.md",
    "memory.md",
    "SKILLS.md",
    // HEARTBEAT.md is NOT here — OpenClaw core reads it directly for cron heartbeats
    // SOUL.md is NOT here — stays in place as graduation nudge
]);
/** Files to skip — never ingest, never archive. */
const SKIP_FILES = new Set([
    "SOUL.md", // Stays for graduation nudge — read during soul graduation
    "BOOTSTRAP.md", // Ephemeral onboarding file — deleted by OpenClaw after setup
    "HEARTBEAT.md", // Actively used by OpenClaw core heartbeat runner — not ours to touch
]);
/**
 * Directories that belong to OpenClaw and should be scanned.
 * We only scan one level into these (except skills, which has skill-name/SKILL.md).
 */
const OPENCLAW_DIRS = [
    "memory", // memory/YYYY-MM-DD.md daily logs
    "skills", // skills/<name>/SKILL.md
    ".agents", // .agents/skills/<name>/SKILL.md
    "sessions", // sessions/*.jsonl transcripts
];
/** Max file size to ingest (256KB — same as OpenClaw's skill limit). */
const MAX_FILE_SIZE = 256 * 1024;
// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Check whether a workspace has OpenClaw files that could be migrated.
 * Fast — only checks for known indicators, never recurses into user dirs.
 */
export async function hasMigratableFiles(workspaceDir) {
    // Check for any known root-level OpenClaw files
    for (const file of OPENCLAW_ROOT_FILES) {
        try {
            await stat(join(workspaceDir, file));
            return true;
        }
        catch { /* doesn't exist */ }
    }
    // Check for OpenClaw directories
    for (const dir of OPENCLAW_DIRS) {
        try {
            const s = await stat(join(workspaceDir, dir));
            if (s.isDirectory())
                return true;
        }
        catch { /* doesn't exist */ }
    }
    return false;
}
/**
 * Ingest OpenClaw workspace files into SurrealDB, then archive originals.
 *
 * Call this after the user confirms migration. Idempotent — checks for
 * a migration marker in the DB before running.
 *
 * Only touches files that belong to OpenClaw. User project files
 * (README.md, package.json, src/, docs/, etc.) are never touched.
 */
export async function migrateWorkspace(workspaceDir, store, embeddings) {
    const result = {
        ingested: 0,
        skills: 0,
        memories: 0,
        skipped: 0,
        archived: false,
        details: [],
    };
    if (!store.isAvailable()) {
        result.details.push("SurrealDB not available — skipping migration");
        return result;
    }
    // Check if already migrated
    try {
        const marker = await store.queryFirst(`SELECT id FROM artifact WHERE path = 'workspace-migration' AND type = 'migration-marker' LIMIT 1`);
        if (marker.length > 0) {
            result.details.push("Workspace already migrated — skipping");
            return result;
        }
    }
    catch {
        // Table might not exist yet, proceed
    }
    // ── Collect only OpenClaw files ──
    const files = await collectOpenClawFiles(workspaceDir);
    if (files.length === 0) {
        result.details.push("No OpenClaw workspace files found to migrate");
        return result;
    }
    result.details.push(`Found ${files.length} OpenClaw files to migrate`);
    // ── Process each file ──
    for (const file of files) {
        try {
            const name = basename(file.absPath);
            // SKILL.md files → create skill records in the graph
            if (name === "SKILL.md") {
                const created = await ingestSkill(file, store, embeddings);
                if (created) {
                    result.skills++;
                    result.details.push(`Skill: ${file.relPath}`);
                }
                else {
                    result.skipped++;
                    result.details.push(`Skipped skill (parse failed): ${file.relPath}`);
                }
                continue;
            }
            // Classify and ingest as artifact
            const fileType = categorizeFile(file.relPath, name);
            const description = summarizeFile(file.relPath, name, file.content);
            let embedding = null;
            if (embeddings.isAvailable()) {
                const textToEmbed = file.content.length < 2000
                    ? file.content
                    : description + "\n" + file.content.slice(0, 1500);
                try {
                    embedding = await embeddings.embed(textToEmbed);
                }
                catch (e) {
                    swallow("migrate:embed", e);
                }
            }
            await store.queryExec(`CREATE artifact CONTENT $record`, {
                record: {
                    path: file.relPath,
                    type: fileType,
                    description,
                    content: file.content,
                    content_hash: simpleHash(file.content),
                    embedding,
                    tags: ["workspace-migration", fileType],
                    migrated_from: "openclaw-default",
                },
            });
            result.ingested++;
            result.details.push(`Ingested: ${file.relPath} (${fileType})`);
            // Also create memory records for content-rich files
            if (shouldCreateMemories(fileType)) {
                const memCount = await ingestAsMemories(file.content, fileType, store, embeddings);
                result.memories += memCount;
            }
        }
        catch (e) {
            result.skipped++;
            result.details.push(`Failed: ${file.relPath} — ${e}`);
            swallow.warn("migrate:ingest", e);
        }
    }
    // ── Archive originals ──
    try {
        const archivePath = await archiveFiles(workspaceDir, files);
        result.archived = true;
        result.archivePath = archivePath;
        result.details.push(`Archived to: ${archivePath}`);
    }
    catch (e) {
        result.details.push(`Archive failed: ${e}`);
        swallow.warn("migrate:archive", e);
    }
    // ── Write migration marker ──
    try {
        await store.queryExec(`CREATE artifact CONTENT $record`, {
            record: {
                path: "workspace-migration",
                type: "migration-marker",
                description: `Migrated ${result.ingested} artifacts, ${result.skills} skills, ${result.memories} memories from workspace`,
                tags: ["workspace-migration"],
            },
        });
    }
    catch (e) {
        swallow.warn("migrate:marker", e);
    }
    return result;
}
// ── File Collection (Allowlist-based, NOT recursive) ─────────────────────────
/**
 * Collect only files that belong to OpenClaw's workspace system.
 * Never touches user project files like README.md, package.json, src/, docs/, etc.
 */
async function collectOpenClawFiles(workspaceDir) {
    const found = [];
    // 1. Known root-level OpenClaw files
    for (const fileName of OPENCLAW_ROOT_FILES) {
        const absPath = join(workspaceDir, fileName);
        const file = await tryReadFile(absPath, workspaceDir);
        if (file)
            found.push(file);
    }
    // 2. memory/ directory — one level of .md files (daily logs)
    await collectFromDir(join(workspaceDir, "memory"), workspaceDir, [".md"], found, false);
    // 3. skills/ directory — look for <name>/SKILL.md (two levels)
    await collectSkillDirs(join(workspaceDir, "skills"), workspaceDir, found);
    // 4. .agents/skills/ directory — same pattern
    await collectSkillDirs(join(workspaceDir, ".agents", "skills"), workspaceDir, found);
    // 5. sessions/ — .jsonl and .json files (one level)
    await collectFromDir(join(workspaceDir, "sessions"), workspaceDir, [".jsonl", ".json"], found, false);
    return found;
}
/**
 * Collect files from a single directory (non-recursive) matching given extensions.
 */
async function collectFromDir(dirPath, rootDir, extensions, out, _recursive) {
    let entries;
    try {
        entries = await readdir(dirPath);
    }
    catch {
        return; // Directory doesn't exist
    }
    const extSet = new Set(extensions.map(e => e.toLowerCase()));
    for (const entry of entries) {
        const absPath = join(dirPath, entry);
        const ext = extname(entry).toLowerCase();
        if (!extSet.has(ext))
            continue;
        const file = await tryReadFile(absPath, rootDir);
        if (file)
            out.push(file);
    }
}
/**
 * Scan a skills directory for the <skill-name>/SKILL.md pattern.
 * Only goes two levels: skills/<name>/SKILL.md — never deeper.
 */
async function collectSkillDirs(skillsRoot, workspaceRoot, out) {
    let entries;
    try {
        entries = await readdir(skillsRoot);
    }
    catch {
        return; // Directory doesn't exist
    }
    for (const entry of entries) {
        const skillDir = join(skillsRoot, entry);
        let s;
        try {
            s = await stat(skillDir);
        }
        catch {
            continue;
        }
        if (!s.isDirectory()) {
            // Might be a top-level .md in skills/ (like SKILLS.md placed inside)
            if (extname(entry).toLowerCase() === ".md") {
                const file = await tryReadFile(skillDir, workspaceRoot);
                if (file)
                    out.push(file);
            }
            continue;
        }
        // Look for SKILL.md inside this skill directory
        const skillMdPath = join(skillDir, "SKILL.md");
        const file = await tryReadFile(skillMdPath, workspaceRoot);
        if (file)
            out.push(file);
        // Also pick up any other .md files in the skill dir (README.md for the skill, etc.)
        let skillFiles;
        try {
            skillFiles = await readdir(skillDir);
        }
        catch {
            continue;
        }
        for (const sf of skillFiles) {
            if (sf === "SKILL.md")
                continue; // Already got it
            if (extname(sf).toLowerCase() !== ".md")
                continue;
            const sfFile = await tryReadFile(join(skillDir, sf), workspaceRoot);
            if (sfFile)
                out.push(sfFile);
        }
    }
}
/**
 * Try to read a single file. Returns null if it doesn't exist, is too large,
 * is empty, or is in the skip list.
 */
async function tryReadFile(absPath, rootDir) {
    const name = basename(absPath);
    if (SKIP_FILES.has(name))
        return null;
    let s;
    try {
        s = await lstat(absPath);
    }
    catch {
        return null;
    }
    if (s.isSymbolicLink() || !s.isFile())
        return null;
    if (s.size === 0 || s.size > MAX_FILE_SIZE)
        return null;
    try {
        const content = await readFile(absPath, "utf-8");
        if (content.trim().length === 0)
            return null;
        // Normalize to forward slashes for cross-platform DB storage
        const relPath = relative(rootDir, absPath).split(sep).join("/");
        return { absPath, relPath, content };
    }
    catch {
        return null;
    }
}
/**
 * Parse a SKILL.md file (YAML frontmatter + markdown body) and create
 * a proper `skill` record in SurrealDB. The skill is immediately usable
 * by the graph retrieval system.
 */
async function ingestSkill(file, store, embeddings) {
    const { frontmatter, body } = parseFrontmatter(file.content);
    if (!frontmatter && !body)
        return false;
    const fm = frontmatter;
    // Derive skill name from frontmatter or directory name
    const parts = file.relPath.split("/");
    const dirName = parts.length >= 2 ? parts[parts.length - 2] : "unknown";
    const skillName = fm?.name ?? dirName;
    const description = fm?.description ?? body.split("\n").find(l => l.trim().length > 10)?.trim() ?? `Skill: ${skillName}`;
    // Extract steps from markdown body
    const steps = extractSteps(body);
    // Compute embedding once: shared between the skill row (via precomputedVec
    // on commitKnowledge) and the artifact row CREATE below. Same text feeds
    // both so retrieval surfaces them coherently.
    let embedding = null;
    if (embeddings.isAvailable()) {
        const textToEmbed = `${skillName}: ${description}\n${steps.join("\n")}`.slice(0, 6000);
        try {
            embedding = await embeddings.embed(textToEmbed);
        }
        catch (e) {
            swallow("migrate:skillEmbed", e);
        }
    }
    // Build preconditions from metadata requirements
    const preconditions = [];
    const requires = fm?.metadata?.openclaw?.requires;
    if (requires?.bins?.length)
        preconditions.push(`Requires binaries: ${requires.bins.join(", ")}`);
    if (requires?.env?.length)
        preconditions.push(`Requires env vars: ${requires.env.join(", ")}`);
    const os = fm?.metadata?.openclaw?.os;
    if (os?.length)
        preconditions.push(`Supported OS: ${os.join(", ")}`);
    // v0.7.79: migrated to commitKnowledge({ kind: "skill" }). Workspace
    // migration has no task or session context, so the three link knobs are
    // all disabled. supersede is disabled because workspace-migrate seeds
    // history (its skills are meant to coexist with prior runs).
    await commitKnowledge({ store, embeddings }, {
        kind: "skill",
        name: skillName,
        description,
        precomputedVec: embedding,
        preconditions: preconditions.length > 0 ? preconditions.join("; ") : undefined,
        steps,
        linkFromTask: false,
        linkUsesConcepts: false,
        supersede: false,
        extras: {
            success_count: 1,
            failure_count: 0,
            avg_duration_ms: 0,
            last_used: null,
            source: "workspace-migration",
            source_path: file.relPath,
            full_content: file.content,
        },
    });
    // Also create artifact record so it shows up in artifact search
    await store.queryExec(`CREATE artifact CONTENT $record`, {
        record: {
            path: file.relPath,
            type: "skill-definition",
            description: `Skill: ${skillName} — ${description}`,
            content: file.content,
            content_hash: simpleHash(file.content),
            embedding,
            tags: ["workspace-migration", "skill", skillName],
            migrated_from: "openclaw-default",
        },
    });
    return true;
}
/**
 * Parse YAML-ish frontmatter from a markdown file.
 * Handles the --- delimited block at the top.
 */
function parseFrontmatter(content) {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) {
        return { frontmatter: null, body: content };
    }
    const endIdx = trimmed.indexOf("---", 3);
    if (endIdx === -1) {
        return { frontmatter: null, body: content };
    }
    const fmBlock = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 3).trim();
    // Simple YAML parser for flat key-value pairs + JSON metadata block.
    // Full YAML parsing would need a dependency — this covers SKILL.md format.
    try {
        const result = {};
        for (const line of fmBlock.split("\n")) {
            const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
            if (match) {
                const [, key, val] = match;
                result[key] = val.trim();
            }
        }
        // Try JSON metadata block if present
        const jsonMatch = fmBlock.match(/metadata:\s*\n\s*(\{[\s\S]*?\})/);
        if (jsonMatch) {
            try {
                result.metadata = JSON.parse(jsonMatch[1]);
            }
            catch {
                // Malformed JSON metadata — skip
            }
        }
        return { frontmatter: Object.keys(result).length > 0 ? result : null, body };
    }
    catch {
        return { frontmatter: null, body };
    }
}
/**
 * Extract procedural steps from markdown body.
 * Looks for ordered/unordered lists, especially under "Steps"/"Usage"/"How" headers.
 */
function extractSteps(body) {
    const steps = [];
    const sectionRe = /^#{1,3}\s+(steps|usage|how|instructions|procedure|workflow)/im;
    const sectionMatch = body.match(sectionRe);
    const searchArea = sectionMatch ? body.slice(sectionMatch.index) : body;
    // Ordered list items
    const orderedRe = /^\s*\d+\.\s+(.+)$/gm;
    let m;
    while ((m = orderedRe.exec(searchArea)) !== null) {
        steps.push(m[1].trim());
        if (steps.length >= 20)
            break;
    }
    // Fallback: bullet points
    if (steps.length === 0) {
        const bulletRe = /^\s*[-*]\s+(.+)$/gm;
        while ((m = bulletRe.exec(searchArea)) !== null) {
            steps.push(m[1].trim());
            if (steps.length >= 20)
                break;
        }
    }
    return steps;
}
// ── Memory Ingestion ─────────────────────────────────────────────────────────
/** File types that should also be broken into memory records. */
function shouldCreateMemories(fileType) {
    return [
        "identity", "user-profile", "agent-config", "memory-index",
        "daily-memory", "skills-index",
    ].includes(fileType);
}
/**
 * Extract meaningful chunks from a .md file and store as memory records.
 */
async function ingestAsMemories(content, fileType, store, embeddings) {
    const chunks = content
        .split(/\n#{1,3}\s+|\n\n/)
        .map(c => c.trim())
        .filter(c => c.length > 20);
    const categoryMap = {
        "identity": "identity",
        "user-profile": "user-profile",
        "agent-config": "agent-config",
        "memory-index": "general",
        "daily-memory": "daily-memory",
        "skills-index": "skill",
    };
    const category = categoryMap[fileType] ?? "general";
    let created = 0;
    for (const chunk of chunks.slice(0, 20)) {
        try {
            // Route through commitKnowledge so workspace-migration memories
            // auto-seal about_concept edges like any other memory write.
            await commitKnowledge({ store, embeddings }, {
                kind: "memory",
                text: chunk,
                importance: 50,
                category,
            });
            created++;
        }
        catch (e) {
            swallow("migrate:createMemory", e);
        }
    }
    return created;
}
// ── File Classification ──────────────────────────────────────────────────────
function categorizeFile(relPath, name) {
    const upper = name.toUpperCase();
    if (upper === "IDENTITY.MD")
        return "identity";
    if (upper === "USER.MD")
        return "user-profile";
    if (upper === "AGENTS.MD")
        return "agent-config";
    if (upper === "TOOLS.MD")
        return "tool-definitions";
    if (upper === "HEARTBEAT.MD")
        return "heartbeat";
    if (upper === "MEMORY.MD")
        return "memory-index";
    if (upper === "SKILLS.MD")
        return "skills-index";
    if (upper === "SKILL.MD")
        return "skill-definition";
    if (relPath.startsWith("memory/"))
        return "daily-memory";
    if (relPath.startsWith("skills/"))
        return "skill-related";
    if (relPath.startsWith(".agents/"))
        return "agent-skill";
    if (relPath.startsWith("sessions/"))
        return "session-transcript";
    if (name.endsWith(".jsonl"))
        return "session-transcript";
    if (name.endsWith(".json"))
        return "config-data";
    return "workspace-file";
}
function summarizeFile(relPath, name, content) {
    const lineCount = content.split("\n").length;
    const upper = name.toUpperCase();
    if (upper === "IDENTITY.MD")
        return `Agent identity document (${lineCount} lines) — migrated from workspace`;
    if (upper === "USER.MD")
        return `User profile and preferences (${lineCount} lines) — migrated from workspace`;
    if (upper === "AGENTS.MD")
        return `Agent configuration (${lineCount} lines) — migrated from workspace`;
    if (upper === "TOOLS.MD")
        return `Tool definitions and capabilities (${lineCount} lines) — migrated from workspace`;
    if (upper === "HEARTBEAT.MD")
        return `Status heartbeat (${lineCount} lines) — migrated from workspace`;
    if (upper === "MEMORY.MD")
        return `Memory index (${lineCount} lines) — migrated from workspace`;
    if (upper === "SKILLS.MD")
        return `Skills index (${lineCount} lines) — migrated from workspace`;
    if (relPath.startsWith("memory/"))
        return `Daily memory log: ${name} (${lineCount} lines)`;
    if (relPath.startsWith("skills/") || relPath.startsWith(".agents/"))
        return `Skill file: ${relPath} (${lineCount} lines)`;
    if (name.endsWith(".jsonl"))
        return `Session transcript: ${name} (${content.length} chars)`;
    if (name.endsWith(".json"))
        return `Config/metadata: ${name} (${lineCount} lines)`;
    return `Workspace file: ${relPath} (${lineCount} lines)`;
}
// ── Archiving ────────────────────────────────────────────────────────────────
/**
 * Move ingested files into .kongbrain-archive/ preserving directory structure.
 * Uses copyFile + unlink (works across filesystems and on all OSes).
 * SOUL.md is never touched.
 */
async function archiveFiles(workspaceDir, files) {
    const archiveDir = join(workspaceDir, ".kongbrain-archive");
    await mkdir(archiveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const movedPaths = [];
    for (const file of files) {
        if (basename(file.absPath).toUpperCase() === "SOUL.MD")
            continue;
        const relFromRoot = relative(workspaceDir, file.absPath);
        const destPath = join(archiveDir, relFromRoot);
        try {
            await mkdir(dirname(destPath), { recursive: true });
            await copyFile(file.absPath, destPath);
            await unlink(file.absPath);
            movedPaths.push(relFromRoot);
        }
        catch (e) {
            // Non-fatal — file might be locked, read-only, etc.
            swallow.warn("migrate:archiveFile", e);
        }
    }
    // Write manifest
    const manifest = [
        `KongCode Migration Archive`,
        `Date: ${new Date().toISOString()}`,
        `Platform: ${process.platform}`,
        ``,
        `Files migrated to SurrealDB (${movedPaths.length}):`,
        ...movedPaths.map(p => `  ${p}`),
        ``,
        `SOUL.md was left in place for soul graduation.`,
        `To restore files, copy them back from this directory.`,
    ].join("\n");
    await writeFile(join(archiveDir, `migration-${timestamp}.txt`), manifest, "utf-8");
    // Clean up empty directories left behind (deepest-first)
    const dirsToCheck = new Set();
    for (const p of movedPaths) {
        let dir = dirname(join(workspaceDir, p));
        while (dir !== workspaceDir && dir.length > workspaceDir.length) {
            dirsToCheck.add(dir);
            dir = dirname(dir);
        }
    }
    const sortedDirs = [...dirsToCheck].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
        try {
            const remaining = await readdir(dir);
            if (remaining.length === 0) {
                await rmdir(dir);
            }
        }
        catch {
            // Not empty or doesn't exist — fine
        }
    }
    return archiveDir;
}
// ── Utilities ────────────────────────────────────────────────────────────────
/** Simple content hash for dedup (not crypto, just fingerprint). */
function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return `sh-${(hash >>> 0).toString(36)}`;
}
