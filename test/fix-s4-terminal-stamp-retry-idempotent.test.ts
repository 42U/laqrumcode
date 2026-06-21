/**
 * S4 — the R9 guarded terminal stamp is idempotent to its OWN withRetry re-fire.
 *
 * markTerminal's guarded UPDATE carries
 * `WHERE status="committing" AND committing_token=$guard`. queryMulti wraps that
 * statement in withRetry (src/engine/surreal.ts): a deadline'd write MAY have
 * executed server-side — flipping status "committing" → the terminal status with
 * OUR committing_token still attached — before the SDK response was lost. The
 * re-fire then sees status already terminal, so the `status="committing"` gate
 * matches nothing and queryMulti returns {changed:0, archived:0}.
 *
 * Pre-fix, that zero-match was treated identically to a genuine mid-write reclaim
 * → markTerminal returned false and handleCommitWorkResults reported
 * success:false / skipped:true for a commit that DID complete (its knowledge was
 * already written by commitResults, and the row WAS terminalized by our own
 * retried write). That is a spurious skip of genuine work.
 *
 * Fix (mirrors the K41 committing_token self-recognition): on a zero-match the
 * guarded markTerminal does a confirmation SELECT for OUR OWN terminal state +
 * token. If the row is already in our terminal status carrying our token, our
 * earlier retried write stamped it → return true (genuine success). Only when
 * the row is NOT ours in a terminal state is it a real reclaim → false.
 *
 * These drive the public handler with a mock store. The discriminating case
 * (queryMulti → {changed:0, archived:0} BUT the confirmation SELECT matches our
 * own row) FAILS against the pre-fix code, which skipped unconditionally on a
 * zero-match.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleCommitWorkResults } from "../src/tools/pending-work.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const sess = {} as unknown as SessionState;
const WORK_ID = "pending_work:s4abc";

/**
 * Build a mock store that walks handleCommitWorkResults' call sequence for a
 * work_type whose commitResults hits the no-op `default` branch (no store writes
 * inside commitResults).
 *
 * The guarded markTerminal's queryMulti returns {changed:0, archived:0} to
 * simulate the gate matching nothing. `confirmMatchesSelf` controls what the
 * NEW confirmation SELECT (status=$st AND committing_token=$guard) returns:
 *   true  → our own retried write already stamped the row (genuine success)
 *   false → the row is NOT in our terminal state with our token (real reclaim)
 */
function makeState(opts: { confirmMatchesSelf: boolean }) {
  const { confirmMatchesSelf } = opts;
  let call = 0;
  let confirmSelectSeen = false;
  let seenConfirmBindings: Record<string, unknown> | undefined;

  const queryFirst = vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
    call++;
    if (call === 1) {
      // CAS processing→committing, RETURN BEFORE → we win the claim.
      expect(sql).toContain('status = "committing"');
      return [{ id: WORK_ID, work_type: "noop_s4", session_id: "sess-s4" }];
    }
    // The stillOwned pre-check gates on status="committing" AND committing_token.
    if (sql.includes('status = "committing" AND committing_token')) {
      return [{ id: WORK_ID }];
    }
    // S4 confirmation SELECT: status = $st (=completed) AND committing_token = $guard.
    // Disambiguated from the stillOwned pre-check by $st being "completed",
    // not the literal "committing".
    if (sql.includes("status = $st AND committing_token = $guard")) {
      confirmSelectSeen = true;
      seenConfirmBindings = bindings;
      return confirmMatchesSelf ? [{ id: WORK_ID }] : [];
    }
    return [];
  });
  // The guarded markTerminal is the only queryMulti caller in this path — return
  // the gate-missed shape so the confirmation SELECT branch is exercised.
  const queryMulti = vi.fn(async () => ({ changed: 0, archived: 0 }));
  const queryExec = vi.fn(async () => undefined);
  const state = {
    store: { isAvailable: () => true, queryFirst, queryMulti, queryExec },
    embeddings: { isAvailable: () => false },
  } as unknown as GlobalPluginState;
  return {
    state, queryFirst, queryMulti, queryExec,
    confirmSelectSeen: () => confirmSelectSeen,
    confirmBindings: () => seenConfirmBindings,
  };
}

describe("S4 — guarded markTerminal is idempotent to its own withRetry re-fire", () => {
  it("reports SUCCESS (not skipped) when the gate missed but our own token already stamped the row terminal", async () => {
    // queryMulti → {changed:0, archived:0}: the guarded UPDATE matched nothing
    // because our PRIOR retried write already flipped status committing→completed.
    // The confirmation SELECT matches our own row → genuine success.
    const h = makeState({ confirmMatchesSelf: true });
    const res = await handleCommitWorkResults(h.state, sess, { work_id: WORK_ID, results: {} });
    const out = JSON.parse(res.content[0].text);

    expect(out.success).toBe(true);
    expect(out.skipped).not.toBe(true);
    // The confirmation SELECT was actually consulted (the gate, not a guess, decided).
    expect(h.confirmSelectSeen()).toBe(true);
    // And it was scoped to the terminal status + our own guard token.
    const b = h.confirmBindings();
    expect(b?.st).toBe("completed");
    expect(typeof b?.guard).toBe("string");
    expect((b?.guard as string).length).toBeGreaterThan(0);
  });

  it("still reports skipped when the gate missed AND the row is NOT ours in a terminal state (genuine reclaim)", async () => {
    // Same zero-match, but the confirmation SELECT finds no row carrying our
    // token in the terminal state → genuinely reclaimed by a different token.
    const h = makeState({ confirmMatchesSelf: false });
    const res = await handleCommitWorkResults(h.state, sess, { work_id: WORK_ID, results: {} });
    const out = JSON.parse(res.content[0].text);

    expect(out.success).not.toBe(true);
    expect(out.skipped).toBe(true);
    expect(out.message).toMatch(/reclaimed during commitResults|double-complete/i);
    // The confirmation SELECT WAS attempted before deciding to skip.
    expect(h.confirmSelectSeen()).toBe(true);
  });
});

describe("S4 — source wiring (the self-recognition survives a refactor)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "tools", "pending-work.ts"), "utf-8");

  it("the guarded zero-match path does a confirmation SELECT on our own terminal status + token", () => {
    expect(src).toMatch(/SELECT id FROM \$\{workId\} WHERE status = \$st AND committing_token = \$guard/);
  });

  it("a confirmed self-match returns true (genuine success), not a spurious false", () => {
    // The branch must return true when the confirmation SELECT matched our row.
    expect(src).toMatch(/if \(mine\.length > 0\) return true;/);
  });
});
