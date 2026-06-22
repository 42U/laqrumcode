/**
 * D1 — backfill-coverage invariant (v0.7.94).
 *
 * Every content-bearing table whose hot-path write can persist a row with
 * `embedding=NONE` (because the embed call is wrapped in
 * `try { ... await embeddings.embed(...) } catch (e) { swallow(...) }`)
 * MUST have a corresponding `backfill<Table>Embeddings` function registered
 * in `src/engine/maintenance.ts`. Without that backfill, transient
 * BGE-M3 failures produce permanent recall sediment.
 *
 * v0.7.92 missed this for artifact + concept (29 stuck rows for 6 weeks).
 * v0.7.93 added artifact/concept backfill. v0.7.94 adds reflection +
 * monologue + turn_archive after the same bug class was found there.
 * This lint exists so the next "add a new content table" PR can't ship
 * without wiring the matching backfill.
 *
 * If a new table genuinely doesn't need backfill (e.g. embedding-optional
 * design), add it to `EXEMPT_TABLES` with a one-line rationale.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

/** Tables whose hot-path WRITE can leave embedding=NONE. Sourced from a
 *  grep of `swallow.*embed` patterns in src/. */
const TABLES_REQUIRING_BACKFILL = [
  "concept",
  "memory",      // covered by consolidateMemories Pass 2, not a separate backfill
  "artifact",
  "skill",
  "reflection",
  "monologue",
  "turn_archive",
] as const;

/** Tables exempt from backfill — embedding-optional, or seeded
 *  explicitly with no swallow path. */
const EXEMPT_TABLES = new Set<string>([
  "turn",            // live turn writes use synchronous embed; gone in <7d to archive
  "identity_chunk",  // seeded explicitly; no swallow-then-create path
  "core_memory",     // no embedding field at all
]);

describe("D1 — backfill-coverage invariant", () => {
  it("every TABLES_REQUIRING_BACKFILL has a backfill<Table>Embeddings function in maintenance.ts", () => {
    const maintenanceSrc = readFileSync(
      resolve(REPO_ROOT, "src/engine/maintenance.ts"),
      "utf-8",
    );

    // Map table name → expected function name. Special case: `memory`
    // backfill lives in surreal.ts::consolidateMemories Pass 2, not
    // maintenance.ts. Verify by looking for the consolidateMemories call
    // chain instead.
    const missing: string[] = [];
    for (const tb of TABLES_REQUIRING_BACKFILL) {
      if (EXEMPT_TABLES.has(tb)) continue;
      if (tb === "memory") {
        // memory backfill is consolidateMemories Pass 2 (surreal.ts:1889+).
        // Verify consolidateMemories is called from maintenance.ts Group 3.
        if (!/consolidateMemories\s*\(/.test(maintenanceSrc)) {
          missing.push(`memory (consolidateMemories not called from maintenance.ts)`);
        }
        continue;
      }
      // Function name = backfill<TableCamelCase>Embeddings.
      // turn_archive → backfillTurnArchiveEmbeddings.
      const camel = tb.replace(/(^|_)([a-z])/g, (_, _u, c) => c.toUpperCase());
      const fn = `backfill${camel}Embeddings`;
      const re = new RegExp(`async\\s+function\\s+${fn}\\b`);
      if (!re.test(maintenanceSrc)) {
        missing.push(`${tb} → expected function ${fn}`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `D1: ${missing.length} content table(s) lack backfill coverage:\n` +
          missing.map(m => `  ${m}`).join("\n") +
          `\n\nFix: add the backfill function to src/engine/maintenance.ts ` +
          `and call it from the Group-3 maintenance block. See ` +
          `backfillArtifactEmbeddings as the canonical template.`,
      );
    }
    expect(missing.length).toBe(0);
  });

  it("every registered backfill function is called from Group-3 maintenance", () => {
    const maintenanceSrc = readFileSync(
      resolve(REPO_ROOT, "src/engine/maintenance.ts"),
      "utf-8",
    );
    const fnDefs = [...maintenanceSrc.matchAll(/async\s+function\s+(backfill\w+Embeddings)\b/g)]
      .map(m => m[1] as string);
    const uncalled: string[] = [];
    for (const fn of fnDefs) {
      // Look for an invocation: a direct `await <fn>(` OR the runJob-wrapped
      // thunk form `() => <fn>(` (E1 wraps backfills in runJob for observability).
      const callRe = new RegExp(`(await\\s+${fn}|=>\\s*${fn})\\s*\\(`);
      if (!callRe.test(maintenanceSrc)) {
        uncalled.push(fn);
      }
    }
    if (uncalled.length > 0) {
      throw new Error(
        `D1: ${uncalled.length} backfill function(s) defined but never called:\n` +
          uncalled.map(f => `  ${f}`).join("\n"),
      );
    }
    expect(uncalled.length).toBe(0);
  });
});
