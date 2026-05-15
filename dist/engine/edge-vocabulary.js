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
 *
 * The entries below match the actual edge tables in src/engine/schema.surql
 * plus the raw-SQL relations (`performed`, `owns`, `task_part_of`,
 * `session_task`) used by the structural pillars. Aspirational vocabulary
 * (`decomposes_into`, `elaborates`, ...) was retired in v0.7.74 because none
 * of those names were ever written via store.relate().
 */
export const CANONICAL_EDGES = {
    // ── 5-pillar relations ─────────────────────────────────────────────────
    performed: "IN agent OUT task — an agent performed a task",
    owns: "IN agent OUT project — an agent owns a project",
    task_part_of: "IN task OUT project — a task is part of a project",
    session_task: "IN session OUT task — a session is bound to a task",
    produced: "IN task OUT artifact — a task produced an artifact",
    derived_from: "IN concept|subagent OUT task|artifact|session — a concept (or subagent) was derived from a task, artifact, or session row (widened 0.7.23 + 0.7.70)",
    relevant_to: "IN concept OUT project — a concept is relevant to a project",
    used_in: "IN artifact OUT project — an artifact is used in a project",
    // ── Hierarchy (concept ↔ concept) ──────────────────────────────────────
    narrower: "IN concept OUT concept — the IN concept is narrower than the OUT (is-a-kind-of)",
    broader: "IN concept OUT concept — the IN concept is broader than the OUT (parent-of)",
    related_to: "IN concept OUT concept — concepts are related but not hierarchical",
    // ── Memory causality (memory ↔ memory) ─────────────────────────────────
    caused_by: "IN memory OUT memory — the IN memory was caused by the OUT memory",
    supports: "IN memory OUT memory — the IN memory supports the OUT memory",
    contradicts: "IN memory OUT memory — the IN memory contradicts the OUT memory",
    describes: "IN memory OUT memory — the IN memory describes the OUT memory",
    // ── Concept evolution ──────────────────────────────────────────────────
    supersedes: "IN memory OUT concept|memory — a memory row marks a concept or earlier memory as superseded; written only via src/engine/supersedes.ts after a contradiction is detected. The IN row carries the correction text.",
    // ── Cross-pillar links ─────────────────────────────────────────────────
    about_concept: "IN memory OUT concept — a memory is about a concept (canonical retrieval bridge)",
    artifact_mentions: "IN artifact OUT concept — an artifact mentions a concept",
    mentions: "IN turn OUT concept — a turn mentions a concept",
    // ── Turn-level ─────────────────────────────────────────────────────────
    responds_to: "IN turn OUT turn — the IN turn responds to the OUT turn",
    part_of: "IN turn OUT session — a turn is part of a session (every turn carries this edge)",
    // ── Skill provenance ───────────────────────────────────────────────────
    skill_from_task: "IN skill OUT task — the skill was distilled from this task",
    skill_uses_concept: "IN skill OUT concept — the skill uses this concept (dynamic edge name written via commit.ts)",
    // ── Subagent provenance ────────────────────────────────────────────────
    spawned: "IN session OUT subagent — the session spawned this subagent (forward edge)",
    spawned_from: "IN subagent OUT session — the subagent was spawned from this session (reverse edge for traversal)",
    // ── Reflection ─────────────────────────────────────────────────────────
    reflects_on: "IN reflection OUT session — a reflection reflects on a session",
};
const CANONICAL_EDGE_NAMES = Object.keys(CANONICAL_EDGES);
const _CANONICAL_SET = new Set(CANONICAL_EDGE_NAMES);
/** True if the given edge name is in the canonical vocabulary. */
export function isCanonicalEdge(edge) {
    return _CANONICAL_SET.has(edge);
}
/** Return the semantic description of a canonical edge, or a placeholder. */
export function describeEdge(edge) {
    return CANONICAL_EDGES[edge] ?? "(non-canonical)";
}
