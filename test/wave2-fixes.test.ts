/**
 * Live coverage for the 2026-06-10 Wave-2 fixes (QA-waterfall remediation,
 * memory:65eoe78c151tot1eecdc):
 *
 *  - W2-05/06: UNIQUE (in,out) edge indexes (ensureEdgeIndexes) + tolerant
 *    relate() — duplicate writes become idempotent no-ops; dirty tables are
 *    flagged for the dedup migration instead of failing boot.
 *  - W2-10: supersede decay-once — a retried correction must not re-decay.
 *  - W2-22: seed skills — fresh installs seed the full curated set (pre-fix:
 *    0 of 15, every CREATE failed on null → option<string>).
 *  - W2-14: archiveOldTurns retrieved-guard — turns referenced by
 *    retrieval_outcome survive archival (pre-fix: guard was a silent no-op).
 *  - W2-23: createSession/createTask omit absent keys (no NULL poisoning,
 *    no option<string> coercion failure on the kc-less fallback).
 *
 * Requires a live SurrealDB; the beforeAll probe races a 10s timeout so CI's
 * no-DB env skips cleanly. ns=kong_test, per-run dbs, removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurrealStore } from "../src/engine/surreal.js";
import { ensureEdgeIndexes, pendingFlagPath, GUARDED_EDGE_TABLES } from "../src/engine/edge-indexes.js";
import { commitKnowledge } from "../src/engine/commit.js";
import { seedSkillsFromJson } from "../src/engine/maintenance.js";
import type { GlobalPluginState } from "../src/engine/state.js";

const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "kong_test";
const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "schema.surql");
const EMB = Array(1024).fill(0.01);

const fakeEmbeddings = {
  isAvailable: () => true,
  embed: async () => Array(1024).fill(0.02),
};

function makeStore(db: string): SurrealStore {
  return new SurrealStore({
    url: URL,
    get httpUrl() { return URL.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: USER, pass: PASS, ns: TEST_NS, db,
  });
}

let store: SurrealStore | undefined; // primary db (indexes armed clean)
let dirtyStore: SurrealStore | undefined; // db with pre-seeded duplicate edges
let cacheDirClean = "";
let cacheDirDirty = "";
const DB_CLEAN = `w2_clean_${STAMP}`;
const DB_DIRTY = `w2_dirty_${STAMP}`;

async function scalar<T>(s: SurrealStore, sql: string): Promise<T | undefined> {
  const r = await s.queryMulti<unknown>(sql);
  // SurrealDB 3.1.x honors `SELECT VALUE count() ... GROUP ALL` inconsistently:
  // a scanned count unwraps to a bare number, but when a UNIQUE index drives the
  // aggregate it comes back as { count: N }. Normalize so numeric assertions hold
  // regardless of index state (the value is identical; only the wrapper differs).
  if (r !== null && typeof r === "object" && "count" in (r as Record<string, unknown>)) {
    return (r as Record<string, unknown>).count as T;
  }
  return r as T;
}

beforeAll(async () => {
  store = makeStore(DB_CLEAN);
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SurrealDB connect timeout after 10s")), 10_000)),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping wave2-fixes tests:", (e as Error).message);
    store = undefined;
    return;
  }
  await store.queryExec(await readFile(SCHEMA, "utf8"));
  dirtyStore = makeStore(DB_DIRTY);
  await dirtyStore.initialize();
  await dirtyStore.queryExec(await readFile(SCHEMA, "utf8"));
  cacheDirClean = await mkdtemp(join(tmpdir(), "w2-cache-clean-"));
  cacheDirDirty = await mkdtemp(join(tmpdir(), "w2-cache-dirty-"));

  // Dirty db: two identical owns edges BEFORE arming (the pre-fix damage shape).
  await dirtyStore.queryExec(`CREATE agent:w2a SET name = 'a'`);
  await dirtyStore.queryExec(`CREATE project:w2p SET name = 'p'`);
  await dirtyStore.queryExec(`RELATE agent:w2a->owns->project:w2p`);
  await dirtyStore.queryExec(`RELATE agent:w2a->owns->project:w2p`);
}, 30_000);

afterAll(async () => {
  for (const [s, db] of [[store, DB_CLEAN], [dirtyStore, DB_DIRTY]] as const) {
    if (!s) continue;
    try { await s.queryExec(`REMOVE DATABASE ${db}`); } catch { /* ok */ }
    try { await s.dispose(); } catch { /* ok */ }
  }
  for (const d of [cacheDirClean, cacheDirDirty]) {
    if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}, 20_000);

