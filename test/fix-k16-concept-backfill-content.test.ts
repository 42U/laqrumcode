/**
 * K16 regression — concept embedding backfill keyed off the dead `name` column.
 *
 * BUG (pre-fix): backfillConceptEmbeddings() in src/engine/maintenance.ts ran
 *   SELECT id, name FROM concept
 *     WHERE (embedding IS NONE OR array::len(embedding) = 0)
 *       AND name IS NOT NONE AND name != ""
 * and embedded `row.name`. But the hot-path writer (surreal.ts upsertConcept)
 * populates `content`, NOT `name` (the column was renamed content pre-0.7.x).
 * So the `name`-gated WHERE matched ~zero real rows: un-embedded content-only
 * concepts were NEVER healed — a silent backfill-coverage hole (D1 invariant).
 *
 * FIX: SELECT + embed `content` (with the legacy `name` arm kept as an OR
 * fallback / COALESCE embed target).
 *
 * Pure-static source assertions (no DB, no mock), mirroring
 * lint-backfill-coverage.test.ts. The "WHERE permits content-only rows" and
 * "embed target derives from content" checks FAIL against the pre-fix
 * name-only body.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/engine/maintenance.ts", import.meta.url), "utf8");

/** Slice out the backfillConceptEmbeddings function body. */
function conceptBackfillBody(s: string): string {
  const start = s.indexOf("async function backfillConceptEmbeddings");
  expect(start, "backfillConceptEmbeddings not found in maintenance.ts").toBeGreaterThan(-1);
  // Grab a generous window — the function is well under 4000 chars.
  return s.slice(start, start + 4000);
}

describe("K16: concept backfill keys off `content`, not the dead `name` column", () => {
  const body = conceptBackfillBody(src);

  it("SELECTs the content column", () => {
    // Must pull `content` so the embed target can come from the column the
    // writer actually populates.
    expect(body).toMatch(/SELECT[^;]*\bcontent\b[^;]*FROM\s+concept/i);
  });

  it("WHERE clause admits content-only rows (does NOT gate solely on name)", () => {
    // Pre-fix WHERE was `... AND name IS NOT NONE AND name != ""` — a content-
    // only row (name absent) failed it. The fix must reference `content` in the
    // WHERE so content-bearing rows are selected.
    const where = body.slice(body.search(/WHERE/i), body.search(/LIMIT/i));
    expect(where, "WHERE clause should reference content").toMatch(/content\s+IS\s+NOT\s+NONE|content\s*!=\s*""/i);

    // And it must NOT be gated EXCLUSIVELY on name (the dead-column bug). If the
    // only IS-NOT-NONE guard is on `name`, content-only rows are still skipped.
    const gatesOnContent = /content\s+IS\s+NOT\s+NONE/i.test(where) || /content\s*!=\s*""/i.test(where);
    expect(gatesOnContent, "backfill still gates only on the dead `name` column").toBe(true);
  });

  it("embeds a content-derived target (not name-only)", () => {
    // The embed target must derive from row.content (legacy row.name may be a
    // fallback). Pre-fix it was `let target = row.name;`.
    expect(body).toMatch(/row\.content/);
    // The embed() call exists and is fed `target`.
    expect(body).toMatch(/embed\(\s*target\s*\)/);
  });
});
