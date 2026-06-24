#!/usr/bin/env node
/**
 * One-shot migration: ingest every SKILL.md under /skills/ into the
 * laqrumcode `skill` table. Founder directive (2026-05-15): no more .md
 * proliferation. Skill bodies belong in the vector-indexed DB.
 *
 * Approach: direct SurrealDB write with body in the SCHEMALESS skill
 * row. Embedding is left NULL on insert; the daemon's bootstrap
 * maintenance hook (backfillSkillEmbeddings) populates embeddings on
 * the next daemon start so recall(scope="skills") works after
 * /reload-plugins.
 *
 * Idempotent: skips any name that already exists in the table.
 *
 * Env-var overrides (defaults from src/engine/config.ts):
 *   SURREAL_URL   — default ws://127.0.0.1:8000/rpc
 *   SURREAL_USER  — default root
 *   SURREAL_PASS  — default root
 *   SURREAL_NS    — default laqrum
 *   SURREAL_DB    — default memory
 *   LAQRUMCODE_SKILLS_DIR — default /home/zero/voidorigin/laqrumcode/skills
 */

import { Surreal } from "/home/zero/voidorigin/laqrumcode/node_modules/surrealdb/dist/surrealdb.mjs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "laqrum";
const DB = process.env.SURREAL_DB || "memory";
const SKILLS_DIR = process.env.LAQRUMCODE_SKILLS_DIR || "/home/zero/voidorigin/laqrumcode/skills";

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("No frontmatter block found");
  const [, raw, body] = m;
  const fm = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { frontmatter: fm, body: body.trim() };
}

function idStr(id) {
  if (id && typeof id === "object" && id.tb !== undefined) {
    return `${id.tb}:${id.id}`;
  }
  return String(id);
}

async function main() {
  const db = new Surreal();
  await db.connect(URL);
  await db.signin({ username: USER, password: PASS });
  await db.use({ namespace: NS, database: DB });

  const entries = await readdir(SKILLS_DIR);
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const results = [];

  for (const entry of entries.sort()) {
    const dir = join(SKILLS_DIR, entry);
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillMd = join(dir, "SKILL.md");

    let content;
    try {
      content = await readFile(skillMd, "utf8");
    } catch {
      results.push({ entry, status: "no-skill-md" });
      skipped++;
      continue;
    }

    let parsed;
    try {
      parsed = parseFrontmatter(content);
    } catch (e) {
      results.push({ entry, status: "parse-error", error: e.message });
      errors++;
      continue;
    }

    // Canonical name is the directory slug (matches Claude Code's slash-command
    // discovery convention). Frontmatter `name` is preserved as `title` for
    // human-readable display.
    const name = entry;
    const title = parsed.frontmatter.name ?? entry;
    const description = parsed.frontmatter.description ?? "";
    const body = parsed.body;

    if (!description) {
      results.push({ entry, status: "no-description" });
      errors++;
      continue;
    }
    if (body.length < 20) {
      results.push({ entry, status: "body-too-short", body_length: body.length });
      errors++;
      continue;
    }

    const existing = await db.query(
      "SELECT id FROM skill WHERE name = $name LIMIT 1",
      { name },
    );
    const existingRows = Array.isArray(existing[0]) ? existing[0] : [];
    if (existingRows.length > 0) {
      results.push({ entry, status: "skip-exists", id: idStr(existingRows[0].id) });
      skipped++;
      continue;
    }

    const created = await db.query(
      `CREATE skill CONTENT {
        name: $name,
        description: $description,
        body: $body,
        steps: [],
        active: true,
        confidence: 1.0,
        source: "migration-from-md",
        source_path: $path
      } RETURN id`,
      { name, description, body, path: skillMd },
    );
    const createdRows = Array.isArray(created[0]) ? created[0] : [];
    if (createdRows.length === 0) {
      results.push({ entry, status: "create-failed" });
      errors++;
      continue;
    }
    results.push({
      entry,
      status: "migrated",
      id: idStr(createdRows[0].id),
      body_length: body.length,
    });
    migrated++;
  }

  console.log("\n=== Migration Results ===");
  for (const r of results) {
    const tail = r.id ? ` -> ${r.id}` : "";
    const sz = r.body_length ? ` (${r.body_length} chars)` : "";
    console.log(`  ${r.entry.padEnd(32)} ${r.status}${tail}${sz}`);
  }
  console.log(`\nTotal: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);

  if (migrated > 0) {
    console.log(`\nNext: rebuild dist/ and /reload-plugins so the daemon picks up`);
    console.log(`backfillSkillEmbeddings (which populates HNSW vectors for the new rows).`);
  }

  await db.close();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
