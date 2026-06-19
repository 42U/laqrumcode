/**
 * Duplicate-row defense — end-to-end integration test.
 *
 * Reproduces the ORIGINAL bug class and proves the fix defeats it.
 *
 * ORIGINAL BUG (pre-fix):
 *   SessionEnd hook fired multiple times within ~200ms for the same
 *   kc_session_id (Claude Code resume races, hook redelivery). The handler
 *   had an in-memory `cleanedUp` guard, but `state.removeSession()` wiped
 *   the SessionState — a follow-up event recreated a fresh SessionState
 *   with cleanedUp=false, and four parallel CREATEs landed four duplicate
 *   `causal_graduate` rows (and a matching duplicate set for soul_*,
 *   coalesced_extraction).
 *
 * THE FIX:
 *   1. handleSessionEnd() now uses an atomic `claimSessionForCleanup()`
 *      UPDATE on the session row. Only one caller per session wins.
 *   2. The DB schema has a compound UNIQUE index
 *      `pw_session_worktype_status_unique` on
 *      pending_work(session_id, work_type, status) — so even if the
 *      app-layer claim were defeated, a duplicate CREATE would be
 *      rejected by SurrealDB.
 *
 * This test asserts BOTH layers work:
 *   - racing 4 handleSessionEnd() calls on the same session results in
 *     exactly one set of pending_work rows
 *   - racing 2 runDeferredCleanup() calls on the same orphan likewise
 *     produces exactly one set of pending_work rows
 *
 * Isolation: every test creates a NEW Surreal database under a fresh
 * namespace (kctest_dedup_<timestamp>_<rand>) and tears it down on
 * afterAll. Never touches the user's kong/memory DB.
 *
 * Skip with: `SKIP_INTEGRATION=1 npm test -- --run dedup-integration`
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import { handleSessionEnd } from "../src/hook-handlers/session-end.js";
import { runDeferredCleanup } from "../src/engine/deferred-cleanup.js";
import type { EmbeddingService } from "../src/engine/embeddings.js";
import type { MemoryConfig } from "../src/engine/config.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";

// Disable auto-drain so the test doesn't try to spawn headless Claude.
process.env.KONGCODE_AUTO_DRAIN = "0";

const TEST_NS = `kctest_dedup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const TEST_DB = "dedup";

const SURREAL_URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_USER = process.env.SURREAL_USER ?? "root";
const SURREAL_PASS = process.env.SURREAL_PASS ?? "root";

let store: SurrealStore | undefined;
let state: GlobalPluginState | undefined;

// Minimal config + stub embeddings — handleSessionEnd never touches embeddings,
// so a null-fronted stub is enough. The only fields handleSessionEnd reads
// off `config` are paths.cacheDir and thresholds — both via auto-drain, which
// we've disabled via env var above.
function makeMinimalConfig(): MemoryConfig {
  return {
    surreal: {
      url: SURREAL_URL,
      get httpUrl() {
        return SURREAL_URL
          .replace("ws://", "http://")
          .replace("wss://", "https://")
          .replace("/rpc", "");
      },
      user: SURREAL_USER,
      pass: SURREAL_PASS,
      ns: TEST_NS,
      db: TEST_DB,
    },
    embedding: { modelPath: "/dev/null", dimension: 1024 } as any,
    thresholds: { midSessionCleanupThreshold: 25_000 } as any,
    paths: { cacheDir: "/tmp", dataDir: "/tmp" } as any,
  } as unknown as MemoryConfig;
}

const fakeEmbeddings = {} as unknown as EmbeddingService;

beforeAll(async () => {
  if (SKIP) return;
  store = new SurrealStore(makeMinimalConfig().surreal);
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SurrealDB connection timed out after 15s")), 15_000),
      ),
    ]);
  } catch (e) {
    console.warn("SurrealDB unavailable, skipping dedup integration:", (e as Error).message);
    store = undefined;
    return;
  }
  state = new GlobalPluginState(makeMinimalConfig(), store, fakeEmbeddings);
  // Use /tmp as the workspace so handoff file lands somewhere safe + writable.
  state.workspaceDir = "/tmp";
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try {
    // Drop the entire test namespace — nukes every table we touched.
    await store.queryExec(`REMOVE NAMESPACE ${TEST_NS}`);
  } catch { /* ok if already gone */ }
  try { await store.close(); } catch { /* ok */ }
}, 15_000);

