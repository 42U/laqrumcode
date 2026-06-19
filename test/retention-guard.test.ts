/**
 * Regression guard: retrieval_outcome retention.
 *
 * retrieval_outcome is the fastest-growing table and pure ACAN training
 * telemetry. The audit found it had NO retention (grew forever, the dominant
 * disk consumer at scale) and NO created_at index (the trainer's ORDER BY
 * created_at DESC LIMIT 15000 was an unindexed full sort). These assertions
 * ensure the bounding purge + index stay wired.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const surreal = readFileSync(join(root, "src", "engine", "surreal.ts"), "utf-8");
const schema = readFileSync(join(root, "src", "engine", "schema.surql"), "utf-8");
const maintenance = readFileSync(join(root, "src", "engine", "maintenance.ts"), "utf-8");

describe("retrieval_outcome retention", () => {
  it("has a bounding purge method", () => {
    expect(surreal).toContain("purgeOldRetrievalOutcomes");
  });
  it("runs the purge from maintenance", () => {
    expect(maintenance).toContain("store.purgeOldRetrievalOutcomes()");
  });
  it("has a created_at index for the trainer sort + purge predicate", () => {
    expect(schema).toContain("ro_created_idx");
    expect(schema).toMatch(/ro_created_idx ON retrieval_outcome FIELDS created_at/);
  });
});
