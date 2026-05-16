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

interface SkillRow {
  id: string;
  name: string;
  description: string;
  body?: string;
  preconditions?: string;
  postconditions?: string;
  steps?: unknown[];
  active?: boolean;
}

export async function handleGetSkillBody(
  state: GlobalPluginState,
  _session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return { content: [{ type: "text", text: "Error: `name` is required." }] };
  }

  const rows = await state.store.queryFirst<SkillRow>(
    `SELECT id, name, description, body, preconditions, postconditions, steps, active
       FROM skill
       WHERE name = $name AND (active = true OR active IS NONE)
       LIMIT 1`,
    { name },
  );

  if (!rows.length) {
    return {
      content: [{
        type: "text",
        text:
          `No active skill found with name "${name}". ` +
          `Use recall(scope="skills", query=...) to discover skills by description.`,
      }],
    };
  }

  const row = rows[0];
  const parts: string[] = [];
  parts.push("---");
  parts.push(`name: ${row.name}`);
  parts.push(`description: ${row.description}`);
  parts.push("---");
  parts.push("");

  if (row.body && row.body.trim().length > 0) {
    parts.push(row.body);
  } else {
    if (row.preconditions) {
      parts.push("## Preconditions");
      parts.push("");
      parts.push(row.preconditions);
      parts.push("");
    }
    if (Array.isArray(row.steps) && row.steps.length > 0) {
      parts.push("## Steps");
      parts.push("");
      for (let i = 0; i < row.steps.length; i++) {
        const step = row.steps[i];
        if (typeof step === "string") {
          parts.push(`${i + 1}. ${step}`);
        } else if (step && typeof step === "object") {
          const s = step as { tool?: string; description?: string; argsPattern?: string };
          const desc = s.description ?? s.tool ?? JSON.stringify(s);
          parts.push(`${i + 1}. ${desc}`);
        }
      }
      parts.push("");
    }
    if (row.postconditions) {
      parts.push("## Postconditions");
      parts.push("");
      parts.push(row.postconditions);
      parts.push("");
    }
    if (parts.length === 5) {
      parts.push(`(This skill has no body, preconditions, steps, or postconditions stored. The row exists but is empty: ${row.id})`);
    }
  }

  return {
    content: [{
      type: "text",
      text: parts.join("\n"),
    }],
  };
}
