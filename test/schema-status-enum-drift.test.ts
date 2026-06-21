/**
 * Schema-vs-code drift guard for pending_work.status (campaign K0).
 *
 * batch-2a's C1 commit-ownership CAS added a transient `status='committing'`
 * write in src/tools/pending-work.ts, but the SCHEMAFULL ASSERT enum in
 * src/engine/schema.surql was left at ['pending','processing','completed',
 * 'failed']. The SCHEMAFULL assert rejected the write, so commit_work_results
 * failed deterministically and the ENTIRE drain pipeline could not commit any
 * work item. The existing commit-claim-guard.test.ts MOCKS the store, so it
 * asserted the CAS *string* contained "committing" yet never ran it against the
 * real schema — structurally blind to the drift.
 *
 * This test is pure-static (no DB, no mock): it parses the schema enum and the
 * statuses the code actually writes, and asserts code ⊆ schema. It would have
 * failed on the K0 drift and guards the whole class going forward.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");
const pendingWorkSrc = readFileSync(new URL("../src/tools/pending-work.ts", import.meta.url), "utf8");

/** Extract the ASSERT enum for `status ON pending_work`. */
function pendingWorkStatusEnum(src: string): Set<string> {
  // DEFINE FIELD (OVERWRITE|IF NOT EXISTS)? status ON pending_work ... ASSERT $value IN [ ... ]
  const m = src.match(
    /DEFINE FIELD[^\n]*\bstatus\b\s+ON\s+pending_work[\s\S]*?ASSERT\s+\$value\s+IN\s+\[([^\]]*)\]/,
  );
  if (!m) throw new Error("could not locate pending_work.status ASSERT enum in schema.surql");
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

/** Every literal `status = "X"` / `status: "X"` written in the pending-work code. */
function statusesWrittenByCode(src: string): Set<string> {
  return new Set([...src.matchAll(/status\s*[:=]\s*"([a-z_]+)"/g)].map((x) => x[1]));
}

describe("pending_work.status schema-vs-code enum drift (K0)", () => {
  const enumSet = pendingWorkStatusEnum(schemaSrc);
  const codeSet = statusesWrittenByCode(pendingWorkSrc);

  it("schema enum includes the full daemon lifecycle including the transient 'committing'", () => {
    for (const s of ["pending", "processing", "committing", "completed", "failed"]) {
      expect(enumSet.has(s), `schema status enum is missing '${s}'`).toBe(true);
    }
  });

  it("every status the code writes is permitted by the SCHEMAFULL assert (no drift)", () => {
    const drift = [...codeSet].filter((s) => !enumSet.has(s));
    expect(
      drift,
      `pending-work.ts writes status value(s) the schema ASSERT rejects: ${drift.join(", ")} — ` +
        `add them to the enum in schema.surql or the SCHEMAFULL write throws at runtime`,
    ).toEqual([]);
  });

  it("the code actually exercises the 'committing' transient (guards against a silent revert)", () => {
    // If a future refactor drops the committing CAS, this test should be updated
    // in lockstep — it documents that 'committing' is load-bearing, not dead.
    expect(codeSet.has("committing")).toBe(true);
  });
});
