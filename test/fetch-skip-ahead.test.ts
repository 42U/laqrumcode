/**
 * 0.7.119: handleFetchPendingWork skip-ahead loop (QA coverage flag).
 *
 * Self-completing payload builders (causal_graduate with nothing eligible,
 * blank-transcript extraction, …) return `{empty:true}` after marking their
 * item terminal. The fetch loop must consume those daemon-side and only hand
 * the drain agent REAL work — each empty formerly burned a full agent
 * round-trip narrating "the work was empty" (founder report 2026-06-11).
 */
import { describe, it, expect, vi } from "vitest";
import { handleFetchPendingWork } from "../src/tools/pending-work.js";
import type { GlobalPluginState } from "../src/engine/state.js";
import type { SessionState } from "../src/engine/state.js";

interface QueueItem {
  id: string;
  work_type: string;
  session_id: string;
  payload?: Record<string, unknown>;
}

/** Store mock driving the fetch loop by SQL shape. Items are claimed in
 *  order; causal_graduate items self-complete (no eligible chains);
 *  coalesced_extraction items get a transcript from `turnsBySession`. */
function makeState(queue: QueueItem[], turnsBySession: Record<string, Array<{ turnId: string; role: string; text: string }>>, opts: { failTerminal?: boolean } = {}) {
  const pending = [...queue];
  const terminalCalls: string[] = [];
  const store = {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql: string) => {
      // ORDER MATTERS: the claim UPDATE's SET clause contains
      // `status = "processing"`, so it must be matched BEFORE the
      // stale-recovery SELECT branch.
      if (sql.startsWith("UPDATE pending_work:")) {
        const id = sql.split(" ")[1];
        const idx = pending.findIndex((i) => i.id === id);
        if (idx === -1) return [];
        const [item] = pending.splice(idx, 1); // claim consumes the row
        return [item];
      }
      if (sql.includes('status = "processing"')) return []; // stale-recovery sweep
      if (sql.includes('status = "pending"') && sql.includes("ORDER BY priority")) {
        return pending.slice(0, 3).map((i) => ({ id: i.id })); // candidates
      }
      if (sql.includes("FROM causal_chain")) return []; // nothing eligible → self-complete
      return [];
    }),
    queryExec: vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE pending_work:")) {
        if (opts.failTerminal) throw new Error("markTerminal boom");
        terminalCalls.push(sql.split("UPDATE ")[1]?.split(" ")[0] ?? "?");
      }
    }),
    getSessionTurnsRich: vi.fn(async (sid: string) => turnsBySession[sid] ?? []),
    getAllCoreMemory: vi.fn(async () => []),
  };
  const state = { store, embeddings: { isAvailable: () => false } } as unknown as GlobalPluginState;
  return { state, store, terminalCalls };
}

const SESSION = {} as SessionState;

function parse(res: { content: Array<{ type: "text"; text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

describe("handleFetchPendingWork skip-ahead", () => {
  it("skips self-completed empties and returns the first REAL payload", async () => {
    const { state, terminalCalls } = makeState(
      [
        { id: "pending_work:e1", work_type: "causal_graduate", session_id: "s1" },
        { id: "pending_work:e2", work_type: "causal_graduate", session_id: "s2" },
        { id: "pending_work:real1", work_type: "coalesced_extraction", session_id: "s3", payload: { turn_count: 2 } },
      ],
      { s3: [
        { turnId: "t1", role: "user", text: "please fix the flaky daemon spawn race we hit yesterday" },
        { turnId: "t2", role: "assistant", text: "done — the lock steal now verifies holder liveness first" },
      ] },
    );
    const out = parse(await handleFetchPendingWork(state, SESSION, {}));
    expect(out.empty).toBeUndefined();
    expect(out.work_type).toBe("coalesced_extraction");
    expect(out.work_id).toBe("pending_work:real1");
    expect(terminalCalls).toHaveLength(2); // both empties marked terminal daemon-side
  });

  it("returns the done-message when the queue is only empties (all self-completed)", async () => {
    const { state, terminalCalls } = makeState(
      [
        { id: "pending_work:e1", work_type: "causal_graduate", session_id: "s1" },
        { id: "pending_work:e2", work_type: "causal_graduate", session_id: "s2" },
      ],
      {},
    );
    const out = parse(await handleFetchPendingWork(state, SESSION, {}));
    expect(out.empty).toBe(true);
    expect(out.message).toContain("No pending work");
    expect(terminalCalls).toHaveLength(2);
  });

  it("the 11th consecutive empty is returned to the caller (pass budget)", async () => {
    const items: QueueItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `pending_work:e${i}`,
      work_type: "causal_graduate",
      session_id: `s${i}`,
    }));
    const { state, terminalCalls } = makeState(items, {});
    const out = parse(await handleFetchPendingWork(state, SESSION, {}));
    // 10 skips consumed e0..e9; e10 (the 11th) is returned as empty:true.
    expect(out.empty).toBe(true);
    expect(out.work_id).toBe("pending_work:e10");
    expect(terminalCalls).toHaveLength(11);
  });

  it("blank-transcript extraction self-completes and is skipped past", async () => {
    const { state, terminalCalls } = makeState(
      [
        { id: "pending_work:blank", work_type: "coalesced_extraction", session_id: "empty-session", payload: { turn_count: 2 } },
      ],
      { "empty-session": [] }, // archival race: turns gone by fetch time
    );
    const out = parse(await handleFetchPendingWork(state, SESSION, {}));
    expect(out.empty).toBe(true);
    expect(out.message).toContain("No pending work"); // skipped past to done
    expect(terminalCalls).toContain("pending_work:blank");
  });

  it("a thrown markTerminal surfaces as {error} without looping", async () => {
    const { state } = makeState(
      [{ id: "pending_work:e1", work_type: "causal_graduate", session_id: "s1" }],
      {},
      { failTerminal: true },
    );
    const out = parse(await handleFetchPendingWork(state, SESSION, {}));
    expect(out.error).toBeDefined();
  });
});
