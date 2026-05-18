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
export async function handleGetSkillBody(state, _session, args) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
        return { content: [{ type: "text", text: "Error: `name` is required." }] };
    }
    const rows = await state.store.queryFirst(`SELECT id, name, description, body, preconditions, postconditions, steps, active
       FROM skill
       WHERE name = $name AND (active = true OR active IS NONE)
       LIMIT 1`, { name });
    if (!rows.length) {
        return {
            content: [{
                    type: "text",
                    text: `No active skill found with name "${name}". ` +
                        `Use recall(scope="skills", query=...) to discover skills by description.`,
                }],
        };
    }
    const row = rows[0];
    const parts = [];
    parts.push("---");
    parts.push(`name: ${row.name}`);
    parts.push(`description: ${row.description}`);
    parts.push("---");
    parts.push("");
    if (row.body && row.body.trim().length > 0) {
        parts.push(row.body);
    }
    else {
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
                }
                else if (step && typeof step === "object") {
                    const s = step;
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
    // v0.7.96 Piece C — explicit fetch IS usage. Increment success_count +
    // last_used so the skill's invocation history reflects reality.
    // memory:sbxbggtmj7nmafpw9ayn captured the gap: 99% of skills had
    // success_count stuck at DEFAULT 1 because tracking only fired on
    // auto-injection (intent ∈ SKILL_INTENTS), never on explicit fetches.
    // Fire-and-forget; never blocks the response, never throws upward.
    void state.store.queryExec(`UPDATE ${row.id} SET success_count += 1, last_used = time::now()`).catch(() => { });
    return {
        content: [{
                type: "text",
                text: parts.join("\n"),
            }],
    };
}
