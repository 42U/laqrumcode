/**
 * update_skill MCP tool. Revises an EXISTING skill row in the kongcode DB.
 *
 * Counterpart to create_skill, which deliberately rejects name collisions.
 * Before this tool, the only way to change a shipped skill body was raw
 * SurrealQL — and a naive `UPDATE skill SET body = ...` left the OLD embedding
 * in place, so `recall(scope="skills")` kept matching the stale content (the
 * maintenance backfill only fills rows `WHERE embedding IS NONE`, so it never
 * refreshes a stale-but-present vector). This tool closes that gap: it patches
 * the provided fields AND re-embeds so the vector index stays in sync.
 *
 * The embedding target mirrors create_skill and the maintenance backfill
 * exactly: `${name}: ${description}\n\n${body}`. If the embedding service is
 * unavailable, embedding is set to NONE (not left stale) so the backfill
 * recomputes it later.
 *
 * `name` identifies the skill and is NOT mutable here — renaming a skill has
 * slash-command implications and is out of scope. At least one mutable field
 * (body, description, steps, preconditions, postconditions) must be provided.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
type ToolResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
};
export declare function handleUpdateSkill(state: GlobalPluginState, _session: SessionState, args: Record<string, unknown>): Promise<ToolResult>;
export {};
