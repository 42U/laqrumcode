/**
 * D2 — cosine + destructive op requires identity guard (v0.7.94).
 *
 * Background: v0.7.92's skill-supersede bug deactivated unrelated skills
 * because the SQL `SELECT ... FROM skill ... cosine ≥ 0.82 ... UPDATE
 * active = false` had only a similarity guard, no `name = $newName`
 * equality clause. Long procedural-skill bodies routinely cleared 0.82
 * cosine between unrelated skills. The fix: every cosine-driven UPDATE/
 * DELETE/early-return must additionally check a domain-identity field.
 *
 * This lint walks every `.ts` file in src/, finds SQL strings that contain
 * `vector::similarity::cosine`, and asserts that:
 *   - the SQL contains a non-similarity equality guard
 *     (`name =`, `category =`, `path =`, `string::lowercase(text) =`,
 *     `session_id =`, etc.), OR
 *   - the file:line is whitelisted as a READ-ONLY cosine site (search,
 *     ranking, edge-creation) that doesn't feed a destructive op.
 *
 * v0.7.93 verified: every destructive cosine site in kongcode has a guard.
 * This lint prevents drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");

/** Read-only cosine sites that do NOT feed a destructive op.
 *  Format: `src/path/file.ts:approxLine` — line is the START of the
 *  multi-line SQL template (the line with `vector::similarity::cosine`). */
const READ_ONLY_COSINE_SITES = new Set<string>([
  // vectorSearch — multi-table retrieval, read-only. Lines are the
  // `vector::similarity::cosine` line within each SELECT statement.
  "src/engine/surreal.ts:422",  // turn (same-session)
  "src/engine/surreal.ts:426",  // turn (cross-session)
  "src/engine/surreal.ts:434",  // turn_archive
  "src/engine/surreal.ts:439",  // concept
  "src/engine/surreal.ts:445",  // memory
  "src/engine/surreal.ts:450",  // artifact
  "src/engine/surreal.ts:455",  // monologue
  "src/engine/surreal.ts:460",  // identity_chunk

  // tagBoostedConcepts — read-only ranking for tag boost.
  "src/engine/surreal.ts:883",

  // graphExpand kNN — cosine used as a scoreExpr in neighbor-fetch SELECT.
  // Read-only ranking, no destructive op on matched neighbors.
  "src/engine/surreal.ts:915",

  // upsertConcept dedup-candidate scan — KNN over concepts with the same
  // superseded_at IS NONE filter. Race-recovery / first-write path; the
  // upsert decision uses the result for a content-equality match, not for
  // a destructive op.
  "src/engine/surreal.ts:1038",

  // commitCorrection oldText resolver (commit.ts:1053 concept, :1062 memory)
  // — vector match to find the user-named supersede target. Decays stability
  // explicitly (not silent), invoked only via the supersede MCP tool with
  // explicit user intent.
  "src/engine/commit.ts:1053",
  "src/engine/commit.ts:1062",

  // upsertConcept race-recovery KNN match — read-only fallback on UNIQUE
  // collision; returns existing id without mutating.
  "src/engine/surreal.ts:1127",

  // findRelevantSkills (skills.ts) and findSimilarReflections
  // (reflection.ts) — read-only retrieval.
  "src/engine/skills.ts:108",
  "src/engine/reflection.ts:55",

  // linkToRelevantConcepts / linkConceptHierarchy — creates edges
  // (mentions, about_concept, etc.); doesn't destructively mutate
  // the matched node.
  "src/engine/concept-links.ts:42",
  "src/engine/concept-links.ts:109",
  "src/engine/concept-links.ts:154",

  // causal.ts cause search — read-only lookup of candidate cause memories
  // for chain construction. Doesn't mutate the matched row.
  "src/engine/causal.ts:163",

  // link-hierarchy MCP tool — user-invoked explicit hierarchy assertion,
  // read-only candidate lookup before creating broader/narrower edges.
  "src/tools/link-hierarchy.ts:52",

  // what-is-missing diagnostic — read-only.
  "src/tools/what-is-missing.ts:63",
]);

/** Identity-guard patterns. The cosine SQL must contain at least one. */
const IDENTITY_GUARDS = [
  /\bname\s*=\s*\$/,
  /\bcategory\s*=\s*\$/,
  /\bpath\s*=\s*\$/,
  /\bsession_id\s*=\s*\$/,
  /string::lowercase\(text\)\s*=\s*string::lowercase/,
  /\btext\s*=\s*\$/,
];

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  block: string;
}

function scan(file: string): Hit[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/vector::similarity::cosine/.test(lines[i] ?? "")) continue;
    // Capture the SQL block — heuristic: walk forward until we see the
    // closing backtick or a line that begins a new statement (function
    // call ), }, ;).
    let blockEnd = i;
    for (let j = i; j < Math.min(i + 30, lines.length); j++) {
      blockEnd = j;
      if (/`\s*,?\s*$/.test(lines[j] ?? "") || /^\s*\);/.test(lines[j] ?? "")) break;
    }
    const block = lines.slice(Math.max(0, i - 3), blockEnd + 1).join("\n");
    hits.push({ file: rel, line: i + 1, block });
  }
  return hits;
}

describe("D2 — cosine + destructive op requires identity guard", () => {
  it("every cosine SQL outside the read-only whitelist has an identity guard", () => {
    const files = walkTs(SRC_DIR);
    const allHits: Hit[] = [];
    for (const f of files) allHits.push(...scan(f));

    const unguarded = allHits.filter(h => {
      const key = `${h.file}:${h.line}`;
      if (READ_ONLY_COSINE_SITES.has(key)) return false;
      // Allow ±1 line drift on whitelist for editing convenience.
      if (
        READ_ONLY_COSINE_SITES.has(`${h.file}:${h.line - 1}`) ||
        READ_ONLY_COSINE_SITES.has(`${h.file}:${h.line + 1}`)
      ) return false;
      // Otherwise, require an identity guard in the SQL block.
      return !IDENTITY_GUARDS.some(re => re.test(h.block));
    });

    if (unguarded.length > 0) {
      const details = unguarded
        .map(h => `  ${h.file}:${h.line}  (no name=/category=/path=/text= guard found)`)
        .join("\n");
      throw new Error(
        `D2: ${unguarded.length} cosine SQL site(s) without an identity guard:\n${details}\n\n` +
          `If this site is READ-ONLY (search / ranking / edge creation), add it to ` +
          `READ_ONLY_COSINE_SITES with the file:line. Otherwise add an identity guard ` +
          `(e.g. AND name = \$newName, AND category = \$cat, AND string::lowercase(text) = ` +
          `string::lowercase(\$text)) to the SQL. See supersedeOldSkills (skills.ts:53) ` +
          `for the canonical guarded pattern.`,
      );
    }
    expect(unguarded.length).toBe(0);
  });
});
