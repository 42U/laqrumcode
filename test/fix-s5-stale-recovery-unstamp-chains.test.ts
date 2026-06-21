/**
 * S5 — stale-recovery un-stamps a stuck causal_graduate item's won chains.
 *
 * R8 added failure-recovery on the COMMIT path: a causal_graduate synthesis that
 * threw or produced zero skills un-stamps (graduated_at = NONE) the chains it
 * claimed at fetch time, so a later graduation retries them. But that recovery
 * only fires when a commit actually arrives. The lost-RPC / crash path —
 * fetch-claim stamps the chains, then the process dies (or the commit RPC is
 * lost) BEFORE commit_work_results runs — leaves the work item stuck in
 * processing/committing AND its won chains graduated_at-stamped permanently. The
 * stale-recovery loop in handleFetchPendingWork reverts/archives the stuck work
 * row but, pre-fix, did NOT un-stamp won_chain_ids → those chains were stranded:
 * graduated_at set, never synthesized into a skill, never re-opened.
 *
 * Fix: in the stale-recovery loop, for a stuck row whose work_type is
 * causal_graduate, read its persisted won_chain_ids and reset those causal_chain
 * rows back to graduated_at = NONE (only the still-stamped ones — idempotent)
 * BEFORE reverting/archiving the work item. Mirrors the commit-path
 * unstampGraduatedChains helper.
 *
 * This drives the real handleFetchPendingWork with a mock store and asserts the
 * un-stamp UPDATE fires, targets the won chain ids, and happens BEFORE the
 * revert/archive transaction. It FAILS against the pre-fix code, which never
 * touched causal_chain during stale-recovery.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleFetchPendingWork } from "../src/tools/pending-work.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const sess = {} as unknown as SessionState;
const STUCK_ID = "pending_work:s5stuck";
const CHAIN_A = "causal_chain:s5a";
const CHAIN_B = "causal_chain:s5b";

/**
 * Mock store that walks handleFetchPendingWork's stale-recovery path for a
 * single stuck causal_graduate row carrying won_chain_ids, then drains to empty.
 *
 * Records the ordered SQL trace so the test can assert the un-stamp (queryMulti
 * against causal_chain) fired BEFORE the revert/archive (queryExec BEGIN block).
 */
function makeState(opts: { wonChainIds?: string[]; workType?: string }) {
  const { wonChainIds = [CHAIN_A, CHAIN_B], workType = "causal_graduate" } = opts;
  const trace: string[] = [];

  const queryFirst = vi.fn(async (sql: string) => {
    // 1. Stuck-row SELECT (processing/committing past the stale window).
    if (sql.includes('status = "processing" OR status = "committing"') && sql.includes("won_chain_ids")) {
      trace.push("stuck-select");
      return [{ id: STUCK_ID, session_id: "sess-s5", work_type: workType, won_chain_ids: wonChainIds }];
    }
    // 2. Claim-loop candidates SELECT — return none so the handler exits with
    //    {empty:true} right after stale-recovery (keeps the test focused).
    if (sql.includes('WHERE status = "pending"')) {
      trace.push("candidates-select");
      return [];
    }
    return [];
  });

  // unstampGraduatedChains is the only queryMulti caller reachable here.
  const queryMulti = vi.fn(async (sql: string) => {
    if (sql.includes("UPDATE causal_chain SET graduated_at = NONE")) {
      trace.push(`unstamp:${sql.replace(/\s+/g, " ").trim()}`);
      return { n: wonChainIds.length };
    }
    trace.push("queryMulti:other");
    return { n: 0 };
  });

  // The stale-recovery revert/archive transaction goes through queryExec.
  const queryExec = vi.fn(async (sql: string) => {
    if (sql.includes("BEGIN TRANSACTION")) trace.push("revert-archive-tx");
    else trace.push("queryExec:other");
    return undefined;
  });

  const state = {
    store: { isAvailable: () => true, queryFirst, queryMulti, queryExec },
    embeddings: { isAvailable: () => false },
  } as unknown as GlobalPluginState;
  return { state, queryFirst, queryMulti, queryExec, trace };
}

describe("S5 — stale-recovery un-stamps a stuck causal_graduate item's won chains", () => {
  it("resets the won chains to graduated_at = NONE before reverting/archiving the work item", async () => {
    const h = makeState({ wonChainIds: [CHAIN_A, CHAIN_B] });
    const res = await handleFetchPendingWork(h.state, sess, {});
    const out = JSON.parse(res.content[0].text);

    // Handler drained to empty after recovery.
    expect(out.empty).toBe(true);

    // The un-stamp UPDATE fired and targeted exactly the won chain ids.
    const unstampCall = h.queryMulti.mock.calls.find(c => String(c[0]).includes("UPDATE causal_chain SET graduated_at = NONE"));
    expect(unstampCall).toBeDefined();
    const unstampSql = String(unstampCall![0]);
    expect(unstampSql).toContain(CHAIN_A);
    expect(unstampSql).toContain(CHAIN_B);
    // Idempotent: only resets rows still stamped.
    expect(unstampSql).toContain("graduated_at IS NOT NONE");

    // Ordering: un-stamp BEFORE the revert/archive transaction for that row.
    const unstampIdx = h.trace.findIndex(t => t.startsWith("unstamp:"));
    const revertIdx = h.trace.indexOf("revert-archive-tx");
    expect(unstampIdx).toBeGreaterThanOrEqual(0);
    expect(revertIdx).toBeGreaterThanOrEqual(0);
    expect(unstampIdx).toBeLessThan(revertIdx);
  });

  it("does NOT attempt an un-stamp for a non-causal_graduate stuck row", async () => {
    // A stuck coalesced_extraction row never claimed chains — recovery must not
    // touch causal_chain.
    const h = makeState({ workType: "coalesced_extraction", wonChainIds: [] });
    await handleFetchPendingWork(h.state, sess, {});
    const unstampCall = h.queryMulti.mock.calls.find(c => String(c[0]).includes("UPDATE causal_chain SET graduated_at = NONE"));
    expect(unstampCall).toBeUndefined();
    // The revert/archive still happened.
    expect(h.trace).toContain("revert-archive-tx");
  });

  it("skips the un-stamp (no-op) when a causal_graduate stuck row has no won_chain_ids (legacy row)", async () => {
    // unstampGraduatedChains returns 0 early on an empty id list — no UPDATE
    // against causal_chain is issued.
    const h = makeState({ workType: "causal_graduate", wonChainIds: [] });
    await handleFetchPendingWork(h.state, sess, {});
    const unstampCall = h.queryMulti.mock.calls.find(c => String(c[0]).includes("UPDATE causal_chain SET graduated_at = NONE"));
    expect(unstampCall).toBeUndefined();
    expect(h.trace).toContain("revert-archive-tx");
  });
});

describe("S5 — source wiring (the un-stamp survives a refactor)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "tools", "pending-work.ts"), "utf-8");

  it("the stuck-row SELECT also fetches won_chain_ids", () => {
    expect(src).toMatch(/SELECT id, session_id, work_type, won_chain_ids FROM pending_work/);
  });

  it("the stale-recovery loop calls unstampGraduatedChains for causal_graduate rows", () => {
    expect(src).toMatch(/row\.work_type === "causal_graduate"/);
    expect(src).toMatch(/unstampGraduatedChains\(\s*\{ id: String\(row\.id\), won_chain_ids: row\.won_chain_ids \}/);
  });
});
