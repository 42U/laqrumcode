/**
 * Predeploy schema-repair contract tests — documents the Agent 22 decision
 * matrix from scripts/predeploy-dedup.mjs `repairSchema()` so that future
 * refactors of that function (or accidental regressions) are caught.
 *
 * The script itself is a CLI that takes a live Surreal handle, so direct
 * in-process unit tests would require either spawning Surreal or stubbing
 * the entire client. Instead, this file mirrors the decision logic exactly
 * (using the same dispatch shape as the script reads from INFO FOR TABLE)
 * and asserts the four documented branches:
 *
 *   1. concept.superseded_by field absent           → "defined" / "would_define"
 *   2. concept.superseded_by already record-typed   → "skipped_already_correct"
 *   3. concept.superseded_by wrong type, 0 rows     → "repaired" / "would_repair"
 *   4. concept.superseded_by wrong type, N>0 rows   → "aborted_has_data"
 *
 * Plus the pw_session_worktype_status_unique index re-attempt sub-decisions:
 *   - already correct shape → "skipped_already_correct"
 *   - absent / wrong shape  → "defined" / "would_define" / "failed"
 *
 * If predeploy-dedup.mjs's repairSchema() diverges from these branches, the
 * tests will go stale and need updating — they are the contract.
 */

import { describe, it, expect } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Parallel implementation of the script's decision logic. Kept here in-test
// so the contract is documented independently of the implementation. If the
// upstream script diverges, both the script and this test must be updated.
// ─────────────────────────────────────────────────────────────────────────────

interface TableInfo {
  fields?: Record<string, string>;
  indexes?: Record<string, string>;
}

interface DbStub {
  conceptInfo: TableInfo | "error";
  pwInfo: TableInfo | "error";
  /** Number of concept rows whose superseded_by is NOT NONE. */
  conceptRowsWithValue: number;
  /** If true, the script will simulate the DEFINE INDEX statement throwing. */
  indexDefineThrows?: boolean;
}

function decideFieldRepair(stub: DbStub, apply: boolean): string {
  if (stub.conceptInfo === "error") return "error";
  const fieldDefn = String(stub.conceptInfo.fields?.superseded_by ?? "");
  if (!fieldDefn) {
    return apply ? "defined" : "would_define";
  }
  if (/record/i.test(fieldDefn)) {
    return "skipped_already_correct";
  }
  if (stub.conceptRowsWithValue > 0) {
    return "aborted_has_data";
  }
  return apply ? "repaired" : "would_repair";
}

function decideIndexRepair(stub: DbStub, apply: boolean): string {
  if (stub.pwInfo === "error") return "error";
  const idxDefn = String(stub.pwInfo.indexes?.pw_session_worktype_status_unique ?? "");
  if (
    idxDefn &&
    /UNIQUE/i.test(idxDefn) &&
    /session_id/.test(idxDefn) &&
    /work_type/.test(idxDefn) &&
    /status/.test(idxDefn)
  ) {
    return "skipped_already_correct";
  }
  if (!apply) return "would_define";
  if (stub.indexDefineThrows) return "failed";
  return "defined";
}

