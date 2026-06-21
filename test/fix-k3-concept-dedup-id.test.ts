/**
 * K3 regression — concept dedup race + dead recovery catch.
 *
 * BUG (pre-fix): SurrealStore.upsertConcept() did `SELECT ... LIMIT 1` then
 * `CREATE concept CONTENT $record` with a RANDOM record id. Two concurrent
 * upserts of byte-identical content both saw the SELECT-miss and both CREATE'd
 * a row → an exact duplicate concept (the M5 TOCTOU race). The recovery branch
 * (`catch (createErr) { if (isUniqueViolation(...)) ... re-SELECT }`) was DEAD
 * code: with random ids and no UNIQUE on content, the CREATE never collided, so
 * the catch never fired.
 *
 * FIX: key the new row's PRIMARY record id on a sha256 of the LOWERCASED+trimmed
 * content (`CREATE concept:⟨<hash>⟩ ...`). upsertConcept is the SOLE
 * `CREATE concept` funnel, so two racers now compute the SAME id and SurrealDB's
 * native record-id uniqueness rejects the loser with AlreadyExists — which
 * isUniqueViolation() catches, making the recovery branch LIVE. No schema DDL,
 * so no daemon-boot risk from a fresh UNIQUE index on a table that already
 * carries active duplicates.
 *
 * These are pure unit tests over the real exported SurrealStore with a mocked
 * query layer (constructor opens no connection). They FAIL against the pre-fix
 * `CREATE concept CONTENT` (no deterministic id, so no collision, so the
 * "same content → same id" and "loser is recovered via the catch" assertions
 * both break).
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { SurrealStore } from "../src/engine/surreal.js";

/** The exact key derivation the fix uses (see surreal.ts upsertConcept).
 *  R11: prefixed with a constant non-digit "c" so the driver never brackets an
 *  all-digit key into an id that fails RECORD_ID_RE. 31 hex + "c" = 32 chars. */
function expectedKey(content: string): string {
  return "c" + createHash("sha256").update(content.trim().toLowerCase()).digest("hex").slice(0, 31);
}

/** Build a SurrealStore whose query layer is fully mocked. `onCreate` captures
 *  the CREATE statement; the dedup SELECT always misses so we reach CREATE. */
function makeStore(opts: {
  onCreate: (sql: string) => Array<{ id: string }>; // what the CREATE "returns"
  recoverySelect?: () => Array<{ id: string }>; // Stage-A re-SELECT after a collision
}) {
  const store = new SurrealStore({
    url: "ws://127.0.0.1:0/rpc",
    ns: "t",
    db: "t",
    user: "u",
    pass: "p",
  } as any);

  const createSqls: string[] = [];
  // The initial dedup SELECT and the post-collision Stage-A rematch use BYTE-
  // IDENTICAL SQL, so distinguish them by order: the 1st lowercase-content
  // SELECT is the initial dedup (must MISS so we reach CREATE); the 2nd is the
  // Stage-A rematch (returns recoverySelect()).
  let lowercaseSelects = 0;
  (store as any).queryFirst = vi.fn(async (sql: string) => {
    if (/^\s*CREATE\s+concept/i.test(sql)) {
      createSqls.push(sql);
      return opts.onCreate(sql);
    }
    if (/SELECT\s+id\s+FROM\s+concept\s+WHERE\s+string::lowercase\(content\)/i.test(sql)) {
      lowercaseSelects += 1;
      if (lowercaseSelects === 1) return []; // initial dedup → miss
      return opts.recoverySelect ? opts.recoverySelect() : []; // Stage-A rematch
    }
    return [];
  });
  (store as any).queryExec = vi.fn(async () => undefined);
  (store as any).bumpAccessCounts = vi.fn(async () => undefined);

  return { store, createSqls };
}

