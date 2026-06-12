/**
 * 0.7.121: access_stats counter side-table (the vlog write-amplification fix).
 *
 * Production forensics 2026-06-12: per-retrieval `UPDATE <row> SET
 * access_count += 1` rewrote full embedded rows (4–12KB) into surrealkv's
 * append-only value log — 63.8GB of dead versions around ~0.3GB of data.
 * Bumps now land in ~100B access_stats rows; rows get an amortized weekly
 * sync; scoring merges exact deltas via fetchAccessDeltas.
 *
 * Live test (kong_test ns) — skips cleanly when no DB is reachable (CI).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { parsePluginConfig } from "../src/engine/config.js";

let store: SurrealStore | undefined;
let available = false;

beforeAll(async () => {
  const config = parsePluginConfig({});
  store = new SurrealStore({ ...config.surreal, ns: "kong_test", db: "access_stats_test" });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SurrealDB connect timeout after 10s")), 10_000),
      ),
    ]);
    available = true;
    await store.queryExec(`DELETE access_stats; DELETE concept;`).catch(() => {});
  } catch {
    available = false;
  }
}, 15_000);

afterAll(async () => {
  if (available && store) {
    await store.queryExec(`REMOVE DATABASE access_stats_test`).catch(() => {});
    await store.close().catch(() => {});
  }
});

function itDb(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (!available) return; // no live DB — skip silently (CI)
    await fn();
  }, 30_000);
}

describe("access_stats side-table counters", () => {
  itDb("bumps land in the side table, not as row rewrites", async () => {
    await store!.queryExec(
      `CREATE concept:bumptest SET content = "bump target", access_count = 5, last_accessed = time::now()`,
    );
    await store!.bumpAccessCounts(["concept:bumptest"]);
    await store!.bumpAccessCounts(["concept:bumptest"]);
    const stats = await store!.queryFirst<{ hits: number }>(
      `SELECT hits FROM access_stats:⟨concept_bumptest⟩`,
    );
    expect(stats[0]?.hits).toBe(2);
    // Row untouched (last_accessed fresh → weekly sync gate didn't fire).
    const row = await store!.queryFirst<{ access_count: number }>(
      `SELECT access_count FROM concept:bumptest`,
    );
    expect(row[0]?.access_count).toBe(5);
  });

  itDb("weekly sync folds the delta exactly once (stale row)", async () => {
    await store!.queryExec(
      `CREATE concept:synctest SET content = "sync target", access_count = 10, last_accessed = time::now() - 8d`,
    );
    await store!.bumpAccessCounts(["concept:synctest"]); // sync fires: 10 + 1
    await store!.bumpAccessCounts(["concept:synctest"]); // fresh now: no sync
    const row = await store!.queryFirst<{ access_count: number; synced_hits: number }>(
      `SELECT access_count, synced_hits FROM concept:synctest`,
    );
    expect(row[0]?.access_count).toBe(11);
    expect(row[0]?.synced_hits).toBe(1);
    const stats = await store!.queryFirst<{ hits: number }>(
      `SELECT hits FROM access_stats:⟨concept_synctest⟩`,
    );
    expect(stats[0]?.hits).toBe(2);
  });

  itDb("fetchAccessDeltas returns only the un-synced remainder", async () => {
    const deltas = await store!.fetchAccessDeltas([
      "concept:bumptest", // 2 hits, 0 synced → delta 2
      "concept:synctest", // 2 hits, 1 synced → delta 1
      "concept:never_bumped", // no stats row → absent
    ]);
    expect(deltas.get("concept:bumptest")).toBe(2);
    expect(deltas.get("concept:synctest")).toBe(1);
    expect(deltas.has("concept:never_bumped")).toBe(false);
  });

  itDb("accepts RecordId-like OBJECT ids (0.7.122 — callers pass raw row ids)", async () => {
    await store!.queryExec(`CREATE concept:objid SET content = "obj id target", last_accessed = time::now()`);
    // Simulate a RecordId object: String(obj) must yield "table:id".
    const rid = { toString: () => "concept:objid" };
    await store!.bumpAccessCounts([rid]);
    const deltas = await store!.fetchAccessDeltas([rid]);
    expect(deltas.get("concept:objid")).toBe(1);
  });

  itDb("multi-id bump batch (the joined LET+UPDATE shape) counts each id once", async () => {
    await store!.queryExec(`CREATE concept:multi1 SET content = "m1", last_accessed = time::now()`);
    await store!.queryExec(`CREATE concept:multi2 SET content = "m2", last_accessed = time::now()`);
    await store!.bumpAccessCounts(["concept:multi1", "concept:multi2", "concept:multi1"]);
    const deltas = await store!.fetchAccessDeltas(["concept:multi1", "concept:multi2"]);
    expect(deltas.get("concept:multi1")).toBe(2);
    expect(deltas.get("concept:multi2")).toBe(1);
  });

  itDb("negative fold is clamped (stats reset below watermark cannot decrement)", async () => {
    await store!.queryExec(`CREATE concept:clamptest SET content = "c", access_count = 9, synced_hits = 5, last_accessed = time::now() - 8d`);
    await store!.queryExec(`CREATE access_stats:⟨concept_clamptest⟩ SET hits = 1, target = concept:clamptest`);
    await store!.bumpAccessCounts(["concept:clamptest"]); // hits→2 < watermark 5 → fold clamps to 0
    const row = await store!.queryFirst<{ access_count: number }>(`SELECT access_count FROM concept:clamptest`);
    expect(row[0]?.access_count).toBe(9);
  });

  itDb("upsertConcept dedup-hit bumps side table and leaves the embedded row alone", async () => {
    const emb = Array.from({ length: 1024 }, () => 0.5);
    const first = await store!.upsertConcept("amplification fix dedup target", emb);
    expect(first.existed).toBe(false);
    const second = await store!.upsertConcept("amplification fix dedup target", emb);
    expect(second.existed).toBe(true);
    expect(second.id).toBe(first.id);
    const key = second.id.replace(":", "_");
    const stats = await store!.queryFirst<{ hits: number }>(
      `SELECT hits FROM access_stats:⟨${key}⟩`,
    );
    expect(stats[0]?.hits ?? 0).toBeGreaterThanOrEqual(1);
  });
});
