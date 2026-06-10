/**
 * 0.7.118: unit tests for the zombie-WS hardening primitives in
 * src/engine/surreal.ts — raceWithDeadline (per-query deadline) and
 * isRetryableSurrealError (the widened retry classification).
 *
 * Production incident (2026-06-10): the SDK's WebSocket entered a state where
 * query() promises never settled and isConnected stayed true — meta.health
 * answered in 2ms while rpcsInFlight grew unboundedly and every DB-touching
 * tool hung. These primitives convert that hang into a typed, retryable error.
 */
import { describe, it, expect } from "vitest";
import { raceWithDeadline, isRetryableSurrealError, QUERY_DEADLINE_MS } from "../src/engine/surreal.js";

describe("raceWithDeadline", () => {
  it("resolves with the value when the promise wins", async () => {
    await expect(raceWithDeadline(Promise.resolve(42), 1_000, "test")).resolves.toBe(42);
  });

  it("rejects with a deadline error when the promise never settles (the zombie shape)", async () => {
    const never = new Promise<never>(() => { /* zombie: no settle, no error event */ });
    await expect(raceWithDeadline(never, 30, "SurrealDB query")).rejects.toThrow(
      "SurrealDB query deadline exceeded after 30ms",
    );
  });

  it("propagates the underlying rejection unchanged when it loses to no one", async () => {
    const boom = new Error("Anonymous access not allowed");
    await expect(raceWithDeadline(Promise.reject(boom), 1_000, "test")).rejects.toBe(boom);
  });

  it("a late settle after the deadline does not unhandled-reject", async () => {
    let settle!: (v: string) => void;
    const slow = new Promise<string>((res) => { settle = res; });
    await expect(raceWithDeadline(slow, 20, "test")).rejects.toThrow("deadline exceeded");
    settle("late"); // must be silently consumed
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("isRetryableSurrealError", () => {
  it("matches the three production-observed retryable classes", () => {
    // connection drop
    expect(isRetryableSurrealError(new Error("There was a problem with the database: The connection must be connected"))).toBe(true);
    expect(isRetryableSurrealError(new Error("ConnectionUnavailable"))).toBe(true);
    // blown deadline (zombie)
    expect(isRetryableSurrealError(new Error("SurrealDB query deadline exceeded after 60000ms"))).toBe(true);
    // auth drop after WS auto-reconnect (the dedup-edges 240k-deletes incident)
    expect(isRetryableSurrealError(new Error("Anonymous access not allowed: Not enough permissions to perform this action"))).toBe(true);
    expect(isRetryableSurrealError(new Error("IAM error: Not enough permissions"))).toBe(true);
  });

  it("does not retry ordinary query errors", () => {
    expect(isRetryableSurrealError(new Error("Parse error: Unexpected token"))).toBe(false);
    expect(isRetryableSurrealError(new Error("Database index `x` already contains [a, b]"))).toBe(false);
    expect(isRetryableSurrealError(new Error("Expected `array<number>` but found `0f`"))).toBe(false);
    expect(isRetryableSurrealError(null)).toBe(false);
  });
});

describe("QUERY_DEADLINE_MS", () => {
  it("defaults generous (only zombies blow it, not slow CPU-tier queries)", () => {
    // Env-clamped [1s, 10min]; default 60s when KONGCODE_DB_QUERY_TIMEOUT_MS unset.
    expect(QUERY_DEADLINE_MS).toBeGreaterThanOrEqual(1_000);
    expect(QUERY_DEADLINE_MS).toBeLessThanOrEqual(600_000);
  });
});
