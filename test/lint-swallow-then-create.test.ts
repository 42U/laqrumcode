/**
 * D3 — swallow-then-create requires matching backfill (v0.7.94).
 *
 * Pattern: when a hot-path write embeds via
 *   try { embedding = await embeddings.embed(text); }
 *   catch (e) { swallow(...); }
 * and then `CREATE <table> CONTENT $record` (or store.create<Table>) with
 * the optional `embedding` field, a swallowed BGE-M3 failure persists a
 * row with `embedding = NONE`. Without a registered backfill for that
 * table, the row is permanent recall sediment (v0.7.92 found this for
 * artifact + concept; v0.7.93/v0.7.94 closed reflection + monologue +
 * turn_archive).
 *
 * This lint walks src/ for `swallow.*embed.*` patterns followed within 30
 * lines by a CREATE <table> or store.create<Table> / upsert<Table> call.
 * For each matched (swallow → create) pair it asserts that <table> has a
 * `backfill<Table>Embeddings` function defined in
 * `src/engine/maintenance.ts` (with `memory` covered by `consolidateMemories`
 * Pass 2 as the legacy equivalent).
 *
 * Whitelist `EXEMPT_CREATE_SITES` for sites where the create doesn't carry
 * an embedding field (and so the swallow can't persist null-embedding).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");

/** Table → expected coverage. "consolidateMemories" is the memory backfill
 *  legacy alias; otherwise look for `backfill<Camel>Embeddings`. */
const TABLE_COVERAGE: Record<string, string> = {
  concept: "backfillConceptEmbeddings",
  memory: "consolidateMemories",
  artifact: "backfillArtifactEmbeddings",
  skill: "backfillSkillEmbeddings",
  reflection: "backfillReflectionEmbeddings",
  monologue: "backfillMonologueEmbeddings",
  turn: "consolidateMemories",  // archived to turn_archive, no separate live-turn backfill
  turn_archive: "backfillTurnArchiveEmbeddings",
};

/** File:line sites exempt because the CREATE doesn't carry an embedding
 *  (and so the swallow can't leak null-embedding into the persisted row). */
const EXEMPT_CREATE_SITES = new Set<string>([
  // No exemptions yet; add as needed.
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
}

/** Find swallow-then-create pairs in a file. A "pair" is: a line matching
 *  `swallow.*embed` followed within 30 lines by a CREATE <table> or
 *  store.create<Table>/upsert<Table> call. */
function scan(file: string): Hit[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
  const hits: Hit[] = [];

  const swallowEmbedRe = /swallow(?:\.warn)?\s*\([^)]*embed/i;
  const createTableRe = /\bCREATE\s+(\w+)\b/;
  const storeCreateRe = /store\.create([A-Z]\w+)\s*\(/;
  const storeUpsertRe = /store\.upsert([A-Z]\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    if (!swallowEmbedRe.test(lines[i] ?? "")) continue;
    // Look ahead up to 30 lines for a CREATE / store.createX / store.upsertX.
    for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
      const line = lines[j] ?? "";
      const createM = createTableRe.exec(line);
      const storeCreateM = storeCreateRe.exec(line);
      const storeUpsertM = storeUpsertRe.exec(line);
      let table: string | undefined;
      if (createM) {
        table = createM[1]?.toLowerCase();
      } else if (storeCreateM) {
        // CamelCase → snake_case
        table = storeCreateM[1]
          ?.replace(/([A-Z])/g, "_$1")
          .replace(/^_/, "")
          .toLowerCase();
      } else if (storeUpsertM) {
        table = storeUpsertM[1]
          ?.replace(/([A-Z])/g, "_$1")
          .replace(/^_/, "")
          .toLowerCase();
      }
      if (table && Object.keys(TABLE_COVERAGE).includes(table)) {
        const key = `${rel}:${i + 1}`;
        if (EXEMPT_CREATE_SITES.has(key)) break;
        hits.push({ file: rel, line: i + 1, table });
        break;
      }
    }
  }
  return hits;
}

describe("D3 — swallow-then-create requires matching backfill", () => {
  it("every swallow-then-create pair has a registered backfill in maintenance.ts", () => {
    const files = walkTs(SRC_DIR);
    const allHits: Hit[] = [];
    for (const f of files) allHits.push(...scan(f));

    const maintenanceSrc = readFileSync(
      resolve(REPO_ROOT, "src/engine/maintenance.ts"),
      "utf-8",
    );
    const surrealSrc = readFileSync(
      resolve(REPO_ROOT, "src/engine/surreal.ts"),
      "utf-8",
    );

    const uncovered: string[] = [];
    for (const h of allHits) {
      const expected = TABLE_COVERAGE[h.table];
      if (!expected) {
        uncovered.push(`${h.file}:${h.line}  table=${h.table}  (no coverage registered)`);
        continue;
      }
      // Look for the expected backfill function in maintenance.ts; if not
      // found, allow consolidateMemories in surreal.ts as the legacy
      // memory-backfill counterpart.
      const inMaintenance = new RegExp(`\\b${expected}\\b`).test(maintenanceSrc);
      const inSurreal = new RegExp(`\\b${expected}\\b`).test(surrealSrc);
      if (!inMaintenance && !inSurreal) {
        uncovered.push(`${h.file}:${h.line}  table=${h.table}  → expected ${expected}, not found`);
      }
    }

    if (uncovered.length > 0) {
      throw new Error(
        `D3: ${uncovered.length} swallow-then-create pair(s) without registered backfill:\n` +
          uncovered.map(u => `  ${u}`).join("\n") +
          `\n\nFix: add backfill<Table>Embeddings to src/engine/maintenance.ts ` +
          `(mirror backfillArtifactEmbeddings as the template) and call it from ` +
          `the Group-3 maintenance block. See v0.7.94 CHANGELOG for the canonical ` +
          `pattern.`,
      );
    }
    expect(uncovered.length).toBe(0);
  });
});
