/**
 * R4 regression — ReDoS in PostToolUse path extraction.
 *
 * The old `EXT_PATH_RE` ( /[\w./~-]+\.(?:ts|...)\b/g ) put `.` inside the `+`
 * character class AND required a literal `\.` after it. On an adversarial
 * dot-heavy tool result (a Grep/recall payload full of dots) the class and the
 * literal dot overlap at every position, so when the trailing extension fails
 * to match the engine retries every partition of the dot-run — catastrophic
 * O(n^2)+ backtracking. Measured ~4s for a single 64KB all-dots slice, run
 * synchronously on the shared daemon event loop inside handlePostToolUse, i.e.
 * every co-located session stalls for seconds per malicious PostToolUse.
 *
 * The K48 64KB slice cap bounds the LENGTH of the scanned text but not the
 * backtracking cost — 64KB of dots is exactly the worst case it still admits.
 *
 * Fix: a tokenized + length-capped + anchored extractor (`extractExtPaths`):
 * split on whitespace/wrapping punctuation, reject tokens over MAX_PATH_TOKEN,
 * then test each short token with an ANCHORED `^...$` regex (no global scan, so
 * no restart-at-every-offset blowup). String.split is linear; the per-token
 * regex work is bounded. Result is sub-millisecond on the same input.
 *
 * These tests would FAIL (time out / take seconds) against the pre-fix regex.
 */
import { describe, it, expect, vi } from "vitest";
import { extractExtPaths, handlePostToolUse } from "../src/hook-handlers/post-tool-use.js";
import { SessionState } from "../src/engine/state.js";
import type { GlobalPluginState } from "../src/engine/state.js";

/** Wall-clock a synchronous callback, in milliseconds. */
function timeMs(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Generous ceiling: the fix runs sub-ms in practice, the vulnerable regex took
// ~4000ms. 200ms cleanly separates fixed from broken even on a loaded CI box.
const REDOS_BUDGET_MS = 200;

describe("R4: extractExtPaths is ReDoS-safe on adversarial input", () => {
  // Each of these inputs drove the OLD regex into multi-second backtracking.
  const attacks: Array<[string, string]> = [
    ["64KB all dots", ".".repeat(64 * 1024)],
    ["32K 'x.' repeats", "x.".repeat(32 * 1024)],
    ["16K 'word.' repeats", "word.".repeat(16 * 1024)],
    ["dot-run then non-matching tail", "a.".repeat(30000) + "!"],
    ["one giant dotted token", "a" + ".a".repeat(40000)],
    ["64K trailing colons", "f.ts" + ":".repeat(64 * 1024)],
  ];

  for (const [name, input] of attacks) {
    it(`completes well under ${REDOS_BUDGET_MS}ms on ${name}`, () => {
      const ms = timeMs(() => extractExtPaths(input, () => {}));
      expect(ms).toBeLessThan(REDOS_BUDGET_MS);
    });
  }
});

describe("R4: extractExtPaths still extracts the paths the edit-gate needs", () => {
  function collect(text: string): string[] {
    const out: string[] = [];
    extractExtPaths(text, (p) => out.push(p));
    return out;
  }

  it("captures a relative source path as a single entry", () => {
    expect(collect("src/engine/state.ts")).toContain("src/engine/state.ts");
  });

  it("captures bare filenames with a known extension", () => {
    const got = collect("touched plain.md and config.json here");
    expect(got).toContain("plain.md");
    expect(got).toContain("config.json");
  });

  it("captures multiple space-separated paths on one line", () => {
    const got = collect("package.json  tsconfig.json  vite.config.ts");
    expect(got).toEqual(
      expect.arrayContaining(["package.json", "tsconfig.json", "vite.config.ts"]),
    );
  });

  it("strips a grep/compiler line:col suffix to recover the clean path", () => {
    // grep -n (spaced match), tsc (numeric col), and grep on a no-whitespace
    // line where the whole `path.ext:line:hit` stays a single token — the head
    // matcher recovers the leading path the old \b-anchored regex got for free.
    expect(collect("src/engine/state.ts:42:  const x = 1;")).toContain("src/engine/state.ts");
    expect(collect("src/foo.ts:12:5")).toContain("src/foo.ts");
    expect(collect("bar.js:7:hit")).toContain("bar.js");
  });

  it("keeps a leading ./ on relative paths", () => {
    expect(collect("./rel/path.json")).toContain("./rel/path.json");
  });

  it("does NOT extract unknown extensions", () => {
    const got = collect("foo.exe bar.unknownext");
    expect(got).toHaveLength(0);
  });
});

// --- End-to-end through the real handler (the actual hot path) -------------

function makeState(session: SessionState): GlobalPluginState {
  const store = {
    isAvailable: () => false, // skip the artifact-commit branch
    queryFirst: vi.fn(async () => []),
    queryExec: vi.fn(async () => {}),
  } as unknown as GlobalPluginState["store"];
  const embeddings = {
    isAvailable: () => false,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as unknown as GlobalPluginState["embeddings"];
  const state = {
    store,
    embeddings,
    config: { thresholds: { midSessionCleanupThreshold: 25_000 } },
  } as unknown as GlobalPluginState;
  (state as unknown as { getSession: (k: string) => SessionState | undefined }).getSession =
    (k: string) => (k === session.sessionKey ? session : undefined);
  return state;
}

describe("R4: handlePostToolUse survives a dot-bomb Grep payload", () => {
  it("returns promptly and does not stall the event loop", async () => {
    const session = new SessionState("r4-sess", "r4-sess");
    const state = makeState(session);
    // A Grep result with a real path early (inside the K48 64KB slice window)
    // followed by an adversarial dot-run that used to drive the regex into
    // multi-second backtracking.
    const payload = {
      session_id: "r4-sess",
      tool_name: "Grep",
      tool_response: "src/engine/state.ts:1:hit\n" + ".".repeat(64 * 1024),
    };

    const t0 = process.hrtime.bigint();
    await handlePostToolUse(state, payload);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(ms).toBeLessThan(REDOS_BUDGET_MS);
    // And the legitimate path was still observed (the K48 behavior this refines).
    expect(session._observedFilePaths.has("src/engine/state.ts")).toBe(true);
  });
});
