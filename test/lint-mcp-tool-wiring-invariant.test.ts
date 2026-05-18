/**
 * MCP tool wiring invariant (v0.7.85).
 *
 * Enforces the 5-surface contract for every MCP tool. Adding a new tool
 * requires coordinated edits across:
 *
 *   A. src/mcp-server.ts                  TOOLS array               (legacy in-process path)
 *   B. src/shared/tool-defs.ts            MCP_TOOLS                 (thin-client advertisement)
 *   C. src/shared/tool-defs.ts            MCP_TO_IPC_METHOD         (snake -> dotted-camel mapping)
 *   D. src/shared/ipc-types.ts            IPC_METHODS               (typesafe method union)
 *   E. src/daemon/index.ts                server.register call      (actual handler wiring)
 *
 * This test extracts each set by regex and fails if any tool is missing from
 * any surface relative to the source-of-truth (A). v0.7.84 shipped with
 * `create_skill` and `get_skill_body` in A only; the daemon-split path was
 * unreachable through any live MCP client until v0.7.85 wired them through.
 * This lint prevents recurrence by failing fast at `npm test`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** Convert dotted-camelCase tail (e.g. "createSkill") to snake_case ("create_skill"). */
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()).replace(/^_/, "");
}

function extractFromMcpServer(): Set<string> {
  const file = readSrc("src/mcp-server.ts");
  // The TOOLS array starts with `const TOOLS = [` and ends with `];`.
  const m = file.match(/const TOOLS\s*=\s*\[\s*([\s\S]*?)\n\];/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/^\s*name:\s*"([a-z_]+)"/gm)].map((x) => x[1]));
}

function extractFromToolDefsMcpTools(): Set<string> {
  const file = readSrc("src/shared/tool-defs.ts");
  const m = file.match(/export const MCP_TOOLS\s*=\s*\[\s*([\s\S]*?)\n\] as const;/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/^\s*name:\s*"([a-z_]+)"/gm)].map((x) => x[1]));
}

