const VALID_SIGNALS = new Set(["helpful", "irrelevant", "outdated", "pin"]);
const VALID_TABLES = new Set(["memory", "concept"]);
function text(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
export async function handleRecordRetrievalFeedback(state, session, args) {
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
    const existsRows = await store.queryBatch([`SELECT id FROM type::record($table, $id)`], { table, id: idPart });
    if (!existsRows[0] || existsRows[0].length === 0) {
        return text({ ok: false, error: `No ${table} found with id ${memoryId}.` });
    }
    const result = { ok: true, memory_id: memoryId, signal };
    // helpful / irrelevant / outdated → relabel this session's retrieval_outcome
    // rows for the memory (those carry query_embedding → ACAN training samples).
    if (signal === "helpful" || signal === "irrelevant" || signal === "outdated") {
        const relevance = signal === "helpful" ? 1.0 : 0.0;
        const relevant = signal === "helpful";
        // llm_reason is option<string>: bind a string, or write the SurrealDB literal
        // NONE — never JS null, which fails option<string> coercion ("found NULL").
        const binds = { rel: relevance, isrel: relevant, mid: memoryId, sid: session.sessionId };
        if (reason != null)
            binds.reason = reason;
        const reasonSet = reason != null ? "llm_reason = $reason" : "llm_reason = NONE";
        // RETURN id keeps the 1024-dim query_embedding out of the response payload.
        const updated = await store.queryBatch([`UPDATE retrieval_outcome
          SET llm_relevance = $rel, llm_relevant = $isrel, feedback_source = 'explicit', ${reasonSet}
          WHERE memory_id = $mid AND session_id = $sid AND query_embedding != NONE
          RETURN id`], binds);
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
        await store.queryExec(`UPDATE type::record($table, $id) SET ${field} = math::max([(${field} ?? ${base}) * 0.4, ${floor}])`, { table, id: idPart });
        result.decayed = `${field} reduced`;
        result.hint = "For a definitive fix, call supersede(old_text, new_text) with the corrected understanding — it writes a correction memory + supersedes edge.";
    }
    // pin → boost so it surfaces when relevant. memory uses importance; concept uses stability.
    if (signal === "pin") {
        const field = table === "memory" ? "importance" : "stability";
        await store.queryExec(`UPDATE type::record($table, $id) SET ${field} = 10.0`, { table, id: idPart });
        result.pinned = `${field} set to 10`;
    }
    return text(result);
}
