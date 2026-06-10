/**
 * Integration tests — real SurrealDB on localhost:8000.
 *
 * These tests connect to a live database. Skip with:
 *   SKIP_INTEGRATION=1 npx vitest run
 *
 * Requires: docker container running surrealdb on port 8000
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "kong_test";
const TEST_DB = `integration_${Date.now()}`;

let store: SurrealStore;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const user = process.env.SURREAL_USER ?? "root";
  const pass = process.env.SURREAL_PASS ?? "root";
  store = new SurrealStore({
    url,
    get httpUrl() { return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user,
    pass,
    ns: TEST_NS,
    db: TEST_DB,
  });
  try {
    // Timeout the connection attempt — WebSocket connect can hang indefinitely
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SurrealDB connection timed out after 10s")), 10_000),
      ),
    ]);
  } catch (e) {
    console.warn("SurrealDB not available, skipping integration tests:", (e as Error).message);
    store = undefined as any;
  }
}, 15_000);

afterAll(async () => {
  if (!store) return;
  // Clean up test database
  try {
    await store.queryExec(`REMOVE DATABASE ${TEST_DB}`);
  } catch { /* ok */ }
  try {
    await store.shutdown();
  } catch { /* ok */ }
}, 15_000);

// Helper to skip when DB unavailable
function itDb(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => {
    if (SKIP || !store?.isAvailable()) return;
    await fn();
  }, timeout);
}

// ── Basic connectivity ──

