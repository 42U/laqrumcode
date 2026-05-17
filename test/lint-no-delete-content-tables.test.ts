/**
 * D4 — no-DELETE-on-content-tables invariant (v0.7.94).
 *
 * Founder rule (2026-05-17, core_memory:c7hcrruuezcmehmd30yd, Tier 0 p95):
 * > "Nothing should be getting deleted."
 *
 * Content-bearing tables (memory, concept, skill, reflection, monologue,
 * identity_chunk, core_memory, artifact, turn_archive) are append-only.
 * Destructive operations on these tables must use soft-deactivate
 * (UPDATE status='archived' / active=false / superseded_at = time::now())
 * with an archive_reason annotation for forensic recovery. This lint fails
 * CI if any `DELETE <content_table>` pattern appears in src/.
 *
 * The destructive consolidate/GC/dedup patterns inherited from KongBrain
 * fork (commit 5b93d73, 2026-04-06) silently destroyed user memory for ~6
 * weeks before v0.7.93 converted all 11 sites. This lint prevents
 * regression.
 *
 * Legitimate exceptions:
 *   - `turn` table: archived via INSERT INTO turn_archive + DELETE turn
 *     (lossless move, not a destructive op). Whitelist the archiveOldTurns
 *     site specifically.
 *   - Comment / docstring text containing "DELETE" — skipped via line
 *     content heuristic (must be a SurrealQL string, not a // or *).
 *   - Migration scripts in scripts/ are outside src/ scope.
 *   - Volatile / non-content tables: pending_work, orchestrator_metrics,
 *     retrieval_outcome, embedding_cache, maintenance_runs — DELETE OK.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");

/** Content-bearing tables. DELETE on these is forbidden by founder rule. */
const CONTENT_TABLES = [
  "memory",
  "concept",
  "skill",
  "reflection",
  "monologue",
  "identity_chunk",
  "core_memory",
  "artifact",
  "turn_archive",
];

/** Approved file:line exception sites with rationale. */
const APPROVED_EXCEPTIONS = new Set<string>([
  // No exceptions yet. Add format: "src/engine/foo.ts:123  // <one-line reason>"
  // when the v0.7.94 ratchet legitimately needs a content-table DELETE.
]);

/** Files allowed to mention DELETE in comments / lint-regex strings. */
const NON_QUERY_FILES = new Set<string>([
  "src/engine/hooks/edit-gates.ts",  // lint regex DEFINES the DELETE pattern
  "src/engine/hooks/profile.ts",     // saved core_memory text mentions DELETE
]);

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
  table: string;
  content: string;
}

/** Find DELETE <content_table> occurrences in actual SurrealQL strings
 *  (not comments or non-query files). Heuristic: line must contain a
 *  backtick + start with whitespace + DELETE + table, OR be inside a
 *  template literal context (queryExec call). */
function scan(file: string): Hit[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
  if (NON_QUERY_FILES.has(rel)) return [];

  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip comment-only lines
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const tb of CONTENT_TABLES) {
      // Match DELETE <table> followed by space/newline/semicolon.
      // Also catch DELETE FROM <table> and DELETE <table> WHERE ....
      const re = new RegExp(`\\bDELETE\\s+(?:FROM\\s+)?${tb}\\b`);
      if (re.test(line)) {
        hits.push({ file: rel, line: i + 1, table: tb, content: line.trim() });
      }
    }
  }
  return hits;
}

describe("D4 — no-DELETE-on-content-tables invariant", () => {
  it("no DELETE on any content-bearing table outside the approved exception list", () => {
    const files = walkTs(SRC_DIR);
    const allHits: Hit[] = [];
    for (const f of files) allHits.push(...scan(f));
    const unapproved = allHits.filter(h => !APPROVED_EXCEPTIONS.has(`${h.file}:${h.line}`));
    if (unapproved.length > 0) {
      const details = unapproved
        .map(h => `  ${h.file}:${h.line}  [${h.table}]  ${h.content}`)
        .join("\n");
      throw new Error(
        `D4: ${unapproved.length} DELETE statement(s) on content tables found:\n${details}\n\n` +
          `Founder rule: "Nothing should be getting deleted." Use soft-deactivate ` +
          `instead — UPDATE active=false / status='archived' / superseded_at=time::now() ` +
          `with an archive_reason annotation. See v0.7.93 CHANGELOG for the conversion ` +
          `template. If this DELETE is genuinely append-safe (e.g. paired with INSERT INTO ` +
          `${"<table>_archive"}), add it to APPROVED_EXCEPTIONS with a one-line rationale.`,
      );
    }
    expect(unapproved.length).toBe(0);
  });
});
