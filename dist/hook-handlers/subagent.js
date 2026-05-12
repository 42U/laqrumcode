/**
 * TaskCreated + SubagentStop hook handlers (v1).
 *
 * Subagent tracking lifecycle:
 *   1. PreToolUse(Agent|Task) in pre-tool-use.ts captures the spawn,
 *      writes an initial `subagent` row with outcome="in_progress", and
 *      stashes tool_use_id → subagent_id in session._activeSubagents.
 *   2. SubagentStop (this handler) closes the row with ended_at,
 *      duration_ms, outcome, and optional result_summary.
 *   3. handleTaskCreated currently just logs the raw payload — the
 *      richer data is at PreToolUse so this stays minimal for now.
 *
 * Correlation key preference:
 *   - payload.tool_use_id (if Claude Code propagates it to SubagentStop)
 *   - payload.agent_id (documented per Claude Code hooks reference)
 *   - fallback: most-recent in_progress row for this session
 */
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
export async function handleTaskCreated(state, payload) {
    // Minimal: log the payload shape so the first real TaskCreated hit
    // lets us see what Claude Code actually sends. The rich spawn capture
    // lives in PreToolUse(Agent|Task) in pre-tool-use.ts.
    const sessionId = payload.session_id ?? "default";
    log.info(`[subagent] TaskCreated fired: session=${sessionId} keys=${Object.keys(payload).join(",")}`);
    return {};
}
export async function handleSubagentStop(state, payload) {
    const sessionId = payload.session_id ?? "default";
    const session = state.getSession(sessionId);
    const { store } = state;
    if (!store.isAvailable())
        return {};
    const toolUseId = String(payload.tool_use_id ?? payload.agent_id ?? "");
    const agentType = String(payload.agent_type ?? "");
    const resultText = String(payload.result ?? payload.output ?? "");
    const outcome = String(payload.outcome ?? (payload.error ? "error" : "completed"));
    try {
        // Prefer tool_use_id stashed at spawn time for exact correlation.
        let subagentId = null;
        if (session && toolUseId) {
            subagentId = session._activeSubagents.get(toolUseId) ?? null;
            if (subagentId)
                session._activeSubagents.delete(toolUseId);
        }
        // Fallback: find most-recent in_progress row for this session + agent_type.
        if (!subagentId) {
            const rows = await store.queryFirst(`SELECT id FROM subagent
         WHERE parent_session_id = $sid AND outcome = 'in_progress'
         ${agentType ? "AND agent_type = $at" : ""}
         ORDER BY created_at DESC LIMIT 1`, agentType ? { sid: sessionId, at: agentType } : { sid: sessionId }).catch(() => []);
            subagentId = rows[0]?.id ? String(rows[0].id) : null;
        }
        if (subagentId) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-]+$/.test(subagentId))
                return {};
            await store.queryExec(`UPDATE ${subagentId} SET
           ended_at = time::now(),
           duration_ms = <int>(time::unix(time::now()) * 1000 - time::unix(created_at ?? time::now()) * 1000),
           outcome = $outcome,
           result_summary = $result`, {
                outcome,
                result: resultText.slice(0, 500),
            });
            log.info(`[subagent] stopped: id=${subagentId.slice(-8)} outcome=${outcome}`);
        }
        else {
            // Orphan stop: no matching start — write a bare row so we don't drop the signal.
            await store.queryExec(`CREATE subagent CONTENT $data`, {
                data: {
                    parent_session_id: sessionId,
                    agent_type: agentType || "unknown",
                    outcome,
                    result_summary: resultText.slice(0, 500),
                    description: "orphan stop (no matching spawn)",
                    correlation_key: toolUseId || "orphan",
                },
            });
            log.warn(`[subagent] orphan stop: no spawn row matched. session=${sessionId} agent_type=${agentType}`);
        }
    }
    catch (e) {
        swallow.warn("subagent:stop", e);
    }
    return {};
}
