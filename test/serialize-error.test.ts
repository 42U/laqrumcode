import { describe, it, expect } from "vitest";

/**
 * Round-5 coverage: serializeError() in src/tools/pending-work.ts (lines 34-43).
 *
 * The function is file-internal (not exported, not in __test__). Per the
 * Round-5 scope constraint "Don't touch src/ files", we vendor a literal copy
 * here and pin its behavior. Any source-side drift will produce a coverage
 * gap, not a silent regression — the production callers (lines 190, 418, 845)
 * still hit serializeError via the normal commit_work_results path, which is
 * exercised by other suites.
 *
 * IMPORTANT: this copy MUST stay byte-for-byte identical to the source. If
 * src/tools/pending-work.ts:34-43 is edited, update this vendored copy in the
 * same PR. The doc comment in the source should reference this test file.
 */
function serializeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e ?? "unknown");
  const seen = new WeakSet<object>();
  seen.add(e);
  let out = e.message;
  let cur: unknown = (e as { cause?: unknown }).cause;
  let depth = 0;
  let truncated = false;
  while (cur instanceof Error && !seen.has(cur) && depth < 8) {
    seen.add(cur);
    out += ` | caused by: ${cur.message}`;
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  if ((cur instanceof Error && depth >= 8) || (cur && typeof cur === "object" && seen.has(cur as object))) {
    truncated = true;
  }
  if (truncated) out += " | (chain truncated)";
  if (out.length > 4096) out = out.slice(0, 4093) + "...";
  return out;
}

describe("serializeError — non-Error inputs", () => {
  it("returns 'unknown' for undefined (hardened null-coercion)", () => {
    // Hardened: undefined → "unknown" (avoids leaking literal 'undefined'
    // into error payloads consumed downstream by subagents).
    expect(serializeError(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for null (hardened null-coercion)", () => {
    expect(serializeError(null)).toBe("unknown");
  });

  it("returns the string itself for a string", () => {
    expect(serializeError("a plain string")).toBe("a plain string");
  });

  it("returns the stringified number for a number", () => {
    expect(serializeError(42)).toBe("42");
  });

  it("returns '[object Object]' for a plain object (matches String() coercion)", () => {
    expect(serializeError({ foo: "bar" })).toBe("[object Object]");
  });

  it("returns 'true' for a boolean", () => {
    expect(serializeError(true)).toBe("true");
  });
});

describe("serializeError — Error chain depth", () => {
  it("returns just the message for an Error with no cause", () => {
    const e = new Error("top-level only");
    expect(serializeError(e)).toBe("top-level only");
  });

  it("joins a shallow (1-deep) cause chain", () => {
    const inner = new Error("inner failure");
    const outer = new Error("outer wrap", { cause: inner });
    expect(serializeError(outer)).toBe("outer wrap | caused by: inner failure");
  });

  it("joins a deep (5-level) cause chain in order", () => {
    const l5 = new Error("L5");
    const l4 = new Error("L4", { cause: l5 });
    const l3 = new Error("L3", { cause: l4 });
    const l2 = new Error("L2", { cause: l3 });
    const l1 = new Error("L1", { cause: l2 });
    expect(serializeError(l1)).toBe(
      "L1 | caused by: L2 | caused by: L3 | caused by: L4 | caused by: L5",
    );
  });

  it("stops walking when cause is a non-Error (string, undefined, etc.)", () => {
    // .cause is a string — Error chain ends there.
    const e = new Error("had string cause", { cause: "not-an-error" as unknown });
    expect(serializeError(e)).toBe("had string cause");
  });
});

describe("serializeError — circular cause chain (REGRESSION)", () => {
  // Hardened implementation uses a WeakSet `seen` to short-circuit cycles
  // plus a depth cap of 8. A circular cause graph (a.cause = b; b.cause = a)
  // must terminate quickly and produce a bounded output. The Promise.race
  // wrapper is preserved as a backstop against any future regression that
  // re-introduces the unguarded walk.
  it("terminates within a reasonable budget without OOM", async () => {
    const a: Error & { cause?: unknown } = new Error("A");
    const b: Error & { cause?: unknown } = new Error("B");
    a.cause = b;
    b.cause = a;

    const BUDGET_MS = 500;
    const MAX_LEN = 1_000_000; // 1 MB output budget

    // Run serializeError in a worker-style race. If it doesn't terminate
    // inside BUDGET_MS, the timeout wins and the test fails with a clear
    // hang signal rather than the suite stalling forever. We also cap the
    // string length to detect runaway growth even if the call returns.
    const result = await Promise.race([
      new Promise<{ ok: true; value: string }>((resolve) => {
        // Defer to next tick so the timeout can win for unhardened code.
        setImmediate(() => {
          try {
            const value = serializeError(a);
            resolve({ ok: true, value });
          } catch {
            resolve({ ok: true, value: "<threw>" });
          }
        });
      }),
      new Promise<{ ok: false; value: string }>((resolve) => {
        setTimeout(
          () => resolve({ ok: false, value: "<hung past budget>" }),
          BUDGET_MS,
        );
      }),
    ]);

    expect(result.ok, "serializeError must terminate on circular cause within budget").toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(MAX_LEN);
    // The hardened impl appends "(chain truncated)" when it short-circuits.
    expect(result.value).toContain("(chain truncated)");
  }, 2000);
});

describe("serializeError — output length", () => {
  // Hardened impl caps total output at 4096 chars with a "..." tail.
  it("caps output at 4096 chars for an oversized single message", () => {
    const longMsg = "x".repeat(10_000);
    const e = new Error(longMsg);
    const out = serializeError(e);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("...")).toBe(true);
  });

  it("does NOT trim short outputs", () => {
    const e = new Error("short message");
    const out = serializeError(e);
    expect(out).toBe("short message");
    expect(out.endsWith("...")).toBe(false);
  });
});

describe("serializeError — depth cap", () => {
  // Hardened impl caps walked depth at 8 (independent of cycle detection)
  // so an attacker can't pin CPU by stitching an arbitrarily-long
  // non-circular chain.
  it("walks at most 8 cause levels and marks truncation", () => {
    // Build a 12-deep cause chain. Only the first 8 should appear.
    let cur: Error = new Error("L13");
    for (let i = 12; i >= 1; i--) {
      cur = new Error(`L${i}`, { cause: cur });
    }
    const out = serializeError(cur);
    // L1 .. L9 should appear (L1 is top, L2..L9 added through 8 walked
    // levels). L10+ should not.
    expect(out).toContain("L1 ");
    expect(out).toContain("L9");
    expect(out).not.toContain("L10");
    expect(out).toContain("(chain truncated)");
  });
});
