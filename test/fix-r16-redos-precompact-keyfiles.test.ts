/**
 * R16 regression — same ReDoS as R4, in PreCompact key-file extraction.
 *
 * handlePreCompact joins the last 30 transcript turns into one string and ran
 * `fullText.match(/[\w\-/.]+\.\w{1,5}/g)` over it to pull "key files". That
 * regex has the identical stem/literal-dot overlap as R4's EXT_PATH_RE: `.` is
 * inside the `+` class and a literal `\.` follows. A dot-heavy turn (e.g. a
 * pasted stack trace, a base64 blob, an ASCII-art table) makes the join a
 * worst-case input and stalls the shared daemon event loop for seconds during
 * compaction — right when the user is waiting.
 *
 * Fix: route extraction through the shared, hardened `extractExtPaths`
 * (tokenized + length-capped + anchored => linear), then apply PreCompact's
 * existing narrower extension filter + dedup + cap so the FILES: output is
 * unchanged for legitimate transcripts.
 *
 * This test drives the REAL handler with a store whose getSessionTurnsRich
 * returns a dot-bomb turn alongside turns that mention real files; it asserts
 * the handler returns promptly AND that real files still surface in the
 * compaction summary. It would time out against the pre-fix inline regex.
 */
import { describe, it, expect, vi } from "vitest";
import { handlePreCompact } from "../src/hook-handlers/pre-compact.js";
import { SessionState } from "../src/engine/state.js";
import type { GlobalPluginState } from "../src/engine/state.js";

type RichTurn = { turnId: string; role: string; text: string; tool_name?: string };

function makeState(session: SessionState, turns: RichTurn[]): GlobalPluginState {
  const store = {
    isAvailable: () => true,
    getSessionTurnsRich: vi.fn(async (_sid: string, _lim: number) => turns),
    addSessionTokens: vi.fn(async () => {}),
    // createCompactionCheckpoint is fire-and-forget (.catch) in the handler.
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

// The vulnerable inline regex took ~4s on a 64KB dot-run turn. 300ms cleanly
// separates fixed (sub-ms) from broken even on a loaded CI box.
const REDOS_BUDGET_MS = 300;

describe("R16: handlePreCompact survives a dot-bomb transcript turn", () => {
  it("returns promptly and still extracts real key files", async () => {
    const session = new SessionState("r16-sess", "r16-sess");
    session.surrealSessionId = ""; // skip the addSessionTokens DB branch
    const turns: RichTurn[] = [
      // Legit work turns — these files MUST survive into the FILES: summary.
      { turnId: "turn:1", role: "assistant", text: "edited src/engine/state.ts and config.json", tool_name: "Edit" },
      { turnId: "turn:2", role: "assistant", text: "ran tests in scripts/run.py", tool_name: "Bash" },
      // Adversarial dot-bomb turn (e.g. a pasted blob) — the ReDoS trigger.
      { turnId: "turn:3", role: "user", text: ".".repeat(64 * 1024) },
    ];
    const state = makeState(session, turns);

    const t0 = process.hrtime.bigint();
    await handlePreCompact(state, { session_id: "r16-sess" });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(ms).toBeLessThan(REDOS_BUDGET_MS);

    // The compaction summary's FILES: line must still contain the real paths.
    const summary = session._compactionSummary ?? "";
    expect(summary).toContain("src/engine/state.ts");
    expect(summary).toContain("config.json");
    expect(summary).toContain("scripts/run.py");
  });

  it("is fast even when the dot-run is one un-split mega-token", async () => {
    // No whitespace in the bomb: it stays a single token, so the length cap
    // (not the splitter) is what protects us. Still must be sub-budget.
    const session = new SessionState("r16-sess2", "r16-sess2");
    session.surrealSessionId = "";
    const turns: RichTurn[] = [
      { turnId: "turn:1", role: "user", text: "x.".repeat(40000) },
    ];
    const state = makeState(session, turns);

    const t0 = process.hrtime.bigint();
    await handlePreCompact(state, { session_id: "r16-sess2" });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(ms).toBeLessThan(REDOS_BUDGET_MS);
  });
});
