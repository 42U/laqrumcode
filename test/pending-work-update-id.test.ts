/**
 * Regression test for the UPDATE $id bug class.
 *
 * Context: SurrealDB rejects `UPDATE $id SET ...` when $id is a plain string
 * parameter — the surreal-js client serializes strings as strings, not as
 * RecordId types. The only query shape that works is either:
 *   (a) direct interpolation after assertRecordId validation, OR
 *   (b) passing a true RecordId instance as the param (which we don't do
 *       anywhere in the codebase).
 *
 * This test scans the compiled sources for any remaining `UPDATE $id`,
 * `SELECT * FROM $id`, or `DELETE $id` patterns where the surrounding code
 * does NOT contain an assertRecordId or direct-interpolation-safe marker.
 *
 * It's a static-analysis test, not a SurrealDB integration test — much
 * faster in CI and catches the regression at source-review time without
 * requiring a running DB.
 *
 * To convert this into a full integration test later, add Docker-backed
 * SurrealDB fixture and call handleFetchPendingWork + handleCommitWorkResults
 * end-to-end. That's out of scope for the first version.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  content: string;
  safe: boolean;
}

function scan(file: string): Hit[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const hits: Hit[] = [];
  const pattern = /\b(UPDATE|SELECT\s+\*\s+FROM|DELETE)\s+\$[a-zA-Z_][a-zA-Z0-9_]*\b/;

  // Native SurQL FOR loop over a SELECT id result lets you DELETE $var.id
  // or UPDATE $var.id where $var is a row object with a record-id-typed id
  // field. That's legal SurrealDB syntax, not the JS-param bug class we're
  // catching. v0.7.93 added UPDATE to the exception alongside DELETE when
  // garbageCollectMemories / garbageCollectConcepts converted from
  // FOR $m IN $stale { DELETE $m.id } to FOR $m IN $stale { UPDATE $m.id SET ... }.
  const forLoopOpPattern = /(?:DELETE|UPDATE)\s+\$\w+\.\w+/;
  const forIntroPattern = /FOR\s+\$\w+\s+IN/;

  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue;

    // Skip DELETE/UPDATE $m.id when the surrounding lines open a FOR $x IN block
    if (forLoopOpPattern.test(lines[i])) {
      const contextStart = Math.max(0, i - 8);
      const context = lines.slice(contextStart, i + 1).join("\n");
      if (forIntroPattern.test(context)) continue;
    }

    // Check the 6 lines above for an assertRecordId / assertWorkRecordId /
    // safety marker comment.
    const start = Math.max(0, i - 6);
    const window = lines.slice(start, i + 1).join("\n");
    const safe =
      /assertRecordId/.test(window) ||
      /assertWorkRecordId/.test(window) ||
      /Direct interpolation safe/.test(window) ||
      /SurrealDB rejects/.test(window);
    hits.push({ file, line: i + 1, content: lines[i].trim(), safe });
  }
  return hits;
}

describe("UPDATE $id regression", () => {
  it("has no unsafe UPDATE/SELECT/DELETE $id patterns in src/", () => {
    const files = walk(SRC_ROOT);
    const allHits: Hit[] = [];
    for (const f of files) {
      allHits.push(...scan(f));
    }
    const unsafe = allHits.filter(h => !h.safe);
    if (unsafe.length > 0) {
      const details = unsafe.map(h =>
        `  ${h.file.replace(SRC_ROOT, "src")}:${h.line}  ${h.content}`
      ).join("\n");
      throw new Error(
        `Found ${unsafe.length} unsafe $id SQL patterns without ` +
        `assertRecordId guard:\n${details}\n\n` +
        `Fix: assertRecordId(id) + \`UPDATE \${id} SET ...\` direct interpolation. ` +
        `See src/engine/surreal.ts relate() for the canonical pattern.`
      );
    }
    expect(unsafe.length).toBe(0);
  });
});
