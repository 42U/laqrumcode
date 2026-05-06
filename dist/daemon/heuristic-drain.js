/**
 * Heuristic pre-drain — handle simple pending_work items in-process
 * without spawning a headless Claude subprocess.
 *
 * Targets:
 *   - handoff_note: template from last N turns (no LLM needed)
 *   - reflection (short sessions <3 turns): template summary
 *
 * Returns the number of items processed. The caller can subtract from
 * the queue size to decide whether a full subprocess spawn is still needed.
 */
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { commitKnowledge } from "../engine/commit.js";
const RECORD_ID_RE = /^pending_work:[a-zA-Z0-9_]+$/;
export async function drainHeuristic(state) {
    const { store, embeddings } = state;
    if (!store.isAvailable())
        return 0;
    let processed = 0;
    try {
        const items = await store.queryFirst(`SELECT * FROM pending_work WHERE status = "pending" AND work_type IN ["handoff_note", "reflection"] ORDER BY priority ASC, created_at ASC LIMIT 10`);
        for (const item of items) {
            if (!RECORD_ID_RE.test(item.id))
                continue;
            try {
                const ok = await processItem(item, state);
                if (ok) {
                    await store.queryExec(`UPDATE ${item.id} SET status = "completed", completed_at = time::now()`);
                    processed++;
                }
            }
            catch (e) {
                swallow.warn(`heuristic-drain:${item.work_type}`, e);
            }
        }
    }
    catch (e) {
        swallow.warn("heuristic-drain:query", e);
    }
    if (processed > 0) {
        log.info(`[heuristic-drain] processed ${processed} items in-process`);
    }
    return processed;
}
async function processItem(item, state) {
    switch (item.work_type) {
        case "handoff_note":
            return processHandoffNote(item, state);
        case "reflection":
            return processShortReflection(item, state);
        default:
            return false;
    }
}
async function processHandoffNote(item, state) {
    const { store, embeddings } = state;
    const turns = await store.getSessionTurns(item.session_id, 8);
    if (turns.length === 0)
        return false;
    const userTurns = turns.filter(t => t.role === "user");
    const topics = userTurns.map(t => (t.text ?? "").slice(0, 120).trim()).filter(Boolean);
    if (topics.length === 0)
        return false;
    const note = topics.length === 1
        ? `I worked on: ${topics[0]}. Session had ${turns.length} turns.`
        : `I worked on ${topics.length} topics: ${topics.slice(0, 3).join("; ")}. Session had ${turns.length} turns.`;
    let emb = null;
    if (embeddings.isAvailable()) {
        try {
            emb = await embeddings.embed(note);
        }
        catch { /* ok */ }
    }
    const record = {
        text: note,
        category: "handoff",
        importance: 6,
        source: `session:${item.session_id}`,
        session_id: item.session_id,
    };
    if (item.project_id)
        record.project_id = item.project_id;
    if (emb?.length)
        record.embedding = emb;
    const memRows = await store.queryFirst(`CREATE memory CONTENT $record RETURN id`, { record });
    const memId = memRows[0]?.id;
    if (memId && note.length >= 30) {
        try {
            await commitKnowledge({ store, embeddings }, {
                kind: "concept",
                name: note.slice(0, 200),
                sourceId: memId,
                edgeName: "derived_from",
                source: "handoff:promote",
                precomputedVec: emb,
                projectId: item.project_id,
            });
        }
        catch (e) {
            swallow("heuristic:handoff:promote", e);
        }
    }
    return true;
}
async function processShortReflection(item, state) {
    const { store, embeddings } = state;
    const turns = await store.getSessionTurns(item.session_id, 5);
    if (turns.length > 3)
        return false;
    const text = `Brief session (${turns.length} turns). ` +
        (turns.length === 0
            ? "No substantive exchange."
            : `Topics: ${turns.filter(t => t.role === "user").map(t => (t.text ?? "").slice(0, 80)).join("; ").slice(0, 200)}`);
    let emb = null;
    if (embeddings.isAvailable()) {
        try {
            emb = await embeddings.embed(text);
        }
        catch { /* ok */ }
    }
    if (emb?.length) {
        const existing = await store.queryFirst(`SELECT vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection WHERE embedding != NONE AND array::len(embedding) > 0
       ORDER BY score DESC LIMIT 1`, { vec: emb });
        if (existing.length > 0 && (existing[0].score ?? 0) > 0.85)
            return true;
    }
    const record = {
        session_id: item.session_id,
        text,
        category: "session_review",
        severity: "minor",
        importance: 4.0,
    };
    if (item.project_id)
        record.project_id = item.project_id;
    if (emb?.length)
        record.embedding = emb;
    await store.queryFirst(`CREATE reflection CONTENT $record RETURN id`, { record });
    return true;
}
