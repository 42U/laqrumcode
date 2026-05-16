#!/usr/bin/env node
/**
 * Finalize the SKILL.md -> DB migration:
 *   1. SELECT all skill rows that were migrated from .md (source='migration-from-md')
 *   2. Write .claude-plugin/skills-seed.json containing the full bodies so the
 *      daemon can hydrate a fresh install's DB on first boot.
 *   3. Replace each skills/<name>/SKILL.md with a 5-line stub:
 *        ---
 *        name: <name>
 *        description: <description>
 *        ---
 *
 *        Body in kongcode DB. Call mcp__plugin_kongcode_kongcode__get_skill_body
 *        with name="<name>" to load full instructions.
 *
 * Idempotent: re-running on already-stubbed .md files is a no-op (the stub
 * shape is the new source of truth; this script doesn't restore bodies from
 * stubs — that's the daemon-bootstrap seed hook's job).
 *
 * Env-var overrides match scripts/migrate-skills-to-db.mjs.
 */

import { Surreal } from "/home/zero/voidorigin/kongcode/node_modules/surrealdb/dist/surrealdb.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "kong";
const DB = process.env.SURREAL_DB || "memory";
const REPO_ROOT = "/home/zero/voidorigin/kongcode";
const SKILLS_DIR = join(REPO_ROOT, "skills");
const SEED_PATH = join(REPO_ROOT, ".claude-plugin", "skills-seed.json");

function idStr(id) {
  if (id && typeof id === "object" && id.tb !== undefined) {
    return `${id.tb}:${id.id}`;
  }
  return String(id);
}

function escapeYaml(s) {
  if (!s) return "";
  if (/[:#"\n\\]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function buildStub(name, description) {
  return `---
name: ${name}
description: ${escapeYaml(description)}
---

Body in kongcode DB. Call \`mcp__plugin_kongcode_kongcode__get_skill_body\` with \`name="${name}"\` to load full instructions.
`;
}

async function main() {
  const db = new Surreal();
  await db.connect(URL);
  await db.signin({ username: USER, password: PASS });
  await db.use({ namespace: NS, database: DB });

  const rows = await db.query(
    `SELECT id, name, description, body, steps, preconditions, postconditions, source_path
       FROM skill
       WHERE source = "migration-from-md"
       ORDER BY name`,
  );
  const skills = Array.isArray(rows[0]) ? rows[0] : [];

  if (skills.length === 0) {
    console.error("ERROR: No skills found with source='migration-from-md'.");
    console.error("Run scripts/migrate-skills-to-db.mjs first.");
    process.exit(1);
  }

  console.log(`Found ${skills.length} migrated skills.`);

  // Fix any rows where `name` was taken from frontmatter's human-readable title
  // ("Audit Drift") instead of the directory slug ("audit-drift"). The directory
  // name is the canonical slash-command identifier in Claude Code's plugin
  // discovery, so we coerce `name` to match.
  for (const s of skills) {
    if (!s.source_path) continue;
    const m = String(s.source_path).match(/\/skills\/([^/]+)\/SKILL\.md$/);
    if (!m) continue;
    const correctName = m[1];
    if (s.name === correctName) continue;
    console.log(`  FIX-NAME "${s.name}" -> "${correctName}"`);
    await db.query(
      "UPDATE skill SET name = $newName WHERE name = $oldName AND source = 'migration-from-md'",
      { newName: correctName, oldName: s.name },
    );
    s.name = correctName;
  }

  const seed = skills.map((s) => ({
    name: s.name,
    description: s.description,
    body: s.body,
    steps: s.steps ?? [],
    preconditions: s.preconditions ?? null,
    postconditions: s.postconditions ?? null,
  }));

  await mkdir(dirname(SEED_PATH), { recursive: true });
  await writeFile(SEED_PATH, JSON.stringify({ version: 1, generated_at: new Date().toISOString(), skills: seed }, null, 2) + "\n", "utf8");
  console.log(`Wrote seed: ${SEED_PATH} (${seed.length} skills, ${Buffer.byteLength(JSON.stringify(seed))} bytes)`);

  let stubbed = 0;
  let errors = 0;
  for (const s of skills) {
    const stubPath = join(SKILLS_DIR, s.name, "SKILL.md");
    const stubContent = buildStub(s.name, s.description);
    try {
      await writeFile(stubPath, stubContent, "utf8");
      console.log(`  STUB ${s.name.padEnd(32)} ${stubPath} (${stubContent.length} chars)`);
      stubbed++;
    } catch (e) {
      console.error(`  ERROR ${s.name}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nTotal: ${stubbed} stubbed, ${errors} errors`);

  await db.close();
}

main().catch((e) => {
  console.error("Finalize failed:", e);
  process.exit(1);
});
