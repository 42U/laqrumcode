/**
 * Categorical block on edits to linter/formatter config files.
 *
 * Steers the agent to fix code instead of weakening tooling. Carve-outs:
 * pyproject.toml, package.json, tsconfig.json are NOT in the denylist — they
 * hold real project metadata that legitimately needs editing, not just
 * lint/format rules.
 *
 * Bypass: LAQRUMCODE_ALLOW_CONFIG_EDIT=1 skips the check for the lifetime
 * of the daemon. Useful when the user is intentionally tuning configs.
 */

import { basename, resolve } from "node:path";

const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([
  // ESLint
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  // Prettier
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  "prettier.config.js",
  "prettier.config.mjs",
  "prettier.config.cjs",
  // Biome
  "biome.json",
  "biome.jsonc",
  // Ruff
  ".ruff.toml",
  "ruff.toml",
  // Shell
  ".shellcheckrc",
  // Stylelint
  ".stylelintrc",
  ".stylelintrc.js",
  ".stylelintrc.json",
  ".stylelintrc.yml",
  ".stylelintrc.yaml",
  "stylelint.config.js",
  "stylelint.config.cjs",
  // EditorConfig
  ".editorconfig",
]);

/** Bypass set by env. Read once — the env is stable for the daemon's life. */
let bypassActive: boolean | null = null;
function readBypass(): boolean {
  const raw = (process.env.LAQRUMCODE_ALLOW_CONFIG_EDIT ?? "").trim();
  return raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}

export function isProtectedConfigFile(filePath: string): boolean {
  if (!filePath) return false;
  if (bypassActive === null) bypassActive = readBypass();
  if (bypassActive) return false;
  const base = basename(resolve(filePath));
  return PROTECTED_BASENAMES.has(base);
}

/**
 * Test-only: clear bypass cache and let a new env take effect.
 * @internal
 */
export function _resetConfigProtectionCacheForTests(): void {
  bypassActive = null;
}

/** Exported for tests + the Tier-0 directive text. */
export function listProtectedBasenames(): string[] {
  return Array.from(PROTECTED_BASENAMES).sort();
}
