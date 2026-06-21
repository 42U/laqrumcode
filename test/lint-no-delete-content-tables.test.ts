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
 * G1 KEYSTONE EVOLUTION (2026-06-21, core_memory:hoj8fvmbt7d14mskciba):
 * the deletion policy changed — hard-deleting content is now PERMITTED, but
 * ONLY through the single audited choke point src/engine/gc.ts::gcHardDelete.
 * The CONTENT_TABLES list and the DELETE regex are UNCHANGED (loosening them
 * re-opens the 2026-04-06 silent-data-loss class). Instead a content DELETE
 * is allowed iff:
 *     file === 'src/engine/gc.ts'  AND
 *     the hit line OR a line in the enclosing function carries a
 *     `// GATED-GC:` marker.
 * This mirrors the COSINE_GUARD_OK marker-scoping pattern in
 * lint-cosine-identity-guard.test.ts (D2): approval is anchored on an inline,
 * self-documenting marker at the call site, NOT a blanket file whitelist and
 * NOT a line-number whitelist (which suffers the recurring line-shift tax).
 * D5 (below) independently asserts gcHardDelete still snapshots + after-
 * verifies, so a future edit cannot strip the safety primitives and keep the
 * gate open.
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
 *   - src/engine/gc.ts gated sites (see G1 KEYSTONE EVOLUTION above).
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
  // v0.7.95: pending_work is now append-only too. Was previously
  // categorized as "ephemeral by design" but the founder rule is
  // absolute: nothing should be DELETE'd from any content-bearing
  // table. tools/pending-work.ts + surreal.ts:purgeStalePendingWork
  // converted to UPDATE active=false.
  "pending_work",
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
  /** True if the hit line OR its enclosing function carries `// GATED-GC:`. */
  gated: boolean;
}

/** The single audited content-DELETE choke point. Only gated DELETEs here pass. */
const GC_KEYSTONE_FILE = "src/engine/gc.ts";

/** Inline marker that authorizes a content DELETE inside the keystone file.
 *  Mirrors the COSINE_GUARD_OK marker pattern in D2. */
const GATED_GC_MARKER = /\/\/\s*GATED-GC:/;

/** True if the hit line ITSELF carries the GATED-GC marker. SAME-LINE scope
 *  ONLY (GAP-2 fix, 2026-06-21): a function-body-wide search would let a future
 *  ad-hoc DELETE added ANYWHERE inside gcHardDelete be auto-laundered by the
 *  markers already present in that one large function — re-opening the blind/
 *  ad-hoc class within gc.ts. Each gated DELETE must carry its OWN
 *  `// GATED-GC:` marker on the same line; the keystone's two DELETE sites do. */
function isGatedHit(lines: string[], hitIdx: number): boolean {
  return GATED_GC_MARKER.test(lines[hitIdx] ?? "");
}

/** DYNAMIC-table DELETE detector (TIGHTENING, not loosening — added with the
 *  G1 keystone 2026-06-21). The literal CONTENT_TABLES regex below is left
 *  UNCHANGED; this is an ADDITIONAL pattern that catches `DELETE ${expr}` /
 *  `DELETE FROM ${expr}` template-interpolated table deletes. The keystone
 *  deletes via `DELETE ${table}` / `DELETE ${edgeTb}` (table is a parameter),
 *  so without this the keystone's own DELETEs are invisible to D4 and the gate
 *  would be vacuous. A grep confirmed ZERO `DELETE ${...}` exist outside
 *  gc.ts, so this introduces no false positives — but it now forces ANY future
 *  dynamic-table content DELETE to live in the gated keystone too. */
const DYNAMIC_DELETE_RE = /\bDELETE\s+(?:FROM\s+)?\$\{/;

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
        hits.push({
          file: rel,
          line: i + 1,
          table: tb,
          content: line.trim(),
          gated: rel === GC_KEYSTONE_FILE && isGatedHit(lines, i),
        });
      }
    }
    // Dynamic-table DELETE (`DELETE ${...}`) — table name is a JS expression.
    if (DYNAMIC_DELETE_RE.test(line)) {
      hits.push({
        file: rel,
        line: i + 1,
        table: "<dynamic>",
        content: line.trim(),
        gated: rel === GC_KEYSTONE_FILE && isGatedHit(lines, i),
      });
    }
  }
  return hits;
}

