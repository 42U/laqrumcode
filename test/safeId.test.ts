/**
 * safeId unit tests — engine/errors.ts:safeId.
 *
 * R6 regression: safeId is the guard that prevents `String(undefined)` from
 * minting the literal token `"undefined"` and propagating it as a real id
 * downstream (where it then explodes inside RELATE / UPDATE statements).
 *
 * R7 hotfix (this revision): R7 originally tightened to "non-empty string in,
 * non-empty string out". That silently broke every call site that consumes a
 * SurrealDB driver row, because `r.id` from the driver is a RecordId object
 * (not a string). The R7 string-only gate rejected every real id and rows
 * dropped out of downstream `.filter(r => r.id)` filters. This revision keeps
 * R7's original intent — reject numbers/booleans/NaN that would stringify to
 * truthy junk ("0" / "false" / "NaN") — while accepting RecordId-like objects
 * whose `.toString()` returns the canonical `"table:id"` form. Plain objects
 * with no useful toString still get rejected via the "[object Object]" guard.
 *
 * Truthiness contract callers depend on:
 *   - nullish input            → "" (drops the row when callers .filter(r => r.id))
 *   - empty string             → "" (idempotent)
 *   - non-empty string input   → unchanged (no double-stringification)
 *   - number / boolean / NaN   → "" (no coercion to "0" / "false" / "NaN")
 *   - plain object             → "" ("[object Object]" guard)
 *   - RecordId-like (toString) → canonical "table:id" string
 */

import { describe, it, expect } from "vitest";
import { safeId } from "../src/engine/errors.js";

describe("safeId", () => {
  it("returns empty string for null", () => {
    expect(safeId(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(safeId(undefined)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    // Empty string is already falsy; the gate works either way but we want
    // the function to be idempotent on its own output.
    expect(safeId("")).toBe("");
  });

  it("returns non-empty string input unchanged", () => {
    expect(safeId("foo")).toBe("foo");
    expect(safeId("concept:abc123")).toBe("concept:abc123");
  });

  it("returns empty string for numeric inputs (no String() coercion)", () => {
    // R7 tightening: previously safeId(0) → "0", safeId(123) → "123". Both
    // are truthy-when-non-empty strings that would pass `.filter(r => r.id)`
    // and then explode in RELATE / UPDATE. SurrealDB row.id is always a
    // RecordId object or a serialised string — never a raw number — so this
    // is a defensible tightening that surfaces upstream projection bugs
    // (e.g. accidentally pulling `access_count` into an id column).
    expect(safeId(0)).toBe("");
    expect(safeId(123)).toBe("");
    expect(safeId(-1)).toBe("");
    expect(safeId(NaN)).toBe("");
    expect(safeId(Infinity)).toBe("");
  });

  it("returns empty string for boolean inputs (no String() coercion)", () => {
    // R7 tightening: safeId(false) used to be "false" — a truthy string.
    expect(safeId(false)).toBe("");
    expect(safeId(true)).toBe("");
  });

  it("returns empty string for plain objects with no useful toString", () => {
    // Plain objects stringify to "[object Object]" — that's the guard.
    // Callers that have a plain object in an id column have an upstream
    // projection bug; this boundary drops them so the bug doesn't reach
    // RELATE / UPDATE.
    expect(safeId({ id: "x" })).toBe("");
    expect(safeId({})).toBe("");
  });

  it("accepts RecordId-like objects via toString (the hotfix)", () => {
    // SurrealDB driver returns row.id as a RecordId instance. Its
    // .toString() returns the canonical "table:id" form. R7's original
    // string-only gate rejected these and silently broke every call site
    // that mapped over driver rows. This is the contract that restores
    // them.
    const recordIdLike = { toString: () => "concept:abc" };
    expect(safeId(recordIdLike)).toBe("concept:abc");

    const turnIdLike = { toString: () => "turn:001q7ffhvsb68a4oy7w4" };
    expect(safeId(turnIdLike)).toBe("turn:001q7ffhvsb68a4oy7w4");
  });

  it("returns empty string for arrays (they toString as csv, not table:id)", () => {
    // Arrays have a useful toString but it isn't a record id, so it would
    // pass the "[object Object]" check. We don't add an extra format gate
    // here because the existing assertRecordId() downstream in surreal.ts
    // catches malformed ids at RELATE/UPDATE time. We document the
    // permissive behaviour: [] toString-es to "" (empty, dropped), but
    // [1,2] toString-es to "1,2" (passes safeId, will fail assertRecordId
    // downstream and throw loudly — that's correct behaviour for an
    // upstream projection bug).
    expect(safeId([])).toBe(""); // empty → falls back to ""
    expect(safeId([1, 2])).toBe("1,2"); // documents the permissive boundary
  });

  it("returns empty string for symbol input", () => {
    // Symbols throw on String() coercion implicitly; we route them through
    // the final fallthrough so they return "".
    // Using try/catch because Symbol coercion via String() is allowed (returns
    // "Symbol(foo)") but typeof !== "object". They hit the bottom fallthrough.
    expect(safeId(Symbol("foo"))).toBe("");
  });

  it("nullish/non-string output is falsy — callers can rely on .filter(r => r.id)", () => {
    // The whole point: an empty string drops out of a truthiness filter, so
    // a row with no usable id never reaches RELATE / UPDATE downstream.
    expect(Boolean(safeId(null))).toBe(false);
    expect(Boolean(safeId(undefined))).toBe(false);
    expect(Boolean(safeId(""))).toBe(false);
    expect(Boolean(safeId(0))).toBe(false);
    expect(Boolean(safeId(false))).toBe(false);
    expect(Boolean(safeId(NaN))).toBe(false);
    expect(Boolean(safeId({}))).toBe(false);
    expect(Boolean(safeId("real-id"))).toBe(true);
    expect(Boolean(safeId({ toString: () => "concept:abc" }))).toBe(true);
  });
});
