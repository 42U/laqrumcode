#!/usr/bin/env node
/**
 * migrate-claude-auto-memory.mjs
 *
 * Migrates Claude Code's file-based "auto memory" — the .md files at
 * ~/.claude/projects/<project>/memory/ — into laqrumcode as knowledge gems,
 * then deletes the originals and replaces MEMORY.md with a pointer.
 *
 * Why: Claude Code ships an auto-memory system that writes per-project .md
 * files. With laqrumcode installed, that fragments knowledge across two stores.
 * This script ingests existing fragments into the laqrumcode graph and
 * deprecates the file-based copy.
 *
 * Usage:
 *   node scripts/migrate-claude-auto-memory.mjs [options] [directory]
 *
 *   directory   defaults to ~/.claude/projects/-<cwd-slug>/memory
 *               pass "all" to iterate every directory under
 *               ~/.claude/projects/* /memory
 *
 * Options:
 *   --dry-run       print what would happen, do not write or move
 *   --keep          ingest into laqrumcode but leave originals untouched
 *                   (no archive, no MEMORY.md rewrite)
 *   --delete        DESTRUCTIVE: delete originals after ingest (opt-in).
 *                   Default behavior archives originals to
 *                   <dir>/.laqrumcode-archive/<timestamp>/ instead.
 *   --batch <N>     gems per create_knowledge_gems call (default: 10;
 *                   30s daemon RPC timeout caps practical batch sizes)
 *
 * Examples:
 *   # migrate the current project's auto-memory (archives originals)
 *   node scripts/migrate-claude-auto-memory.mjs
 *
 *   # migrate every project's auto-memory in one go
 *   node scripts/migrate-claude-auto-memory.mjs all
 *
 *   # see what would happen without writing
 *   node scripts/migrate-claude-auto-memory.mjs --dry-run
 *
 *   # destructive (only after verifying laqrumcode ingest worked)
 *   node scripts/migrate-claude-auto-memory.mjs --delete
 *
 * Requires: laqrumcode daemon running on ~/.laqrumcode-daemon.sock
 */

import { readFile, readdir, stat, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DAEMON_SOCKET = join(HOME, ".laqrumcode-daemon.sock");
const PROJECTS_ROOT = join(HOME, ".claude", "projects");

// ── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const KEEP = argv.includes("--keep");
const DELETE = argv.includes("--delete");
const BATCH_FLAG = argv.indexOf("--batch");
const BATCH_SIZE = BATCH_FLAG >= 0 ? Number(argv[BATCH_FLAG + 1]) || 10 : 10;
const TARGET = argv.find(a => !a.startsWith("--") && a !== String(BATCH_SIZE));

// ── Daemon UDS RPC ──────────────────────────────────────────────────────────

let rpcId = 0;
function callDaemon(method, params) {
  return new Promise((resolve, reject) => {
    if (!existsSync(DAEMON_SOCKET)) {
      reject(new Error(`Daemon socket missing at ${DAEMON_SOCKET}. Start the daemon first.`));
      return;
    }
    const id = ++rpcId;
    const sock = connect(DAEMON_SOCKET);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`RPC timeout after 60s for method=${method}`));
    }, 60_000);
    sock.on("data", chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timer);
            sock.end();
            if (msg.error) reject(new Error(msg.error.message ?? String(msg.error)));
            else resolve(msg.result);
            return;
          }
        } catch { /* incomplete line */ }
      }
    });
    sock.on("error", e => { clearTimeout(timer); reject(e); });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// ── Frontmatter parsing ─────────────────────────────────────────────────────

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const fm = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { frontmatter: fm, body: text.slice(end + 5).trim() };
}

// ── Single-directory migration ──────────────────────────────────────────────

