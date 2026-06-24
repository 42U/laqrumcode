#!/usr/bin/env node
// One-shot: append v0.7.91 sections to laqrumcode-release skill body, create
// pre-flight-done-check skill. Idempotent — re-running on an already-updated
// DB row is detected by checking for the v0.7.91 marker string in the body.

import { Surreal } from "/home/zero/voidorigin/laqrumcode/node_modules/surrealdb/dist/surrealdb.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "laqrum";
const DB = process.env.SURREAL_DB || "memory";

const REPO_ROOT = "/home/zero/voidorigin/laqrumcode";
const RELEASE_ADDITIONS = readFileSync(join(REPO_ROOT, "scripts/v091-laqrumcode-release-additions.md"), "utf8");
const PREFLIGHT_BODY = readFileSync(join(REPO_ROOT, "scripts/v091-pre-flight-done-check.md"), "utf8");

const db = new Surreal();
await db.connect(URL);
await db.signin({ username: USER, password: PASS });
await db.use({ namespace: NS, database: DB });

const cur = await db.query(`SELECT id, body FROM skill WHERE name = "laqrumcode-release" LIMIT 1`);
const row = cur[0]?.[0];
if (!row) {
  console.error("laqrumcode-release skill not found");
  process.exit(1);
}
const existing = row.body || "";

if (existing.includes("(added v0.7.91)")) {
  console.log(`SKIP laqrumcode-release: already contains v0.7.91 additions`);
} else {
  const newBody = existing + "\n" + RELEASE_ADDITIONS;
  // Clear embedding so the backfill job re-embeds with the new body content.
  await db.query(`UPDATE skill SET body = $body, embedding = NONE WHERE name = "laqrumcode-release"`, { body: newBody });
  console.log(`UPDATED laqrumcode-release body: ${existing.length} -> ${newBody.length} chars`);
}

const existsCheck = await db.query(`SELECT id FROM skill WHERE name = "pre-flight-done-check" LIMIT 1`);
const preCheck = existsCheck[0] || [];
if (preCheck.length > 0) {
  await db.query(`UPDATE skill SET body = $body, embedding = NONE WHERE name = "pre-flight-done-check"`, { body: PREFLIGHT_BODY });
  console.log(`UPDATED pre-flight-done-check body (existing row)`);
} else {
  const created = await db.query(
    `CREATE skill CONTENT {
      name: "pre-flight-done-check",
      description: $description,
      body: $body,
      steps: [],
      active: true,
      confidence: 1.0,
      source: "create_skill_v091"
    } RETURN id`,
    {
      description: `Pre-flight checklist invoked before declaring any bug fix shipped, verified, or done. Catches the "tests passed locally so shipped" failure mode by requiring CI receipts + daemon restart + live grep on the original bug signature before the user-facing reply.`,
      body: PREFLIGHT_BODY,
    },
  );
  const newId = created[0]?.[0]?.id;
  console.log(`CREATED pre-flight-done-check skill at ${newId?.tb}:${newId?.id}`);
}

await db.close();
console.log("done");