function itDb(name: string, fn: () => Promise<void>, t = 30_000) {
  it(name, async () => { if (!store) return; await fn(); }, t);
}

describe("W2-05/06 — UNIQUE edge indexes + tolerant relate", () => {
  itDb("clean db: all guarded tables arm; duplicate relate becomes idempotent no-op", async () => {
    const res = await ensureEdgeIndexes(store!, cacheDirClean);
    expect(res.defined.length).toBe(GUARDED_EDGE_TABLES.length);
    expect(res.skipped).toEqual([]);
    expect(existsSync(pendingFlagPath(cacheDirClean))).toBe(false);

    await store!.queryExec(`CREATE concept:w2x SET content = 'x', embedding = $e, stability = 1.0`, { e: EMB });
    await store!.queryExec(`CREATE concept:w2y SET content = 'y', embedding = $e, stability = 1.0`, { e: EMB });
    const first = await store!.relate("concept:w2x", "related_to", "concept:w2y");
    const second = await store!.relate("concept:w2x", "related_to", "concept:w2y");
    expect(first).toBe(true);   // written
    expect(second).toBe(false); // UNIQUE-rejected → idempotent no-op, no throw
    const count = await scalar<number>(store!, `SELECT VALUE count() FROM related_to WHERE in = concept:w2x AND out = concept:w2y GROUP ALL`);
    expect(count ?? 0).toBe(1); // pre-fix: 2
  });

  itDb("dirty db: duplicated table is flagged + skipped; clean tables still arm", async () => {
    const res = await ensureEdgeIndexes(dirtyStore!, cacheDirDirty);
    expect(res.skipped).toContain("owns");
    expect(res.defined.length).toBe(GUARDED_EDGE_TABLES.length - 1);
    const flags = JSON.parse(readFileSync(pendingFlagPath(cacheDirDirty), "utf8"));
    expect(Object.keys(flags)).toEqual(["owns"]);
    // Second boot: skipped table doesn't retry (no per-boot rebuild cost).
    const res2 = await ensureEdgeIndexes(dirtyStore!, cacheDirDirty);
    expect(res2.skipped).toContain("owns");
  });
});

describe("W2-10 — supersede decay-once", () => {
  itDb("a retried correction does not re-apply stability decay", async () => {
    await store!.queryExec(`CREATE concept:w2_target SET content = 'stale belief target', embedding = $e, stability = 1.0`, { e: EMB });
    const state = { store: store!, embeddings: fakeEmbeddings } as unknown as GlobalPluginState;
    const args = {
      kind: "correction" as const,
      text: "CORRECTION: the belief is stale",
      oldId: "concept:w2_target",
      importance: 8,
      sessionId: "w2-sess",
    };
    const r1 = await commitKnowledge(state, args);
    expect(r1.supersededIds).toContain("concept:w2_target");
    const afterFirst = await scalar<number>(store!, `SELECT VALUE stability FROM concept:w2_target`);
    expect(afterFirst).toBeCloseTo(0.4, 5);

    // Retry (same correction written again — the RPC-timeout retry shape).
    await commitKnowledge(state, args);
    const afterSecond = await scalar<number>(store!, `SELECT VALUE stability FROM concept:w2_target`);
    expect(afterSecond).toBeCloseTo(0.4, 5); // pre-fix: 0.16 (multiplicative re-decay)
    const edges = await scalar<number>(store!, `SELECT VALUE count() FROM supersedes WHERE out = concept:w2_target GROUP ALL`);
    expect(edges ?? 0).toBeLessThanOrEqual(2); // one per correction memory; never per retry-decay
  });
});

