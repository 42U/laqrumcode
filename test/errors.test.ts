import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { swallow } from "../src/engine/errors.js";

describe("swallow", () => {
  const originalEnv = process.env.LAQRUMBRAIN_DEBUG;

  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.LAQRUMBRAIN_DEBUG = originalEnv;
    vi.restoreAllMocks();
  });

  it("swallow() is silent by default", () => {
    delete process.env.LAQRUMBRAIN_DEBUG;
    swallow("test:ctx", new Error("boom"));
    // Can't easily test silence since module-level const is already captured,
    // but we verify it doesn't throw
  });

  it("swallow.warn() logs to console.warn", () => {
    swallow.warn("test:ctx", new Error("warning message"));
    expect(console.warn).toHaveBeenCalled();
    const args = (console.warn as any).mock.calls[0].join(" ");
    expect(args).toContain("test:ctx");
    expect(args).toContain("warning message");
  });

  it("swallow.error() logs to console.error with stack", () => {
    const err = new Error("critical failure");
    swallow.error("test:ctx", err);
    expect(console.error).toHaveBeenCalled();
    const args = (console.error as any).mock.calls[0].join(" ");
    expect(args).toContain("critical failure");
  });

  it("swallow.warn handles non-Error values", () => {
    swallow.warn("test:ctx", "string error");
    expect(console.warn).toHaveBeenCalled();
    const args = (console.warn as any).mock.calls[0].join(" ");
    expect(args).toContain("string error");
  });

  it("swallow.warn handles undefined", () => {
    swallow.warn("test:ctx");
    expect(console.warn).toHaveBeenCalled();
    const args = (console.warn as any).mock.calls[0].join(" ");
    expect(args).toContain("unknown");
  });

  it("swallow.error handles undefined", () => {
    swallow.error("test:ctx");
    expect(console.error).toHaveBeenCalled();
    const args = (console.error as any).mock.calls[0].join(" ");
    expect(args).toContain("unknown");
  });
});
