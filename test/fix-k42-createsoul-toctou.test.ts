/**
 * K42 regression — createSoul() had a check-then-create TOCTOU on the fixed
 * `soul:kongbrain` id with no try/catch. If a concurrent caller (two
 * session-end pipelines, or a retry) slips between hasSoul() and the CREATE,
 * the second CREATE throws "already exists" and the whole call rejected.
 *
 * The fix wraps the CREATE in try/catch and treats already-exists as
 * idempotent success (re-checking hasSoul() after the catch). These tests use
 * a mock store; the "throws then succeeds" case FAILS against the pre-fix code
 * (the error propagated out of createSoul()).
 */
import { describe, it, expect, vi } from "vitest";
import { createSoul } from "../src/engine/soul.js";

const emptyDoc = {
  working_style: [],
  emotional_dimensions: [],
  self_observations: [],
  earned_values: [],
} as any;

describe("K42: createSoul TOCTOU idempotency", () => {
  it("returns true (not throw) when CREATE loses the race but the soul exists", async () => {
    let soulExists = false; // hasSoul() before CREATE → false; after → true
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM soul:kongbrain")) return soulExists ? [{ id: "soul:kongbrain" }] : [];
        return [];
      }),
      queryExec: vi.fn(async () => {
        // Simulate the concurrent winner having created it just now.
        soulExists = true;
        throw new Error("Database record `soul:kongbrain` already exists");
      }),
    };
    // Must resolve true, not reject.
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe(true);
  });

  it("returns false when CREATE fails for a real reason and no soul exists", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async (sql: string) => {
        if (sql.includes("FROM soul:kongbrain")) return []; // never exists
        return [];
      }),
      queryExec: vi.fn(async () => { throw new Error("disk full"); }),
    };
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe(false);
  });

  it("returns false up front when the soul already exists (unchanged happy path)", async () => {
    const store = {
      isAvailable: () => true,
      queryFirst: vi.fn(async () => [{ id: "soul:kongbrain" }]),
      queryExec: vi.fn(async () => {}),
    };
    await expect(createSoul(emptyDoc, store as any)).resolves.toBe(false);
    expect(store.queryExec).not.toHaveBeenCalled();
  });
});
