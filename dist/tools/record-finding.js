/**
 * record_finding MCP tool — structured save for decisions, corrections,
 * preferences, and reusable facts.
 *
 * Wraps commitKnowledge({kind: "memory", ...}) with a validated input
 * shape so bots don't have to remember category naming conventions, the
 * importance scale, or which text to embed. The substrate-does-the-work
 * analog of "teach yourself what to save and how" — the tool signature
 * teaches it by being the only way in.
 *
 * Covers the four most common things a bot wants to permanently remember:
 *   - decision: "we chose X over Y because Z"
 *   - correction: "the user corrected my belief that A — actually B"
 *   - preference: "user prefers workflow/style signal"
 *   - fact: general technical knowledge the bot wants to persist
 *
 * Every write auto-seals about_concept edges via commitKnowledge.
 */
import { commitKnowledge } from "../engine/commit.js";
const DEFAULT_IMPORTANCE = {
    correction: 9, // highest signal — user correcting the bot
    decision: 7, // structural choice worth preserving
    preference: 7, // workflow/style signal
    fact: 6, // technical knowledge, lower than active guidance
};
export async function handleRecordFinding(state, session, args) {
    const findingType = String(args.finding_type ?? "").trim();
    const text = String(args.text ?? "").trim();
    const why = typeof args.why === "string" ? args.why.trim() : "";
    const importance = typeof args.importance === "number" ? args.importance : undefined;
    if (!findingType || !["decision", "correction", "preference", "fact"].includes(findingType)) {
        return {
            content: [{
                    type: "text",
                    text: 'Error: `finding_type` must be one of "decision", "correction", "preference", or "fact".',
                }],
        };
    }
    if (!text || text.length < 10) {
        return {
            content: [{
                    type: "text",
                    text: "Error: `text` is required and must be at least 10 characters — vague entries are useless on recall.",
                }],
        };
    }
    // Compose the stored text so the category prefix is human-readable AND the
    // text itself is standalone (recall returns it verbatim). If `why` is
    // provided, append it so rationale rides with the finding.
    const storedText = why
        ? `[${findingType.toUpperCase()}] ${text}\nRationale: ${why}`
        : `[${findingType.toUpperCase()}] ${text}`;
    const { id, edges } = await commitKnowledge({ store: state.store, embeddings: state.embeddings }, {
        kind: "memory",
        text: storedText,
        embeddingText: text,
        importance: importance ?? DEFAULT_IMPORTANCE[findingType],
        category: findingType,
        sessionId: session.sessionId,
    });
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    ok: Boolean(id),
                    memory_id: id,
                    category: findingType,
                    edges_created: edges,
                    stored_text_preview: storedText.slice(0, 160) + (storedText.length > 160 ? "..." : ""),
                }, null, 2),
            }],
    };
}