describe("K3: deterministic content-hash record id seals the dedup race", () => {
  it("CREATEs against concept:⟨sha256(lowercased content)⟩, not a random-id `CREATE concept`", async () => {
    const content = "Graph connectivity determines recall quality";
    const key = expectedKey(content);
    const { store, createSqls } = makeStore({
      onCreate: () => [{ id: `concept:${key}` }],
    });

    const res = await store.upsertConcept(content, null);

    expect(createSqls).toHaveLength(1);
    // Must target the deterministic id, not the bare `CREATE concept CONTENT`.
    expect(createSqls[0]).toContain(`concept:⟨${key}⟩`);
    expect(createSqls[0]).not.toMatch(/CREATE\s+concept\s+CONTENT/i);
    expect(res.existed).toBe(false);
    expect(res.id).toBe(`concept:${key}`);
  });

  it("byte-identical content (case/space variants) maps to the SAME target id", async () => {
    const variants = [
      "Append-only retention uses soft-tags",
      "  append-only retention uses soft-tags  ",
      "APPEND-ONLY RETENTION USES SOFT-TAGS",
    ];
    const seen = new Set<string>();
    for (const v of variants) {
      const { store, createSqls } = makeStore({ onCreate: () => [{ id: "concept:x" }] });
      await store.upsertConcept(v, null);
      const m = createSqls[0].match(/concept:⟨([0-9a-f]+)⟩/);
      expect(m, `no deterministic id in: ${createSqls[0]}`).toBeTruthy();
      seen.add(m![1]);
    }
    // All three normalize to one key → the race between them collides on the PK.
    expect(seen.size).toBe(1);
  });

  it("different content maps to a DIFFERENT target id (no over-collision)", async () => {
    const a = makeStore({ onCreate: () => [{ id: "concept:a" }] });
    const b = makeStore({ onCreate: () => [{ id: "concept:b" }] });
    await a.store.upsertConcept("concept alpha text", null);
    await b.store.upsertConcept("concept beta text", null);
    const ka = a.createSqls[0].match(/concept:⟨([0-9a-f]+)⟩/)![1];
    const kb = b.createSqls[0].match(/concept:⟨([0-9a-f]+)⟩/)![1];
    expect(ka).not.toBe(kb);
  });

  it("the recovery catch is now LIVE: a CREATE AlreadyExists is folded to the winner's id", async () => {
    // Simulate the race loser: its deterministic-id CREATE collides with the
    // winner's row. The catch must re-SELECT and return the winner's id with
    // existed=true (NOT throw, NOT return an empty id).
    const content = "racing concept content";
    let firstCreate = true;
    const { store } = makeStore({
      onCreate: () => {
        if (firstCreate) {
          firstCreate = false;
          const e: any = new Error("Database record `concept:abc` already exists");
          e.kind = "AlreadyExists";
          throw e;
        }
        return [{ id: "concept:should-not-happen" }];
      },
      // Winner's active row is found by the Stage-A lowercase rematch.
      recoverySelect: () => [{ id: "concept:winner" }],
    });

    const res = await store.upsertConcept(content, null);
    expect(res.id).toBe("concept:winner");
    expect(res.existed).toBe(true);
  });

  it("append-only re-learn: collision with NO active match retries with a random id (fresh sibling)", async () => {
    // The deterministic id collides but the only occupant is a SUPERSEDED twin
    // (Stage-A rematch misses, no embedding for Stage-B). Pre-fix behavior was a
    // fresh random-id CREATE; the fix preserves that so re-learning superseded
    // content never hard-throws.
    let call = 0;
    const createSqls: string[] = [];
    const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
    (store as any).bumpAccessCounts = vi.fn(async () => undefined);
    (store as any).queryExec = vi.fn(async () => undefined);
    (store as any).queryFirst = vi.fn(async (sql: string) => {
      if (/^\s*CREATE\s+concept/i.test(sql)) {
        createSqls.push(sql);
        call++;
        if (call === 1) {
          const e: any = new Error("already exists");
          e.kind = "AlreadyExists";
          throw e; // deterministic-id CREATE collides with a superseded twin
        }
        return [{ id: "concept:reborn" }]; // the random-id retry succeeds
      }
      // Both the initial dedup SELECT and the Stage-A rematch miss (only a
      // superseded twin exists, which the `superseded_at IS NONE` filter hides).
      return [];
    });

    const res = await store.upsertConcept("previously superseded content", null);
    expect(res.id).toBe("concept:reborn");
    expect(res.existed).toBe(false);
    // Two CREATE attempts: deterministic id (collided) then a random-id retry.
    expect(createSqls).toHaveLength(2);
    expect(createSqls[1]).toMatch(/CREATE\s+concept:⟨[0-9a-f]+⟩/i);
    // The retry id is NOT the content-hash key (it's a random uuid-hex).
    const key = expectedKey("previously superseded content");
    expect(createSqls[1]).not.toContain(`concept:⟨${key}⟩`);
  });
});