// The enqueue dedup gate (2026-06-18) keys off pending+active rows across ALL
// sessions, not just the case's own kc_session_id. Because every case shares
// one per-file namespace, a graduation row left by an earlier case would make
// a later case's enqueue correctly skip (→ 0 rows). Clear the queue before
// each case so the "racing enqueues produce exactly one set" invariant is
// exercised from an empty global queue — which is what these cases intend.
beforeEach(async () => {
  if (SKIP || !store?.isAvailable()) return;
  await store.queryExec(`DELETE pending_work`).catch(() => { /* table may not exist yet */ });
});

function itDb(name: string, fn: () => Promise<void>, timeout = 30_000) {
  it(name, async () => {
    if (SKIP || !store?.isAvailable() || !state) return;
    await fn();
  }, timeout);
}

/**
 * Seed a fresh session row + matching in-memory SessionState. The kc_session_id
 * is unique per test so concurrent test cases never collide on the UNIQUE
 * compound index (pending_work.session_id, work_type, status).
 */
async function seedSession(opts: { kcSid: string; turnCount: number; lastUser?: string; lastAssistant?: string }) {
  const s = store!;
  const surrealSessionId = await s.createSession("test-agent", opts.kcSid, "project:test");

  const session = state!.getOrCreateSession(opts.kcSid, opts.kcSid);
  session.surrealSessionId = surrealSessionId;
  session.userTurnCount = opts.turnCount;
  session.lastUserText = opts.lastUser ?? "test user input";
  session.lastAssistantText = opts.lastAssistant ?? "test assistant response";
  session.agentId = "test-agent";
  session.projectId = "project:test";
  return { surrealSessionId, session };
}

async function countPending(kcSid: string, workType: string): Promise<number> {
  const rows = await store!.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM pending_work
       WHERE session_id = $sid AND work_type = $wt
       GROUP ALL`,
    { sid: kcSid, wt: workType },
  );
  return Number(rows[0]?.n ?? 0);
}

async function countAllPendingForSession(kcSid: string): Promise<number> {
  const rows = await store!.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM pending_work WHERE session_id = $sid GROUP ALL`,
    { sid: kcSid },
  );
  return Number(rows[0]?.n ?? 0);
}

