/**
 * Live tests for the read-only web UI data layer (src/ui-server.ts, GH #15).
 *
 * Exercises the exported query functions against a seeded kong_test DB — the
 * SQL layer where the two pre-ship bugs lived (type::thing→type::record, and
 * queryMulti returning only the last row instead of the rows array).
 *
 * Requires a live SurrealDB. The beforeAll probe RACES a 10s timeout (< the 30s
 * hook budget) so CI — which ships no SurrealDB — skips cleanly instead of the
 * hook timing out and reporting a FAIL (the v0.7.109 regression). ns=kong_test
 * is isolated from the production kong/memory graph.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurrealStore } from "../src/engine/surreal.js";
import { dashboard, listMemories, listConcepts, graphNeighborhood, nodeDetail } from "../src/ui-server.js";
import type { GlobalPluginState } from "../src/engine/state.js";

const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "kong_test";
const TEST_DB = `ui_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "schema.surql");

let store: SurrealStore | undefined;
let state: GlobalPluginState;

beforeAll(async () => {
  store = new SurrealStore({
    url: URL,
    get httpUrl() { return URL.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: USER,
    pass: PASS,
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
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping ui-server tests:", (e as Error).message);
    store = undefined;
    return;
  }
  const schema = await readFile(SCHEMA, "utf8");
  await store.queryExec(schema);
  await store.queryExec(
    `CREATE concept:uitest_c1 SET content = $c, embedding = $e, stability = 1.0, confidence = 1.0, access_count = 0`,
    { c: "alpha gateway concept", e: Array(1024).fill(0.01) },
  );
  await store.queryExec(
    `CREATE concept:uitest_c2 SET content = $c, stability = 1.0, confidence = 1.0, access_count = 0`,
    { c: "beta downstream concept" },
  );
  await store.queryExec(`RELATE concept:uitest_c1->related_to->concept:uitest_c2`);
  await store.queryExec(
    `CREATE memory:uitest_m1 SET text = $t, category = 'correction', importance = 0.8, status = 'active'`,
    { t: "a correction about the ui-server probe" },
  );
  state = { store } as unknown as GlobalPluginState;
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>) {
  it(name, async () => { if (!store) return; await fn(); }, 30_000);
}

describe("ui-server read endpoints (live, kong_test)", () => {
  itDb("dashboard returns table counts + embedding coverage", async () => {
    const d = await dashboard(state) as any;
    expect(d.table_counts.concept).toBeGreaterThanOrEqual(2);
    expect(d.table_counts.memory).toBeGreaterThanOrEqual(1);
    expect(d.embedding_coverage.concept.total).toBeGreaterThanOrEqual(2);
    expect(d.embedding_coverage.concept.embedded).toBeGreaterThanOrEqual(1);
    expect(typeof d.daemon.uptime_s).toBe("number");
  });

  itDb("concepts list paginates + search filters + never leaks embedding", async () => {
    const all = await listConcepts(state, "", 50, 0) as any;
    expect(all.total).toBeGreaterThanOrEqual(2);
    const filtered = await listConcepts(state, "alpha gateway", 50, 0) as any;
    expect(filtered.rows.length).toBe(1);
    expect(filtered.rows[0].content).toContain("alpha");
    expect("embedding" in filtered.rows[0]).toBe(false);
  });

  itDb("memories list + case-insensitive search filter", async () => {
    const m = await listMemories(state, "CORRECTION", 50, 0) as any;
    expect(m.total).toBeGreaterThanOrEqual(1);
    expect(m.rows.some((r: any) => r.category === "correction")).toBe(true);
  });

  itDb("graph neighborhood returns the related_to edge + both endpoint nodes", async () => {
    const g = await graphNeighborhood(state, "uitest_c1") as any;
    expect(g.edges.some((e: any) => e.rel === "related_to" && e.src === "uitest_c1" && e.dst === "uitest_c2")).toBe(true);
    const ids = g.nodes.map((n: any) => n.id);
    expect(ids).toContain("uitest_c1");
    expect(ids).toContain("uitest_c2");
  });

  itDb("node detail returns the row with embedding stripped", async () => {
    const n = await nodeDetail(state, "concept", "uitest_c1") as any;
    expect(n).toBeTruthy();
    expect(n.content).toContain("alpha");
    expect("embedding" in n).toBe(false);
  });

  itDb("node detail rejects a non-allowlisted table", async () => {
    const n = await nodeDetail(state, "turn", "anything");
    expect(n).toBeNull();
  });
});
