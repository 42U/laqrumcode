/**
 * R9 — commit terminal-stamp is ownership-gated AT WRITE TIME.
 *
 * The K15 fix added a pre-write `stillOwned` re-assert in
 * handleCommitWorkResults, but that check is snapshotted BEFORE a multi-minute
 * commitResults. If stale-recovery reverts the row mid-write and another
 * drainer re-claims it (its committing_token changes), the ORIGINAL
 * markTerminal(completed) ran unconditionally — re-stamping a row it no longer
 * owned (residual C1 double-complete).
 *
 * Fix: markTerminal accepts a guardToken. The success path passes the commit's
 * own token, so the terminal UPDATE carries
 * `WHERE status="committing" AND committing_token=$guard`. If the row was
 * reclaimed mid-write the UPDATE matches nothing, markTerminal returns false,
 * and the handler reports `skipped` instead of `success`.
 *
 * These drive the public handler with a mock store. The reclaim case
 * (queryMulti → {changed:0, archived:0}) FAILS against the pre-fix code, which
 * stamped completed and returned success regardless of ownership.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleCommitWorkResults } from "../src/tools/pending-work.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const sess = {} as unknown as SessionState;
const WORK_ID = "pending_work:r9abc";

/**
 * Build a mock store that walks handleCommitWorkResults' call sequence for a
 * work_type whose commitResults hits the no-op `default` branch (no store
 * writes inside commitResults). markTerminalResult controls the value the
 * guarded markTerminal's queryMulti returns.
 */
function makeState(opts: {
  markTerminalResult: { changed: number; archived: number };
  onMarkTerminalSql?: (sql: string, bindings: Record<string, unknown> | undefined) => void;
  stillOwned?: boolean;
}) {
  const { markTerminalResult, onMarkTerminalSql, stillOwned = true } = opts;
  let call = 0;
  const queryFirst = vi.fn(async (sql: string) => {
    call++;
    if (call === 1) {
      // CAS processing→committing, RETURN BEFORE → we win the claim.
      expect(sql).toContain('status = "committing"');
      return [{ id: WORK_ID, work_type: "noop_r9", session_id: "sess-r9" }];
    }
    if (sql.includes("status = \"committing\" AND committing_token")) {
      // stillOwned pre-check.
      return stillOwned ? [{ id: WORK_ID }] : [];
    }
    return [];
  });
  const queryMulti = vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
    // The guarded markTerminal is the only queryMulti caller in this path.
    onMarkTerminalSql?.(sql, bindings);
    return markTerminalResult;
  });
  const queryExec = vi.fn(async () => undefined);
  const state = {
    store: { isAvailable: () => true, queryFirst, queryMulti, queryExec },
    embeddings: { isAvailable: () => false },
  } as unknown as GlobalPluginState;
  return { state, queryFirst, queryMulti, queryExec };
}

describe("R9 — markTerminal ownership gate on commit success", () => {
  it("does NOT report success when the row is reclaimed DURING commitResults (token no longer matches)", async () => {
    // markTerminal's guarded UPDATE matches nothing → {changed:0, archived:0}.
    const { state, queryMulti } = makeState({ markTerminalResult: { changed: 0, archived: 0 } });
    const res = await handleCommitWorkResults(state, sess, { work_id: WORK_ID, results: {} });
    const out = JSON.parse(res.content[0].text);

    expect(out.success).not.toBe(true);
    expect(out.skipped).toBe(true);
    expect(out.message).toMatch(/reclaimed during commitResults|double-complete/i);
    // markTerminal was actually attempted (the gate, not the pre-check, decided).
    expect(queryMulti).toHaveBeenCalledTimes(1);
  });

  it("the success-path terminal UPDATE carries the committing_token guard", async () => {
    let seenSql = "";
    let seenGuard: unknown;
    const { state } = makeState({
      markTerminalResult: { changed: 1, archived: 0 },
      onMarkTerminalSql: (sql, b) => { seenSql = sql; seenGuard = b?.guard; },
    });
    await handleCommitWorkResults(state, sess, { work_id: WORK_ID, results: {} });
    // The terminal UPDATE must be ownership-gated.
    expect(seenSql).toContain('committing_token = $guard');
    expect(seenSql).toContain('status = "committing"');
    // And the guard token must be a real value (the commit's own token), not undefined.
    expect(typeof seenGuard).toBe("string");
    expect((seenGuard as string).length).toBeGreaterThan(0);
  });

  it("reports success when the gate still matches the row (changed=1)", async () => {
    const { state } = makeState({ markTerminalResult: { changed: 1, archived: 0 } });
    const res = await handleCommitWorkResults(state, sess, { work_id: WORK_ID, results: {} });
    const out = JSON.parse(res.content[0].text);
    expect(out.success).toBe(true);
  });

  it("treats a sibling-archive (archived=1) as a successful terminalization", async () => {
    // A canonical completed sibling already holds the triple → row archived, not
    // reclaimed. That is still a clean terminalization, so success stands.
    const { state } = makeState({ markTerminalResult: { changed: 0, archived: 1 } });
    const res = await handleCommitWorkResults(state, sess, { work_id: WORK_ID, results: {} });
    const out = JSON.parse(res.content[0].text);
    expect(out.success).toBe(true);
  });
});

describe("R9 — source wiring (guards survive a refactor)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "tools", "pending-work.ts"), "utf-8");

  it("markTerminal accepts a guardToken and gates the ELSE-branch UPDATE on it", () => {
    expect(src).toMatch(/guardToken\?: string/);
    expect(src).toMatch(/committing_token = \$guard/);
  });

  it("the commit success path passes the commit token to markTerminal", () => {
    // markTerminal(..., "completed", myToken) — the 6th arg is the token.
    expect(src).toMatch(/markTerminal\(state, workId, item\.session_id, item\.work_type, "completed", myToken\)/);
  });

  it("a false return from the guarded markTerminal yields a skipped (not success) response", () => {
    expect(src).toMatch(/if \(!stamped\)/);
    expect(src).toMatch(/completion not stamped/i);
  });
});