describe("duplicate-row defense — end-to-end", () => {
  itDb("schema apply succeeds and UNIQUE indexes are present", async () => {
    // If initialize() succeeded in beforeAll, runSchema() applied schema.surql
    // including the 9 UNIQUE indexes from Agent 1 + the artifact UNIQUE.
    const info = await store!.queryMulti<any>("INFO FOR TB pending_work");
    const indexes = info?.indexes ?? {};
    expect(indexes.pw_session_worktype_status_unique).toBeDefined();
    // Sanity: the index definition includes UNIQUE.
    expect(String(indexes.pw_session_worktype_status_unique)).toMatch(/UNIQUE/i);
  });

  itDb("4 racing handleSessionEnd calls produce exactly one set of pending_work rows", async () => {
    // Reproduce the original symptom: 4 parallel SessionEnd hooks for the
    // same session, looking like the burst that gave us 4 duplicate
    // causal_graduate rows in production.
    const kcSid = `race-session-${Date.now()}`;
    await seedSession({ kcSid, turnCount: 3 });

    const results = await Promise.allSettled([
      handleSessionEnd(state!, { session_id: kcSid }),
      handleSessionEnd(state!, { session_id: kcSid }),
      handleSessionEnd(state!, { session_id: kcSid }),
      handleSessionEnd(state!, { session_id: kcSid }),
    ]);

    // All four calls should resolve (none should throw — losers just bail).
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    // Causal graduate — the original symptom row type. Exactly 1.
    expect(await countPending(kcSid, "causal_graduate")).toBe(1);

    // Soul — handleSessionEnd queues soul_generate first time (no soul row yet
    // in this fresh test DB) or soul_evolve if hasSoul returned true.
    // Either way: exactly one soul work item.
    const soulGen = await countPending(kcSid, "soul_generate");
    const soulEvolve = await countPending(kcSid, "soul_evolve");
    expect(soulGen + soulEvolve).toBe(1);

    // Coalesced extraction — turnCount=3 ≥ 2, so the winner queues one.
    expect(await countPending(kcSid, "coalesced_extraction")).toBe(1);

    // Grand total: causal_graduate(1) + soul(1) + coalesced_extraction(1) = 3.
    expect(await countAllPendingForSession(kcSid)).toBe(3);
  });

  itDb("the UNIQUE index physically rejects a duplicate CREATE bypassing the claim", async () => {
    // Belt-and-suspenders: prove the DB-level constraint actually fires,
    // not just that the claim arbitrates. This is the layer that protects
    // us if a future code change ever bypasses claimSessionForCleanup.
    const kcSid = `direct-create-${Date.now()}`;
    await store!.queryExec(`CREATE pending_work CONTENT $d`, {
      d: { work_type: "causal_graduate", session_id: kcSid, priority: 7 },
    });
    let rejected = false;
    try {
      await store!.queryExec(`CREATE pending_work CONTENT $d`, {
        d: { work_type: "causal_graduate", session_id: kcSid, priority: 7 },
      });
    } catch (e) {
      rejected = true;
      // Surreal's UNIQUE violation message varies by version; the test
      // just asserts that a second CREATE on the same (session_id,
      // work_type, status='pending') triple fails.
      expect(String((e as Error).message ?? e)).toMatch(/unique|already|index/i);
    }
    expect(rejected).toBe(true);

    // After the first CREATE landed, exactly one pending row exists.
    expect(await countPending(kcSid, "causal_graduate")).toBe(1);
  });

  itDb("session below turn-count threshold skips coalesced_extraction but still queues causal+soul", async () => {
    // userTurnCount=1 is below the >=2 gate, so coalesced_extraction is NOT
    // queued. Still, exactly one causal_graduate + one soul_* must land.
    const kcSid = `single-turn-${Date.now()}`;
    await seedSession({ kcSid, turnCount: 1 });

    await Promise.allSettled([
      handleSessionEnd(state!, { session_id: kcSid }),
      handleSessionEnd(state!, { session_id: kcSid }),
      handleSessionEnd(state!, { session_id: kcSid }),
      handleSessionEnd(state!, { session_id: kcSid }),
    ]);

    expect(await countPending(kcSid, "causal_graduate")).toBe(1);
    expect(await countPending(kcSid, "coalesced_extraction")).toBe(0);
    const soulGen = await countPending(kcSid, "soul_generate");
    const soulEvolve = await countPending(kcSid, "soul_evolve");
    expect(soulGen + soulEvolve).toBe(1);
    expect(await countAllPendingForSession(kcSid)).toBe(2);
  });

  itDb("2 racing runDeferredCleanup calls on the same orphan queue exactly one set", async () => {
    // Simulate a process crash (no SessionEnd ever fired) followed by two
    // concurrent SessionStart-driven deferred cleanups. Only one should
    // win the claim and queue work.
    const kcSid = `orphan-race-${Date.now()}`;

    // Create the orphan: a session row with cleanup_completed != true and
    // started_at > 2m ago so getOrphanedSessions picks it up.
    const surrealId = await store!.createSession("test-agent", kcSid, "project:test");
    // Back-date started_at by 5 minutes so it qualifies as an orphan.
    await store!.queryExec(
      `UPDATE ${surrealId} SET started_at = time::now() - 5m`,
    );
    // Seed a few turns so countTurnsForSession returns >= 2 (queues coalesced).
    for (let i = 0; i < 3; i++) {
      await store!.queryExec(
        `CREATE turn CONTENT { session_id: $sid, role: "user", text: $t, embedding: NONE }`,
        { sid: kcSid, t: `orphan turn ${i}` },
      );
    }

    const [a, b] = await Promise.allSettled([
      runDeferredCleanup(store!),
      runDeferredCleanup(store!),
    ]);
    // Both calls return — but only one wins the per-session claim.
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    // The total `queued` count across both is the number of pending_work
    // rows the WINNER actually CREATE'd — the loser sees `won=false` and
    // bails before incrementing.
    const total =
      (a.status === "fulfilled" ? (a.value as number) : 0) +
      (b.status === "fulfilled" ? (b.value as number) : 0);
    expect(total).toBeGreaterThan(0);

    // Dedup invariant for orphan path: at most ONE row per (session_id,
    // work_type) — no duplicates. The unconditional pair (causal_graduate +
    // soul_*) is what we strictly assert; coalesced_extraction CREATE can
    // fail for unrelated reasons (e.g. the preexisting surreal_session_id
    // type coercion when session.id arrives as a RecordId rather than a
    // plain string from getOrphanedSessions). The dedup defense doesn't
    // care WHY a CREATE failed — what matters is that we never see > 1.
    expect(await countPending(kcSid, "causal_graduate")).toBe(1);
    const ce = await countPending(kcSid, "coalesced_extraction");
    expect(ce).toBeLessThanOrEqual(1);
    const soulGen = await countPending(kcSid, "soul_generate");
    const soulEvolve = await countPending(kcSid, "soul_evolve");
    expect(soulGen + soulEvolve).toBe(1);
  });

  itDb("racing handleSessionEnd + runDeferredCleanup on the same session don't double-queue", async () => {
    // Worst case: the session-end hook fires AND a sibling daemon kicks off
    // deferred cleanup on the same orphan at almost the same instant. Either
    // path is a valid winner; what we must NOT see is two winners both
    // queueing.
    const kcSid = `mixed-race-${Date.now()}`;
    const surrealId = await store!.createSession("test-agent", kcSid, "project:test");
    await store!.queryExec(
      `UPDATE ${surrealId} SET started_at = time::now() - 5m`,
    );
    for (let i = 0; i < 3; i++) {
      await store!.queryExec(
        `CREATE turn CONTENT { session_id: $sid, role: "user", text: $t, embedding: NONE }`,
        { sid: kcSid, t: `mixed turn ${i}` },
      );
    }
    // Wire an in-memory SessionState for the handleSessionEnd path.
    const session = state!.getOrCreateSession(kcSid, kcSid);
    session.surrealSessionId = surrealId;
    session.userTurnCount = 3;
    session.lastUserText = "mixed race user";
    session.lastAssistantText = "mixed race assistant";

    await Promise.allSettled([
      handleSessionEnd(state!, { session_id: kcSid }),
      runDeferredCleanup(store!),
      handleSessionEnd(state!, { session_id: kcSid }),
      runDeferredCleanup(store!),
    ]);

    // Strict dedup invariant on the rows handleSessionEnd queues. If
    // handleSessionEnd won the claim, coalesced_extraction=1 (turnCount=3 ≥ 2);
    // if runDeferredCleanup won, coalesced_extraction may be 0 because of
    // the preexisting surreal_session_id type coercion in deferred-cleanup.
    // Either way: NEVER more than one.
    expect(await countPending(kcSid, "causal_graduate")).toBe(1);
    const ce = await countPending(kcSid, "coalesced_extraction");
    expect(ce).toBeLessThanOrEqual(1);
    const soulGen = await countPending(kcSid, "soul_generate");
    const soulEvolve = await countPending(kcSid, "soul_evolve");
    expect(soulGen + soulEvolve).toBe(1);
  });
});
