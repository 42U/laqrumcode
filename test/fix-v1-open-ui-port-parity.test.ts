/**
 * V1 regression guard: the user-facing launcher scripts/open-ui.mjs must derive
 * the UI port from the SAME source as the daemon (uiPort() in dist/ui-server.js),
 * never a duplicated literal.
 *
 * Round-9 U1 moved uiPort's base 28900→33000 in src/ui-server.ts but the
 * launcher (and the skill doc) kept a hardcoded 28900, so on the default config
 * the daemon bound :3X000 while `node scripts/open-ui.mjs` opened :29900 — the
 * UI was unreachable for ~100% of default installs, and the bearer token in the
 * ?token= URL would be handed to whatever process held the stale port. This
 * guards the single-source-of-truth invariant so the two can never drift again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { uiPort, UI_PORT_BASE } from "../src/ui-server.js";

const launcher = readFileSync(new URL("../scripts/open-ui.mjs", import.meta.url), "utf8");
const skillDoc = readFileSync(new URL("../skills/kongcode-web-ui/SKILL.md", import.meta.url), "utf8");

describe("V1: open-ui.mjs derives the UI port from uiPort() (single source of truth)", () => {
  it("imports uiPort from the built ui-server and calls it (no duplicated formula)", () => {
    expect(launcher).toMatch(/import\s*\{[^}]*\buiPort\b[^}]*\}\s*from\s*["'][^"']*ui-server\.js["']/);
    expect(launcher).toMatch(/=\s*uiPort\(\)/);
  });

  it("contains NO active hardcoded UI-port formula (the U1/V1 drift source)", () => {
    // The drift signal is an ACTIVE port-derivation literal (e.g. `28900 + (uid
    // % N)`). A historical mention of 28900 in an explanatory comment is fine —
    // so strip comments first, then assert the CODE has no port formula / stale
    // literal left.
    const code = launcher
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/\d{4,5}\s*\+\s*\(?\s*uid\s*%/);
    expect(code).not.toContain("28900");
  });

  it("the skill doc states the current default base (33000), not the stale 28900", () => {
    expect(skillDoc).not.toContain("28900");
    expect(skillDoc).toContain(String(UI_PORT_BASE)); // 33000
  });

  it("uiPort() default is the UI base, well clear of the old 28900", () => {
    const saved = process.env.KONGCODE_UI_PORT;
    delete process.env.KONGCODE_UI_PORT;
    try {
      expect(UI_PORT_BASE).toBe(33000);
      expect(uiPort()).toBeGreaterThanOrEqual(UI_PORT_BASE);
    } finally {
      if (saved !== undefined) process.env.KONGCODE_UI_PORT = saved;
    }
  });
});
