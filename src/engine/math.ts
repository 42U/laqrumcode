/**
 * Tiny numerical helpers shared across the engine.
 *
 * Kept deliberately minimal — anything more interesting belongs in the
 * specific module that owns the math. This file exists so the inlined
 * `Math.max(lo, Math.min(hi, n))` pattern stops getting copy-pasted into
 * every new caller that needs to bound a confidence/score/ratio.
 */

/** Clamp a number into the inclusive range [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Clamp a number into the unit interval [0, 1] — the common case. */
export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}
