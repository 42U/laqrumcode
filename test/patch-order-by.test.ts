/**
 * T5 (2026-06-10): unit tests for patchOrderByFields — the SurrealDB 3.x
 * ORDER-BY-must-be-selected auto-patcher in src/engine/surreal.ts.
 *
 * The original was alias-blind (SELECT count() AS c … ORDER BY c appended a
 * phantom raw `c` column) and paren-blind (naive split(",") sheared function
 * arguments into garbage fields). These tests pin the hardened behavior.
 */
import { describe, it, expect } from "vitest";
import { patchOrderByFields } from "../src/engine/surreal.js";

describe("patchOrderByFields", () => {
  it("appends a genuinely missing plain field", () => {
    expect(patchOrderByFields("SELECT a FROM t ORDER BY b")).toBe(
      "SELECT a, b FROM t ORDER BY b",
    );
  });

  it("strips ASC/DESC before checking and still appends", () => {
    expect(patchOrderByFields("SELECT a FROM t ORDER BY b DESC LIMIT 3")).toBe(
      "SELECT a, b FROM t ORDER BY b DESC LIMIT 3",
    );
  });

  it("recognizes an output alias — no phantom column (the alias-blind bug)", () => {
    const sql = "SELECT count() AS c FROM t GROUP ALL ORDER BY c DESC";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("does not shear commas inside function args (the paren-blind bug)", () => {
    const sql = "SELECT math::max([a, b]) AS m FROM t ORDER BY m";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("leaves non-identifier ORDER terms alone instead of appending fake columns", () => {
    const sql = "SELECT a FROM t ORDER BY rand()";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("matches dotted paths by last segment (prior behavior preserved)", () => {
    const sql = "SELECT meta.x FROM t ORDER BY x";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("handles mixed present/missing with dedup", () => {
    expect(
      patchOrderByFields("SELECT a FROM t ORDER BY a, b, b DESC LIMIT 1"),
    ).toBe("SELECT a, b FROM t ORDER BY a, b, b DESC LIMIT 1");
  });

  it("passes through SELECT *", () => {
    const sql = "SELECT * FROM t ORDER BY anything";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("passes through non-SELECT statements", () => {
    const sql = "UPDATE t SET a = 1";
    expect(patchOrderByFields(sql)).toBe(sql);
    const ddl = "DEFINE INDEX IF NOT EXISTS i ON t FIELDS in, out UNIQUE";
    expect(patchOrderByFields(ddl)).toBe(ddl);
  });

  it("passes through SELECT without ORDER BY", () => {
    const sql = "SELECT a, b FROM t LIMIT 5";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("handles alias + expression both being referenced", () => {
    const sql =
      "SELECT vector::similarity::cosine(embedding, $vec) AS score, id FROM concept ORDER BY score DESC LIMIT 10";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("appends ORDER BY field missing from a multi-field selection with AS aliases", () => {
    expect(
      patchOrderByFields("SELECT id, count() AS c FROM t GROUP BY id ORDER BY created_at"),
    ).toBe("SELECT id, count() AS c, created_at FROM t GROUP BY id ORDER BY created_at");
  });

  // 0.7.118: the patcher became subquery-aware (paren masking) — the former
  // "pinned blind spot" test is deleted-and-celebrated per its own comment.
  it("leaves an ORDER BY inside a parenthesized subquery untouched", () => {
    const sql =
      "SELECT math::mean(utilization) AS avg FROM (SELECT utilization, created_at FROM retrieval_outcome WHERE session_id = $sid ORDER BY created_at DESC LIMIT $lim) GROUP ALL";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("still patches an OUTER ORDER BY when a subquery has its own inner one", () => {
    expect(
      patchOrderByFields(
        "SELECT a FROM (SELECT a, b FROM t ORDER BY b DESC LIMIT 5) ORDER BY created_at",
      ),
    ).toBe(
      "SELECT a, created_at FROM (SELECT a, b FROM t ORDER BY b DESC LIMIT 5) ORDER BY created_at",
    );
  });

  it("does not stop the SELECT clause at a projection-subquery's FROM", () => {
    const sql = "SELECT (SELECT VALUE x FROM other LIMIT 1) AS sub, c FROM t ORDER BY c";
    expect(patchOrderByFields(sql)).toBe(sql);
  });

  it("inner LIMIT does not terminate the outer ORDER clause scan", () => {
    // The lookahead used to stop at the first LIMIT even inside parens.
    expect(
      patchOrderByFields("SELECT a FROM (SELECT a FROM t LIMIT 3) ORDER BY b"),
    ).toBe("SELECT a, b FROM (SELECT a FROM t LIMIT 3) ORDER BY b");
  });
});
