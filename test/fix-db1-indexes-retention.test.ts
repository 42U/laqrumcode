/**
 * DB1-indexes-retention lane — static regression guard for the hardening batch
 * covering K8, K18-idx, K33-idx, K7-kernel, and K29.
 *
 * All five findings are about a long-lived per-host daemon: telemetry tables
 * that grow ~1 row/turn forever, with hot-path scans/sorts that were unindexed
 * full table scans, plus the one telemetry table (turn_score) that had no
 * retention at all. This suite is pure-static (no DB, no mock, no build): it
 * parses the actual source files and asserts the fixes are present, so it
 * fails CI on regression without needing a live SurrealDB.
 *
 * Why static and not integration: the index DEFINEs and the retention method
 * are deterministic source-level facts. An integration test would SKIP in CI
 * without a SurrealDB on localhost, giving false green; the drift these
 * findings represent is exactly "the index/method silently isn't there", which
 * a source assertion catches every run.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");
const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");
const maintenanceSrc = readFileSync(new URL("../src/engine/maintenance.ts", import.meta.url), "utf8");

/** True if a `DEFINE INDEX ... ON <table> FIELDS <field>` for the given field
 *  exists (any index name; tolerant of IF NOT EXISTS / OVERWRITE and trailing
 *  index options like a compound or HNSW spec). */
function hasFieldIndex(src: string, table: string, field: string): boolean {
  const re = new RegExp(
    `DEFINE INDEX[^\\n]*\\bON\\s+${table}\\s+FIELDS\\s+${field}\\b`,
  );
  return re.test(src);
}

describe("DB1-indexes-retention: created_at telemetry indexes (K8)", () => {
  it("turn_score has a created_at index (ts_created_idx)", () => {
    // purgeOldTurnScores ORDER BY created_at + DELETE ... WHERE created_at,
    // plus observability.ts/soul.ts range scans, were unindexed without this.
    expect(hasFieldIndex(schemaSrc, "turn_score", "created_at")).toBe(true);
  });

  it("orchestrator_metrics has a created_at index (om_created_idx)", () => {
    // observability.ts:pruneRawMetrics explicitly documents "Indexed scan
    // relies on om_created_idx"; before this fix that index did not exist.
    expect(hasFieldIndex(schemaSrc, "orchestrator_metrics", "created_at")).toBe(true);
  });
});

describe("DB1-indexes-retention: membership/scan indexes (K18-idx, K33-idx)", () => {
  it("reflection has a session_id index (K18 targeted membership)", () => {
    expect(hasFieldIndex(schemaSrc, "reflection", "session_id")).toBe(true);
  });

  it("monologue has a timestamp index (K33 soul-fetch ORDER BY/range)", () => {
    expect(hasFieldIndex(schemaSrc, "monologue", "timestamp")).toBe(true);
  });

  it("memory has an importance index (K33/K30 GC + ordered retrieval)", () => {
    expect(hasFieldIndex(schemaSrc, "memory", "importance")).toBe(true);
  });
});

describe("DB1-indexes-retention: orchestrator_metrics retention comment (K7-kernel)", () => {
  it("the retention comment states soft-tag / NEVER-DELETE, not the stale 'pruned after 30d'", () => {
    // Isolate the orchestrator_metrics_daily header comment block.
    const block = schemaSrc.slice(
      schemaSrc.indexOf("Daily Rollup of Orchestrator Metrics"),
      schemaSrc.indexOf("DEFINE TABLE IF NOT EXISTS orchestrator_metrics_daily"),
    );
    expect(block.length).toBeGreaterThan(0);
    // The stale phrasing implied a hard delete and predated the v0.7.96
    // soft-tag conversion. It must be gone.
    expect(/raw rows pruned after 30d/.test(block)).toBe(false);
    // The corrected comment must name the soft-tag mechanism and the
    // never-delete contract.
    expect(/SOFT-TAG/i.test(block)).toBe(true);
    expect(/pruned_at/.test(block)).toBe(true);
    expect(/NEVER/i.test(block) && /delete/i.test(block)).toBe(true);
  });
});

describe("DB1-indexes-retention: turn_score retention (K29)", () => {
  it("purgeOldTurnScores is defined as a store method", () => {
    expect(/async\s+purgeOldTurnScores\s*\(/.test(surrealSrc)).toBe(true);
  });

  it("purgeOldTurnScores hard-DELETEs turn_score by a created_at cutoff", () => {
    // Mirrors purgeOldRetrievalOutcomes: cutoff via ORDER BY created_at DESC
    // ... START <RETAIN>, then DELETE WHERE created_at < cutoff.
    const m = surrealSrc.match(/async\s+purgeOldTurnScores\s*\([\s\S]*?\n {2}}/);
    expect(m, "purgeOldTurnScores body not found").not.toBeNull();
    const body = m![0];
    expect(/DELETE\s+turn_score\s+WHERE\s+created_at\s*<\s*\$cutoff/.test(body)).toBe(true);
    expect(/ORDER BY created_at DESC/.test(body)).toBe(true);
    // Bounded only-when-over-target guard (don't churn at the bound).
    expect(/count\s*<=\s*RETAIN/.test(body)).toBe(true);
    // Records the run for the time-relative maintenance gate, like its siblings.
    expect(/recordMaintenanceRun\("purgeOldTurnScores"/.test(body)).toBe(true);
  });

  it("purgeOldTurnScores is wired into the Group-1 bootstrap maintenance Promise.all", () => {
    // Must be invoked alongside the other Group-1 purges so it actually runs.
    expect(/store\.purgeOldTurnScores\(\)/.test(maintenanceSrc)).toBe(true);
    const groupOne = maintenanceSrc.slice(
      maintenanceSrc.indexOf("Promise.all(["),
      maintenanceSrc.indexOf("]).then("),
    );
    expect(groupOne.length).toBeGreaterThan(0);
    expect(/store\.purgeOldTurnScores\(\)/.test(groupOne)).toBe(true);
    // It sits with its telemetry-purge siblings.
    expect(/store\.purgeOldRetrievalOutcomes\(\)/.test(groupOne)).toBe(true);
  });

  it("turn_score is NOT a D4 content table, so DELETE turn_score is lint-legal", () => {
    // Guard the invariant the K29 DELETE depends on: turn_score must remain
    // absent from the no-DELETE-content-tables lint's CONTENT_TABLES list
    // (it is telemetry, like retrieval_outcome). If a future change adds it
    // there, this DELETE would violate D4 and CI would break — catch it here.
    const lintSrc = readFileSync(
      new URL("../test/lint-no-delete-content-tables.test.ts", import.meta.url),
      "utf8",
    );
    const m = lintSrc.match(/const CONTENT_TABLES\s*=\s*\[([\s\S]*?)\]/);
    expect(m, "CONTENT_TABLES list not found in D4 lint").not.toBeNull();
    const tables = new Set(
      [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]),
    );
    expect(tables.has("turn_score")).toBe(false);
  });
});
