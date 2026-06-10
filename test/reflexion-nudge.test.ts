import { describe, it, expect, vi } from "vitest";
import { getLastTurnGroundingTrace } from "../src/engine/retrieval-quality.js";

/** Regression for v0.7.31 Reflexion-style grounding nudge.
 *
 * Phase 2 (v0.7.27) wired the [#N] citation parser and the
 * `getLastTurnGroundingTrace` helper but never called the helper.
 * Phase 4 (v0.7.31) calls it from graph-context.ts before the BEHAVIORAL
 * DIRECTIVES section and emits a one-line nudge when the prior turn
 * injected ≥3 high-salience items and the model cited 0 of them.
 *
 * These tests pin the trace contract (what shapes signal "fire" vs
 * "skip"). The full graph-context.ts integration is mocked via the
 * trace shape; the rendering condition is a pure function of trace +
 * cooldown state. */
describe("getLastTurnGroundingTrace — Reflexion nudge contract", () => {
  function setup(rows: { memory_id: string; retrieval_score: number; cited: boolean }[]) {
    // W2-19 (2026-06-10): getLastTurnGroundingTrace is now two queries —
    // (1) latest turn_id for the session, (2) that turn's outcome rows. The
    // old single query was triple-dead (missing VALUE, MAX() not a fn,
    // patcher corruption), so these contract tests only ever passed against
    // a mock; they now mirror the real, working call sequence.
    const queryFirst = vi.fn()
      .mockResolvedValueOnce(rows.length > 0 ? [{ turn_id: "turn:t1" }] : [])
      .mockResolvedValueOnce(rows);
    return { queryFirst: { queryFirst } as any, rows };
  }

  it("returns trace shape with injected, cited, ignored_high_salience", async () => {
    const { queryFirst } = setup([
      { memory_id: "concept:a", retrieval_score: 0.9, cited: false },
      { memory_id: "concept:b", retrieval_score: 0.8, cited: false },
      { memory_id: "concept:c", retrieval_score: 0.7, cited: false },
      { memory_id: "concept:d", retrieval_score: 0.5, cited: false },
    ]);
    const trace = await getLastTurnGroundingTrace("session:s1", queryFirst);
    expect(trace).toEqual({
      injected: 4,
      cited: 0,
      ignored_high_salience: ["concept:a", "concept:b", "concept:c"],
    });
  });

  it("ignored_high_salience excludes items below 0.6", async () => {
    const { queryFirst } = setup([
      { memory_id: "concept:a", retrieval_score: 0.9, cited: false },
      { memory_id: "concept:b", retrieval_score: 0.55, cited: false }, // below threshold
      { memory_id: "concept:c", retrieval_score: 0.4, cited: false },  // below threshold
    ]);
    const trace = await getLastTurnGroundingTrace("session:s1", queryFirst);
    expect(trace?.ignored_high_salience).toEqual(["concept:a"]);
  });

  it("counts cited correctly and excludes cited from ignored", async () => {
    const { queryFirst } = setup([
      { memory_id: "concept:a", retrieval_score: 0.9, cited: true },
      { memory_id: "concept:b", retrieval_score: 0.8, cited: false },
      { memory_id: "concept:c", retrieval_score: 0.7, cited: true },
    ]);
    const trace = await getLastTurnGroundingTrace("session:s1", queryFirst);
    expect(trace?.cited).toBe(2);
    expect(trace?.ignored_high_salience).toEqual(["concept:b"]);
  });

  it("returns null when no rows exist for the session", async () => {
    const { queryFirst } = setup([]);
    const trace = await getLastTurnGroundingTrace("session:s1", queryFirst);
    expect(trace).toBeNull();
  });
});

/** Pure helper that mirrors the firing logic in graph-context.ts.
 *  Pinning it as a test makes the cooldown + threshold gates regression-
 *  testable without spinning up the full context-injection pipeline. */
function shouldFireNudge(
  trace: { injected: number; cited: number; ignored_high_salience: string[] } | null,
  currentTurn: number,
  lastFireTurn: number,
): boolean {
  if (!trace) return false;
  if (trace.injected < 3) return false;
  if (trace.cited > 0) return false;
  if (trace.ignored_high_salience.length < 3) return false;
  if (currentTurn <= lastFireTurn + 1) return false;
  return true;
}

describe("Reflexion nudge fire conditions (mirrors graph-context.ts gate)", () => {
  it("fires when ≥3 high-salience items ignored and cooldown elapsed", () => {
    const trace = { injected: 4, cited: 0, ignored_high_salience: ["a", "b", "c", "d"] };
    expect(shouldFireNudge(trace, 5, -1)).toBe(true);
    expect(shouldFireNudge(trace, 5, 3)).toBe(true);
  });

  it("does NOT fire when at least 1 item was cited (engagement signal)", () => {
    const trace = { injected: 4, cited: 1, ignored_high_salience: ["a", "b", "c"] };
    expect(shouldFireNudge(trace, 5, -1)).toBe(false);
  });

  it("does NOT fire below volume threshold (<3 high-salience ignored)", () => {
    const trace = { injected: 5, cited: 0, ignored_high_salience: ["a", "b"] };
    expect(shouldFireNudge(trace, 5, -1)).toBe(false);
  });

  it("does NOT fire on cooldown (fired previous turn)", () => {
    const trace = { injected: 4, cited: 0, ignored_high_salience: ["a", "b", "c"] };
    expect(shouldFireNudge(trace, 5, 4)).toBe(false); // last fire was turn 4, current is 5
    expect(shouldFireNudge(trace, 5, 5)).toBe(false); // same turn
  });

  it("does NOT fire on null trace (no prior retrieval)", () => {
    expect(shouldFireNudge(null, 5, -1)).toBe(false);
  });
});