describe("W2-22 — seed skills land on a fresh install", () => {
  itDb("seeds every valid curated skill (pre-fix: 0 — null failed option<string>)", async () => {
    const seedPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "skills-seed.json");
    const raw = JSON.parse(await readFile(seedPath, "utf8"));
    const valid = (raw.skills as Array<{ name?: string; description?: string; body?: string }>)
      .filter((s) => s?.name && s?.description && s?.body).length;
    expect(valid).toBeGreaterThan(0);

    const state = { store: store!, embeddings: fakeEmbeddings } as unknown as GlobalPluginState;
    await seedSkillsFromJson(state);
    const seeded = await scalar<number>(store!, `SELECT VALUE count() FROM skill WHERE source = 'seed' GROUP ALL`);
    expect(seeded ?? 0).toBe(valid);

    // Idempotent: re-run dedupes by name, no duplicates.
    await seedSkillsFromJson(state);
    const seededAgain = await scalar<number>(store!, `SELECT VALUE count() FROM skill WHERE source = 'seed' GROUP ALL`);
    expect(seededAgain ?? 0).toBe(valid);
  });
});

describe("W2-14 — archiveOldTurns retrieved-guard", () => {
  itDb("a turn referenced by retrieval_outcome survives; unreferenced old turn archives", async () => {
    await store!.queryExec(`CREATE turn:w2_ref SET session_id = 'w2s', role = 'user', text = 'referenced', embedding = $e, timestamp = time::now() - 8d`, { e: EMB });
    await store!.queryExec(`CREATE turn:w2_unref SET session_id = 'w2s', role = 'user', text = 'unreferenced', embedding = $e, timestamp = time::now() - 8d`, { e: EMB });
    await store!.queryExec(`CREATE retrieval_outcome SET session_id = 'w2s', turn_id = 't', memory_id = 'turn:w2_ref', memory_table = 'turn', retrieval_score = 0.9, utilization = 0.5`);

    // Pin the FIXED guard query directly (archiveOldTurns itself is gated by
    // a 500-turn floor + weekly schedule — out of scope here; rows are also
    // pruned_at-tagged rather than deleted since 0.7.96). Pre-fix, the
    // record-vs-string NOT IN was a silent no-op and this select returned
    // BOTH turns; the <string>id cast makes the retrieved-guard real.
    const stale = await store!.queryFirst<{ id: string }>(
      `SELECT id FROM turn WHERE timestamp < time::now() - 7d AND pruned_at IS NONE AND <string>id NOT IN (SELECT VALUE memory_id FROM retrieval_outcome WHERE memory_table = 'turn') LIMIT 500`,
    );
    const ids = stale.map((r) => String(r.id));
    expect(ids).toContain("turn:w2_unref");     // unreferenced old turn IS archivable
    expect(ids).not.toContain("turn:w2_ref");   // retrieved turn survives (pre-fix: archived)
  });
});

describe("W2-23 — null-omission builders", () => {
  itDb("createSession without kc id succeeds (pre-fix: option<string> coercion failure)", async () => {
    const id = await store!.createSession("w2-agent");
    expect(id).toMatch(/^session:/);
  });

  itDb("createTask without project omits the key — row matches IS NONE backfill predicates", async () => {
    const id = await store!.createTask("w2 task no project");
    expect(id).toMatch(/^task:/);
    const matches = await scalar<number>(store!, `SELECT VALUE count() FROM task WHERE description = 'w2 task no project' AND project_id IS NONE GROUP ALL`);
    expect(matches ?? 0).toBe(1); // pre-fix: stored NULL ≠ NONE → unmatchable
  });
});
