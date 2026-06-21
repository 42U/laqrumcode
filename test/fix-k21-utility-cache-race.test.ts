/**
 * R1 / K21 regression — deterministic-id utility writeback must not freeze on a
 * RETAINED muc_mid_idx UNIQUE colliding with a legacy random-id row.
 *
 * BUG (the R1 regression, introduced alongside K21's deterministic-id rewrite):
 * K21 changed updateUtilityCache to UPSERT against a DETERMINISTIC record id
 * (`memory_utility_cache:⟨memory_X⟩`, one row per target) while the schema still
 * RETAINED `muc_mid_idx UNIQUE` on memory_id. After an upgrade, a legacy row
 * written by the pre-K21 writer carries a RANDOM-ULID id with memory_id=<target>
 * and OWNS the `memory_id = memory:X` slot. The new deterministic-id UPSERT's
 * `SET memory_id = memory:X` then violates the UNIQUE → the write threw, was
 * swallowed by updateUtilityCache's outer catch, and utility writeback for every
 * pre-existing target froze SILENTLY forever.
 *
 * FIX (round 2):
 *   1. REMOVE the muc_mid_idx UNIQUE (schema.surql + runSchema via REMOVE INDEX
 *      IF EXISTS; the deterministic record-id PK already guarantees
 *      one-row-per-target, like access_stats which has no secondary index).
 *   2. Defensive fallback in updateUtilityCache: catch a UNIQUE/collision (for a
 *      daemon racing ahead of the index drop) and accumulate into the row that
 *      owns the memory_id slot via `UPDATE ... WHERE memory_id = $mid` so the
 *      bump is NOT lost.
 *   3. scripts/migrate-memory-utility-cache-id.mjs folds legacy random-id rows
 *      into the deterministic id (covered by static assertions below).
 *
 * Unit tests over the real exported SurrealStore with a mocked query layer
 * (constructor opens no connection), plus static source/schema assertions for
 * the parts that are DDL/migration-shaped. They FAIL against the pre-fix body
 * (UPSERT with no UNIQUE-collision fallback → the seeded-legacy-row bump is
 * silently dropped) and against the retained-UNIQUE schema.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SurrealStore, utilityMean } from "../src/engine/surreal.js";

function makeStore() {
  return new SurrealStore({
    url: "ws://127.0.0.1:0/rpc",
    ns: "t",
    db: "t",
    user: "u",
    pass: "p",
  } as any);
}

describe("K21/R1: deterministic utility writeback survives a legacy-row UNIQUE collision", () => {
  it("happy path: no legacy row → the deterministic-id UPSERT runs once, no fallback, no throw", async () => {
    const store = makeStore();
    const execs: string[] = [];
    (store as any).queryExec = vi.fn(async (sql: string) => { execs.push(sql); });

    await store.updateUtilityCache("memory:abc", 0.8);

    expect(execs).toHaveLength(1);
    // Deterministic id, ':' → '_' in the key, commutative += accumulators.
    expect(execs[0]).toContain("UPSERT memory_utility_cache:⟨memory_abc⟩");
    expect(execs[0]).toMatch(/util_sum\s*\+=/);
    expect(execs[0]).toMatch(/retrieval_count\s*\+=\s*1/);
  });

  it("legacy-row collision: the deterministic UPSERT's UNIQUE violation is caught and the bump folds into the owning row (NOT silently dropped)", async () => {
    const store = makeStore();
    const execs: Array<{ sql: string; bindings: any }> = [];
    (store as any).queryExec = vi.fn(async (sql: string, bindings: any) => {
      execs.push({ sql, bindings });
      // First call = the deterministic-id UPSERT. Simulate the RETAINED UNIQUE
      // rejecting it because a legacy random-id row owns the memory_id slot.
      if (/^\s*UPSERT memory_utility_cache:/i.test(sql) && execs.length === 1) {
        const e: any = new Error(
          "Database index `muc_mid_idx` already contains memory:abc",
        );
        e.kind = "AlreadyExists";
        throw e;
      }
      // The fallback UPDATE-by-memory_id succeeds.
    });

    // Must NOT throw (the outer catch would have swallowed a throw, but then the
    // bump is lost — we assert the fallback path actually ran instead).
    await store.updateUtilityCache("memory:abc", 0.5);

    expect(execs).toHaveLength(2);
    // 2nd statement is the recovery UPDATE that targets the row OWNING the slot.
    const fallback = execs[1].sql;
    expect(fallback).toMatch(/^\s*UPDATE memory_utility_cache/i);
    expect(fallback).toMatch(/WHERE memory_id = \$mid/);
    expect(fallback).toMatch(/util_sum\s*\+=/);
    expect(fallback).toMatch(/retrieval_count\s*\+=\s*1/);
  });

  it("a NON-unique error from the UPSERT is not masked by the fallback (still swallowed by the outer catch, fallback not attempted)", async () => {
    const store = makeStore();
    const execs: string[] = [];
    (store as any).queryExec = vi.fn(async (sql: string) => {
      execs.push(sql);
      if (/^\s*UPSERT/i.test(sql)) throw new Error("connection reset"); // not a UNIQUE violation
    });

    // updateUtilityCache swallows all errors (fire-and-forget), so this resolves;
    // the key assertion is that the UNIQUE-only fallback did NOT run for a
    // non-unique error (no second UPDATE statement).
    await store.updateUtilityCache("memory:abc", 0.5);
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatch(/^\s*UPSERT/i);
  });

  it("utilityMean reads a legacy materialized avg_utilization (util_sum IS NONE) so post-fold rows still resolve", () => {
    // Legacy random-id row shape (pre-K21 writer): materialized mean, no util_sum.
    expect(utilityMean({ avg_utilization: 0.7, util_sum: null, retrieval_count: null })).toBe(0.7);
    // K21 commutative-accumulator row: mean = util_sum / retrieval_count.
    expect(utilityMean({ util_sum: 2.0, retrieval_count: 4 })).toBe(0.5);
    // Neither derivable → null.
    expect(utilityMean({})).toBeNull();
  });
});

describe("K21/R1: schema + migration drop the harmful UNIQUE and fold legacy rows", () => {
  const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");
  const migrationSrc = readFileSync(
    new URL("../scripts/migrate-memory-utility-cache-id.mjs", import.meta.url),
    "utf8",
  );

  it("schema REMOVEs muc_mid_idx and does NOT re-DEFINE it as UNIQUE", () => {
    expect(schemaSrc).toMatch(/REMOVE INDEX IF EXISTS muc_mid_idx ON memory_utility_cache/);
    // The only surviving muc_mid_idx mention must be the REMOVE — no DEFINE … UNIQUE.
    expect(schemaSrc).not.toMatch(/DEFINE INDEX[^\n]*muc_mid_idx[^\n]*UNIQUE/);
  });

  it("migration drops the UNIQUE (REMOVE INDEX) and never re-creates it", () => {
    expect(migrationSrc).toMatch(/REMOVE INDEX IF EXISTS muc_mid_idx ON memory_utility_cache/);
    expect(migrationSrc).not.toMatch(/DEFINE INDEX muc_mid_idx ON memory_utility_cache FIELDS memory_id UNIQUE/);
  });

  it("migration folds legacy random-id rows into the deterministic id (sum accumulators, then delete legacy)", () => {
    // The fold-in must accumulate via += into the deterministic id and DELETE
    // the legacy row (memory_utility_cache is a telemetry/cache table — deletes
    // allowed). Keying mirrors the writer: memory_id with ':' → '_'.
    expect(migrationSrc).toMatch(/UPSERT \$\{detId\} SET[\s\S]*util_sum \+=/);
    expect(migrationSrc).toMatch(/retrieval_count \+=/);
    // The legacy row is deleted via a bound RecordId ($legacy), not raw interpolation.
    expect(migrationSrc).toMatch(/DELETE \$legacy/);
    expect(migrationSrc).toMatch(/legacy:\s*legacyId/);
  });
});
