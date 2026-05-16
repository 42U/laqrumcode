/**
 * get_skill_body MCP tool. Fetches the full body markdown of a skill by
 * name. Skills are DB-resident (vector-indexed in the `skill` table);
 * SKILL.md files on disk are 5-line stubs whose body line directs the
 * agent to call this tool to load the real procedural content.
 *
 * Returns a single text block: reconstructed frontmatter (name +
 * description) followed by the body. If the skill predates the body
 * field, falls back to assembling preconditions / steps / postconditions
 * into a synthetic body.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleGetSkillBody(state: GlobalPluginState, _session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
