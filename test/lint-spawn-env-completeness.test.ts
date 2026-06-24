/**
 * Drain-subprocess spawn completeness invariant (v0.7.91).
 *
 * Every `spawn(claudeBin, ...)` call inside `src/daemon/auto-drain.ts` MUST:
 *
 *   1. Include `"--plugin-dir"` in the argv array. v0.7.85 omitted this and
 *      the spawned `claude --agent laqrumcode:memory-extractor-lite` subprocess
 *      had no laqrumcode plugin loaded, so its `fetch_pending_work` and
 *      `commit_work_results` tools didn't exist. Drain failed silently for
 *      two days because `stdio: "ignore"` hid the "tools are not available"
 *      stderr from any log.
 *
 *   2. Include `CLAUDE_PLUGIN_ROOT:` as an explicit key in `buildDrainEnv()`,
 *      with `PLUGIN_DIR` (derived from this daemon's own `import.meta.url`)
 *      as the value. Without this the subprocess's hooks fail to resolve
 *      `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/hook-proxy.cjs` and the SessionEnd
 *      hook is cancelled, breaking the event-driven drain chain (v0.7.86 /
 *      v0.7.88 history).
 *
 * The check inspects the source text of `auto-drain.ts`. For each `spawn(`
 * callsite that looks like a child claude invocation, slurp the next ~30
 * lines as the call's window and assert `"--plugin-dir"` literal is present.
 * Also assert `buildDrainEnv()` body contains an explicit
 * `CLAUDE_PLUGIN_ROOT: PLUGIN_DIR` (or equivalent) assignment in its base
 * env object.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const AUTO_DRAIN = resolve(REPO_ROOT, "src/daemon/auto-drain.ts");

describe("drain spawn completeness invariant (v0.7.91)", () => {
  const content = readFileSync(AUTO_DRAIN, "utf8");
  const lines = content.split(/\r?\n/);

  it("every spawn() call passes --plugin-dir", () => {
    const violations: Array<{ line: number; window: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      // Match `spawn(` that's a statement (not the import line and not a
      // method call like `child.spawn(`). The actual child-spawn calls in
      // this file are `const child = spawn(` or just `spawn(`.
      if (!/^\s*(?:const\s+\w+\s*=\s*)?spawn\s*\(/.test(lines[i])) continue;
      // Skip the `function spawn(` definition if it ever appears (it doesn't here).
      if (/^\s*function\s+spawn\s*\(/.test(lines[i])) continue;

      // Slurp this line + next 30 lines as the call window.
      const window = lines.slice(i, Math.min(i + 30, lines.length)).join("\n");

      if (!window.includes('"--plugin-dir"') && !window.includes("'--plugin-dir'")) {
        violations.push({ line: i + 1, window: window.slice(0, 400) });
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v =>
        `  src/daemon/auto-drain.ts:${v.line}\n${v.window.split(/\r?\n/).map(l => "    " + l).join("\n")}`
      ).join("\n\n");
      throw new Error(
        `Found ${violations.length} spawn() call(s) in auto-drain.ts that don't pass --plugin-dir:\n\n` +
        details +
        `\n\nEvery spawn(claudeBin, ...) MUST include "--plugin-dir" in argv. Without it the spawned\n` +
        `claude subprocess has no laqrumcode plugin loaded and its memory-extractor agent can't call\n` +
        `fetch_pending_work or commit_work_results. v0.7.85 shipped this gap; drain silently failed\n` +
        `for two days. Pass the plugin dir via the module-level PLUGIN_DIR constant.`,
      );
    }
  });

  it("buildDrainEnv() sets CLAUDE_PLUGIN_ROOT explicitly", () => {
    // Locate the function body — `function buildDrainEnv` then matching `}`.
    const fnStart = lines.findIndex(l => /^\s*function\s+buildDrainEnv\s*\(/.test(l));
    expect(fnStart, "buildDrainEnv function must exist in auto-drain.ts").toBeGreaterThanOrEqual(0);

    // Slurp a generous window — buildDrainEnv is under 50 lines historically.
    const fnBody = lines.slice(fnStart, Math.min(fnStart + 80, lines.length)).join("\n");

    // Must contain an explicit CLAUDE_PLUGIN_ROOT: <something> assignment
    // (key in the env object literal). The value should be PLUGIN_DIR
    // (module-level constant) or process.env.CLAUDE_PLUGIN_ROOT (less ideal
    // but acceptable). We just require the key to be set as part of the
    // base env, not only conditionally inside the ALLOWED_CLAUDE propagation
    // loop (which only fires if the parent's env had it).
    const baseAssignRe = /\bCLAUDE_PLUGIN_ROOT\s*:\s*\w/;
    if (!baseAssignRe.test(fnBody)) {
      throw new Error(
        `buildDrainEnv() in src/daemon/auto-drain.ts does not set CLAUDE_PLUGIN_ROOT explicitly in its base env object.\n\n` +
        `The conditional propagation through the ALLOWED_CLAUDE loop only works if the daemon's own\n` +
        `process.env carries CLAUDE_PLUGIN_ROOT, which isn't guaranteed for daemons spawned from a\n` +
        `detached shell. Add \`CLAUDE_PLUGIN_ROOT: PLUGIN_DIR\` to the env object at the top of\n` +
        `buildDrainEnv(). v0.7.86 / v0.7.88 / v0.7.89 had recurring SessionEnd-hook-cancelled bugs\n` +
        `that traced to this gap.`,
      );
    }
  });
});
