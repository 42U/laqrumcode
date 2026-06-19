/**
 * C1 — commit-claim ownership guard.
 *
 * handleCommitWorkResults must atomically flip the row processing→committing
 * (CAS) and DISCARD the extraction when that CAS matches no row — i.e. when
 * stale-recovery already reverted/reclaimed the row or it was already
 * committed. Without this, two drainers (the original + a post-stale-recovery
 * re-claimer) both write the extraction → duplicate knowledge / double soul
 * revision.
 */

import { describe, it, expect, vi } from "vitest";
import { handleCommitWorkResults } from "../src/tools/pending-work.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const sess = {} as unknown as SessionState;

describe("commit-claim ownership guard (C1)", () => {
  it("discards the extraction when the row is no longer in 'processing' (CAS misses)", async () => {
    const queryExec = vi.fn(async () => undefined);
    // CAS `UPDATE ... WHERE status="processing" RETURN BEFORE` matches no row.
    const queryFirst = vi.fn(async () => [] as unknown[]);
    const state = {
      store: { isAvailable: () => true, queryFirst, queryExec },
      embeddings: { isAvailable: () => false },
    } as unknown as GlobalPluginState;

    const res = await handleCommitWorkResults(state, sess, {
      work_id: "pending_work:abc",
      results: { concepts: [{ name: "x", content: "should not be written" }] },
    });
    const out = JSON.parse(res.content[0].text);

    expect(out.success).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.message).toMatch(/no longer in 'processing'|double-write/i);
    // The CAS ran exactly once; no write/markTerminal transaction followed.
    expect(queryFirst).toHaveBeenCalledTimes(1);
    expect(queryExec).not.toHaveBeenCalled();
  });

  it("the CAS targets status='processing' with RETURN BEFORE", async () => {
    let casSql = "";
    const queryFirst = vi.fn(async (sql: string) => { casSql = sql; return []; });
    const state = {
      store: { isAvailable: () => true, queryFirst, queryExec: vi.fn() },
      embeddings: { isAvailable: () => false },
    } as unknown as GlobalPluginState;

    await handleCommitWorkResults(state, sess, { work_id: "pending_work:abc", results: {} });
    expect(casSql).toContain('status = "committing"');
    expect(casSql).toContain('WHERE status = "processing"');
    expect(casSql).toContain("RETURN BEFORE");
  });

  it("rejects a missing work_id before touching the store", async () => {
    const queryFirst = vi.fn(async () => []);
    const state = {
      store: { isAvailable: () => true, queryFirst, queryExec: vi.fn() },
      embeddings: { isAvailable: () => false },
    } as unknown as GlobalPluginState;
    const res = await handleCommitWorkResults(state, sess, { results: {} });
    expect(res.content[0].text).toMatch(/work_id is required/i);
    expect(queryFirst).not.toHaveBeenCalled();
  });
});
