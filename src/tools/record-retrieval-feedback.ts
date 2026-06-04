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

const VALID_SIGNALS = new Set(["helpful", "irrelevant", "outdated", "pin"]);
const VALID_TABLES = new Set(["memory", "concept"]);

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export async function handleRecordRetrievalFeedback(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const store = state.store;
  const memoryId = String(args.memory_id ?? "").trim();
  const signal = String(args.signal ?? "").trim();
  const reason = args.reason != null ? String(args.reason) : null;

  if (!memoryId.includes(":")) {
    return text({ ok: false, error: "`memory_id` is required and must be a full record id like 'memory:abc' or 'concept:xyz'." });
  }
  if (!VALID_SIGNALS.has(signal)) {
    return text({ ok: false, error: `\`signal\` must be one of: helpful, irrelevant, outdated, pin. Got: '${signal}'. (mute is a later increment.)` });
  }

  const sep = memoryId.indexOf(":");
  const table = memoryId.slice(0, sep);
  const idPart = memoryId.slice(sep + 1);
  if (!VALID_TABLES.has(table)) {
    return text({ ok: false, error: "memory_id must reference a `memory` or `concept` record." });
  }

  // Existence check (bound — no interpolation of user input).
  const existsRows = await store.queryBatch<{ id: unknown }>(
    [`SELECT id FROM type::record($table, $id)`],
    { table, id: idPart },
  );
  if (!existsRows[0] || existsRows[0].length === 0) {
    return text({ ok: false, error: `No ${table} found with id ${memoryId}.` });
  }

  const result: Record<string, unknown> = { ok: true, memory_id: memoryId, signal };

  // helpful / irrelevant / outdated → relabel this session's retrieval_outcome
  // rows for the memory (those carry query_embedding → ACAN training samples).
  if (signal === "helpful" || signal === "irrelevant" || signal === "outdated") {
    const relevance = signal === "helpful" ? 1.0 : 0.0;
    const relevant = signal === "helpful";
    // llm_reason is option<string>: bind a string, or write the SurrealDB literal
    // NONE — never JS null, which fails option<string> coercion ("found NULL").
    const binds: Record<string, unknown> = { rel: relevance, isrel: relevant, mid: memoryId, sid: session.sessionId };
    if (reason != null) binds.reason = reason;
    const reasonSet = reason != null ? "llm_reason = $reason" : "llm_reason = NONE";
    // RETURN id keeps the 1024-dim query_embedding out of the response payload.
    const updated = await store.queryBatch<{ id: unknown }>(
      [`UPDATE retrieval_outcome
          SET llm_relevance = $rel, llm_relevant = $isrel, feedback_source = 'explicit', ${reasonSet}
          WHERE memory_id = $mid AND session_id = $sid AND query_embedding != NONE
          RETURN id`],
      binds,
    );
    const n = updated[0]?.length ?? 0;
    result.relabeled_training_samples = n;
    if (n === 0) {
      result.note = "No retrieval_outcome row with a query embedding was found for this memory in the current session, so there's no ACAN training sample to relabel yet. (The row is written at turn-end when a memory is actually injected — give feedback after it has been surfaced.) The memory-level effects below are still applied.";
    }
  }

  // outdated → decay the table-appropriate priority field so it loses retrieval
  // priority (memory ranks on importance, concept on stability), and point at
  // supersede for a definitive fix.
  if (signal === "outdated") {
    const field = table === "memory" ? "importance" : "stability";
    const base = table === "memory" ? 0.5 : 1.0;
    const floor = table === "memory" ? 0.05 : 0.1;
    await store.queryExec(
      `UPDATE type::record($table, $id) SET ${field} = math::max([(${field} ?? ${base}) * 0.4, ${floor}])`,
      { table, id: idPart },
    );
    result.decayed = `${field} reduced`;
    result.hint = "For a definitive fix, call supersede(old_text, new_text) with the corrected understanding — it writes a correction memory + supersedes edge.";
  }

  // pin → boost so it surfaces when relevant. memory uses importance; concept uses stability.
  if (signal === "pin") {
    const field = table === "memory" ? "importance" : "stability";
    await store.queryExec(
      `UPDATE type::record($table, $id) SET ${field} = 10.0`,
      { table, id: idPart },
    );
    result.pinned = `${field} set to 10`;
  }

  return text(result);
}
