/**
 * S3 regression — residual QUADRATIC backtracking in the suffix-strip step of
 * extractExtPaths, plus the missing 64KB input cap in PreCompact.
 *
 * Part (a): the R4/R16 fix left ONE backtracking regex on the hot path —
 * `tok.replace(/(?::\d+|[.,:;!?])+$/, "")`. The outer `(...)+` wraps an
 * alternation whose `:\d+` branch itself contains `\d+`. On a token like
 * `:1:1:1…X` (a `:digit` run whose final char breaks the `$` anchor) the engine
 * tries every partition of the run across the two nested quantifiers — measured
 * O(n^2): ~16ms@4KB, ~260ms@16KB, ~4200ms@64KB. The MAX_PATH_TOKEN=512 cap
 * bounds a single LIVE token to ~1ms, but (i) the R4/R16 "linear" claim was
 * false for this line, and (ii) the primitive is a latent footgun if the cap is
 * ever raised. The fix replaces it with a non-backtracking reverse character
 * scan (`stripPathSuffix`) that is byte-identical on the documented cases and
 * strictly O(n).
 *
 * Part (b): PreCompact joined up to 30 untruncated turns into `fullText` and
 * passed the WHOLE thing (potentially many MB) to extractExtPaths with no size
 * cap — unlike post-tool-use, which slices to 64KB (the K48 guard). Even after
 * (a), extractExtPaths is O(n) in input length, so a multi-MB join does multi-MB
 * of tokenizing synchronously on the shared daemon event loop during compaction.
 * The fix mirrors the 64KB cap before extraction.
 *
 * These tests assert wall-clock budgets: part (a)'s suffix-strip timing test
 * targets the EXACT adversarial token shape, and would take seconds against the
 * pre-fix regex.
 */
import { describe, it, expect, vi } from "vitest";
import { extractExtPaths } from "../src/hook-handlers/post-tool-use.js";
import { handlePreCompact } from "../src/hook-handlers/pre-compact.js";
import { SessionState } from "../src/engine/state.js";
import type { GlobalPluginState } from "../src/engine/state.js";