describe("D4 — no-DELETE-on-content-tables invariant", () => {
  it("no DELETE on any content-bearing table outside the keystone gate", () => {
    const files = walkTs(SRC_DIR);
    const allHits: Hit[] = [];
    for (const f of files) allHits.push(...scan(f));
    // A hit is allowed iff (a) it is a legacy file:line in APPROVED_EXCEPTIONS,
    // OR (b) it is a `// GATED-GC:`-marked DELETE inside the keystone file
    // src/engine/gc.ts. Every other content DELETE still fails.
    const unapproved = allHits.filter(
      h => !APPROVED_EXCEPTIONS.has(`${h.file}:${h.line}`) && !h.gated,
    );
    if (unapproved.length > 0) {
      const details = unapproved
        .map(h => `  ${h.file}:${h.line}  [${h.table}]  ${h.content}`)
        .join("\n");
      throw new Error(
        `D4: ${unapproved.length} DELETE statement(s) on content tables found:\n${details}\n\n` +
          `Deletion policy (core_memory:hoj8fvmbt7d14mskciba): content DELETE is permitted ` +
          `ONLY through the single audited keystone src/engine/gc.ts::gcHardDelete, and each ` +
          `gated site must carry a \`// GATED-GC:\` marker on the DELETE line or in its ` +
          `enclosing function. Everywhere else, use soft-deactivate — UPDATE active=false / ` +
          `status='archived' / superseded_at=time::now() with an archive_reason annotation. ` +
          `Do NOT loosen CONTENT_TABLES or the DELETE regex (that re-opens the 2026-04-06 ` +
          `silent-data-loss class).`,
      );
    }
    expect(unapproved.length).toBe(0);
  });

  it("the keystone file actually has gated DELETE sites (gate is wired, not vacuous)", () => {
    // Defensive: if a refactor removes every gated DELETE from gc.ts, the
    // marker-allow branch becomes dead code and a future un-gated DELETE could
    // slip in unnoticed. Assert the keystone carries at least the content
    // delete + the edge sweep.
    const gcHits = scan(resolve(SRC_DIR, "engine", "gc.ts"));
    const gated = gcHits.filter(h => h.gated);
    expect(
      gated.length,
      "expected ≥1 GATED-GC-marked content DELETE in src/engine/gc.ts",
    ).toBeGreaterThanOrEqual(1);
    // And: no UN-gated content DELETE may exist in the keystone file itself.
    const ungatedInKeystone = gcHits.filter(h => !h.gated);
    expect(
      ungatedInKeystone,
      `un-gated content DELETE(s) in the keystone file:\n${ungatedInKeystone
        .map(h => `  gc.ts:${h.line} [${h.table}] ${h.content}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * D5 — keystone safety-primitive presence lint (2026-06-21).
 *
 * Same strength as D1 (backfill-pairing): a presence/grep check that a future
 * edit cannot strip the snapshot write or the after-verify (dangling-edge)
 * check from gcHardDelete and still pass CI. Without D5, someone could delete
 * the snapshot + verify code, keep the `// GATED-GC:` markers, and the gate
 * would still "pass" D4 while no longer being reversible or verified.
 *
 * Checks (all against src/engine/gc.ts):
 *   1. a snapshot write exists  — `writeFileSync(` of the snapshot path.
 *   2. an after-verify dangling-edge check exists — a count over an edge
 *      table filtered by `in IN [...] OR out IN [...]` feeding verifyFailures.
 *   3. the after-verify THROWS on failure — `throw new Error` referencing the
 *      verify failure set.
 *   4. the target-gone assertion exists — a count of surviving targets.
 */
describe("D5 — gcHardDelete retains snapshot + after-verify primitives", () => {
  const gcSrc = readFileSync(resolve(SRC_DIR, "engine", "gc.ts"), "utf-8");

  it("gcHardDelete writes a reversible snapshot before deleting", () => {
    expect(
      /writeFileSync\s*\(\s*snapshotPath/.test(gcSrc),
      "snapshot write (writeFileSync(snapshotPath, ...)) missing — reversibility primitive stripped",
    ).toBe(true);
    // The snapshot must capture incident edges too, not just target rows.
    expect(
      /-- =+ INCIDENT EDGES =+/.test(gcSrc) ||
        /INCIDENT EDGES/.test(gcSrc),
      "snapshot does not capture incident edges",
    ).toBe(true);
  });

  it("gcHardDelete after-verifies zero dangling edges across relation tables", () => {
    // A dangling-edge verification: count edges still referencing the deleted
    // ids AFTER the delete, accumulating into a verify-failure set.
    const hasEdgeDanglingCheck =
      /verifyFailures/.test(gcSrc) &&
      /in IN \[\$\{idList\}\]\s+OR\s+out IN \[\$\{idList\}\]/.test(gcSrc) &&
      /RELATION_TABLES/.test(gcSrc);
    expect(
      hasEdgeDanglingCheck,
      "after-verify dangling-edge check (count of in/out ∈ ids over RELATION_TABLES → verifyFailures) missing",
    ).toBe(true);
  });

  it("gcHardDelete asserts the target rows are gone", () => {
    expect(
      /survivingTargets/.test(gcSrc) ||
        /target row\(s\) still present/.test(gcSrc),
      "target-gone assertion missing from after-verify",
    ).toBe(true);
  });

  it("gcHardDelete THROWS (does not silently pass) when after-verify fails", () => {
    const throwsOnVerifyFail =
      /if\s*\(\s*verifyFailures\.length\s*>\s*0\s*\)/.test(gcSrc) &&
      /throw new Error\(/.test(gcSrc);
    expect(
      throwsOnVerifyFail,
      "gcHardDelete must throw when verifyFailures is non-empty (no silent success)",
    ).toBe(true);
  });
});
