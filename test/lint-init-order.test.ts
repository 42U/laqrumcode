/**
 * Daemon init-order invariant (v0.7.91).
 *
 * The auto-drain scheduler MUST be armed BEFORE any `await store.initialize()`
 * or `await embeddings.initialize()` calls in `src/daemon/index.ts`. v0.7.89
 * shipped an init order that called `startDrainScheduler` AFTER the slow
 * embeddings init; when the embedding model loaded slowly (or hung), the
 * scheduler never armed. Daemon stayed "alive" (HTTP API up) but
 * `pending_work` queue stopped draining. This lint asserts the structural
 * ordering so the regression cannot ship.
 *
 * The check is a line-number comparison on the parsed source, NOT a runtime
 * assertion — runtime would require an actually-hanging init, which is
 * impractical to simulate in a unit test.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DAEMON_INDEX = resolve(REPO_ROOT, "src/daemon/index.ts");

function findFirstLine(content: string, re: RegExp): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines so the regex doesn't false-fire on a
    // docstring example like "// before any `await store.initialize()`".
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;
    if (re.test(line)) return i + 1;
  }
  return -1;
}

describe("daemon init-order invariant (v0.7.91)", () => {
  it("startDrainScheduler is called BEFORE await store.initialize() in src/daemon/index.ts", () => {
    const content = readFileSync(DAEMON_INDEX, "utf8");

    // Find the actual call site (not the import line).
    // The import is `import { startDrainScheduler, ... } from`; the call is
    // `startDrainScheduler(` followed by an arg expression, not by `,` or `}`.
    const callLine = findFirstLine(
      content,
      /^\s*startDrainScheduler\s*\(\s*\w/,
    );
    const importLine = findFirstLine(
      content,
      /^\s*import\s*\{[^}]*\bstartDrainScheduler\b/,
    );

    expect(callLine, "startDrainScheduler() call must exist in src/daemon/index.ts").toBeGreaterThan(0);
    expect(callLine, "startDrainScheduler() call must not be the import line itself").not.toBe(importLine);

    const storeInitLine = findFirstLine(content, /\bawait\s+store\.initialize\s*\(/);
    const embeddingsInitLine = findFirstLine(content, /\bawait\s+embeddings\.initialize\s*\(/);

    expect(storeInitLine, "await store.initialize() must exist in src/daemon/index.ts").toBeGreaterThan(0);
    expect(embeddingsInitLine, "await embeddings.initialize() must exist in src/daemon/index.ts").toBeGreaterThan(0);

    if (callLine >= storeInitLine || callLine >= embeddingsInitLine) {
      throw new Error(
        `Daemon init-order invariant violated.\n\n` +
        `  startDrainScheduler() call at src/daemon/index.ts:${callLine}\n` +
        `  await store.initialize() at      src/daemon/index.ts:${storeInitLine}\n` +
        `  await embeddings.initialize() at src/daemon/index.ts:${embeddingsInitLine}\n\n` +
        `startDrainScheduler MUST be called BEFORE both await store.initialize() AND await embeddings.initialize().\n` +
        `Otherwise, if either init hangs or takes too long, the scheduler never arms, daemon appears alive\n` +
        `(HTTP API on), but pending_work queue stops draining. v0.7.89 shipped this exact regression and\n` +
        `v0.7.90 lacked this lint. Move the startDrainScheduler(...) block earlier in initializeStack().`,
      );
    }
  });
});