function extractFromToolDefsMap(): Set<string> {
  const file = readSrc("src/shared/tool-defs.ts");
  const m = file.match(/export const MCP_TO_IPC_METHOD[^{]*\{\s*([\s\S]*?)\n\};/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/^\s*([a-z_]+):\s*"tool\./gm)].map((x) => x[1]));
}

function extractFromIpcTypes(): Set<string> {
  const file = readSrc("src/shared/ipc-types.ts");
  const m = file.match(/export const IPC_METHODS\s*=\s*\[\s*([\s\S]*?)\n\] as const;/);
  if (!m) return new Set();
  const dotted = [...m[1].matchAll(/"tool\.([a-zA-Z]+)"/g)].map((x) => x[1]);
  return new Set(dotted.map(camelToSnake));
}

function extractFromDaemonIndex(): Set<string> {
  const file = readSrc("src/daemon/index.ts");
  const matches = [
    ...file.matchAll(
      /server\.register\(\s*"tool\.[a-zA-Z]+"\s*,\s*wrapToolHandler\(\s*\w+\s*,\s*"([a-z_]+)"\s*\)/g,
    ),
  ];
  return new Set(matches.map((x) => x[1]));
}

/** Extract the "tool.X" first-arg strings from server.register(...) calls. */
function extractDaemonRegisterFirstArgs(): Set<string> {
  const file = readSrc("src/daemon/index.ts");
  const matches = [
    ...file.matchAll(/server\.register\(\s*"(tool\.[a-zA-Z]+)"\s*,/g),
  ];
  return new Set(matches.map((x) => x[1]));
}

/** Extract MCP_TO_IPC_METHOD as full key→value pairs. */
function extractToolDefsMapPairs(): Map<string, string> {
  const file = readSrc("src/shared/tool-defs.ts");
  const m = file.match(/export const MCP_TO_IPC_METHOD[^{]*\{\s*([\s\S]*?)\n\};/);
  if (!m) return new Map();
  const pairs = new Map<string, string>();
  for (const x of m[1].matchAll(/^\s*([a-z_]+):\s*"(tool\.[a-zA-Z]+)"/gm)) {
    pairs.set(x[1], x[2]);
  }
  return pairs;
}

function diff(label: string, source: Set<string>, target: Set<string>, sourceLabel: string, targetLabel: string): string[] {
  const out: string[] = [];
  for (const t of source) {
    if (!target.has(t)) out.push(`  - "${t}" in ${sourceLabel} but missing from ${targetLabel}`);
  }
  for (const t of target) {
    if (!source.has(t)) out.push(`  - "${t}" in ${targetLabel} but missing from ${sourceLabel}`);
  }
  return out;
}

describe("MCP tool wiring invariant (v0.7.85)", () => {
  it("every tool name appears in all 5 surfaces", () => {
    const A = extractFromMcpServer();
    const B = extractFromToolDefsMcpTools();
    const C = extractFromToolDefsMap();
    const D = extractFromIpcTypes();
    const E = extractFromDaemonIndex();

    expect(A.size, "extracted tool count from src/mcp-server.ts TOOLS array").toBeGreaterThan(0);

    const surfaces: Array<[string, Set<string>, string]> = [
      ["B", B, "src/shared/tool-defs.ts MCP_TOOLS"],
      ["C", C, "src/shared/tool-defs.ts MCP_TO_IPC_METHOD"],
      ["D", D, "src/shared/ipc-types.ts IPC_METHODS (tool.* filtered)"],
      ["E", E, "src/daemon/index.ts server.register calls"],
    ];

    const violations: string[] = [];
    for (const [letter, set, label] of surfaces) {
      const d = diff(letter, A, set, "src/mcp-server.ts (source of truth)", label);
      violations.push(...d);
    }

    if (violations.length > 0) {
      const msg = [
        `MCP tool wiring invariant violated. Adding a new MCP tool requires`,
        `coordinated edits across all 5 surfaces:`,
        ``,
        `  A. src/mcp-server.ts          TOOLS array`,
        `  B. src/shared/tool-defs.ts    MCP_TOOLS`,
        `  C. src/shared/tool-defs.ts    MCP_TO_IPC_METHOD`,
        `  D. src/shared/ipc-types.ts    IPC_METHODS (tool.* entries)`,
        `  E. src/daemon/index.ts        server.register(...) calls`,
        ``,
        `Violations:`,
        ...violations,
        ``,
        `Fix by adding the missing tool name to each flagged surface. See CHANGELOG.md`,
        `[0.7.85] for context on why this invariant exists.`,
      ].join("\n");
      throw new Error(msg);
    }
  });

  // v0.7.96 hardening (added after deep-dive audit 2026-05-18). The 5-surface
  // membership check above catches the v0.7.84 failure class (tool present
  // in A only). It does NOT catch value-side drift: if
  // MCP_TO_IPC_METHOD.core_memory = "tool.coreMem" but the daemon registers
  // "tool.coreMemory", both surfaces still have the snake_case key
  // "core_memory" so membership matches — but the IPC dispatch fails at
  // runtime because the client sends "tool.coreMem" while the server only
  // knows "tool.coreMemory". This test asserts that every value in
  // MCP_TO_IPC_METHOD appears verbatim as a first-arg in
  // server.register(...) in daemon/index.ts.
  it("every MCP_TO_IPC_METHOD value matches a server.register first-arg", () => {
    const map = extractToolDefsMapPairs();
    const registered = extractDaemonRegisterFirstArgs();
    expect(map.size, "extracted MCP_TO_IPC_METHOD pair count").toBeGreaterThan(0);
    expect(registered.size, "extracted server.register first-arg count").toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [snakeKey, dottedValue] of map.entries()) {
      if (!registered.has(dottedValue)) {
        violations.push(
          `  - MCP_TO_IPC_METHOD.${snakeKey} = "${dottedValue}" but no server.register("${dottedValue}", ...) call found in src/daemon/index.ts`,
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          `MCP_TO_IPC_METHOD value drift: values must match server.register(...) first args verbatim.`,
          ``,
          `Violations:`,
          ...violations,
          ``,
          `This catches typos like MCP_TO_IPC_METHOD.foo = "tool.foO" vs server.register("tool.foo", ...) — the membership check passes but the dispatch fails at runtime.`,
        ].join("\n"),
      );
    }
  });
});
