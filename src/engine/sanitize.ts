/**
 * Strip laqrumcode structural XML tags from user-supplied text.
 *
 * Prevents stored content from breaking out of its injection envelope
 * when retrieved and assembled into the LLM context. Applied at write
 * time (core_memory, record_finding, commit_work_results) so the graph
 * never contains tag-breakout payloads.
 */

const STRUCTURAL_TAGS = [
  "system-reminder",
  "recalled_memory",
  "active_directives",
  "session_directives",
  "reflection_context",
  "laqrumcode_pending_work",
  "laqrumcode-alert",
  "rules_reminder",
  "persisted-output",
  "user-prompt-submit-hook",
] as const;

const TAG_RE = new RegExp(
  `</?(?:${STRUCTURAL_TAGS.join("|")})\\b[^>]*>`,
  "gi",
);

export function stripStructuralTags(text: string): string {
  return text.replace(TAG_RE, "").replace(/\n{3,}/g, "\n\n");
}
