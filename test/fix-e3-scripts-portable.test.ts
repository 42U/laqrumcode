/**
 * E3 + E16 release-gate lint for the disaster-recovery scripts.
 *
 * These are STATIC source assertions (no SurrealDB, no daemon, no subprocess) so
 * they run on every platform in CI and gate every release.
 *
 * E3 (CRITICAL — portability): scripts/backup-jsonl.mjs and
 * scripts/restore-jsonl.mjs ship inside the npm package (package.json `files`
 * includes "scripts/"). They previously imported surrealdb from a hardcoded
 * absolute path —
 *     import { … } from "/home/<dev>/…/node_modules/surrealdb/dist/surrealdb.mjs"
 * — which exists ONLY on the author's machine, so disaster-recovery
 * (backup/restore) crashed with ERR_MODULE_NOT_FOUND on 100% of real installs.
 * The fix is the bare specifier `from "surrealdb"` (Node resolves it from the
 * installed package), matching scripts/migrate-*.mjs. This lint asserts the two
 * DR scripts contain NO absolute "/home/" path and NO absolute node_modules
 * import, so the regression can never silently return.
 *
 * E16 (data-loss): both scripts' NODE_TABLES list must enumerate EVERY node
 * (non-RELATION) table defined in src/engine/schema.surql — otherwise a table is
 * silently dropped from backup and lost on restore. The original omission was
 * `access_stats` (the 0.7.121 access-counter side table → losing access-count /
 * recency history). This lint diffs schema.surql's `DEFINE TABLE` node set
 * against each script's NODE_TABLES and fails on any missing table, so adding a
 * new node table to the schema without wiring backup/restore breaks the build.
 *
 * Scope: this gate covers the two disaster-recovery scripts only — they are the
 * E3/E16 deliverable and the highest-severity path (they run on a fresh or
 * broken install where the repo checkout's node_modules absolute path does not
 * exist). Sibling scripts (backup-semantic, forget, migrate-skills-to-db,
 * finalize-skill-migration, update-skills-v091) carry the identical absolute
 * node_modules import and need the same one-line fix in a follow-up lane.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SCHEMA_PATH = join(REPO, "src", "engine", "schema.surql");

/** The disaster-recovery scripts this gate protects (E3 + E16 deliverable). */
const DR_SCRIPTS = ["backup-jsonl.mjs", "restore-jsonl.mjs"] as const;

function readScript(name: string): string {
  return readFileSync(join(REPO, "scripts", name), "utf8");
}

/**
 * Parse src/engine/schema.surql for node (non-RELATION) table names. A node
 * table is `DEFINE TABLE [IF NOT EXISTS|OVERWRITE] <name> …` WITHOUT
 * `TYPE RELATION` on the same line. RELATION tables are edges (handled by the
 * scripts' separate EDGE_TABLES list) and are intentionally excluded.
 */
function schemaNodeTables(): string[] {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const out = new Set<string>();
  for (const line of sql.split(/\r?\n/)) {
    if (!/^DEFINE TABLE\b/.test(line)) continue;
    if (/\bTYPE\s+RELATION\b/.test(line)) continue; // edge table → not a node
    const m = line.match(/^DEFINE TABLE\s+(?:IF NOT EXISTS\s+|OVERWRITE\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * Extract the NODE_TABLES string array literal from a script's source. We parse
 * the literal text (not import the .mjs) so the lint stays a pure static check
 * with no runtime/daemon dependency. Captures the contents between
 * `const NODE_TABLES = [` and the matching `];`, then pulls every "quoted"
 * string token.
 */
function scriptNodeTables(src: string): string[] {
  const m = src.match(/const NODE_TABLES\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!m) throw new Error("NODE_TABLES array literal not found in script");
  const tokens = m[1].match(/"([^"]+)"/g) ?? [];
  return tokens.map(t => t.slice(1, -1)).sort();
}

describe("E3 — disaster-recovery scripts are install-portable", () => {
  for (const name of DR_SCRIPTS) {
    it(`${name} has no absolute /home/ path`, () => {
      const src = readScript(name);
      const offenders = src
        .split(/\r?\n/)
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes("/home/"));
      expect(
        offenders,
        `absolute /home/ path(s) would break on any non-author machine:\n` +
          offenders.map(o => `  ${name}:${o.n}: ${o.line.trim()}`).join("\n"),
      ).toEqual([]);
    });

    it(`${name} imports surrealdb by bare specifier, not an absolute node_modules path`, () => {
      const src = readScript(name);
      // No absolute node_modules import anywhere (the ERR_MODULE_NOT_FOUND class).
      const absImport = src.match(/import\s+[^;]*from\s+"\/[^"]*node_modules[^"]*"/g) ?? [];
      expect(
        absImport,
        `absolute node_modules import(s) crash on install:\n  ${absImport.join("\n  ")}`,
      ).toEqual([]);
      // And it positively imports surrealdb via the bare specifier.
      expect(src).toMatch(/import\s+\{[^}]*\}\s+from\s+"surrealdb"/);
    });
  }
});

describe("E16 — NODE_TABLES covers every schema node table (no silent backup loss)", () => {
  it("schema.surql exposes a non-empty node-table set including access_stats", () => {
    const nodes = schemaNodeTables();
    expect(nodes.length).toBeGreaterThan(0);
    // access_stats was the originally-omitted table; assert the parser sees it
    // so the coverage checks below are meaningful.
    expect(nodes).toContain("access_stats");
  });

  for (const name of DR_SCRIPTS) {
    it(`${name} NODE_TABLES contains every node table in schema.surql`, () => {
      const schemaNodes = schemaNodeTables();
      const scriptNodes = new Set(scriptNodeTables(readScript(name)));
      const missing = schemaNodes.filter(t => !scriptNodes.has(t));
      expect(
        missing,
        `${name} NODE_TABLES omits schema node table(s) → silently dropped from ` +
          `backup and lost on restore: ${missing.join(", ")}`,
      ).toEqual([]);
    });

    it(`${name} NODE_TABLES has no phantom table absent from schema.surql`, () => {
      // A node table listed by the script but not defined in the schema is dead
      // weight (a SELECT * over a nonexistent table is a harmless 0 rows) but
      // signals drift — assert the script list is a SUBSET of the schema's node
      // tables so renames/removals in schema.surql are caught here too.
      const schemaNodes = new Set(schemaNodeTables());
      const scriptNodes = scriptNodeTables(readScript(name));
      const phantom = scriptNodes.filter(t => !schemaNodes.has(t));
      expect(
        phantom,
        `${name} NODE_TABLES lists table(s) not defined in schema.surql ` +
          `(drift / rename?): ${phantom.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("backup-jsonl.mjs and restore-jsonl.mjs NODE_TABLES are identical", () => {
    // The two scripts MUST agree (restore reads what backup wrote). A divergence
    // means a table backed up but never restored, or vice-versa.
    const a = scriptNodeTables(readScript("backup-jsonl.mjs"));
    const b = scriptNodeTables(readScript("restore-jsonl.mjs"));
    expect(a).toEqual(b);
  });
});
