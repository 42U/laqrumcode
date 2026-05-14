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
export declare const CANONICAL_EDGES: {
    readonly decomposes_into: "a whole splits into parts (e.g. total effect → direct + mediated channels)";
    readonly elaborates: "one concept adds detail to another";
    readonly contextualizes: "one concept frames another";
    readonly enables: "a method/tool makes another possible";
    readonly extends: "builds on a prior concept while preserving its claims";
    readonly mechanism_for: "A is the mechanism through which B happens";
    readonly explained_by: "A holds because of B";
    readonly prerequisite_for: "A must be true for B to hold";
    readonly identification_for: "A is the identification strategy enabling B's causal claim";
    readonly supported_by: "A is supported by evidence B";
    readonly necessitates: "A forces B as a consequence";
    readonly contrasts_with: "A and B are in direct opposition";
    readonly tempered_by: "A's effect is moderated by B";
    readonly fails_when: "A stops working when B occurs";
    readonly complemented_by: "A works alongside B (both needed)";
    readonly corrects: "A replaces an incorrect claim in B";
    readonly implies: "A implies B as a logical consequence";
    readonly amplifies: "A strengthens B's effect";
    readonly applies_to_options: "A has implications for options pricing/trading";
    readonly applies_to_equities: "A has implications for equity trading";
    readonly applies_to_code: "A has implications for source code in this project";
    readonly derived_from: "A was extracted from source B (artifact)";
    readonly cites: "A references B as a source";
    readonly supersedes: "A replaces an outdated B in the active knowledge set";
};
export type CanonicalEdge = keyof typeof CANONICAL_EDGES;
/** True if the given edge name is in the canonical vocabulary. */
export declare function isCanonicalEdge(edge: string): edge is CanonicalEdge;
/** Return the semantic description of a canonical edge, or a placeholder. */
export declare function describeEdge(edge: string): string;
