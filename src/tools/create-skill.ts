/**
 * create_skill MCP tool. Writes a skill row into the kongcode DB as the
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
import { commitKnowledge } from "../engine/commit.js";

type StructuredStep = { tool?: string; description?: string; argsPattern?: string };
type StepArg = string | StructuredStep;

export async function handleCreateSkill(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const body = typeof args.body === "string" ? args.body : "";
  const preconditions = typeof args.preconditions === "string" ? args.preconditions.trim() : undefined;
  const postconditions = typeof args.postconditions === "string" ? args.postconditions.trim() : undefined;
  const stepsArg = args.steps;

  if (!name) return errText("Error: `name` is required (kebab-case, matches the slash command).");
  if (!description) return errText("Error: `description` is required. Used for slash-command suggestion and embedding.");
  if (!body || body.trim().length < 20) {
    return errText("Error: `body` is required and must be at least 20 characters of markdown body.");
  }

  const steps: StepArg[] = Array.isArray(stepsArg) ? (stepsArg as StepArg[]) : [];

  const existing = await state.store.queryFirst<{ id: string }>(
    `SELECT id FROM skill WHERE name = $name LIMIT 1`,
    { name },
  );
  if (existing.length > 0) {
    return errText(
      `Error: a skill named "${name}" already exists (${existing[0].id}). ` +
      `Use a different name, or update the existing row directly via raw SurrealQL ` +
      `if this is a content revision.`,
    );
  }

  const { id, edges } = await commitKnowledge(
    { store: state.store, embeddings: state.embeddings },
    {
      kind: "skill",
      name,
      description,
      steps,
      preconditions,
      postconditions,
      embeddingText: `${name}: ${description}\n\n${body}`,
      sessionId: session.sessionId,
      extras: { body },
    },
  );

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: Boolean(id),
        skill_id: id,
        name,
        edges_created: edges,
        body_length: body.length,
      }, null, 2),
    }],
  };
}

function errText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}
