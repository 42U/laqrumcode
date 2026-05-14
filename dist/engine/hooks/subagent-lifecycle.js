/**
 * subagent_spawned / subagent_ended hooks — track spawned subagents in the graph.
 *
 * Creates `subagent` records and `spawned` edges (session → subagent).
 * Updates subagent records with outcome on completion.
 */
import { swallow, isUniqueViolation } from "../errors.js";
import { log } from "../log.js";
// ── Handlers ─────────────────────────────────────────────────────────────
export function createSubagentSpawnedHandler(state) {
    return async (event, ctx) => {
        try {
            const store = state.store;
            // Dedup: subagent_spawned can fire twice for the same run_id (gateway
            // retry or hook re-delivery). Skip CREATE if a row already exists.
            // Agent 1 is adding a UNIQUE index on subagent.run_id that would reject
            // the duplicate at the DB layer; this avoids even attempting it.
            const existing = await store.queryFirst(`SELECT id FROM subagent WHERE run_id = $rid LIMIT 1`, { rid: event.runId }).catch(() => []);
            if (existing[0]?.id) {
                return;
            }
            // Create the subagent record
            let rows = [];
            try {
                rows = await store.queryFirst(`CREATE subagent CONTENT {
            run_id: $run_id,
            parent_session_key: $parent_key,
            child_session_key: $child_key,
            parent_session_id: $parent_key,
            child_session_id: $child_key,
            agent_id: $agent_id,
            label: $label,
            mode: $mode,
            task: $label,
            status: "running",
            created_at: time::now()
          } RETURN id`, {
                    run_id: event.runId,
                    parent_key: ctx.requesterSessionKey ?? "unknown",
                    child_key: event.childSessionKey,
                    agent_id: event.agentId ?? "default",
                    label: event.label ?? null,
                    mode: event.mode ?? "run",
                });
            }
            catch (createErr) {
                // TOCTOU: a sibling subagent_spawned handler can race in between our
                // existence-check SELECT and the CREATE. The UNIQUE index on run_id
                // (subagent_run_unique in schema.surql) rejects ours, which is the
                // desired protection. Stay on log.debug — this is the constraint
                // doing its job, not an error.
                if (isUniqueViolation(createErr)) {
                    log.debug(`[hook:subagentSpawned] CREATE rejected by UNIQUE (sibling won race): run_id=${event.runId}`);
                    return;
                }
                throw createErr;
            }
            const subagentId = String(rows[0]?.id ?? "");
            if (!subagentId)
                return;
            // Find the parent's surreal session ID to create the spawned edge.
            // The requesterSessionKey is the OpenClaw session key — we need to
            // find the matching surreal session record.
            if (ctx.requesterSessionKey) {
                // Look up active session state first (fast path)
                const parentSession = state.getSession(ctx.requesterSessionKey);
                if (parentSession?.surrealSessionId) {
                    await store.relate(parentSession.surrealSessionId, "spawned", subagentId);
                }
                else {
                    // Fallback: find the most recent session record that's still active
                    const sessions = await store.queryFirst(`SELECT id FROM session
             WHERE ended_at IS NONE
             ORDER BY started_at DESC LIMIT 1`);
                    if (sessions.length > 0) {
                        await store.relate(String(sessions[0].id), "spawned", subagentId);
                    }
                }
            }
        }
        catch (e) {
            swallow.warn("hook:subagentSpawned", e);
        }
    };
}
export function createSubagentEndedHandler(state) {
    return async (event, ctx) => {
        try {
            const store = state.store;
            // Update the subagent record by run_id.
            //
            // Agent 1's schema migration typed `ended_at ON subagent` as
            // `option<datetime>`. The JS driver cannot coerce a raw ISO string to
            // SurrealDB's datetime type; the binding has to be cast in-query with
            // `<datetime>$ended_at`. When the gateway omits `endedAt` we fall back
            // to `time::now()` inline (no binding) so the query stays valid.
            const hasEndedAt = typeof event.endedAt === "string" && event.endedAt.length > 0;
            const endedAtExpr = hasEndedAt ? "<datetime>$ended_at" : "time::now()";
            const bindings = {
                run_id: event.runId,
                status: event.outcome === "success" ? "completed"
                    : event.reason === "spawn-failed" ? "error"
                        : event.outcome ?? "completed",
                outcome: event.outcome ?? null,
                error: event.error ?? null,
                reason: event.reason ?? null,
            };
            if (hasEndedAt)
                bindings.ended_at = event.endedAt;
            await store.queryExec(`UPDATE subagent SET
          status = $status,
          outcome = $outcome,
          error = $error,
          reason = $reason,
          ended_at = ${endedAtExpr}
        WHERE run_id = $run_id`, bindings);
        }
        catch (e) {
            swallow.warn("hook:subagentEnded", e);
        }
    };
}
