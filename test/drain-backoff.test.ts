/**
 * Pure unit tests for the auto-drain failure backoff (2026-06-09 spawn-storm
 * fix). No DB, no spawns — CI-safe anywhere.
 *
 * Context: with every extractor instantly failing (weekly API limit), the
 * scheduler burned exactly 50 spawns/day (the full budget) in ~20 minutes
 * after UTC midnight, five days running. These helpers gate respawning.
 */
import { describe, it, expect } from "vitest";
import {
  computeDrainCooldown,
  classifyDrainOutcome,
  DRAIN_FAST_FAIL_MS,
  DRAIN_FAILURE_COOLDOWN_THRESHOLD,
  DRAIN_COOLDOWN_BASE_MS,
  DRAIN_COOLDOWN_MAX_MS,
} from "../src/daemon/auto-drain.js";

describe("computeDrainCooldown", () => {
  it("no cooldown below the threshold", () => {
    for (let n = 0; n < DRAIN_FAILURE_COOLDOWN_THRESHOLD; n++) {
      expect(computeDrainCooldown(n)).toBe(0);
    }
  });

  it("starts at the base cooldown when the threshold is hit", () => {
    expect(computeDrainCooldown(DRAIN_FAILURE_COOLDOWN_THRESHOLD)).toBe(DRAIN_COOLDOWN_BASE_MS);
  });

  it("doubles per additional failure", () => {
    expect(computeDrainCooldown(DRAIN_FAILURE_COOLDOWN_THRESHOLD + 1)).toBe(DRAIN_COOLDOWN_BASE_MS * 2);
    expect(computeDrainCooldown(DRAIN_FAILURE_COOLDOWN_THRESHOLD + 2)).toBe(DRAIN_COOLDOWN_BASE_MS * 4);
  });

  it("caps at the max cooldown", () => {
    expect(computeDrainCooldown(DRAIN_FAILURE_COOLDOWN_THRESHOLD + 10)).toBe(DRAIN_COOLDOWN_MAX_MS);
    expect(computeDrainCooldown(100)).toBe(DRAIN_COOLDOWN_MAX_MS);
  });
});

describe("classifyDrainOutcome", () => {
  it("queue progress is success regardless of runtime", () => {
    expect(classifyDrainOutcome(50, 5, 4)).toBe("progress");
    expect(classifyDrainOutcome(DRAIN_FAST_FAIL_MS * 10, 5, 1)).toBe("progress");
  });

  it("fast exit with no progress is a fast-failure (the storm signature)", () => {
    expect(classifyDrainOutcome(2_000, 5, 5)).toBe("fast-failure");
    expect(classifyDrainOutcome(DRAIN_FAST_FAIL_MS - 1, 5, 5)).toBe("fast-failure");
  });

  it("queue GROWTH during a fast run still counts as failure (storm enqueued its own items)", () => {
    expect(classifyDrainOutcome(2_000, 5, 7)).toBe("fast-failure");
  });

  it("long run with no progress is neutral — slow legitimate work never accrues cooldown", () => {
    expect(classifyDrainOutcome(DRAIN_FAST_FAIL_MS, 5, 5)).toBe("neutral");
    expect(classifyDrainOutcome(DRAIN_FAST_FAIL_MS * 3, 5, 6)).toBe("neutral");
  });
});
