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
import { createServer as httpCreateServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SurrealStore } from "../src/engine/surreal.js";
import {
  dashboard, listMemories, listConcepts, graphNeighborhood, nodeDetail,
  listDirectives, soulView, listSessions, listRetrievalOutcomes, querySandbox,
  uiRequestHandler,
} from "../src/ui-server.js";
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
  // NB: ns/db are intentionally NOT pre-provisioned here — SurrealStore.runSchema()
  // now issues idempotent DEFINE NAMESPACE/DATABASE IF NOT EXISTS, so initialize()
  // provisions a fresh ns/db itself (the fresh-install fix). This suite passing is
  // an implicit integration check of that path; see test/fresh-provision.test.ts
  // for the focused regression.
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
  // v2 view fixtures (GH #15 v2): directives, identity/soul, session, retrieval outcome.
  await store.queryExec(
    `CREATE core_memory:uitest_d1 SET text = $t, category = 'rules', tier = 0, priority = 100, active = true, created_at = time::now()`,
    { t: "uitest directive — always loaded" },
  );
  await store.queryExec(
    `CREATE identity_chunk:uitest_i1 SET source = 'soul', chunk_index = 0, text = $t, importance = 0.9, identity_version = 'v1', active = true, agent_id = 'test', embedding = $e`,
    { t: "uitest soul chunk — working style", e: Array(1024).fill(0.02) },
  );
  await store.queryExec(
    `CREATE session:uitest_s1 SET agent_id = 'test', started_at = time::now(), last_active = time::now(), turn_count = 5, total_input_tokens = 100, total_output_tokens = 50, kc_session_id = 'kc-uitest'`,
  );
  await store.queryExec(
    `CREATE retrieval_outcome:uitest_r1 SET memory_table = 'concept', memory_id = 'uitest_c1', retrieval_score = 0.8, utilization = 0.5, recency = 0.9, importance = 0.7, was_neighbor = false, session_id = 'kc-uitest', turn_id = 'turn-uitest', created_at = time::now(), query_embedding = $e`,
    { e: Array(1024).fill(0.03) },
  );
  state = {
    store,
    embeddings: { isAvailable: () => true, embed: async () => Array(1024).fill(0.01) },
  } as unknown as GlobalPluginState;
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

  // ── v2 views ────────────────────────────────────────────────────────────────
  itDb("directives lists active Tier-0 entries with text + tier", async () => {
    const d = await listDirectives(state) as any;
    const row = d.rows.find((r: any) => r.id === "uitest_d1");
    expect(row).toBeTruthy();
    expect(row.tier).toBe(0);
    expect(row.text).toContain("always loaded");
  });

  itDb("soul returns identity chunks + version history, embedding stripped", async () => {
    const s = await soulView(state) as any;
    const chunk = s.chunks.find((c: any) => c.id === "uitest_i1");
    expect(chunk).toBeTruthy();
    expect(chunk.text).toContain("working style");
    expect("embedding" in chunk).toBe(false);
    expect(s.versions.some((v: any) => v.identity_version === "v1")).toBe(true);
  });

  itDb("sessions list returns the session with turn + token counts", async () => {
    const s = await listSessions(state, 50, 0) as any;
    expect(s.total).toBeGreaterThanOrEqual(1);
    const row = s.rows.find((r: any) => r.id === "uitest_s1");
    expect(row).toBeTruthy();
    expect(row.turn_count).toBe(5);
  });

  itDb("retrieval outcomes list NEVER leaks query_embedding", async () => {
    const r = await listRetrievalOutcomes(state, 50, 0) as any;
    expect(r.total).toBeGreaterThanOrEqual(1);
    const row = r.rows.find((x: any) => x.id === "uitest_r1");
    expect(row).toBeTruthy();
    expect(row.retrieval_score).toBeCloseTo(0.8);
    expect("query_embedding" in row).toBe(false);
  });

  itDb("query sandbox returns scored hits, embedding-stripped, and writes nothing", async () => {
    const before = await store!.queryBatch<{ c: number }>([`SELECT count() AS c FROM retrieval_outcome GROUP ALL`]);
    const beforeN = before[0]?.[0]?.c ?? 0;
    const q = await querySandbox(state, "alpha gateway", 10) as any;
    expect(q.available).toBe(true);
    expect(q.primary.length).toBeGreaterThanOrEqual(1);
    expect(typeof q.primary[0].score).toBe("number");
    expect("embedding" in q.primary[0]).toBe(false);
    // Read-only invariant: running a sandbox query must not stage an ACAN row.
    const after = await store!.queryBatch<{ c: number }>([`SELECT count() AS c FROM retrieval_outcome GROUP ALL`]);
    expect(after[0]?.[0]?.c ?? 0).toBe(beforeN);
  });

  // ── HTTP security envelope (drives the real request handler) ──────────────────
  itDb("HTTP envelope: 401 unauthed, 405 on write, 403 traversal, 200 authed", async () => {
    const TOKEN = "ui-test-token-9f3a";
    const srv = httpCreateServer(uiRequestHandler(state, TOKEN));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      // No credential → the whole /api surface is closed.
      expect((await fetch(`${base}/api/ui/directives`)).status).toBe(401);
      expect((await fetch(`${base}/ui/`)).status).toBe(401);
      // Authenticated but non-GET → read-only enforcement.
      expect((await fetch(`${base}/api/ui/directives`, { method: "POST", headers: auth })).status).toBe(405);
      expect((await fetch(`${base}/api/ui/query`, { method: "DELETE", headers: auth })).status).toBe(405);
      // Path traversal (percent-encoded so URL parsing can't collapse it) → rejected.
      const trav = await fetch(`${base}/ui/%2e%2e%2f%2e%2e%2fpackage.json`, { headers: auth });
      expect(trav.status).toBe(403);
      // Authenticated GET of a new v2 endpoint → 200 with data.
      const ok = await fetch(`${base}/api/ui/directives`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(Array.isArray((await ok.json() as any).rows)).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
