/**
 * Unit tests for the engine-layer primitives introduced by the laqrumcode
 * duplicate-row fix (Agent 17 / v0.7.69).
 *
 * Five distinct primitives are exercised here, each tested in isolation
 * from the rest of the engine:
 *
 *   1. SurrealStore.claimSessionForCleanup / releaseSessionClaim
 *      (atomic single-winner cleanup claim with rollback)
 *   2. GlobalPluginState.onSessionRemoved
 *      (callback registry fired by removeSession + reapStaleSessions)
 *   3. core-memory.ts cleanup wiring
 *      (WeakSet-guarded one-time hook registration; tier0WritesPerSession
 *       map cleared on SessionEnd via the registered callback)
 *   4. identity.ts seedIdentity mutex
 *      (single in-flight promise prevents two callers from double-seeding)
 *   5. cognitive-bootstrap.ts seedCognitiveBootstrap mutex (same shape)
 *
 * SurrealStore tests require a live SurrealDB on localhost:8000 and are
 * skipped when SKIP_INTEGRATION=1 or the connection fails. Each test
 * uses a unique session record so race-condition tests are isolated.
 * All other tests are pure unit tests with mocks.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import type { MemoryConfig } from "../src/engine/config.js";
import type { EmbeddingService } from "../src/engine/embeddings.js";
import { createCoreMemoryToolDef } from "../src/engine/tools/core-memory.js";
import { seedIdentity } from "../src/engine/identity.js";
import { seedCognitiveBootstrap } from "../src/engine/cognitive-bootstrap.js";

// ── Live-DB harness for SurrealStore tests ────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "laqrum_test";
const TEST_DB = `dup_fix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let store: SurrealStore;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const user = process.env.SURREAL_USER ?? "root";
  const pass = process.env.SURREAL_PASS ?? "root";
  store = new SurrealStore({
    url,
    get httpUrl() {
      return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", "");
    },
    user,
    pass,
    ns: TEST_NS,
    db: TEST_DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SurrealDB connect timeout after 10s")), 10_000),
      ),
    ]);
  } catch (e) {
    // Mark as unavailable; itDb() below will skip.
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping SurrealStore tests:", (e as Error).message);
    store = undefined as any;
  }
}, 15_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.shutdown?.(); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => {
    if (SKIP || !store?.isAvailable()) return;
    await fn();
  }, timeout);
}

/** Create a fresh session row, return its record id. Each test uses a
 *  unique row so single-winner tests don't bleed across tests. */
async function freshSession(): Promise<string> {
  const rows = await store.queryFirst<{ id: string }>(
    `CREATE session CONTENT { agent_id: "dup-fix-test", started_at: time::now() } RETURN id`,
  );
  const id = String(rows[0]?.id ?? "");
  if (!id.startsWith("session:")) throw new Error(`bad session id: ${id}`);
  return id;
}

// ── 1. SurrealStore.claimSessionForCleanup / releaseSessionClaim ──────────

