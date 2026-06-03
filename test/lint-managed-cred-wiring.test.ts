/**
 * Phase 2 managed-credential WIRING invariant (source-level).
 *
 * resolveReusedTargetCred + getOrCreateManagedCred are unit-tested directly in
 * managed-cred.test.ts. What a pure-function test CANNOT see is whether the
 * production call sites are wired correctly. This file locks the wiring by
 * inspecting source text (same idiom as lint-spawn-env-completeness.test.ts):
 *
 *   1. bootstrap()'s FRESH-MANAGED-SPAWN path must spawn the child with the
 *      GENERATED cred (getOrCreateManagedCred), NOT input.surrealUser/Pass.
 *      A regression here would spawn with root:root again (the bug Phase 2
 *      removes) or spawn with one secret and connect with another (auth fail).
 *
 *   2. Every `surrealServer: { ... }` object literal returned by bootstrap()
 *      must carry `user` and `pass` keys, so BootstrapResult always conveys a
 *      credential for the chosen target.
 *
 *   3. The daemon (src/daemon/index.ts) must adopt result.surrealServer.user
 *      and .pass into config.surreal after bootstrap — otherwise SurrealStore
 *      connects with the default config creds and the managed child rejects it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const BOOTSTRAP = resolve(REPO_ROOT, "src/engine/bootstrap.ts");
const DAEMON = resolve(REPO_ROOT, "src/daemon/index.ts");

describe("Phase 2 managed-cred wiring invariant", () => {
  const bootstrapSrc = readFileSync(BOOTSTRAP, "utf8");
  const daemonSrc = readFileSync(DAEMON, "utf8");

  it("fresh managed spawn uses the generated cred, not input.surrealUser/Pass", () => {
    // Locate the spawnManagedSurreal(...) CALL (not the function definition).
    // The definition is `async function spawnManagedSurreal(`; the call is
    // `managedSurreal = await spawnManagedSurreal(`.
    const callIdx = bootstrapSrc.indexOf("await spawnManagedSurreal(");
    expect(callIdx, "spawnManagedSurreal call must exist").toBeGreaterThan(-1);
    const window = bootstrapSrc.slice(callIdx, callIdx + 400);

    // Must pass the generated cred's fields.
    expect(window).toMatch(/managedCred\.user/);
    expect(window).toMatch(/managedCred\.pass/);
    // Must NOT pass the configured input creds into the managed spawn (that
    // was the pre-Phase-2 behavior that produced a root:root managed child).
    expect(window).not.toMatch(/input\.surrealUser/);
    expect(window).not.toMatch(/input\.surrealPass/);

    // And the generated cred is obtained via the idempotent helper just above.
    const preWindow = bootstrapSrc.slice(Math.max(0, callIdx - 400), callIdx);
    expect(preWindow).toMatch(/getOrCreateManagedCred\(input\.cacheDir\)/);
  });

  it("every surrealServer return literal carries user and pass", () => {
    // Find each `surrealServer: {` object literal and slurp to its closing `}`.
    const re = /surrealServer:\s*\{/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(bootstrapSrc)) !== null) {
      // Walk forward to the matching brace (these literals are small + flat).
      const start = m.index + m[0].length - 1; // at the `{`
      let depth = 0;
      let end = start;
      for (let i = start; i < bootstrapSrc.length; i++) {
        const ch = bootstrapSrc[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      const literal = bootstrapSrc.slice(start, end + 1);
      count++;
      expect(literal, `surrealServer literal #${count} must carry user`).toMatch(/\buser\b/);
      expect(literal, `surrealServer literal #${count} must carry pass`).toMatch(/\bpass\b/);
    }
    // Sanity: the BootstrapResult.surrealServer type def + three return
    // branches (SURREAL_URL override, reuse, fresh) = 4 `surrealServer: {`
    // sites, every one of which must carry user + pass.
    expect(count).toBe(4);
  });

  it("daemon adopts surrealServer.user and .pass into config.surreal", () => {
    expect(daemonSrc).toMatch(/result\.surrealServer\.user/);
    expect(daemonSrc).toMatch(/result\.surrealServer\.pass/);
    // Assigned onto config.surreal (the object SurrealStore is built from).
    expect(daemonSrc).toMatch(/config\.surreal as \{ user: string \}\)\.user/);
    expect(daemonSrc).toMatch(/config\.surreal as \{ pass: string \}\)\.pass/);
  });
});
