/**
 * Static integrity check between schema.surql RELATION definitions
 * and src/ call sites that invoke store.relate(<from>, "<edge>", <to>).
 *
 * Heuristic: infer the IN/OUT table from variable-name suffix
 * (conceptId → concept, taskId → task, …). When a from/to identifier
 * isn't a known suffix we skip — the goal is to catch the obvious
 * mismatches like the 0.7.22 derived_from bug, not to type-check
 * arbitrary expressions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(__dirname, "..", "src");
const SCHEMA_PATH = join(SRC_DIR, "engine", "schema.surql");

interface RelationDef {
  edge: string;
  inTables: string[];
  outTables: string[];
}

function parseRelations(schema: string): Map<string, RelationDef> {
  const out = new Map<string, RelationDef>();
  const re =
    /DEFINE\s+TABLE\s+(?:(?:IF\s+NOT\s+EXISTS|OVERWRITE)\s+)?(\w+)\s+TYPE\s+RELATION\s+IN\s+([^\s]+)\s+OUT\s+([^\s;]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema)) !== null) {
    out.set(m[1], {
      edge: m[1],
      inTables: m[2].split("|").map(s => s.trim()),
      outTables: m[3].split("|").map(s => s.trim()),
    });
  }
  return out;
}

const SUFFIX_TO_TABLE: Array<[RegExp, string]> = [
  [/conceptId$/i, "concept"],
  [/taskId$/i, "task"],
  [/artifactId$/i, "artifact"],
  [/sessionId$/i, "session"],
  [/surrealSessionId$/i, "session"],
  [/subagentId$/i, "subagent"],
  [/skillId$/i, "skill"],
  [/memoryId$/i, "memory"],
  [/turnId$/i, "turn"],
  [/projectId$/i, "project"],
  [/agentId$/i, "agent"],
  [/reflectionId$/i, "reflection"],
];

function inferTable(expr: string): string | null {
  const trimmed = expr.trim();
  // Peel String(x) wrappers
  const inner = trimmed.match(/^String\(([^)]+)\)$/)?.[1] ?? trimmed;
  // Peel item.<name>, session.<name>, data.<name>, etc.
  const tail = inner.split(".").pop()!;
  for (const [re, table] of SUFFIX_TO_TABLE) {
    if (re.test(tail)) return table;
  }
  return null;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkTs(p, acc);
    else if (entry.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

interface CallSite {
  file: string;
  line: number;
  edge: string;
  fromExpr: string;
  toExpr: string;
}

function findRelateCalls(): CallSite[] {
  const calls: CallSite[] = [];
  const re =
    /\.relate\(\s*([^,]+?)\s*,\s*"([^"]+)"\s*,\s*([^)]+?)\s*\)/g;
  for (const file of walkTs(SRC_DIR)) {
    const text = readFileSync(file, "utf-8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      calls.push({
        file: file.replace(SRC_DIR + "/", ""),
        line,
        fromExpr: m[1],
        edge: m[2],
        toExpr: m[3],
      });
    }
  }
  return calls;
}

describe("schema/edge integrity", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  const relations = parseRelations(schema);
  const calls = findRelateCalls();

  it("schema declares a non-empty set of relations", () => {
    expect(relations.size).toBeGreaterThan(10);
  });

  it("every store.relate edge name is declared in schema", () => {
    const missing: string[] = [];
    for (const c of calls) {
      if (!relations.has(c.edge)) {
        missing.push(`${c.file}:${c.line} → "${c.edge}"`);
      }
    }
    expect(missing, `Edges used in code but undefined in schema:\n${missing.join("\n")}`)
      .toEqual([]);
  });

  it("every inferable (edge, from, to) is allowed by schema", () => {
    const violations: string[] = [];
    for (const c of calls) {
      const def = relations.get(c.edge);
      if (!def) continue;
      const fromTable = inferTable(c.fromExpr);
      const toTable = inferTable(c.toExpr);
      if (fromTable && !def.inTables.includes(fromTable)) {
        violations.push(
          `${c.file}:${c.line} → ${c.edge}: IN ${fromTable} not in [${def.inTables.join("|")}] (expr: ${c.fromExpr})`,
        );
      }
      if (toTable && !def.outTables.includes(toTable)) {
        violations.push(
          `${c.file}:${c.line} → ${c.edge}: OUT ${toTable} not in [${def.outTables.join("|")}] (expr: ${c.toExpr})`,
        );
      }
    }
    expect(violations, `Schema/code mismatches:\n${violations.join("\n")}`).toEqual([]);
  });
});
