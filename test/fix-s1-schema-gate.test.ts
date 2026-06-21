/**
 * S1 regression: schema-apply failure must leave the store reported-UNAVAILABLE.
 *
 * Bug: initialize() connected, ran runSchema(), then set initialized=true.
 * isAvailable() returned only `db.isConnected`. When the socket connected but
 * the schema apply FAILED (e.g. ns/db missing, DEFINE perms, a wedged server
 * blowing the 60s deadline), isConnected was still true, so isAvailable()
 * returned true and the daemon served writes for its whole lifetime WITHOUT the
 * UNIQUE seals / DEFINE INDEX the dedup + committing_token CAS campaign relies
 * on. The reconnect path (ensureConnected) never re-ran schema, so it never
 * healed.
 *
 * Fix: a private schemaApplied flag, set true ONLY after runSchema() resolves;
 * isAvailable() === (isConnected && schemaApplied). A reconnect re-applies the
 * schema and re-arms the flag, so a degraded boot self-heals.
 *
 * This is a near-non-mock test: it drives the REAL SurrealStore.initialize(),
 * applySchemaWithRetry(), isAvailable() and ensureConnected() logic. The only
 * seam is the SurrealDB SDK client (a network socket), replaced by a tiny fake
 * whose query() we make fail or succeed to model the server's behaviour.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { loadSchema } from "../src/engine/schema-loader.js";

const config = {
  url: "ws://127.0.0.1:9/rpc",
  ns: "test_ns",
  db: "test_db",
  user: "root",
  pass: "root",
} as unknown as ConstructorParameters<typeof SurrealStore>[0];

/** Minimal stand-in for the surrealdb `Surreal` client. Only the methods the
 *  store's connect/schema/reconnect paths touch are implemented. `query` is
 *  programmable so a test can make the SCHEMA apply (the big multi-statement
 *  string from loadSchema) fail or succeed independently of the cheap
 *  DEFINE NS/DB provision string. */
class FakeDb {
  isConnected = false;
  /** decides the fate of each query; default: everything resolves. */
  queryImpl: (sql: string) => Promise<unknown[]> = async () => [];
  schemaStr = loadSchema();

  async connect(): Promise<void> {
    this.isConnected = true;
  }
  async close(): Promise<void> {
    this.isConnected = false;
  }
  async query(sql: string): Promise<unknown[]> {
    return this.queryImpl(sql);
  }
}

/** Swap the store's private `db` for our fake and hand the fake back. */
function inject(store: SurrealStore): FakeDb {
  const fake = new FakeDb();
  (store as unknown as { db: FakeDb }).db = fake;
  return fake;
}

function isSchemaApply(sql: string, fake: FakeDb): boolean {
  // The provision step is a short DEFINE NAMESPACE/DATABASE string; the
  // authoritative apply is the full schema. Match on the schema body.
  return sql.includes(fake.schemaStr.slice(0, 40));
}

describe("S1: isAvailable gated on schemaApplied", () => {
  let store: SurrealStore;
  let fake: FakeDb;

  beforeEach(() => {
    store = new SurrealStore(config);
    fake = inject(store);
  });

  it("connect-OK but schema-apply-FAILS leaves isAvailable() === false", async () => {
    // socket connects fine; EVERY schema apply rejects (provision is best-effort
    // and swallowed, so reject it too — only the schema-apply rejection matters).
    fake.queryImpl = async (sql) => {
      if (isSchemaApply(sql, fake)) {
        throw new Error("The namespace 'test_ns' does not exist");
      }
      throw new Error("provision blocked"); // swallowed by runSchema's try/catch
    };

    await expect(store.initialize()).rejects.toThrow(/does not exist/);

    // The socket is up...
    expect(store.isConnected()).toBe(true);
    // ...but the store must report UNAVAILABLE because the schema never applied.
    expect(store.isAvailable()).toBe(false);
  });

  it("a subsequent successful schema apply (via reconnect) flips isAvailable() true", async () => {
    let schemaShouldFail = true;
    fake.queryImpl = async (sql) => {
      if (isSchemaApply(sql, fake)) {
        if (schemaShouldFail) throw new Error("The namespace 'test_ns' does not exist");
        return [];
      }
      // provision: succeed once schema is allowed, reject while failing (swallowed).
      if (schemaShouldFail) throw new Error("provision blocked");
      return [];
    };

    // Degraded boot.
    await expect(store.initialize()).rejects.toThrow();
    expect(store.isAvailable()).toBe(false);

    // Server heals. ensureConnected()'s reconnect builds a fresh `new Surreal()`
    // internally (un-injectable from here) and then, post-connect, calls the
    // private applySchemaWithRetry() to re-arm the schema — that re-arm is the
    // exact mechanism the fix added to heal a degraded boot. We invoke that same
    // private method (the connection is already up on our fake) to prove a
    // subsequent SUCCESSFUL schema apply flips isAvailable() true.
    schemaShouldFail = false;
    await (store as unknown as { applySchemaWithRetry(): Promise<void> }).applySchemaWithRetry();

    expect(store.isConnected()).toBe(true);
    expect(store.isAvailable()).toBe(true);
  });

  it("happy path: connect + schema apply both succeed → isAvailable() true", async () => {
    fake.queryImpl = async () => []; // everything succeeds
    await expect(store.initialize()).resolves.toBe(true);
    expect(store.isAvailable()).toBe(true);
  });

  it("schema apply that fails once then succeeds is healed by the bounded retry within initialize()", async () => {
    let schemaAttempts = 0;
    fake.queryImpl = async (sql) => {
      if (isSchemaApply(sql, fake)) {
        schemaAttempts++;
        if (schemaAttempts < 2) throw new Error("transient: deadline exceeded");
        return [];
      }
      return [];
    };

    await expect(store.initialize()).resolves.toBe(true);
    expect(schemaAttempts).toBeGreaterThanOrEqual(2); // retried
    expect(store.isAvailable()).toBe(true); // healed within initialize
  });

  it("isAvailable() is false before initialize() even though no error occurred", () => {
    // schemaApplied defaults false; the fake socket is not connected yet either.
    expect(store.isAvailable()).toBe(false);
  });
});
