/**
 * record_retrieval_feedback MCP tool — explicit feedback on a retrieved memory
 * or concept (GH #16 item 5, Phase A).
 *
 * ACAN learns from implicit signals (cross-encoder utilization + tool outcomes).
 * This lets the agent record a DELIBERATE signal — "that injected memory was
 * helpful / irrelevant / outdated" — which is the highest-signal training data.
 *
 * The integration is deliberately small: ACAN's training query already prefers
 * an explicit label (src/engine/acan.ts:333,
 *   `IF llm_relevance != NONE THEN llm_relevance ELSE utilization`),
 * so setting llm_relevance on the retrieval_outcome row that was written at
 * turn-end (which carries the query_embedding ACAN training requires) is all it
 * takes to relabel the training sample. We therefore UPDATE that existing row
 * rather than CREATE a bare one (a bare row has no query_embedding and ACAN
 * training skips it).
 *
 * Signals:
 *   helpful    → llm_relevance 1.0, llm_relevant true   (boost in training)
 *   irrelevant → llm_relevance 0.0, llm_relevant false  (demote in training)
 *   outdated   → llm_relevance 0.0, llm_relevant false + decay stability;
 *                returns a hint to call `supersede` for a definitive fix
 *   pin        → boost importance (memory) / stability (concept) so it surfaces
 *
 * `mute` (stop surfacing entirely) is Phase B — it requires a new `muted` field
 * plus a filter across the hot retrieval candidate-selection path, so it is
 * intentionally NOT in this additive v1.
 *
 * All record ids are bound via type::record($table,$id) — never string-
 * interpolated — so a hostile memory_id cannot inject SQL.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleRecordRetrievalFeedback(state: GlobalPluginState, session: SessionState, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
