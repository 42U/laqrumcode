/**
 * SCHEMA-UPGRADE-WEDGE regression (data-preserving, never destroy content).
 *
 * BUG: on installs upgrading across <0.7.70 with legacy data, applying
 * src/engine/schema.surql can be REJECTED, wedging the daemon in degraded mode
 * until a human runs scripts/predeploy-dedup.mjs:
 *
 *  (1) `DEFINE FIELD OVERWRITE status ON pending_work ... ASSERT $value IN
 *      ['pending','processing','committing','completed','failed']` evaluates the
 *      ASSERT against EVERY existing pending_work row at daemon boot. A pre-0.7.x
 *      row carrying a legacy status ("queued"), a typo, or NULL fails the ASSERT
 *      and the whole schema apply is rejected.
 *  (2) several UNIQUE DEFINE INDEX statements (subagent_*_unique, retoutc_unique,
 *      turnscore_unique, identity_chunk_unique, maturity_stage_unique,
 *      causal_chain_unique, artifact_path_unique) are rejected if pre-existing
 *      duplicate rows already violate uniqueness.
 *
 * FIX (data-PRESERVING — the C2 principle, NEVER a content DELETE):
 *  (a) schema.surql: BEFORE the pending_work.status OVERWRITE+ASSERT, an in-band
 *      normalize (mirroring the concept-rename LET+IF migration idiom in the same
 *      file) moves any out-of-enum/NULL status to the safe terminal 'failed'
 *      bucket so the ASSERT passes. pending_work is the work QUEUE (telemetry-
 *      ish); 'failed' is benign and loses no content.
 *  (b) surreal.ts applySchemaWithRetry: on an apply failure whose signature is a
 *      UNIQUE-index violation (isUniqueViolation), it does NOT blindly retry
 *      (the dups persist) — it writes a LOUD maintenance_runs error row (C2
 *      pattern → memory_health RED) naming the exact data-preserving recovery
 *      command, since auto-deduping the CONTENT table `artifact` from schema
 *      apply would bypass the gcHardDelete keystone.
 *
 * These are pure-static assertions over the schema text + the surreal.ts source
 * (no DB, no mock): they parse the migration statement, its ORDERING relative to
 * the ASSERT, the enum it normalizes against, and the surreal.ts recovery wiring.
 * They FAIL against the pre-fix sources (no normalize statement; a bare retry
 * loop with no UNIQUE-violation diagnostic).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");
const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");

const FULL_ENUM = ["pending", "processing", "committing", "completed", "failed"];

// ── Locators over the schema text ────────────────────────────────────────────

/** Byte offset of the pending_work.status normalize UPDATE (the in-band
 *  migration that moves out-of-enum rows to 'failed'). The pattern is the
 *  guarded form `IF ... THEN UPDATE pending_work SET status = 'failed' ...`. */
function normalizeOffset(src: string): number {
  // Match the UPDATE that rewrites status to 'failed' filtered by the
  // out-of-enum / IS NONE predicate. Tolerant of whitespace/newlines.
  const m = src.match(
    /UPDATE\s+pending_work\s+SET\s+status\s*=\s*'failed'\s+WHERE\s+status\s+NOT\s+IN\s+\[[^\]]*\][\s\S]*?status\s+IS\s+NONE/i,
  );
  return m ? (m.index ?? -1) : -1;
}

