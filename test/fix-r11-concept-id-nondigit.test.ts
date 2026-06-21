/**
 * R11 / K3 refinement — deterministic concept id must NEVER be all-digits.
 *
 * BUG (the R11 regression in K3's deterministic-id scheme): the record-id key
 * was `sha256(content).slice(0,32)`. A sha256-hex prefix that happens to be ALL
 * DIGITS produces an id like `concept:123…`. SurrealDB's driver brackets such a
 * key as ⟨digits⟩ on write, but the resulting `"concept:123…"` string fails this
 * codebase's RECORD_ID_RE (`^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_-]+$` — the id
 * part's first char must NOT be a bare digit per assertRecordId). So edge-wiring
 * that re-validates the id (assertRecordId on the existing-row re-upsert path)
 * THREW, dropping edges / surfacing an uncaught error. ~1-in-10^32 per concept,
 * but reachable across ~1M installs.
 *
 * FIX: prefix the key with a constant non-digit letter ("c") on BOTH the
 * deterministic CREATE and the random re-learn CREATE, so the id's first char is
 * always a letter → the driver and RECORD_ID_RE agree on every write and on the
 * returned id. Dedup semantics are unchanged (still a pure function of
 * lowercased content; "c" is a hex char so the slice stays in [0-9a-f]).
 *
 * Unit tests over the real exported SurrealStore with a mocked query layer
 * (constructor opens no connection). The "leading char is a non-digit / matches
 * RECORD_ID_RE" assertions FAIL against the pre-fix `slice(0,32)` body whenever
 * the simulated key is all-digit, and the structural prefix assertion FAILS for
 * EVERY input against the un-prefixed body.
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { RecordId } from "surrealdb";
import { SurrealStore } from "../src/engine/surreal.js";
import { RECORD_ID_RE } from "../src/engine/errors.js";

describe("R11/K3: deterministic concept id always begins with a non-digit", () => {
  it("the deterministic key is prefixed with a constant letter (leading char is a non-digit)", async () => {
    // A spread of contents — every produced id must start with a letter.
    for (const content of [
      "alpha", "9 numeric leading", "12345", "", "  spaced  ", "CASE Variant",
      "a concept whose text is irrelevant to the key shape",
    ]) {
      const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
      let createSql = "";
      (store as any).bumpAccessCounts = vi.fn(async () => undefined);
      (store as any).queryExec = vi.fn(async () => undefined);
      (store as any).queryFirst = vi.fn(async (sql: string) => {
        if (/^\s*CREATE\s+concept/i.test(sql)) { createSql = sql; return [{ id: "concept:x" }]; }
        return [];
      });
      await store.upsertConcept(content, null);
      if (!content.trim()) {
        // Empty content short-circuits with no CREATE — nothing to assert.
        expect(createSql).toBe("");
        continue;
      }
      const m = createSql.match(/concept:⟨([^⟩]+)⟩/);
      expect(m, `no deterministic id in: ${createSql}`).toBeTruthy();
      const key = m![1];
      // Leading char must be a non-digit (the fix's "c" prefix).
      expect(/^[a-zA-Z_]/.test(key), `key "${key}" starts with a digit`).toBe(true);
      // And the full record id must satisfy the canonical validator that
      // assertRecordId uses on the re-upsert path.
      expect(RECORD_ID_RE.test(`concept:${key}`), `concept:${key} fails RECORD_ID_RE`).toBe(true);
    }
  });

  it("an all-digit hash key is neutralized: the driver brackets a bare all-digit key (⟨…⟩, fails RECORD_ID_RE), the 'c' prefix prevents it", () => {
    // The REAL mechanism (probed against the surrealdb RecordId): a RecordId
    // whose KEY is an all-digit STRING stringifies WITH angle brackets —
    // `concept:⟨000…⟩` — because bare digits would round-trip as a NUMBER. That
    // bracketed form fails RECORD_ID_RE (⟨/⟩ are outside [a-zA-Z0-9_-]), so the
    // existing-row re-upsert path's assertRecordId(String(id)) threw and edge-
    // wiring dropped the row. A digit-FIRST but mixed-alnum key does NOT get
    // bracketed, so only the all-digit tail is pathological.
    const allDigitKey = "0".repeat(31);                       // pre-fix: 32-hex slice could be all-digit
    const prefixedKey = "c" + "0".repeat(31);                 // post-fix: leading "c"
    const unprefixedStr = String(new RecordId("concept", allDigitKey));
    const prefixedStr = String(new RecordId("concept", prefixedKey));
    // Pre-fix bug: bracketed → invalid.
    expect(unprefixedStr).toContain("⟨");
    expect(RECORD_ID_RE.test(unprefixedStr)).toBe(false);
    // The fix: leading letter → no brackets → valid and re-upsertable.
    expect(prefixedStr).toBe(`concept:${prefixedKey}`);
    expect(RECORD_ID_RE.test(prefixedStr)).toBe(true);
  });

  it("the returned deterministic id is re-upsertable: a subsequent dedup-hit calls assertRecordId(id) WITHOUT throwing", async () => {
    // Existing-row path: the dedup SELECT HITS, returning the deterministic id
    // the create path would have produced. upsertConcept calls assertRecordId on
    // it — with the "c" prefix that never throws even for an all-digit hash tail.
    const detId = `concept:c${"0".repeat(31)}`;
    const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
    (store as any).bumpAccessCounts = vi.fn(async () => undefined);
    (store as any).queryExec = vi.fn(async () => undefined);
    (store as any).queryFirst = vi.fn(async (sql: string) => {
      // Lowercase-content dedup SELECT hits with the deterministic id.
      if (/SELECT\s+id\s+FROM\s+concept\s+WHERE\s+string::lowercase\(content\)/i.test(sql)) {
        return [{ id: detId }];
      }
      return [];
    });

    // No embedding → the lowercase-equality dedup branch is taken; it finds
    // detId and runs assertRecordId(detId). Must resolve to existed:true.
    const res = await store.upsertConcept("some content", null);
    expect(res.existed).toBe(true);
    expect(res.id).toBe(detId);
  });

  it("the re-learn (random-id) CREATE is also letter-prefixed", async () => {
    // Force the deterministic CREATE to collide (AlreadyExists) with no active
    // rematch and no embedding, so the random-id re-learn fallback fires. Its id
    // must also be letter-prefixed (randomUUID hex can be all-digit too).
    let call = 0;
    let rebornSql = "";
    const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
    (store as any).bumpAccessCounts = vi.fn(async () => undefined);
    (store as any).queryExec = vi.fn(async () => undefined);
    (store as any).queryFirst = vi.fn(async (sql: string) => {
      if (/^\s*CREATE\s+concept/i.test(sql)) {
        call++;
        if (call === 1) { const e: any = new Error("already exists"); e.kind = "AlreadyExists"; throw e; }
        rebornSql = sql;
        return [{ id: "concept:reborn" }];
      }
      return []; // all SELECTs miss (only a superseded twin)
    });

    await store.upsertConcept("re-learn me", null);
    const m = rebornSql.match(/concept:⟨([^⟩]+)⟩/);
    expect(m, `no re-learn id in: ${rebornSql}`).toBeTruthy();
    expect(/^[a-zA-Z_]/.test(m![1]), `re-learn key "${m![1]}" starts with a digit`).toBe(true);
  });
});

describe("R11/K3: dedup semantics preserved under the prefix", () => {
  /** The exact key derivation the fix uses (must match surreal.ts upsertConcept). */
  function expectedKey(content: string): string {
    return "c" + createHash("sha256").update(content.toLowerCase()).digest("hex").slice(0, 31);
  }

  it("case/space variants still map to the SAME prefixed key (fold preserved)", async () => {
    const variants = ["Append Only", "append only", "APPEND ONLY"];
    const keys = new Set<string>();
    for (const v of variants) {
      const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as any);
      let createSql = "";
      (store as any).bumpAccessCounts = vi.fn(async () => undefined);
      (store as any).queryExec = vi.fn(async () => undefined);
      (store as any).queryFirst = vi.fn(async (sql: string) => {
        if (/^\s*CREATE\s+concept/i.test(sql)) { createSql = sql; return [{ id: "concept:x" }]; }
        return [];
      });
      await store.upsertConcept(v, null);
      keys.add(createSql.match(/concept:⟨([^⟩]+)⟩/)![1]);
    }
    expect(keys.size).toBe(1);
    // And it equals the documented derivation (production uses .toLowerCase(),
    // and upsertConcept trims at entry, so a trimmed-lowercase hash matches).
    expect([...keys][0]).toBe(expectedKey("append only"));
  });
});
