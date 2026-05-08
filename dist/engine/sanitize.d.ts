/**
 * Strip kongcode structural XML tags from user-supplied text.
 *
 * Prevents stored content from breaking out of its injection envelope
 * when retrieved and assembled into the LLM context. Applied at write
 * time (core_memory, record_finding, commit_work_results) so the graph
 * never contains tag-breakout payloads.
 */
export declare function stripStructuralTags(text: string): string;
