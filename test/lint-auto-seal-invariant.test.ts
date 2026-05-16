/**
 * Auto-seal invariant — v0.7.81 (cross-platform fix v0.7.82).
 *
 * Enforces the contract the v0.7.76-v0.7.81 auto-sealing campaign exists
 * to establish: every graph edge write goes through `commitKnowledge`
 * (the canonical write path) or through one of the explicitly whitelisted
 * helper / analytical / context-assembly modules. Any new `store.relate(...)`
 * call in `src/` outside the whitelist fails this test and CI.
 *
 * The bypass procedure when a legitimate new use case appears: add the
 * file to `APPROVED_RELATE_CALLERS` below with a comment explaining the
 * rationale. The PR reviewer audits the addition just like any other
 * whitelist entry.
 *
 * Regex shape (per v0.7.81 Stage 2 audit):
 *   - `RELATE_METHOD_RE`: statement-start anchored to skip false positives
 *     from comments / JSDoc / string literals. Matches `await store.relate(`,
 *     `return store.relate(`, `await state.store.relate(`, etc.
 *   - `RAW_RELATE_RE`: catches `RELATE foo->bar` template-string usage in
 *     surreal.ts's 5-pillar wrappers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");

/**
 * Files allowed to contain `store.relate(...)` calls or raw `RELATE`
 * SurrealQL statements. Every entry has a one-line justification.
 */
const APPROVED_RELATE_CALLERS = new Set<string>([
  // The canonical write path. All commitConcept / commitMemory / commitArtifact
  // / commitReflection / commitSubagent / commitSkill / commitCorrection
  // helpers + the linkToProject + linkConceptCrossLink utilities live here.
  "src/engine/commit.ts",

  // linkToRelevantConcepts (used for mentions, about_concept, artifact_mentions,
  // skill_uses_concept dynamic edges) + linkConceptHierarchy (broader/narrower
  // similarity-based wiring). Called by commit.ts.
  "src/engine/concept-links.ts",

  // Analytical post-hoc edges (caused_by, supports, contradicts, describes)
  // wired between EXISTING memory rows after extraction analysis. Not a
  // "new node + edge" pattern; doesn't fit commitKnowledge's shape.
  "src/engine/causal.ts",

  // Pre-0.7.23 orphan-recovery: backfills derived_from for concept/subagent
  // rows that lost their provenance edge due to a historical schema-mismatch
  // bug. One-off migration path, not a normal write path.
  "src/engine/recovery.ts",

  // Turn ingestion: part_of (turn→session), responds_to (turn→turn). These
  // fire during the user-prompt-submit / pre-tool-use hooks as the
  // conversation is captured; commitKnowledge doesn't model turn writes.
  "src/context-assembler.ts",

  // Public MCP tool for manual broader/narrower assertions. Users invoke
  // this to set hierarchy explicitly; it's the explicit-edge counterpart
  // to commit.ts's similarity-based hierarchy linking.
  "src/tools/link-hierarchy.ts",

  // SurrealStore.relate() method body itself + four 5-pillar wrappers
  // (session_task, task_part_of, performed, owns) using raw RELATE
  // SurrealQL. These are the underlying primitives commitKnowledge uses.
  "src/engine/surreal.ts",
]);

/** `await store.relate(...)`, `return store.relate(...)`, optionally with
 *  `state.` prefix. Statement-start anchored to skip JSDoc/comment hits. */
const RELATE_METHOD_RE = /^\s*(?:await\s+|return\s+)?(?:state\.)?store\.relate\s*\(/m;

/** Raw SurrealQL `RELATE x->edge` pattern in template literals. */
const RAW_RELATE_RE = /\bRELATE\s+\S+\s*->/;

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".mts"))) out.push(full);
  }
  return out;
}

describe("auto-seal invariant (v0.7.81)", () => {
  it("no unapproved store.relate(...) call sites in src/", () => {
    const files = walkTs(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      // v0.7.82: normalize Windows backslashes to forward slashes so the
      // APPROVED_RELATE_CALLERS Set (which uses forward-slash paths) matches
      // on both POSIX and Windows runners. Without this, Windows CI returned
      // "src\engine\concept-links.ts" while the whitelist contained
      // "src/engine/concept-links.ts" — every approved file flagged as a
      // violation. Same cross-platform-path bug class as the v0.7.70/v0.7.71
      // CRLF regex fixes.
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      const content = readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Anchored regex requires statement-start, so single-line tests work.
        const methodMatch = RELATE_METHOD_RE.test(line);
        const rawMatch = RAW_RELATE_RE.test(line);
        if ((methodMatch || rawMatch) && !APPROVED_RELATE_CALLERS.has(rel)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(v => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      const msg = [
        `Found ${violations.length} store.relate(...) call site(s) outside the auto-seal whitelist:`,
        lines,
        "",
        "Hand-wired store.relate() calls outside the whitelisted modules violate the",
        "auto-sealing invariant established by the v0.7.76-v0.7.81 campaign. Either:",
        "  (a) Route the write through commitKnowledge({ kind: \"...\", ... }) in",
        "      src/engine/commit.ts, which auto-seals all schema-required edges.",
        "  (b) If the use case is genuinely outside commitKnowledge's contract",
        "      (e.g. analytical post-hoc edges, recovery / migration paths),",
        "      add the file to APPROVED_RELATE_CALLERS in this test with a",
        "      comment explaining the rationale.",
        "See CHANGELOG.md [0.7.76]-[0.7.81] entries for context.",
      ].join("\n");
      throw new Error(msg);
    }
  });
});
