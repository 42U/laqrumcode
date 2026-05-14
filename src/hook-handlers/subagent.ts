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
 *   - fallback: exact-match SELECT by correlation_key (NEVER guess by recency —
 *     a SubagentStop that re-fires would close the wrong subagent's row)
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { swallow, isUniqueViolation } from "../engine/errors.js";
import { log } from "../engine/log.js";

/**
 * SurrealDB UNIQUE-index violation detection — see isUniqueViolation in
 * src/engine/errors.ts for the full detector. Agent 1's schema added UNIQUE
 * indexes on `subagent.correlation_key` and `subagent.run_id`. Under racy
 * CREATE paths (two hook invocations, two gateway redeliveries, etc.) the
 * second CREATE is *expected* to fail at the DB layer. Calls below
 * downgrade those expected rejections from swallow.warn to log.debug so
 * the warn channel stays clean for real failures.
 */

export async function handleTaskCreated(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  // Minimal: log the payload shape so the first real TaskCreated hit
  // lets us see what Claude Code actually sends. The rich spawn capture
  // lives in PreToolUse(Agent|Task) in pre-tool-use.ts.
  const sessionId = (payload.session_id as string) ?? "default";
  log.info(`[subagent] TaskCreated fired: session=${sessionId} keys=${Object.keys(payload).join(",")}`);
  return {};
}

export async function handleSubagentStop(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  const { store } = state;
  if (!store.isAvailable()) return {};

  const toolUseId = String(payload.tool_use_id ?? payload.agent_id ?? "");
  const agentType = String(payload.agent_type ?? "");
  const resultText = String(payload.result ?? payload.output ?? "");
  const outcome = String(payload.outcome ?? (payload.error ? "error" : "completed"));

  try {
    // Prefer tool_use_id stashed at spawn time for exact correlation. Do NOT
    // remove the stash entry yet — if the UPDATE below throws, a re-fired
    // SubagentStop must still see the entry so it can retry. Delete-on-success
    // ordering: UPDATE first, then delete. Without this, the first SubagentStop
    // burned the stash and a second invocation fell through to the orphan-stop
    // branch, writing a spurious orphan row for what was a one-tool-use spawn.
    let subagentId: string | null = null;
    if (session && toolUseId) {
      subagentId = session._activeSubagents.get(toolUseId) ?? null;
    }

    // Exact-match fallback: SELECT by correlation_key. Never guess by recency
    // — a double-fired SubagentStop on a session with multiple live subagents
    // would close the wrong row. If we can't match the toolUseId, we fall
    // through to the orphan-stop branch below.
    if (!subagentId && toolUseId) {
      const rows = await store.queryFirst<{ id: string }>(
        `SELECT id FROM subagent WHERE correlation_key = $cid LIMIT 1`,
        { cid: toolUseId },
      ).catch(() => []);
      subagentId = rows[0]?.id ? String(rows[0].id) : null;
    }

    if (subagentId) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-]+$/.test(subagentId)) return {};
      await store.queryExec(
        `UPDATE ${subagentId} SET
           ended_at = time::now(),
           duration_ms = <int>(time::unix(time::now()) * 1000 - time::unix(created_at ?? time::now()) * 1000),
           outcome = $outcome,
           result_summary = $result`,
        {
          outcome,
          result: resultText.slice(0, 500),
        },
      );
      // UPDATE landed — now it's safe to drop the stash entry. A second
      // SubagentStop for this tool_use_id would have re-tried via the
      // correlation_key fallback and (idempotently) re-applied the same SET.
      if (session && toolUseId) session._activeSubagents.delete(toolUseId);
      log.info(`[subagent] stopped: id=${subagentId.slice(-8)} outcome=${outcome}`);
    } else {
      // Orphan stop: no matching start — write a bare row so we don't drop
      // the signal. Dedup by correlation_key first; if a row already exists
      // (e.g. SubagentStop re-fired and the first invocation already wrote
      // the orphan row), skip the CREATE. Agent 1's UNIQUE index on
      // correlation_key would reject the duplicate at the DB layer anyway.
      const corrKey = toolUseId || "orphan";
      const existing = await store.queryFirst<{ id: string }>(
        `SELECT id FROM subagent WHERE correlation_key = $cid LIMIT 1`,
        { cid: corrKey },
      ).catch(() => []);
      if (existing[0]?.id) {
        log.debug(`[subagent] orphan stop dedup'd: corr=${corrKey.slice(0, 8)} existing=${String(existing[0].id).slice(-8)}`);
      } else {
        try {
          await store.queryExec(
            `CREATE subagent CONTENT $data`,
            {
              data: {
                parent_session_id: sessionId,
                agent_type: agentType || "unknown",
                outcome,
                result_summary: resultText.slice(0, 500),
                description: "orphan stop (no matching spawn)",
                correlation_key: corrKey,
              },
            },
          );
          log.warn(`[subagent] orphan stop: no spawn row matched. session=${sessionId} agent_type=${agentType}`);
        } catch (createErr) {
          // SELECT-then-CREATE has a TOCTOU window — a sibling SubagentStop
          // can write the orphan row between our SELECT and our CREATE. The
          // UNIQUE index then rejects ours, which is the DESIRED outcome.
          // Distinguish that expected race from a real failure so log
          // pressure on the warn channel only fires for the latter.
          if (isUniqueViolation(createErr)) {
            log.debug(`[subagent] orphan create rejected by UNIQUE (sibling won race): corr=${corrKey.slice(0, 8)}`);
          } else {
            swallow.warn("subagent:orphanCreate", createErr);
          }
        }
      }
    }
  } catch (e) {
    swallow.warn("subagent:stop", e);
  }

  return {};
}