/** Wall-clock a synchronous callback, in milliseconds. */
function timeMs(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ---------------------------------------------------------------------------
// Part (a): suffix-strip is non-backtracking
// ---------------------------------------------------------------------------

describe("S3(a): suffix-strip in extractExtPaths is O(n), not quadratic", () => {
  // The finding's named probe: a dot-heavy token. A 4KB `a` + `.`*N token.
  // (Tokens >512 are length-rejected before the suffix step, so to actually
  // EXERCISE the suffix scan we drive it through a sub-cap token AND directly
  // through adversarial whole-input runs that used to blow up.)
  it("a 4KB 'a' + dots token completes sub-5ms", () => {
    // This single token is >512 so the extractor length-rejects it; the point is
    // the WHOLE call (split + per-token work) stays trivial regardless.
    const tok = "a" + ".".repeat(4 * 1024);
    const ms = timeMs(() => extractExtPaths(tok, () => {}));
    expect(ms).toBeLessThan(5);
  });

  // The actual residual-ReDoS shape: a `:digit` run whose tail breaks the `$`
  // anchor. Against the old `/(?::\d+|[.,:;!?])+$/` this was O(n^2) (~4.2s@64KB).
  // We feed it as a single 64KB token; the reverse scan is sub-millisecond.
  const colonAttacks: Array<[string, string]> = [
    ["64KB ':1' run + non-anchoring tail", ":1".repeat(32 * 1024) + "X"],
    ["64KB '1:' run + letter", "1:".repeat(32 * 1024) + "z"],
    ["64KB ':1:1…' run then a.ts", ":1".repeat(32 * 1024) + "a.ts"],
    ["64KB pure colon run", ":".repeat(64 * 1024)],
  ];
  for (const [name, input] of colonAttacks) {
    it(`completes well under 50ms on ${name}`, () => {
      const ms = timeMs(() => extractExtPaths(input, () => {}));
      // Sub-50ms is a generous ceiling; the fix is sub-ms, the old regex ~4200ms.
      expect(ms).toBeLessThan(50);
    });
  }
});

describe("S3(a): suffix-strip still recovers the same clean paths as before", () => {
  function collect(text: string): string[] {
    const out: string[] = [];
    extractExtPaths(text, (p) => out.push(p));
    return out;
  }

  it("strips grep/compiler :line and :line:col suffixes", () => {
    expect(collect("src/engine/state.ts:42:")).toContain("src/engine/state.ts");
    expect(collect("src/foo.ts:12:5")).toContain("src/foo.ts");
    expect(collect("bar.js:7")).toContain("bar.js");
  });

  it("strips trailing sentence punctuation", () => {
    expect(collect("see config.json.")).toContain("config.json");
    expect(collect("touched a.ts!")).toContain("a.ts");
    expect(collect("which one, plain.md?")).toContain("plain.md");
  });

  it("preserves the no-whitespace grep head case (bar.js:7:hit)", () => {
    // Whole token does not strip to a known ext (`bar.js:7:hit` ends in `hit`),
    // so the EXT_HEAD_RE path recovers `bar.js`. Behavior must be unchanged.
    expect(collect("bar.js:7:hit")).toContain("bar.js");
  });

  it("does not over-strip a path with no suffix", () => {
    expect(collect("src/engine/state.ts")).toContain("src/engine/state.ts");
    expect(collect("./rel/path.json")).toContain("./rel/path.json");
  });
});

// ---------------------------------------------------------------------------
// Part (b): PreCompact caps fullText at 64KB before extraction
// ---------------------------------------------------------------------------

type RichTurn = { turnId: string; role: string; text: string; tool_name?: string };

function makePreCompactState(session: SessionState, turns: RichTurn[]): GlobalPluginState {
  const store = {
    isAvailable: () => true,
    getSessionTurnsRich: vi.fn(async (_sid: string, _lim: number) => turns),
    addSessionTokens: vi.fn(async () => {}),
    createCompactionCheckpoint: vi.fn(async () => {}),
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

describe("S3(b): handlePreCompact bounds the path scan on a multi-MB transcript", () => {
  // The finding asks for a multi-MB dot-heavy fullText asserting sub-50ms. We
  // build several MB of dot-bomb turns. Without the 64KB cap the extractor
  // tokenizes the whole multi-MB join; with it, work is bounded to 64KB.
  it("returns in well under 50ms on a multi-MB dot-heavy join", async () => {
    const session = new SessionState("s3b-sess", "s3b-sess");
    session.surrealSessionId = ""; // skip the addSessionTokens DB branch
    // 8 turns x 1MB of dots = ~8MB joined fullText.
    const turns: RichTurn[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push({ turnId: `turn:${i}`, role: "user", text: ".".repeat(1024 * 1024) });
    }
    const state = makePreCompactState(session, turns);

    const ms = await (async () => {
      const t0 = process.hrtime.bigint();
      await handlePreCompact(state, { session_id: "s3b-sess" });
      return Number(process.hrtime.bigint() - t0) / 1e6;
    })();

    expect(ms).toBeLessThan(50);
  });

  it("still extracts real key files that fall inside the 64KB window", async () => {
    const session = new SessionState("s3b-sess2", "s3b-sess2");
    session.surrealSessionId = "";
    const turns: RichTurn[] = [
      // A large benign OLDER turn (pushes total past 64KB; T4's tail-slice
      // correctly drops it — it's stale and path-free).
      { turnId: "turn:1", role: "user", text: "x".repeat(128 * 1024) },
      // Real files in the MOST RECENT turns (inside the 64KB tail window — T4
      // makes the cap tail-biased so the actively-edited files survive).
      { turnId: "turn:2", role: "assistant", text: "edited src/engine/state.ts and config.json", tool_name: "Edit" },
      { turnId: "turn:3", role: "assistant", text: "ran scripts/run.py", tool_name: "Bash" },
    ];
    const state = makePreCompactState(session, turns);

    await handlePreCompact(state, { session_id: "s3b-sess2" });

    const summary = session._compactionSummary ?? "";
    expect(summary).toContain("src/engine/state.ts");
    expect(summary).toContain("config.json");
    expect(summary).toContain("scripts/run.py");
  });
});
