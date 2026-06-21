/**
 * Guard for the schema-narrower-than-code "polymorphic record field" class.
 *
 * This class bit THREE times: K0 (pending_work.status enum), then
 * memory_utility_cache.memory_id (typed record<memory>|record<concept>|record<turn>
 * but retrieval-quality writes artifact:/skill: ids too), then concept.superseded_by
 * (typed record<memory> but extraction supersedes concepts WITH concept ids). Each
 * was a swallowed runtime coercion error invisible to the (mocked / itDb-skipped)
 * suite — only surfaced by running the live daemon against a populated DB.
 *
 * A field that stores "an id of an arbitrary retrieved/related record" MUST be the
 * open `record` type, not a narrow per-table union, or a write of an out-of-union
 * table silently fails. These are the known polymorphic fields; they must stay open.
 * (The 3 superseded_by SELF-references — memory/skill/reflection — are intentionally
 * tight: verified only ever written with their own table's id.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");

/** Extract the TYPE clause of a `DEFINE FIELD <field> ON <table>` declaration. */
function fieldType(field: string, table: string): string | null {
  const re = new RegExp(
    `DEFINE FIELD[^\\n]*\\b${field}\\b\\s+ON\\s+${table}\\s+TYPE\\s+([^;]+);`,
  );
  const m = schema.match(re);
  return m ? m[1].trim() : null;
}

describe("schema polymorphic record fields stay OPEN (no narrow per-table union)", () => {
  // memory_id caches utility for ANY scored record (memory/concept/turn/artifact/skill).
  it("memory_utility_cache.memory_id is option<record> (any), not a per-table union", () => {
    const t = fieldType("memory_id", "memory_utility_cache");
    expect(t, "memory_id field not found").toBeTruthy();
    expect(t).toMatch(/option<record>/);
    expect(t).not.toMatch(/record<[a-z_]+>/i); // no narrow per-table record type
  });

  // A concept is superseded by a correction memory OR a newer concept.
  it("concept.superseded_by is option<record> (any), not record<memory>", () => {
    const t = fieldType("superseded_by", "concept");
    expect(t, "concept.superseded_by not found").toBeTruthy();
    expect(t).toMatch(/option<record>/);
    expect(t).not.toMatch(/record<[a-z_]+>/i);
  });

  // Self-referential supersessions are intentionally tight (verified self-type-only).
  it("self-referential superseded_by fields remain table-typed (intentional)", () => {
    expect(fieldType("superseded_by", "memory")).toMatch(/record<memory>/);
    expect(fieldType("superseded_by", "skill")).toMatch(/record<skill>/);
    expect(fieldType("superseded_by", "reflection")).toMatch(/record<reflection>/);
  });
});
