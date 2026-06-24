/**
 * create_skill MCP tool. Writes a skill row into the laqrumcode DB as the
 * canonical location for procedural knowledge. Replaces the historical
 * SKILL.md-on-disk authoring path: bodies live in the vector-indexed
 * `skill` table where they are semantically recallable, smaller, and
 * not subject to file-system fragmentation.
 *
 * The skill table is SCHEMALESS, so `body` is stored via commitSkill's
 * `extras` escape hatch alongside the declared `name`, `description`,
 * `steps`, `preconditions`, `postconditions`, `embedding` fields.
 *
 * Embedding target is `${name}: ${description}\n\n${body}` so the full
 * procedural content participates in vector search, not just the title.
 *
 * Dedup: the tool rejects writes with a name that already exists. Use
 * supersede or update directly for changes to an existing skill.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleCreateSkill(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
