/**
 * Cross-platform path invariant (v0.7.90).
 *
 * Flags code that will pass on Linux/macOS CI but fail on Windows CI because
 * the check uses POSIX path assumptions. The v0.7.89 release was forced into
 * a same-day follow-up commit (9214a73 — "fix(test): make Fix #3
 * CLAUDE_PLUGIN_ROOT assertion platform-portable") because a test wrote
 * `env.CLAUDE_PLUGIN_ROOT.startsWith("/")` to check absolute-path-ness. That
 * returns true on POSIX (paths start with `/`) and false on Windows (paths
 * start with `C:\` or `\\?\`), so Linux CI was green and Windows CI failed
 * 1m27s in. This lint test fails `npm test` so the pre-push hook blocks the
 * pattern before it gets a chance to ship and break Windows CI.
 *
 * Three patterns are flagged:
 *
 *   1. `.startsWith("/")` or `.startsWith('/')` — POSIX-only absolute-path
 *      check. Replace with `import { isAbsolute } from "node:path"`; then
 *      `isAbsolute(p)`. (`isAbsolute` correctly recognizes both `C:\` and
 *      `/foo` shapes.)
 *
 *   2. `.startsWith("\\")` or `.startsWith('\\\\')` — Windows-only check.
 *      Same fix.
 *
 *   3. `.split("\n")` on file content — misses CRLF on Windows. Replace
 *      with `.split(/\r?\n/)`.
 *
 *   4. `path.sep === "/"` / `path.sep !== "\\"` — direct comparison against
 *      sep literals. Almost always wrong; use `path.isAbsolute`, `path.join`,
 *      `path.normalize`, or `path.posix.*` / `path.win32.*` explicitly.
 *
 * Exemption: APPROVED_FILES is a name-keyed Set with a one-line justification
 * per entry. Add a file only when the pattern is intentional (e.g. it's a
 * URL-path check, not a filesystem-path check), and document why.
 *
 * Walks `src/**` and `test/**`. Skips this test file itself (it carries the
 * patterns as string literals for documentation), `node_modules`, `dist`,
 * and dot-prefixed dirs. Comment-only lines (starting with `//` or ` *`) are
 * skipped to avoid flagging the in-docstring examples above.
 *
 * Cross-platform path normalization in the test itself: paths are normalized
 * to forward-slash with `.replace(/\\/g, "/")` before being checked against
 * APPROVED_FILES, same pattern v0.7.82 added to lint-auto-seal-invariant.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");
const TEST_DIR = resolve(REPO_ROOT, "test");

/** `.startsWith("/")` or `.startsWith('/')`. The space allowance covers
 *  `.startsWith( "/" )` style formatting. */
const STARTSWITH_FORWARD_SLASH_RE = /\.startsWith\s*\(\s*["']\/["']\s*\)/;

/** `.startsWith("\\")` (in source written as `\\\\`). Less common in our
 *  codebase but flagged for completeness — same bug class. */
const STARTSWITH_BACK_SLASH_RE = /\.startsWith\s*\(\s*["']\\\\["']\s*\)/;

/** `path.sep === "/"` / `path.sep !== "\\"`. The lookahead allows `!==` and
 *  `==` variants. Whitespace tolerant. */
const PATHSEP_COMPARE_RE = /\bpath\.sep\s*[!=]==?\s*["'][\/\\]["']/;

/** `.split("\n")` without `\r?` tolerance. We don't flag `.split("\\r\\n")`
 *  (Windows-only) because that's a deliberate choice; the LF-only form is
 *  the one that silently breaks. */
const PLAIN_NEWLINE_SPLIT_RE = /\.split\s*\(\s*["']\\n["']\s*\)/;

/** Files allowed to contain these patterns. Each entry must have a one-line
 *  justification as a comment. Paths are forward-slash relative to REPO_ROOT.
 */
const APPROVED_FILES = new Set<string>([
  // This lint test carries the patterns as documentation/fixtures.
  "test/lint-cross-platform-paths.test.ts",
]);

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSyncSafe(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".mts"))) out.push(full);
  }
  return out;
}

function existsSyncSafe(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

describe("cross-platform path invariant (v0.7.90)", () => {
  it("no POSIX-only path checks in src/ or test/", () => {
    const files = [...walkTs(SRC_DIR), ...walkTs(TEST_DIR)];
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; line: number; text: string; pattern: string }> = [];

    for (const file of files) {
      // Normalize Windows backslashes to forward slashes so APPROVED_FILES
      // matches on both runners. Same shape as v0.7.82's fix in
      // lint-auto-seal-invariant.test.ts.
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (APPROVED_FILES.has(rel)) continue;

      const content = readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip comment lines to avoid flagging docstring examples.
        if (/^\s*\/\//.test(line)) continue;
        if (/^\s*\*/.test(line)) continue;

        if (STARTSWITH_FORWARD_SLASH_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim(), pattern: "startsWith('/')" });
        }
        if (STARTSWITH_BACK_SLASH_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim(), pattern: "startsWith('\\\\')" });
        }
        if (PATHSEP_COMPARE_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim(), pattern: "path.sep direct comparison" });
        }
        if (PLAIN_NEWLINE_SPLIT_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim(), pattern: "split('\\n') without CRLF tolerance" });
        }
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.file}:${v.line}  [${v.pattern}]\n    ${v.text}`).join("\n");
      const msg = [
        `Found ${violations.length} cross-platform-brittle pattern(s) in src/ or test/:`,
        details,
        ``,
        `Fix by:`,
        `  startsWith('/') for filesystem path  → import { isAbsolute } from "node:path"; isAbsolute(p)`,
        `  split("\\n") for file content        → split(/\\r?\\n/)`,
        `  path.sep direct compare              → use path module helpers (isAbsolute, join, normalize) instead`,
        ``,
        `If the pattern is intentional (e.g. a URL path check, not a filesystem path), whitelist the file in APPROVED_FILES with a one-line justification.`,
        ``,
        `Context: v0.7.89 shipped a test using \`startsWith("/")\` that passed on Linux CI then failed on Windows CI 1m27s in. The fix commit 9214a73 replaced it with \`path.isAbsolute()\`. This lint prevents the recurrence by failing \`npm test\` before push.`,
      ].join("\n");
      throw new Error(msg);
    }
  });
});
