/**
 * Canonical edge vocabulary for the kongcode graph.
 *
 * Ad-hoc edge names fragment the graph — two concepts linked by
 * `applies_to_options` and `appliesToOptions` and `options_application`
 * can't easily be found together. This file defines the authoritative set
 * with stable names and brief semantics.
 *
 * Adding a new edge: extend the appropriate category, document the
 * semantics in one line, and update the SKILL.md vocabulary sections.
 * Prefer reusing an existing edge over inventing a new one.
 *
 * Not yet wired into relate() as a hard reject — for now this file is a
 * reference used by skills and documentation. A future phase should add
 * warn-on-unknown in relate() so drift is visible without being disruptive.
 */

export const CANONICAL_EDGES = {
  // ── Structural ─────────────────────────────────────────────────────────
  decomposes_into:  "a whole splits into parts (e.g. total effect → direct + mediated channels)",
  elaborates:       "one concept adds detail to another",
  contextualizes:   "one concept frames another",
  enables:          "a method/tool makes another possible",
  extends:          "builds on a prior concept while preserving its claims",

  // ── Mechanism ──────────────────────────────────────────────────────────
  mechanism_for:        "A is the mechanism through which B happens",
  explained_by:         "A holds because of B",
  prerequisite_for:     "A must be true for B to hold",
  identification_for:   "A is the identification strategy enabling B's causal claim",
  supported_by:         "A is supported by evidence B",
  necessitates:         "A forces B as a consequence",

  // ── Tension ────────────────────────────────────────────────────────────
  contrasts_with:   "A and B are in direct opposition",
  tempered_by:      "A's effect is moderated by B",
  fails_when:       "A stops working when B occurs",
  complemented_by:  "A works alongside B (both needed)",
  corrects:         "A replaces an incorrect claim in B",

  // ── Implication ────────────────────────────────────────────────────────
  implies:              "A implies B as a logical consequence",
  amplifies:            "A strengthens B's effect",
  applies_to_options:   "A has implications for options pricing/trading",
  applies_to_equities:  "A has implications for equity trading",
  applies_to_code:      "A has implications for source code in this project",

  // ── Provenance ────────────────────────────────────────────────────────
  derived_from:   "A was extracted from source B (artifact)",
  cites:          "A references B as a source",
  supersedes:     "A replaces an outdated B in the active knowledge set",
} as const;

export type CanonicalEdge = keyof typeof CANONICAL_EDGES;

const CANONICAL_EDGE_NAMES: readonly CanonicalEdge[] =
  Object.keys(CANONICAL_EDGES) as CanonicalEdge[];

const _CANONICAL_SET = new Set<string>(CANONICAL_EDGE_NAMES);

/** True if the given edge name is in the canonical vocabulary. */
export function isCanonicalEdge(edge: string): edge is CanonicalEdge {
  return _CANONICAL_SET.has(edge);
}

/** Return the semantic description of a canonical edge, or a placeholder. */
export function describeEdge(edge: string): string {
  return CANONICAL_EDGES[edge as CanonicalEdge] ?? "(non-canonical)";
}