async function migrateDirectory(dir) {
  if (!existsSync(dir)) return { dir, status: "missing" };

  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    return { dir, status: "unreadable", error: String(e) };
  }

  const mdFiles = entries.filter(f => f.endsWith(".md") && f !== "MEMORY.md");
  if (mdFiles.length === 0) {
    return { dir, status: "empty" };
  }

  const gems = [];
  for (const file of mdFiles) {
    const path = join(dir, file);
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = frontmatter.name || basename(file, ".md");
    // The gem's content is the body (or the full file if no frontmatter).
    // We prepend the type and frontmatter description for context, since the
    // recipient bot will see this content as the embedded label.
    const headerParts = [];
    if (frontmatter.type) headerParts.push(`[${frontmatter.type.toUpperCase()}]`);
    if (frontmatter.description) headerParts.push(frontmatter.description);
    const header = headerParts.length > 0 ? headerParts.join(" — ") + "\n\n" : "";
    const content = (header + body).trim();
    if (content.length < 20) continue; // skip near-empty files
    gems.push({
      name: name.slice(0, 80),
      content,
      importance: frontmatter.type === "feedback" ? 8
        : frontmatter.type === "user" ? 7
        : 6,
    });
  }

  if (gems.length === 0) {
    return { dir, status: "no-eligible-gems" };
  }

  if (DRY_RUN) {
    return { dir, status: "dry-run", would_ingest: gems.length, gem_names: gems.map(g => g.name) };
  }

  // Ingest in batches of BATCH_SIZE to stay under the 30s RPC timeout.
  const projectSlug = basename(dir.replace(/\/memory\/?$/, ""));
  const source = `claude-auto-memory:${projectSlug}`;
  let totalIngested = 0;
  const conceptIds = [];
  for (let i = 0; i < gems.length; i += BATCH_SIZE) {
    const batch = gems.slice(i, i + BATCH_SIZE);
    const result = await callDaemon("tool.createKnowledgeGems", {
      sessionId: "migrate-claude-auto-memory",
      args: {
        source,
        source_type: "auto-memory",
        source_description: `Migrated from Claude Code auto-memory: ${dir}`,
        gems: batch,
      },
    });
    // Extract concept_ids and concepts_created from the tool response.
    // Response shape: { content: [{ type: "text", text: "{...json...}" }] }
    try {
      const text = result?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(text);
      totalIngested += parsed.concepts_created ?? 0;
      if (Array.isArray(parsed.concept_ids)) conceptIds.push(...parsed.concept_ids);
    } catch { /* count by batch length as fallback */ totalIngested += batch.length; }
  }

  // Default: archive originals to <dir>/.laqrumcode-archive/<timestamp>/.
  // --keep: leave them in place. --delete: destroy them (opt-in).
  let movedCount = 0;
  let deletedCount = 0;
  let archiveDir = null;
  if (!KEEP) {
    if (DELETE) {
      for (const file of mdFiles) {
        try { await unlink(join(dir, file)); deletedCount++; } catch { /* skip */ }
      }
    } else {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      archiveDir = join(dir, ".laqrumcode-archive", ts);
      try { await mkdir(archiveDir, { recursive: true }); } catch { /* skip */ }
      for (const file of mdFiles) {
        try {
          await rename(join(dir, file), join(archiveDir, file));
          movedCount++;
        } catch { /* skip */ }
      }
    }
  }

  const pointerPath = join(dir, "MEMORY.md");
  const pointer = `# MEMORY POINTS AT LAQRUMCODE

Migrated to laqrumcode graph on ${new Date().toISOString().slice(0, 10)} via scripts/migrate-claude-auto-memory.mjs.

${totalIngested} memories ingested as concepts. Source tag: \`${source}\`.
${archiveDir ? `\nOriginals archived to: \`${archiveDir.replace(HOME, "~")}\` (reversible).\n` : ""}
Use the laqrumcode MCP tools (\`recall\`, \`record_finding\`, \`core_memory\`, \`introspect\`) for memory operations. Do not write new files here.
`;
  if (!KEEP) {
    try {
      await writeFile(pointerPath, pointer, "utf8");
    } catch { /* skip */ }
  }

  return {
    dir,
    status: "migrated",
    gems_ingested: totalIngested,
    files_archived: movedCount,
    files_deleted: deletedCount,
    archive_dir: archiveDir,
    concept_ids_sample: conceptIds.slice(0, 3),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function resolveTargets() {
  if (TARGET === "all") {
    const projects = await readdir(PROJECTS_ROOT).catch(() => []);
    const dirs = [];
    for (const p of projects) {
      const memDir = join(PROJECTS_ROOT, p, "memory");
      if (existsSync(memDir)) {
        const st = await stat(memDir).catch(() => null);
        if (st?.isDirectory()) dirs.push(memDir);
      }
    }
    return dirs;
  }
  if (TARGET) {
    return [TARGET];
  }
  // Default: current project's memory dir, derived from cwd.
  const slug = "-" + process.cwd().replace(/^\//, "").replace(/\//g, "-");
  return [join(PROJECTS_ROOT, slug, "memory")];
}

const targets = await resolveTargets();
const mode = DRY_RUN ? "dry-run" : KEEP ? "keep" : DELETE ? "delete" : "archive";
console.log(`migrate-claude-auto-memory: ${targets.length} target dir(s), mode=${mode}`);

const results = [];
for (const dir of targets) {
  console.log(`\n→ ${dir}`);
  try {
    const r = await migrateDirectory(dir);
    results.push(r);
    const tail = r.gems_ingested ? ` — ingested ${r.gems_ingested}${r.files_archived ? `, archived ${r.files_archived}` : ""}${r.files_deleted ? `, deleted ${r.files_deleted}` : ""}` : "";
    console.log(`  ${r.status}${tail}`);
    if (r.would_ingest) console.log(`  would ingest: ${r.gem_names.join(", ")}`);
  } catch (e) {
    console.error(`  error: ${e.message}`);
    results.push({ dir, status: "error", error: e.message });
  }
}

const summary = {
  dirs_processed: results.length,
  migrated: results.filter(r => r.status === "migrated").length,
  empty: results.filter(r => r.status === "empty").length,
  missing: results.filter(r => r.status === "missing").length,
  errors: results.filter(r => r.status === "error").length,
  total_gems_ingested: results.reduce((s, r) => s + (r.gems_ingested || 0), 0),
};

console.log(`\n══ summary ══`);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.errors > 0 ? 1 : 0);
