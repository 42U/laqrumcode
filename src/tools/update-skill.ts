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
import { swallow } from "../engine/errors.js";
import { assertRecordId } from "../engine/surreal.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleUpdateSkill(
  state: GlobalPluginState,
  _session: SessionState,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return text("Error: `name` is required to identify the skill to update.");

  const { store, embeddings } = state;
  if (!store.isAvailable()) return text("Error: database unavailable. Cannot update skill.");

  const existing = await store.queryFirst<{ id: string; description: string; body: string }>(
    `SELECT id, description, body FROM skill WHERE name = $name LIMIT 1`,
    { name },
  );
  if (existing.length === 0) {
    return text(`Error: no skill named "${name}" exists. Use create_skill to author a new one.`);
  }
  const cur = existing[0];

  // Build the SET clause from a FIXED whitelist of field names (no user input
  // in the clause strings — values are bound as params), tracking the final
  // description/body needed to recompute the embedding.
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { name };
  const fieldsUpdated: string[] = [];
  let finalDescription = cur.description ?? "";
  let finalBody = cur.body ?? "";

  if (typeof args.description === "string" && args.description.trim()) {
    finalDescription = args.description.trim();
    setClauses.push("description = $description");
    params.description = finalDescription;
    fieldsUpdated.push("description");
  }
  if (typeof args.body === "string") {
    if (args.body.trim().length < 20) {
      return text("Error: `body` must be at least 20 characters of markdown body.");
    }
    finalBody = args.body;
    setClauses.push("body = $body", "body_len = $body_len");
    params.body = finalBody;
    params.body_len = finalBody.length;
    fieldsUpdated.push("body");
  }
  if (Array.isArray(args.steps)) {
    setClauses.push("steps = $steps");
    params.steps = args.steps;
    fieldsUpdated.push("steps");
  }
  if (typeof args.preconditions === "string") {
    setClauses.push("preconditions = $preconditions");
    params.preconditions = args.preconditions.trim();
    fieldsUpdated.push("preconditions");
  }
  if (typeof args.postconditions === "string") {
    setClauses.push("postconditions = $postconditions");
    params.postconditions = args.postconditions.trim();
    fieldsUpdated.push("postconditions");
  }

  if (fieldsUpdated.length === 0) {
    return text("Error: provide at least one field to update (body, description, steps, preconditions, postconditions).");
  }

  // Re-embed so the vector index reflects the new content. NEVER leave a stale
  // vector matching the old body — set embedding = NONE on failure so the
  // maintenance backfill (WHERE embedding IS NONE) recomputes it.
  let reEmbedded = false;
  if (embeddings.isAvailable()) {
    try {
      const vec = await embeddings.embed(`${name}: ${finalDescription}\n\n${finalBody}`);
      if (vec?.length) {
        setClauses.push("embedding = $vec");
        params.vec = vec;
        reEmbedded = true;
      }
    } catch (e) { swallow.warn("update-skill:embed", e); }
  }
  if (!reEmbedded) setClauses.push("embedding = NONE");
  setClauses.push("updated_at = time::now()");

  // Target the exact row read above by id, NOT `WHERE name`: skill.name has no
  // UNIQUE index (schema.surql), so a name-scoped UPDATE would clobber EVERY
  // same-named skill and recompute each one's embedding from THIS row's body.
  // (audit C2)
  const skillId = String(cur.id);
  assertRecordId(skillId);
  const updated = await store.queryFirst<{ id: string }>(
    `UPDATE ${skillId} SET ${setClauses.join(", ")} RETURN id`,
    params,
  );

  return text(JSON.stringify({
    ok: updated.length > 0,
    skill_id: String(updated[0]?.id ?? cur.id),
    name,
    fields_updated: fieldsUpdated,
    body_length: finalBody.length,
    re_embedded: reEmbedded,
  }, null, 2));
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}
