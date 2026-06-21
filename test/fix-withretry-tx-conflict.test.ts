/**
 * withRetry transaction-conflict retry (K21 gap + duplicate-row-fix flake root cause).
 *
 * SurrealStore.withRetry() previously retried ONLY isRetryableSurrealError
 * (connection drop / blown deadline / auth) — NOT a transaction write conflict,
 * which SurrealDB itself reports as "...can be retried". So under real
 * multi-session load a concurrent CAS (claimSessionForCleanup, updateUtilityCache,
 * commit) could surface a conflict ERROR instead of cleanly losing — observed as
 * the intermittently-failing test/duplicate-row-fix.test.ts "two parallel claims"
 * case. withRetry now retries transaction conflicts with bounded backoff (no
 * reconnect — the socket is healthy). These are CI-safe unit tests (a fake db,
 * no live SurrealDB), since the real-DB duplicate-row-fix test skips in CI.
 */
import { describe, it, expect, vi } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

function txConflict(): Error {
  return new Error("Transaction write conflict. This transaction can be retried");
}

function storeWithFakeDb(queryImpl: (sql: string) => Promise<unknown>) {
  const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as never);
  const fake = { isConnected: true, query: vi.fn(queryImpl) };
  (store as unknown as { db: typeof fake }).db = fake;
  return { store, fake };
}

describe("withRetry: transaction conflicts are retried (bounded, no reconnect)", () => {
  it("retries a transaction conflict and succeeds on the next attempt", async () => {
    let n = 0;
    const { store, fake } = storeWithFakeDb(async () => {
      n++;
      if (n === 1) throw txConflict();
      return [null, [{ id: "ok" }]]; // [USE NS result, rows] — queryFirst takes the last set
    });
    const rows = await store.queryFirst<{ id: string }>("SELECT 1");
    expect(rows).toEqual([{ id: "ok" }]);
    expect(fake.query).toHaveBeenCalledTimes(2); // 1 conflicted, retry won
  });

  it("gives up after the bounded retries on a PERSISTENT conflict (1 + 3 = 4 attempts)", async () => {
    const { store, fake } = storeWithFakeDb(async () => {
      throw txConflict();
    });
    await expect(store.queryFirst("SELECT 1")).rejects.toThrow(/conflict/i);
    expect(fake.query).toHaveBeenCalledTimes(4); // bounded — never loops forever
  });

  it("does NOT retry a non-conflict, non-connection error (throws immediately)", async () => {
    const { store, fake } = storeWithFakeDb(async () => {
      throw new Error("Parse error: unexpected token");
    });
    await expect(store.queryFirst("SELECT 1")).rejects.toThrow(/parse error/i);
    expect(fake.query).toHaveBeenCalledTimes(1);
  });
});
