/**
 * Pure unit tests for resolveTransformTimeoutMs (graphTransformContext
 * deadline, 2026-06-09 fix). The previous hard-coded 15s deadline — tuned for
 * GPU-era embed+rerank latency — tripped constantly after the daemon moved to
 * CPU-only mode, degrading every affected prompt to raw-message passthrough.
 * No DB — CI-safe. Passes a fake env; never touches process.env.
 */
import { describe, it, expect } from "vitest";
import { resolveTransformTimeoutMs } from "../src/engine/graph-context.js";

describe("resolveTransformTimeoutMs", () => {
  it("defaults to 15s on GPU (no env)", () => {
    expect(resolveTransformTimeoutMs({})).toBe(15_000);
  });

  it("scales to 45s in CPU mode (LAQRUMCODE_NO_GPU=1, set by gpu-pin)", () => {
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_NO_GPU: "1" })).toBe(45_000);
  });

  it("explicit override wins — including over CPU mode", () => {
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_TRANSFORM_TIMEOUT_MS: "20000" })).toBe(20_000);
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_TRANSFORM_TIMEOUT_MS: "20000", LAQRUMCODE_NO_GPU: "1" })).toBe(20_000);
  });

  it("floors fractional overrides", () => {
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_TRANSFORM_TIMEOUT_MS: "12345.7" })).toBe(12_345);
  });

  it("rejects zero/negative/garbage overrides and falls through to defaults", () => {
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_TRANSFORM_TIMEOUT_MS: "0" })).toBe(15_000);
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_TRANSFORM_TIMEOUT_MS: "-5" })).toBe(15_000);
    expect(resolveTransformTimeoutMs({ LAQRUMCODE_TRANSFORM_TIMEOUT_MS: "abc", LAQRUMCODE_NO_GPU: "1" })).toBe(45_000);
  });
});