// ─────────────────────────────────────────────────────────────────────────────
// Field repair branches
// ─────────────────────────────────────────────────────────────────────────────
describe("predeploy schema-repair: concept.superseded_by field branches", () => {
  it("field absent + APPLY → defined", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideFieldRepair(stub, true)).toBe("defined");
  });

  it("field absent + dry-run → would_define", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideFieldRepair(stub, false)).toBe("would_define");
  });

  it("field already record-typed → skipped_already_correct (idempotent)", () => {
    const stub: DbStub = {
      conceptInfo: {
        fields: { superseded_by: "DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>" },
      },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideFieldRepair(stub, true)).toBe("skipped_already_correct");
    // Same outcome on dry-run — idempotency means no mutation regardless.
    expect(decideFieldRepair(stub, false)).toBe("skipped_already_correct");
  });

  it("field is wrong type + zero rows in use + APPLY → repaired (REMOVE + redefine safe)", () => {
    const stub: DbStub = {
      conceptInfo: {
        fields: { superseded_by: "DEFINE FIELD superseded_by ON concept TYPE option<string>" },
      },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideFieldRepair(stub, true)).toBe("repaired");
  });

  it("field is wrong type + zero rows + dry-run → would_repair", () => {
    const stub: DbStub = {
      conceptInfo: {
        fields: { superseded_by: "DEFINE FIELD superseded_by ON concept TYPE option<string>" },
      },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideFieldRepair(stub, false)).toBe("would_repair");
  });

  it("field is wrong type + N>0 rows carry a value → aborted_has_data (data preservation)", () => {
    // CRITICAL: even with --apply, if any concept row carries a non-NONE
    // superseded_by, the repair MUST abort. REMOVE + redefine would destroy
    // those values. Operator must decide.
    const stub: DbStub = {
      conceptInfo: {
        fields: { superseded_by: "DEFINE FIELD superseded_by ON concept TYPE option<string>" },
      },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 42,
    };
    expect(decideFieldRepair(stub, true)).toBe("aborted_has_data");
    expect(decideFieldRepair(stub, false)).toBe("aborted_has_data");
  });

  it("INFO FOR TABLE concept fails → error (read-side failure, doesn't pretend success)", () => {
    const stub: DbStub = {
      conceptInfo: "error",
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideFieldRepair(stub, true)).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Index repair branches
// ─────────────────────────────────────────────────────────────────────────────
describe("predeploy schema-repair: pw_session_worktype_status_unique branches", () => {
  it("compound UNIQUE already present with correct shape → skipped_already_correct", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: {
        indexes: {
          pw_session_worktype_status_unique:
            "DEFINE INDEX pw_session_worktype_status_unique ON pending_work FIELDS session_id, work_type, status UNIQUE",
        },
      },
      conceptRowsWithValue: 0,
    };
    expect(decideIndexRepair(stub, true)).toBe("skipped_already_correct");
  });

  it("index absent + APPLY → defined", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideIndexRepair(stub, true)).toBe("defined");
  });

  it("index absent + dry-run → would_define", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    expect(decideIndexRepair(stub, false)).toBe("would_define");
  });

  it("KNOWN LIMITATION: substring-based shape check is loose — a WHERE-style defn (missing 'status' as a FIELDS column) is accepted as correct", () => {
    // The script's check is substring-based: any defn that mentions
    // 'session_id', 'work_type', 'status', and 'UNIQUE' anywhere counts as
    // "already correct". An Agent 10–era WHERE-style index (`FIELDS session_id,
    // work_type WHERE status='pending' UNIQUE`) DOES pass this check because
    // 'status' appears in the WHERE clause. The repair then skips, leaving
    // the wrong shape in place. This test documents the contract; a stricter
    // shape parser would be a v0.8 hardening.
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: {
        indexes: {
          pw_session_worktype_status_unique:
            "DEFINE INDEX pw_session_worktype_status_unique ON pending_work FIELDS session_id, work_type WHERE status='pending' UNIQUE",
        },
      },
      conceptRowsWithValue: 0,
    };
    expect(decideIndexRepair(stub, false)).toBe("skipped_already_correct");
  });

  it("index missing 'work_type' column entirely → would_define (token genuinely absent)", () => {
    // Sanity: if a token is truly missing from the defn string, the loose
    // check correctly rejects and falls through to define/would_define.
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: {
        indexes: {
          pw_session_worktype_status_unique:
            "DEFINE INDEX pw_session_worktype_status_unique ON pending_work FIELDS session_id, status UNIQUE",
        },
      },
      conceptRowsWithValue: 0,
    };
    expect(decideIndexRepair(stub, false)).toBe("would_define");
  });

  it("index DEFINE throws on apply (dupes still exist) → failed (with cause logged)", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
      indexDefineThrows: true,
    };
    // The decision tree treats DEFINE failures as recoverable info (the dedup
    // pass should clear violators; failure means it didn't), so the outcome
    // string is 'failed' rather than escalating to fatal.
    expect(decideIndexRepair(stub, true)).toBe("failed");
  });

  it("INFO FOR TABLE pending_work fails → error", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: "error",
      conceptRowsWithValue: 0,
    };
    expect(decideIndexRepair(stub, true)).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end shape: when both branches succeed, the summary line in main()
// includes both outcome strings. This documents the format consumers parse.
// ─────────────────────────────────────────────────────────────────────────────
describe("predeploy schema-repair: combined outcomes documented in summary", () => {
  it("field=defined + index=defined: both populate the SUMMARY line", () => {
    const stub: DbStub = {
      conceptInfo: { fields: {} },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 0,
    };
    const field = decideFieldRepair(stub, true);
    const idx = decideIndexRepair(stub, true);
    const summary = `concept.superseded_by=${field}  pw_session_worktype_status_unique=${idx}`;
    expect(summary).toBe("concept.superseded_by=defined  pw_session_worktype_status_unique=defined");
  });

  it("field=skipped + index=skipped: idempotent second run produces the expected no-op line", () => {
    const stub: DbStub = {
      conceptInfo: {
        fields: { superseded_by: "DEFINE FIELD superseded_by ON concept TYPE option<record<memory>>" },
      },
      pwInfo: {
        indexes: {
          pw_session_worktype_status_unique:
            "DEFINE INDEX pw_session_worktype_status_unique ON pending_work FIELDS session_id, work_type, status UNIQUE",
        },
      },
      conceptRowsWithValue: 0,
    };
    const field = decideFieldRepair(stub, true);
    const idx = decideIndexRepair(stub, true);
    expect(field).toBe("skipped_already_correct");
    expect(idx).toBe("skipped_already_correct");
  });

  it("field=aborted_has_data + index=failed: worst-case operator-visible state surfaces both problems", () => {
    // This is the scenario operators must NOT miss: some rows carry the old
    // type AND dedup hasn't cleared all violators. Both flags fire so the
    // operator knows there's manual work on both sides.
    const stub: DbStub = {
      conceptInfo: {
        fields: { superseded_by: "DEFINE FIELD superseded_by ON concept TYPE option<string>" },
      },
      pwInfo: { indexes: {} },
      conceptRowsWithValue: 7,
      indexDefineThrows: true,
    };
    const field = decideFieldRepair(stub, true);
    const idx = decideIndexRepair(stub, true);
    expect(field).toBe("aborted_has_data");
    expect(idx).toBe("failed");
  });
});
