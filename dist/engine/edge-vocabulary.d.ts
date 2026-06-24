/**
 * Canonical edge vocabulary for the laqrumcode graph.
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
export declare const CANONICAL_EDGES: {
    readonly performed: "IN agent OUT task — an agent performed a task";
    readonly owns: "IN agent OUT project — an agent owns a project";
    readonly task_part_of: "IN task OUT project — a task is part of a project";
    readonly session_task: "IN session OUT task — a session is bound to a task";
    readonly produced: "IN task OUT artifact — a task produced an artifact";
    readonly derived_from: "IN concept|subagent OUT task|artifact|session — a concept (or subagent) was derived from a task, artifact, or session row (widened 0.7.23 + 0.7.70)";
    readonly relevant_to: "IN concept OUT project — a concept is relevant to a project";
    readonly used_in: "IN artifact OUT project — an artifact is used in a project";
    readonly narrower: "IN concept OUT concept — the IN concept is narrower than the OUT (is-a-kind-of)";
    readonly broader: "IN concept OUT concept — the IN concept is broader than the OUT (parent-of)";
    readonly related_to: "IN concept OUT concept — concepts are related but not hierarchical";
    readonly caused_by: "IN memory OUT memory — the IN memory was caused by the OUT memory";
    readonly supports: "IN memory OUT memory — the IN memory supports the OUT memory";
    readonly contradicts: "IN memory OUT memory — the IN memory contradicts the OUT memory";
    readonly describes: "IN memory OUT memory — the IN memory describes the OUT memory";
    readonly supersedes: "IN memory OUT concept|memory — a memory row marks a concept or earlier memory as superseded; written only via src/engine/supersedes.ts after a contradiction is detected. The IN row carries the correction text.";
    readonly about_concept: "IN memory OUT concept — a memory is about a concept (canonical retrieval bridge)";
    readonly artifact_mentions: "IN artifact OUT concept — an artifact mentions a concept";
    readonly mentions: "IN turn OUT concept — a turn mentions a concept";
    readonly responds_to: "IN turn OUT turn — the IN turn responds to the OUT turn";
    readonly part_of: "IN turn OUT session — a turn is part of a session (every turn carries this edge)";
    readonly skill_from_task: "IN skill OUT task — the skill was distilled from this task";
    readonly skill_uses_concept: "IN skill OUT concept — the skill uses this concept (dynamic edge name written via commit.ts)";
    readonly spawned: "IN session OUT subagent — the session spawned this subagent (forward edge)";
    readonly spawned_from: "IN subagent OUT session — the subagent was spawned from this session (reverse edge for traversal)";
    readonly reflects_on: "IN reflection OUT session — a reflection reflects on a session";
};
export type CanonicalEdge = keyof typeof CANONICAL_EDGES;
/** True if the given edge name is in the canonical vocabulary. */
export declare function isCanonicalEdge(edge: string): edge is CanonicalEdge;
/** Return the semantic description of a canonical edge, or a placeholder. */
export declare function describeEdge(edge: string): string;