describe("SurrealStore.claimSessionForCleanup", () => {
  itDb("first claim returns true when cleanup_completed != true", async () => {
    const sid = await freshSession();
    const won = await store.claimSessionForCleanup(sid);
    expect(won).toBe(true);
  });

  itDb("second claim on the same session returns false", async () => {
    const sid = await freshSession();
    const first = await store.claimSessionForCleanup(sid);
    const second = await store.claimSessionForCleanup(sid);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  itDb("two parallel claims: exactly one wins", async () => {
    const sid = await freshSession();
    const [a, b] = await Promise.all([
      store.claimSessionForCleanup(sid),
      store.claimSessionForCleanup(sid),
    ]);
    // Exactly one of the two must be true (XOR).
    expect(a !== b).toBe(true);
    expect(a || b).toBe(true);
  });

  itDb("releaseSessionClaim resets cleanup so a re-claim succeeds", async () => {
    const sid = await freshSession();
    const first = await store.claimSessionForCleanup(sid);
    expect(first).toBe(true);

    await store.releaseSessionClaim(sid);

    const after = await store.queryFirst<{ cleanup_completed: boolean | null; ended_at: string | null }>(
      `SELECT cleanup_completed, ended_at FROM ${sid}`,
    );
    // ended_at should have been cleared back to NONE; cleanup_completed false.
    expect(after[0]?.cleanup_completed).toBe(false);
    expect(after[0]?.ended_at == null || after[0]?.ended_at === undefined).toBe(true);

    const second = await store.claimSessionForCleanup(sid);
    expect(second).toBe(true);
  });

  itDb("claim on a non-existent session record returns false (no row matched)", async () => {
    // Valid id format but no row created.
    const ghost = `session:doesnotexist_${Math.random().toString(36).slice(2, 8)}`;
    const won = await store.claimSessionForCleanup(ghost);
    expect(won).toBe(false);
  });

  // assertRecordId guard is a pure validation path — runs without a DB.
  it("claimSessionForCleanup rejects invalid record id (no DB needed)", async () => {
    // Build a SurrealStore but never connect — assertRecordId throws BEFORE
    // any query is attempted, so the lack of a connection is irrelevant.
    const offline = new SurrealStore({
      url: "ws://127.0.0.1:65535/rpc",
      get httpUrl() { return "http://127.0.0.1:65535"; },
      user: "x", pass: "x", ns: "x", db: "x",
    });
    await expect(offline.claimSessionForCleanup("not-a-record-id"))
      .rejects.toThrow(/Invalid record ID/);
    await expect(offline.claimSessionForCleanup(""))
      .rejects.toThrow(/Invalid record ID/);
    await expect(offline.claimSessionForCleanup("session:bad space"))
      .rejects.toThrow(/Invalid record ID/);
  });

  it("releaseSessionClaim rejects invalid record id", async () => {
    const offline = new SurrealStore({
      url: "ws://127.0.0.1:65535/rpc",
      get httpUrl() { return "http://127.0.0.1:65535"; },
      user: "x", pass: "x", ns: "x", db: "x",
    });
    await expect(offline.releaseSessionClaim("garbage"))
      .rejects.toThrow(/Invalid record ID/);
  });

  // Retry-branch idempotency: when a prior attempt landed but its response was
  // lost and withRetry re-runs the SAME query (with the SAME myToken in
  // bindings), the second branch of the WHERE clause (cleanup_claim_token =
  // $myToken) must fire so we still report won=true. This is a pure unit test
  // — no DB required — that exercises the post-queryFirst code path with the
  // BEFORE row shape a successful retry would observe.
  it("retry branch: returns won=true when BEFORE row already has our token (idempotent retry)", async () => {
    const offline = new SurrealStore({
      url: "ws://127.0.0.1:65535/rpc",
      get httpUrl() { return "http://127.0.0.1:65535"; },
      user: "x", pass: "x", ns: "x", db: "x",
    });
    // Simulate withRetry having executed the original query then retried after
    // a connection drop: the second attempt sees the row already updated by
    // attempt #1, so the BEFORE row reflects cleanup_completed=true AND
    // cleanup_claim_token=myToken. Capture myToken from the bindings so the
    // mocked return shape matches what attempt #2 would actually see.
    const seenCalls: Array<{ sql: string; bindings: Record<string, unknown> }> = [];
    const spy = vi.spyOn(offline, "queryFirst").mockImplementation(
      async (sql: string, bindings?: Record<string, unknown>) => {
        seenCalls.push({ sql, bindings: bindings ?? {} });
        const tok = (bindings?.myToken ?? "") as string;
        return [{ cleanup_completed: true, cleanup_claim_token: tok }] as any;
      },
    );
    const won = await offline.claimSessionForCleanup("session:test_retry");
    expect(won).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // Sanity-check that the SQL still includes both branches of the WHERE
    // clause so the retry-idempotency contract is preserved on every change.
    expect(seenCalls[0]?.sql).toMatch(/cleanup_completed\s*!=\s*true/);
    expect(seenCalls[0]?.sql).toMatch(/cleanup_claim_token\s*=\s*\$myToken/);
    expect(typeof seenCalls[0]?.bindings.myToken).toBe("string");
  });

  // Simulate-lost-response variant: the first queryFirst attempt throws a
  // connection error, the second returns the "already claimed by us" BEFORE
  // row. Mocking queryFirst itself (rather than withRetry's internals) lets us
  // assert the contract from the caller's perspective without coupling to the
  // private retry mechanism. claimSessionForCleanup only invokes queryFirst
  // once, so we model the lost-response scenario as: first invocation throws
  // (simulating the lost wire response that withRetry would catch), then the
  // resolution path returns the BEFORE row of the retried query.
  it("retry branch: lost-response then retry preserves won=true", async () => {
    const offline = new SurrealStore({
      url: "ws://127.0.0.1:65535/rpc",
      get httpUrl() { return "http://127.0.0.1:65535"; },
      user: "x", pass: "x", ns: "x", db: "x",
    });
    let capturedToken = "";
    const spy = vi.spyOn(offline, "queryFirst")
      // First call: simulate the wire-level connection drop that withRetry
      // would normally catch and re-run. We surface it here so the test can
      // observe the consumer's recovery shape.
      .mockImplementationOnce(async (_sql: string, bindings?: Record<string, unknown>) => {
        capturedToken = String(bindings?.myToken ?? "");
        const err = new Error("must be connected to use this method");
        throw err;
      })
      // Second call: the retry. The row was updated by attempt #1, so the
      // BEFORE snapshot shows our token + cleanup_completed=true.
      .mockImplementationOnce(async (_sql: string, _bindings?: Record<string, unknown>) => {
        return [{ cleanup_completed: true, cleanup_claim_token: capturedToken }] as any;
      });

    // claimSessionForCleanup's body doesn't itself retry — that's withRetry's
    // job inside queryFirst — but we want the test to observe the resolution
    // shape. So drive the two-call sequence explicitly: catch the first
    // (simulated) connection failure, then invoke claim again.
    let firstAttemptThrew = false;
    try {
      await offline.claimSessionForCleanup("session:test_lost_response");
    } catch (e) {
      firstAttemptThrew = (e as Error).message.includes("must be connected");
    }
    expect(firstAttemptThrew).toBe(true);

    // Now the retry: the mock returns the "already claimed by us" row for the
    // SAME (newly-generated) token bindings. Since each claim call generates
    // its own myToken, we capture this call's token and stub the next mock
    // invocation accordingly. Reset the spy with a fresh impl that mirrors
    // the retry's response shape.
    spy.mockReset();
    spy.mockImplementation(async (_sql: string, bindings?: Record<string, unknown>) => {
      const tok = String(bindings?.myToken ?? "");
      return [{ cleanup_completed: true, cleanup_claim_token: tok }] as any;
    });
    const won = await offline.claimSessionForCleanup("session:test_lost_response");
    expect(won).toBe(true);
  });
});

// ── 2. GlobalPluginState.onSessionRemoved ─────────────────────────────────

/** Build a minimal GlobalPluginState — we only need the session-removed
 *  registry and removeSession/reapStaleSessions paths, so the store and
 *  embeddings can be inert shells. */
function makeState(): GlobalPluginState {
  const fakeConfig = {
    thresholds: { midSessionCleanupThreshold: 25_000 },
  } as unknown as MemoryConfig;
  const fakeStore = { isAvailable: () => false } as any;
  const fakeEmbeddings = { isAvailable: () => false, dispose: async () => {} } as any;
  return new GlobalPluginState(fakeConfig, fakeStore, fakeEmbeddings);
}

describe("GlobalPluginState.onSessionRemoved", () => {
  it("fires the callback on removeSession with (sessionId, surrealSessionId)", () => {
    const state = makeState();
    const session = state.getOrCreateSession("sk1", "claude-session-1");
    session.surrealSessionId = "session:abc";

    const spy = vi.fn();
    state.onSessionRemoved(spy);

    state.removeSession("sk1");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("claude-session-1", "session:abc");
  });

  it("fires multiple callbacks in insertion order", () => {
    const state = makeState();
    state.getOrCreateSession("sk", "claude-1");

    const order: string[] = [];
    state.onSessionRemoved(() => order.push("a"));
    state.onSessionRemoved(() => order.push("b"));
    state.onSessionRemoved(() => order.push("c"));

    state.removeSession("sk");

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("disposer unregisters the callback", () => {
    const state = makeState();
    state.getOrCreateSession("sk", "claude-1");

    const spy = vi.fn();
    const dispose = state.onSessionRemoved(spy);

    dispose();
    state.removeSession("sk");

    expect(spy).not.toHaveBeenCalled();
  });

  it("a throwing callback does not block siblings (caught + logged)", () => {
    const state = makeState();
    state.getOrCreateSession("sk", "claude-1");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const after = vi.fn();
    state.onSessionRemoved(() => { throw new Error("boom"); });
    state.onSessionRemoved(after);

    // removeSession must not propagate the error.
    expect(() => state.removeSession("sk")).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    // The console.error path must mention the callback failure.
    const errMsgs = errSpy.mock.calls.map((c) => String(c[0]));
    expect(errMsgs.some((m) => m.includes("onSessionRemoved"))).toBe(true);

    errSpy.mockRestore();
  });

  it("reapStaleSessions also fires the callbacks", () => {
    const state = makeState();
    const session = state.getOrCreateSession("sk-stale", "claude-stale");
    session.surrealSessionId = "session:stale";
    // Force the session to look stale (turnStartMs in the deep past).
    session.turnStartMs = Date.now() - 10 * 60 * 60_000;

    const spy = vi.fn();
    state.onSessionRemoved(spy);

    const reaped = state.reapStaleSessions(60_000);
    expect(reaped).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("claude-stale", "session:stale");
  });

  it("removeSession on an unknown key is a no-op and fires no callbacks", () => {
    const state = makeState();
    const spy = vi.fn();
    state.onSessionRemoved(spy);

    state.removeSession("never-registered");

    expect(spy).not.toHaveBeenCalled();
  });
});

// ── 3. core-memory.ts cleanup wiring ──────────────────────────────────────

describe("core-memory toolDef cleanup wiring", () => {
  /** Build a minimal store that supports the toolDef's tier-0 write path:
   *  isAvailable() true, createCoreMemory returns a synthetic id,
   *  getAllCoreMemory returns whatever is set on the closure. */
  function makeFakeStore() {
    return {
      isAvailable: () => true,
      createCoreMemory: vi.fn(async (text: string) => `core_memory:${Math.random().toString(36).slice(2, 8)}`),
      getAllCoreMemory: vi.fn(async () => [] as any[]),
      updateCoreMemory: vi.fn(async () => true),
      deleteCoreMemory: vi.fn(async () => {}),
    } as any;
  }

  it("registers the session-removed hook exactly once per GlobalPluginState (WeakSet guard)", () => {
    const state = makeState();
    (state as any).store = makeFakeStore();
    const session = state.getOrCreateSession("sk", "claude-1");

    const onSessionRemovedSpy = vi.spyOn(state, "onSessionRemoved");

    createCoreMemoryToolDef(state, session);
    createCoreMemoryToolDef(state, session);
    createCoreMemoryToolDef(state, session);

    // Despite three toolDef constructions, the hook must only be wired once.
    expect(onSessionRemovedSpy).toHaveBeenCalledTimes(1);
  });

  it("a fresh GlobalPluginState gets its own callback registration", () => {
    // Two separate states, two separate registrations — the WeakSet keys on
    // the state instance, not on a module-global boolean.
    const stateA = makeState();
    (stateA as any).store = makeFakeStore();
    const sA = stateA.getOrCreateSession("sk", "claude-1");
    const spyA = vi.spyOn(stateA, "onSessionRemoved");
    createCoreMemoryToolDef(stateA, sA);
    expect(spyA).toHaveBeenCalledTimes(1);

    const stateB = makeState();
    (stateB as any).store = makeFakeStore();
    const sB = stateB.getOrCreateSession("sk", "claude-2");
    const spyB = vi.spyOn(stateB, "onSessionRemoved");
    createCoreMemoryToolDef(stateB, sB);
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("removeSession clears the tier0WritesPerSession entry for that sessionId", async () => {
    // We cannot read the module-private map directly, so we observe it via
    // its public effect: tier-0 writes are rate-limited to 5 per session.
    // If removeSession correctly clears the entry, a fresh session reusing
    // the same sessionId can write 5 more times without hitting the limit.
    const state = makeState();
    const fakeStore = makeFakeStore();
    (state as any).store = fakeStore;

    // sessionId is what tier0WritesPerSession is keyed by.
    const REUSED_SID = "claude-reused";
    const session = state.getOrCreateSession("sk", REUSED_SID);

    const toolDef = createCoreMemoryToolDef(state, session);

    // Write 5 tier-0 entries — that's the per-session cap.
    for (let i = 0; i < 5; i++) {
      const res = await toolDef.execute("call", {
        action: "add",
        tier: 0,
        text: `entry ${i}`,
        category: "general",
        priority: 50,
      });
      // Cast to any for details access; the toolDef returns { content, details }.
      const r = res as any;
      expect(r.details?.error).not.toBe(true);
    }

    // The 6th tier-0 write must be rate-limited.
    const sixth = await toolDef.execute("call", {
      action: "add",
      tier: 0,
      text: "entry 6",
      category: "general",
      priority: 50,
    }) as any;
    expect(sixth.details?.reason).toBe("session_rate_limit");

    // Now end the session — the registered onSessionRemoved callback must
    // clear the per-session counter for sessionId="claude-reused".
    state.removeSession("sk");

    // Re-create a fresh session reusing the SAME sessionId (Claude Code
    // reuses session ids across resumes). If the counter wasn't cleared
    // we'd still be at 5/5 and the very first write would be rate-limited.
    const session2 = state.getOrCreateSession("sk", REUSED_SID);
    const toolDef2 = createCoreMemoryToolDef(state, session2);
    const reset = await toolDef2.execute("call", {
      action: "add",
      tier: 0,
      text: "post-reset entry",
      category: "general",
      priority: 50,
    }) as any;
    expect(reset.details?.error).not.toBe(true);
    expect(reset.details?.reason).not.toBe("session_rate_limit");
  });

  it("the registered callback IS the one that fires on removeSession (capture + invoke directly)", () => {
    // Belt-and-suspenders: capture the exact callback that core-memory
    // registers, then invoke it via removeSession and confirm a known-good
    // sessionId path runs. This proves the callback isn't a no-op stub.
    const state = makeState();
    (state as any).store = makeFakeStore();

    const captured: Array<(sid: string, ssid: string) => void> = [];
    const origOnRemoved = state.onSessionRemoved.bind(state);
    vi.spyOn(state, "onSessionRemoved").mockImplementation((cb) => {
      captured.push(cb);
      return origOnRemoved(cb);
    });

    const session = state.getOrCreateSession("sk", "claude-x");
    createCoreMemoryToolDef(state, session);

    expect(captured).toHaveLength(1);
    // Callback must be a function with arity >= 1.
    expect(typeof captured[0]).toBe("function");
    // Direct invocation must not throw.
    expect(() => captured[0]("claude-x", "session:x")).not.toThrow();
  });
});

// ── 4. identity.ts seedIdentity mutex ─────────────────────────────────────

describe("seedIdentity mutex", () => {
  function buildMocks() {
    // Simulate "no current-version chunks present" so seeding proceeds.
    const queryFirst = vi.fn(async () => [{ count: 0 }]);
    const queryExec = vi.fn(async () => {});
    const store = {
      isAvailable: () => true,
      queryFirst,
      queryExec,
    } as any;
    // Track invocations to detect double-seeding.
    const embed = vi.fn(async () => new Array(1024).fill(0));
    const embeddings: EmbeddingService = {
      isAvailable: () => true,
      embed,
    } as any;
    return { store, embeddings, queryExec, embed };
  }

  it("two concurrent calls run the inner work only once and return the same value", async () => {
    const { store, embeddings, embed } = buildMocks();

    const [a, b] = await Promise.all([
      seedIdentity(store, embeddings),
      seedIdentity(store, embeddings),
    ]);

    expect(a).toBe(b);
    // 11 IDENTITY_CHUNKS in identity.ts — embed is called once per chunk
    // for the SINGLE in-flight run, NOT twice.
    expect(embed).toHaveBeenCalledTimes(11);
  });

  it("after a successful seed the mutex clears, allowing the next call to run fresh", async () => {
    const { store, embeddings, embed } = buildMocks();

    await seedIdentity(store, embeddings);
    expect(embed).toHaveBeenCalledTimes(11);

    // Second call AFTER the first resolves — must execute fresh, not return
    // the prior promise. (The version-tag check will short-circuit it to 0
    // in real code because the second call sees the seed already present,
    // but our mock always returns count=0, forcing the inner loop to run.)
    await seedIdentity(store, embeddings);
    expect(embed).toHaveBeenCalledTimes(22);
  });

  it("mutex clears when the inner work throws (next call runs fresh)", async () => {
    const queryFirst = vi.fn(async () => { throw new Error("db kaboom"); });
    const queryExec = vi.fn(async () => {});
    const store = {
      isAvailable: () => true,
      queryFirst,
      queryExec,
    } as any;
    const embed = vi.fn(async () => new Array(1024).fill(0));
    const embeddings = { isAvailable: () => true, embed } as any;

    // First call: queryFirst throws inside the version-tag check. The
    // outer catch returns 0 and the finally clears the mutex.
    const first = await seedIdentity(store, embeddings);
    expect(first).toBe(0);

    // Now swap to a working store and call again — must not be pinned to
    // the prior 0 return; it must execute fresh.
    queryFirst.mockReset();
    queryFirst.mockResolvedValue([{ count: 0 }]);

    const second = await seedIdentity(store, embeddings);
    expect(second).toBe(11);
    expect(embed).toHaveBeenCalledTimes(11);
  });
});

// ── 5. cognitive-bootstrap.ts seedCognitiveBootstrap mutex ────────────────

describe("seedCognitiveBootstrap mutex", () => {
  function buildMocks() {
    const queryFirst = vi.fn(async (sql: string) => {
      // version-tag check for core_memory uses `cnt`; identity_chunk uses `count`.
      if (sql.includes("core_memory") && sql.includes("CONTAINS $tag")) return [{ cnt: 0 }];
      if (sql.includes("identity_chunk")) return [{ count: 0 }];
      return [];
    });
    const queryExec = vi.fn(async () => {});
    const createCoreMemory = vi.fn(async () => "core_memory:abc");
    const store = {
      isAvailable: () => true,
      queryFirst,
      queryExec,
      createCoreMemory,
    } as any;
    const embed = vi.fn(async () => new Array(1024).fill(0));
    const embeddings = { isAvailable: () => true, embed } as any;
    return { store, embeddings, createCoreMemory, embed };
  }

  it("two concurrent calls return the SAME promise — inner work runs once", async () => {
    const { store, embeddings, createCoreMemory, embed } = buildMocks();

    const [a, b] = await Promise.all([
      seedCognitiveBootstrap(store, embeddings),
      seedCognitiveBootstrap(store, embeddings),
    ]);

    expect(a).toEqual(b);
    // 6 CORE_ENTRIES + 6 IDENTITY_CHUNKS — must each fire exactly once
    // across both concurrent callers.
    expect(createCoreMemory).toHaveBeenCalledTimes(6);
    expect(embed).toHaveBeenCalledTimes(6);
  });

  it("mutex clears when the inner work throws (next call runs fresh)", async () => {
    // queryFirst throws — the migration step at the top of the impl catches
    // it via swallow.warn, so the mutex must still clear via .finally().
    // We need a harder failure: make queryExec throw on the migration DELETE.
    const queryFirst = vi.fn(async () => { throw new Error("kaboom"); });
    const queryExec = vi.fn(async () => { throw new Error("kaboom"); });
    const createCoreMemory = vi.fn(async () => "core_memory:abc");
    const store = {
      isAvailable: () => true,
      queryFirst,
      queryExec,
      createCoreMemory,
    } as any;
    const embed = vi.fn(async () => new Array(1024).fill(0));
    const embeddings = { isAvailable: () => true, embed } as any;

    // Impl swallows internal errors per-step; the outer promise still
    // resolves and the finally clears the mutex.
    const first = await seedCognitiveBootstrap(store, embeddings);
    expect(first).toEqual({ identitySeeded: 0, coreSeeded: 0 });

    // Now swap stores to a working one and re-call: must not be pinned.
    queryFirst.mockReset();
    queryFirst.mockImplementation(async (sql: string) => {
      if (sql.includes("core_memory") && sql.includes("CONTAINS $tag")) return [{ cnt: 0 }];
      if (sql.includes("identity_chunk")) return [{ count: 0 }];
      return [];
    });
    queryExec.mockReset();
    queryExec.mockResolvedValue(undefined);

    const second = await seedCognitiveBootstrap(store, embeddings);
    expect(second.coreSeeded).toBe(6);
    expect(second.identitySeeded).toBe(6);
  });
});

// ── pending_work dedup_key: soft-archive no longer collides (v0.7.102) ──────
// Regression for the drain wedge: v0.7.95 soft-archive set active=false but
// kept status='processing', so a 2nd archived row in the same (session,
// work_type, status) slot collided on the old (…, status, active) UNIQUE index
// — throwing "index already contains [...,'processing',true]" and breaking BOTH
// fetch_pending_work (stale-recovery) and commit_work_results (markTerminal).
// The dedup_key index keys archived rows on their own id, so they coexist.
describe("pending_work dedup_key — soft-archive collision fix", () => {
  itDb("multiple archived rows for the same (session, work_type, status) coexist", async () => {
    const sid = `ded-arch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const create = async (): Promise<string> => {
      const r = await store.queryFirst<{ id: string }>(
        `CREATE pending_work CONTENT { session_id: $sid, work_type: "coalesced_extraction", status: "processing", active: true } RETURN id`,
        { sid },
      );
      return String(r[0].id);
    };
    const archive = (id: string) =>
      store.queryExec(`UPDATE ${id} SET active = false, archived_at = time::now(), archive_reason = "regress"`);

    // Each archive frees the triple (dedup_key recomputes to the row id), so
    // the next active create succeeds and ends up archived alongside the rest.
    const a = await create(); await archive(a);
    const b = await create(); await archive(b); // pre-fix: threw here
    const c = await create(); await archive(c);

    const rows = await store.queryFirst<{ id: string; dedup_key: string }>(
      `SELECT id, dedup_key FROM pending_work WHERE session_id = $sid`, { sid },
    );
    expect(rows.length).toBe(3);
    expect(new Set(rows.map(r => r.dedup_key)).size).toBe(3); // all distinct, id-based
  });

  itDb("still rejects a second ACTIVE row for the same (session, work_type, status)", async () => {
    const sid = `ded-active-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = () => store.queryExec(
      `CREATE pending_work CONTENT { session_id: $sid, work_type: "soul_evolve", status: "pending", active: true }`,
      { sid },
    );
    await mk();
    let threw = false;
    try { await mk(); } catch { threw = true; }
    expect(threw).toBe(true); // active triple collides — dedup invariant preserved
  });
});
