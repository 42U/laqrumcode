/**
 * supersede MCP tool — explicit stale-knowledge correction.
 *
 * Lets users/bots say "this thing we believed is no longer true — here is
 * the new version." The substrate:
 *   1. Embeds the old text, finds the top-N concepts whose embedding
 *      matches (via linkSupersedesEdges threshold)
 *   2. Writes a new memory node with the correction text (category
 *      "correction", importance 9)
 *   3. Creates supersedes edges: correction_memory → stale_concept
 *   4. Decays the stability of each superseded concept so it loses
 *      priority in recall
 *
 * This is the explicit, structured alternative to letting the daemon
 * detect corrections from transcript text — useful when the bot KNOWS
 * a belief is stale and wants to mark it definitively rather than hope
 * the extractor catches it.
 */
import { commitKnowledge } from "../engine/commit.js";
export async function handleSupersede(state, session, args) {
    const oldText = String(args.old_text ?? "").trim();
    const newText = String(args.new_text ?? "").trim();
    if (!oldText || !newText) {
        return { content: [{ type: "text", text: "Error: both `old_text` (stale belief) and `new_text` (correction) are required." }] };
    }
    const importance = typeof args.importance === "number" ? args.importance : 9;
    // v0.7.81: migrated to commitKnowledge({ kind: "correction" }) — one
    // helper now writes the correction memory, resolves the target by
    // cosine on oldText, seals the supersedes edge, and runs decay. The
    // previous two-step (commitKnowledge memory + linkSupersedesEdges) is
    // retired along with src/engine/supersedes.ts in this release.
    const result = await commitKnowledge(state, {
        kind: "correction",
        text: `CORRECTION: ${newText} (replaces: ${oldText})`,
        oldText,
        importance,
        sessionId: session.sessionId,
    });
    const correctionMemId = result.id;
    if (!correctionMemId) {
        return { content: [{ type: "text", text: "Error: failed to write correction memory." }] };
    }
    const superseded = result.supersededIds?.length ?? 0;
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    ok: true,
                    correction_memory_id: correctionMemId,
                    superseded_concepts: superseded,
                    message: superseded === 0
                        ? "Correction stored but no concepts matched the old text above threshold — consider rephrasing the old_text to better match existing concept content."
                        : `Marked ${superseded} concept${superseded === 1 ? "" : "s"} as superseded.`,
                }, null, 2),
            }],
    };
}
