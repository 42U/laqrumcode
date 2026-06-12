/**
 * 0.7.118: unit tests for the drain junk guard (QA items D1/D2/D3).
 * Production incident 2026-06-10: drain agents given empty-transcript work
 * items committed apology prose + bare session UUIDs as knowledge.
 */
import { describe, it, expect } from "vitest";
import { isJunkExtractionText } from "../src/tools/pending-work.js";
import { extractConceptNames } from "../src/engine/concept-extract.js";

describe("isJunkExtractionText", () => {
  it("rejects the production-observed junk shapes", () => {
    expect(isJunkExtractionText("c6a29b76-59bc-4df5-a09b-8f02c73fa2f1")).toBe(true);
    expect(isJunkExtractionText("This work item contained an empty transcript (turn_count 0, only the ACTIVE RULES block)")).toBe(true);
    // D1: free LLM phrasing variants from the live May-2026 corpus
    expect(isJunkExtractionText("Empty transcript (turn_count=0) for session X. Nothing to extract.")).toBe(true);
    expect(isJunkExtractionText("Nothing to extract — the transcript was empty.")).toBe(true);
    expect(isJunkExtractionText("short")).toBe(true); // <8 chars
  });

  it("rejects the index-bug junk phrasing families (0.7.120, live corpus: 48 rows)", () => {
    expect(isJunkExtractionText("No transcript data available to reflect on for this work item.")).toBe(true);
    expect(isJunkExtractionText("No transcript provided; nothing to reflect on.")).toBe(true);
    expect(isJunkExtractionText("No session content was available to reflect on for this item.")).toBe(true);
    expect(isJunkExtractionText("No session data available to reflect on for this stuck record.")).toBe(true);
    expect(isJunkExtractionText("No data available to reflect on; item was stuck in processing state.")).toBe(true);
    expect(isJunkExtractionText("No session transcript was attached to this deferred-cleanup work item.")).toBe(true);
  });

  it("accepts legitimate knowledge — including gems ABOUT this bug", () => {
    expect(isJunkExtractionText("SurrealDB DEFINE INDEX IF NOT EXISTS no-ops on existing ready indexes")).toBe(false);
    // The junk phrases only count in the HEAD of the text; a real gem can
    // mention "empty transcript" mid-body.
    expect(
      isJunkExtractionText(
        "The drain pipeline used to commit junk rows when a work item had an empty transcript; 0.7.118 guards the commit path.",
      ),
    ).toBe(false);
    expect(isJunkExtractionText(42)).toBe(false); // non-strings pass through to schema validation
  });
});

describe("extractConceptNames UUID rejection (D3 — the actual junk source)", () => {
  it("never emits a bare UUID as a concept name", () => {
    const names = extractConceptNames(
      "session c6a29b76-59bc-4df5-a09b-8f02c73fa2f1 used hedge-lock and smart_mm_bot during the run",
      10,
    );
    expect(names).not.toContain("c6a29b76-59bc-4df5-a09b-8f02c73fa2f1");
    expect(names).toContain("hedge-lock");
    expect(names).toContain("smart_mm_bot");
  });
});