/** Byte offset of the OVERWRITE status field declaration carrying the ASSERT. */
function statusAssertOffset(src: string): number {
  const m = src.match(
    /DEFINE\s+FIELD\s+OVERWRITE\s+status\s+ON\s+pending_work[\s\S]*?ASSERT\s+\$value\s+IN\s+\[/i,
  );
  return m ? (m.index ?? -1) : -1;
}

/** Pull the enum literal list out of the normalize UPDATE's WHERE clause. */
function normalizeEnum(src: string): Set<string> {
  const m = src.match(
    /UPDATE\s+pending_work\s+SET\s+status\s*=\s*'failed'\s+WHERE\s+status\s+NOT\s+IN\s+\[([^\]]*)\]/i,
  );
  if (!m) throw new Error("normalize UPDATE not found in schema.surql");
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

// ── (a) schema.surql in-band normalize ───────────────────────────────────────

describe("SCHEMA-UPGRADE-WEDGE (a): pending_work.status in-band normalize", () => {
  it("the normalize UPDATE-to-'failed' statement is present", () => {
    expect(
      normalizeOffset(schemaSrc),
      "schema.surql must contain an in-band `UPDATE pending_work SET status = 'failed' " +
        "WHERE status NOT IN [...] OR status IS NONE` before the status ASSERT",
    ).toBeGreaterThanOrEqual(0);
  });

  it("the normalize is ORDERED strictly before the status OVERWRITE+ASSERT", () => {
    const nOff = normalizeOffset(schemaSrc);
    const aOff = statusAssertOffset(schemaSrc);
    expect(nOff, "normalize statement missing").toBeGreaterThanOrEqual(0);
    expect(aOff, "status ASSERT missing").toBeGreaterThanOrEqual(0);
    // Ordering is the whole point: if the ASSERT lands before the data is
    // normalized, the apply is rejected on the legacy row and the daemon wedges.
    expect(
      nOff,
      "the status-normalize migration must appear BEFORE the OVERWRITE+ASSERT — " +
        "otherwise the ASSERT evaluates against un-normalized legacy rows and rejects the apply",
    ).toBeLessThan(aOff);
  });

  it("is gated by a LET+IF count guard so a clean install is a zero-cost no-op (mirrors concept-rename idiom)", () => {
    // The guard prevents a full pending_work table-scan UPDATE on every daemon
    // connect when there are no violators — the exact regression the concept
    // migration LET+IF (schema.surql:73) was added to fix.
    const guard = schemaSrc.match(
      /LET\s+\$pw_bad_status_count\s*=\s*\(SELECT\s+count\(\)\s+FROM\s+pending_work[\s\S]*?GROUP\s+ALL\)\[0\]\.count\s*\?\?\s*0;[\s\S]*?IF\s+\$pw_bad_status_count\s*>\s*0\s+THEN/i,
    );
    expect(
      guard,
      "the normalize must be wrapped in `LET $pw_bad_status_count = (...GROUP ALL)[0].count ?? 0; " +
        "IF $pw_bad_status_count > 0 THEN ... END;` so clean installs never table-scan",
    ).not.toBeNull();
  });

  it("normalizes against the FULL five-value enum — a legacy 'queued' row is rewritten, a valid 'committing' row is NOT", () => {
    const enumSet = normalizeEnum(schemaSrc);
    // Must match the live ASSERT enum exactly, including the transient
    // 'committing' (a real in-flight status — normalizing it to 'failed' would
    // corrupt an actively-committing work item, the opposite of data-preserving).
    for (const s of FULL_ENUM) {
      expect(
        enumSet.has(s),
        `normalize enum is missing '${s}' — it must mirror the status ASSERT enum exactly so ` +
          `valid in-flight statuses are NOT rewritten to 'failed'`,
      ).toBe(true);
    }
    expect(enumSet.size, "normalize enum has extra/unknown values").toBe(FULL_ENUM.length);

    // Behavioral check of the predicate semantics: emulate the WHERE so the test
    // proves the *intent* (queued → rewritten; committing → untouched), not just
    // the text. A row is rewritten iff status NOT IN enum OR status IS NONE.
    const wouldRewrite = (status: string | null) =>
      status === null || !enumSet.has(status);
    expect(wouldRewrite("queued"), "legacy 'queued' must be normalized to 'failed'").toBe(true);
    expect(wouldRewrite(null), "NULL/NONE status must be normalized to 'failed'").toBe(true);
    expect(wouldRewrite("pendng"), "a typo'd status must be normalized to 'failed'").toBe(true);
    expect(wouldRewrite("committing"), "a valid in-flight 'committing' row must be PRESERVED").toBe(false);
    expect(wouldRewrite("pending"), "a valid 'pending' row must be PRESERVED").toBe(false);
    expect(wouldRewrite("completed"), "a valid 'completed' row must be PRESERVED").toBe(false);
  });

  it("rewrites to a TERMINAL benign bucket ('failed'), never deletes the row (C2: data-preserving)", () => {
    // The migration must be an UPDATE, not a DELETE — pending_work content is
    // preserved (moved to a safe terminal state), never destroyed.
    const m = schemaSrc.match(/(\w+)\s+pending_work\s+SET\s+status\s*=\s*'failed'/i);
    expect(m?.[1]?.toUpperCase(), "the normalize must be an UPDATE (preserve), not a DELETE").toBe("UPDATE");
    expect(
      /DELETE\s+pending_work\s+WHERE\s+status\s+NOT\s+IN/i.test(schemaSrc),
      "must NOT delete out-of-enum pending_work rows — that would destroy queue content",
    ).toBe(false);
  });
});

// ── (b) surreal.ts UNIQUE-violation auto-recovery diagnostic ──────────────────

describe("SCHEMA-UPGRADE-WEDGE (b): surreal.ts UNIQUE-violation recovery diagnostic", () => {
  it("applySchemaWithRetry gates on isUniqueViolation to detect the duplicate-row wedge", () => {
    // The retry loop must special-case a UNIQUE-index rejection: retrying the
    // same apply against persistent dups is futile, so it must branch to a
    // diagnostic instead of silently exhausting attempts.
    const body = surrealSrc.match(/private async applySchemaWithRetry\([\s\S]*?\n  \}/);
    expect(body, "applySchemaWithRetry not found").not.toBeNull();
    expect(
      /isUniqueViolation\(/.test(body![0]),
      "applySchemaWithRetry must call isUniqueViolation to recognize the duplicate-row wedge signature",
    ).toBe(true);
  });

  it("writes a maintenance_runs error row naming the EXACT data-preserving recovery command (C2 pattern)", () => {
    // The recovery record must be persisted so memory_health surfaces RED and the
    // operator/fleet-monitor gets a copy-pasteable remediation — not a silent
    // degraded daemon.
    expect(
      /CREATE\s+maintenance_runs\s+CONTENT/.test(surrealSrc),
      "must CREATE a maintenance_runs row recording the wedge",
    ).toBe(true);
    expect(
      surrealSrc.includes("scripts/predeploy-dedup.mjs --apply"),
      "the diagnostic must name the exact recovery command `node scripts/predeploy-dedup.mjs --apply`",
    ).toBe(true);
    expect(
      /status:\s*"error"/.test(surrealSrc),
      "the maintenance_runs recovery row must carry status: 'error' so memory_health reads RED",
    ).toBe(true);
  });

  it("does NOT auto-DELETE content tables from schema apply (gcHardDelete keystone is the only sanctioned path)", () => {
    // Defense: the recovery path must surface a diagnostic, NOT issue an
    // unguarded DELETE on artifact/concept/memory etc. inside applySchemaWithRetry.
    const fn = surrealSrc.match(
      /private async recordSchemaWedgeRecovery\([\s\S]*?\n  \}/,
    );
    expect(fn, "recordSchemaWedgeRecovery not found").not.toBeNull();
    expect(
      /\bDELETE\s+(artifact|concept|memory|turn|reflection)\b/i.test(fn![0]),
      "the wedge-recovery diagnostic must NOT delete content-table rows — that bypasses the gcHardDelete keystone",
    ).toBe(false);
  });
});
