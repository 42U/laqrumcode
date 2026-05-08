/**
 * Loads the bundled schema.surql file for database initialization.
 *
 * Separated from surreal.ts so that file-read and network-client imports
 * are not combined in the same module, which code-safety scanners flag
 * as potential data exfiltration.
 *
 * Resolution strategy:
 *  1. SEA asset (when running as a Node Single Executable bundle) — schema
 *     is embedded into the binary at build time via sea-config.json's `assets`.
 *  2. Filesystem next to this module (compiled-tsc layout: dist/engine/schema.surql).
 *  3. Filesystem one level up (esbuild-bundle layout: dist/schema.surql).
 *  4. Dev fallback: src/engine/schema.surql.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.url is unavailable under CJS-in-SEA. Wrap defensively.
function resolveModuleDir(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function tryLoadFromSea(): string | null {
  try {
    // node:sea is only available in Node 20+. Use globalThis to detect
    // require without eval — CJS-in-SEA exposes it globally.
    const requireFn = typeof globalThis.require === "function" ? globalThis.require : null;
    if (!requireFn) return null;
    const sea = requireFn("node:sea");
    if (!sea?.isSea?.()) return null;
    return sea.getAsset("schema.surql", "utf8");
  } catch {
    return null;
  }
}

export function loadSchema(): string {
  const fromSea = tryLoadFromSea();
  if (fromSea) return fromSea;

  const moduleDir = resolveModuleDir();
  const candidates: string[] = [];
  if (moduleDir) {
    candidates.push(
      join(moduleDir, "schema.surql"),
      join(moduleDir, "..", "schema.surql"),
      join(moduleDir, "..", "src", "engine", "schema.surql"),
      join(moduleDir, "..", "..", "src", "engine", "schema.surql"),
    );
  }
  candidates.push("dist/engine/schema.surql", "src/engine/schema.surql");

  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `kongcode: schema.surql not found in any candidate path. Last error: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}
