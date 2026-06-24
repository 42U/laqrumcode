/**
 * K28 regression — detectAnomalies must compute the soul-graduation context
 * (hasSoul + checkGraduation, ~13 GROUP-ALL aggregations) ONCE per batch and
 * share it across BOTH graduation detectors, instead of each detector
 * recomputing it (the old code ran it ~2x on every UserPromptSubmit).
 *
 * Strategy: count the marker queries that hasSoul() and checkGraduation()
 * issue (`FROM soul:laqrumbrain`, `FROM session GROUP ALL`). With the fix each
 * fires exactly once per detectAnomalies() call. Before the fix they fired
 * twice (once per graduation detector). This is a pure mock test — it would
 * FAIL against the pre-fix code where the two detectors each imported soul.js
 * and called hasSoul/checkGraduation themselves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectAnomalies, makeCooldownState, resetAnomalyCache } from "../src/engine/observability.js";

function countingStore() {
  const calls: Record<string, number> = {};
  const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  return {
    calls,
    isAvailable: () => true,
    queryExec: vi.fn(async () => {}),
    queryMulti: vi.fn(async () => undefined),
    queryFirst: vi.fn(async (sql: string) => {
      // hasSoul()
      if (sql.includes("FROM soul:laqrumbrain")) { bump("hasSoul"); return []; }
      // checkGraduation() volume signal — one representative marker query.
      if (sql.includes("FROM session GROUP ALL")) { bump("checkGraduation"); return [{ count: 0 }]; }
      // Everything else (other signal queries, anomaly detectors) returns empty.
      return [];
    }),
  };
}

describe("K28: graduation context computed once per detectAnomalies batch", () => {
  beforeEach(() => resetAnomalyCache());

  it("calls hasSoul and checkGraduation exactly once (not once per detector)", async () => {
    const store = countingStore();
    await detectAnomalies(store as any, makeCooldownState());
    expect(store.calls.hasSoul).toBe(1);
    expect(store.calls.checkGraduation).toBe(1);
  });

  it("dedupes concurrent callers onto a single in-flight computation", async () => {
    const store = countingStore();
    const cooldown = makeCooldownState();
    // Fire several concurrent calls in the same tick. The in-flight Promise
    // mutex must collapse them to ONE computation, so the marker queries still
    // fire exactly once total across all 5 callers.
    await Promise.all([
      detectAnomalies(store as any, cooldown),
      detectAnomalies(store as any, cooldown),
      detectAnomalies(store as any, cooldown),
      detectAnomalies(store as any, cooldown),
      detectAnomalies(store as any, cooldown),
    ]);
    expect(store.calls.hasSoul).toBe(1);
    expect(store.calls.checkGraduation).toBe(1);
  });
});