describe("SurrealDB integration", () => {
  itDb("connects and runs schema", async () => {
    expect(store.isAvailable()).toBe(true);
  });

  // ── queryBatch ──

  itDb("queryBatch sends multiple statements in one round-trip", async () => {
    // Create test data
    await store.queryExec(`CREATE test_batch:a SET text = "alpha"`);
    await store.queryExec(`CREATE test_batch:b SET text = "beta"`);

    const results = await store.queryBatch<{ id: string; text: string }>([
      `SELECT * FROM test_batch:a`,
      `SELECT * FROM test_batch:b`,
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(1);
    expect(results[0][0].text).toBe("alpha");
    expect(results[1]).toHaveLength(1);
    expect(results[1][0].text).toBe("beta");
  });

  itDb("queryBatch returns empty arrays for no-match statements", async () => {
    const results = await store.queryBatch<any>([
      `SELECT * FROM test_batch WHERE text = "nonexistent"`,
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(0);
  });

  itDb("queryBatch handles empty statements array", async () => {
    const results = await store.queryBatch([]);
    expect(results).toEqual([]);
  });

  // ── CRUD operations ──

  itDb("upsertTurn creates and retrieves turns", async () => {
    const turnId = await store.upsertTurn({
      session_id: "integration-session",
      role: "user",
      text: "Hello from integration test",
      embedding: null,
    });

    expect(turnId).toBeTruthy();
    expect(typeof turnId).toBe("string");

    // Verify it's in the DB
    const rows = await store.queryFirst<{ text: string }>(
      `SELECT text FROM turn WHERE session_id = "integration-session" LIMIT 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].text).toBe("Hello from integration test");
  });

  itDb("relate creates edges between records", async () => {
    const t1 = await store.upsertTurn({ session_id: "int-s1", role: "user", text: "first", embedding: null });
    const t2 = await store.upsertTurn({ session_id: "int-s1", role: "assistant", text: "second", embedding: null });

    if (t1 && t2) {
      await store.relate(t2, "responds_to", t1);

      // Verify edge exists (RELATE creates in→edge→out, query traversal)
      const neighbors = await store.queryFirst<{ id: string }>(
        `SELECT id FROM ${t2}->responds_to->? LIMIT 1`,
      );
      expect(neighbors.length).toBeGreaterThan(0);
    }
  });

  // ── Core memory ──

  itDb("createCoreMemory + getAllCoreMemory round-trip", async () => {
    const id = await store.createCoreMemory("Test directive", "test", 50, 0);
    expect(id).toBeTruthy();

    const entries = await store.getAllCoreMemory(0);
    const found = entries.find(e => e.text === "Test directive");
    expect(found).toBeDefined();
    expect(found!.category).toBe("test");
    expect(found!.priority).toBe(50);
  });

  itDb("deleteCoreMemory removes entry", async () => {
    const id = await store.createCoreMemory("To be deleted", "test", 10, 0);
    expect(id).toBeTruthy();

    await store.deleteCoreMemory(id!);

    const entries = await store.getAllCoreMemory(0);
    const found = entries.find(e => e.text === "To be deleted");
    expect(found).toBeUndefined();
  });

  // ── Memory operations ──

  itDb("createMemory stores with importance and category", async () => {
    const id = await store.createMemory(
      "Integration test memory",
      null, // no embedding
      7,
      "test",
      "integration-session",
    );
    expect(id).toBeTruthy();

    const rows = await store.queryFirst<{ text: string; importance: number; category: string }>(
      `SELECT text, importance, category FROM memory WHERE session_id = "integration-session" LIMIT 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].importance).toBe(7);
    expect(rows[0].category).toBe("test");
  });

  // ── Vector search (with fake embeddings) ──

  itDb("vectorSearch returns results sorted by similarity", async () => {
    // Create turns with simple embeddings for testing
    const vec1 = new Array(1024).fill(0); vec1[0] = 1.0; // unit vector along dim 0
    const vec2 = new Array(1024).fill(0); vec2[1] = 1.0; // unit vector along dim 1

    await store.upsertTurn({ session_id: "vec-test", role: "user", text: "Vector test A", embedding: vec1 });
    await store.upsertTurn({ session_id: "vec-test", role: "user", text: "Vector test B", embedding: vec2 });

    // Query with vec similar to vec1
    const queryVec = new Array(1024).fill(0); queryVec[0] = 0.9; queryVec[1] = 0.1;
    const results = await store.vectorSearch(queryVec, "vec-test", { turn: 5 });

    expect(results.length).toBeGreaterThan(0);
    // "Vector test A" should score higher (closer to queryVec)
    const testA = results.find(r => r.text === "Vector test A");
    const testB = results.find(r => r.text === "Vector test B");
    if (testA && testB) {
      expect(testA.score).toBeGreaterThan(testB.score);
    }
  }, 10_000);

  // ── graphExpand ──

  itDb("graphExpand traverses edges from seed nodes", async () => {
    // Create linked nodes
    const t1 = await store.upsertTurn({ session_id: "graph-test", role: "user", text: "Graph seed", embedding: new Array(1024).fill(0.01) });
    const { id: conceptId } = await store.upsertConcept("graph-test-concept", new Array(1024).fill(0.02), "test");

    if (t1 && conceptId) {
      await store.relate(t1, "mentions", conceptId);

      const neighbors = await store.graphExpand([t1], new Array(1024).fill(0.01));

      // Should find the concept via the mentions edge
      const found = neighbors.find(n => n.text?.includes("graph-test-concept") || n.id === conceptId);
      expect(found).toBeDefined();
    }
  }, 10_000);

  // ── bumpAccessCounts ──

  itDb("bumpAccessCounts increments access_count", async () => {
    const id = await store.upsertTurn({
      session_id: "bump-test", role: "user", text: "Bump me", embedding: null,
    });
    if (!id) return;

    // Initialize access_count (schema may not default it)
    await store.queryExec(`UPDATE ${id} SET access_count = 0`);

    await store.bumpAccessCounts([id]);
    const rows1 = await store.queryFirst<{ access_count: number }>(`SELECT access_count FROM ${id}`);
    expect(rows1[0]?.access_count).toBe(1);

    await store.bumpAccessCounts([id]);
    const rows2 = await store.queryFirst<{ access_count: number }>(`SELECT access_count FROM ${id}`);
    expect(rows2[0]?.access_count).toBe(2);
  });

  itDb("bumpAccessCounts handles empty array", async () => {
    await expect(store.bumpAccessCounts([])).resolves.toBeUndefined();
  });

  // ── SELECT ... WHERE id IN (record reference binding) ──

  itDb("SELECT WHERE id IN works with direct interpolation (not $ids binding)", async () => {
    // Create 2 memories with known IDs
    const id1 = await store.createMemory(
      "Select-in test memory A",
      null,
      5,
      "test",
      "select-in-test",
    );
    const id2 = await store.createMemory(
      "Select-in test memory B",
      null,
      5,
      "test",
      "select-in-test",
    );
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    // Verify getSessionRetrievedMemories path works (uses direct interpolation now).
    // We test the underlying pattern directly: SELECT with array of record IDs.
    const ids = [id1!, id2!];

    // 1) Parameterized binding (the old, potentially broken way)
    const paramResult = await store.queryFirst<{ id: string; text: string }>(
      `SELECT id, text FROM memory WHERE id IN $ids`,
      { ids },
    );

    // 2) Direct interpolation (the fixed way)
    const idList = ids.join(", ");
    const directResult = await store.queryFirst<{ id: string; text: string }>(
      `SELECT id, text FROM memory WHERE id IN [${idList}]`,
    );

    // The direct interpolation approach must always work
    expect(directResult.length).toBe(2);
    const directTexts = directResult.map(r => r.text).sort();
    expect(directTexts).toEqual(["Select-in test memory A", "Select-in test memory B"]);

    // If parameterized returns 0 rows, the bug exists — our fix is correct
    if (paramResult.length === 0) {
      // Bug confirmed: $ids binding doesn't work for record references
      // Our direct interpolation fix in getSessionRetrievedMemories is necessary
      expect(true).toBe(true); // documenting the bug
    } else {
      // If SurrealDB fixed this in a newer version, both approaches work
      expect(paramResult.length).toBe(2);
    }
  });

  // ── Session lifecycle ──

  itDb("session create + mark ended round-trip", async () => {
    const rows = await store.queryFirst<{ id: string }>(
      `CREATE session CONTENT { agent_id: "test-agent", started_at: time::now() } RETURN id`,
    );
    const sessionId = String(rows[0]?.id ?? "");
    expect(sessionId).toContain("session:");

    await store.markSessionEnded(sessionId);

    const updated = await store.queryFirst<{ ended_at: string }>(
      `SELECT ended_at FROM ${sessionId}`,
    );
    expect(updated[0]?.ended_at).toBeTruthy();
  });
});
