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

  // Claude Code's SubagentStop hook does NOT propagate the original
  // PreToolUse(Task).tool_use_id — it ships an `agent_id` (a 17-char hex
  // string) that's never written into the subagent.correlation_key column
  // (PreToolUse wrote `toolu_*` strings there). Falling back to agent_id
  // as a correlation key therefore guarantees the SELECT misses and the
  // orphan-write branch fires. Distinguish the two: when only agent_id
  // is present we treat correlation as "missing" and route through the
  // session-scoped resolver below instead.
  const rawToolUseId = String(payload.tool_use_id ?? "");
  const agentIdRaw = String(payload.agent_id ?? "");
  const toolUseId = rawToolUseId || agentIdRaw; // kept for log lines + dedup keys
  const hasToolUseCorrelation = rawToolUseId.length > 0;
  const agentType = String(payload.subagent_type ?? payload.agent_type ?? "");
  const resultText = String(payload.result ?? payload.output ?? "");
  const outcome = String(payload.outcome ?? (payload.error ? "error" : "completed"));

  // Auto-drain internal subprocesses live outside the PreToolUse →
  // SubagentStop lifecycle: the daemon spawn()s `claude --agent
  // kongcode:memory-extractor[-lite]` directly, so no PreToolUse fires
  // and no spawn row exists. When the subprocess's inner agent finishes,
  // a SubagentStop event arrives here for an agent_type we never wrote
  // a start row for. The previous orphan-write branch would create a
  // bogus row and spam the warn channel. These internal drains are not
  // user-spawned subagents we track in the subagent table — silently
  // skip them.
  const DRAIN_INTERNAL_AGENT_PREFIX = "kongcode:memory-extractor";
  if (agentType.startsWith(DRAIN_INTERNAL_AGENT_PREFIX)) {
    log.debug(`[subagent] skipping stop for internal drain agent (no spawn row by design): session=${sessionId} agent_type=${agentType}`);
    return {};
  }

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

    // v0.7.78 Bug B auditor: when SubagentStop fires without a correlation
    // key (no tool_use_id and no agent_id), neither the stash lookup above
    // nor the SELECT fallback below can match anything. The prior code fell
    // through to the orphan-write branch and inserted a `correlation_key:
    // "orphan"` row, which then collided with itself on every subsequent
    // SubagentStop and spammed the warn channel with "orphan stop: no spawn
    // row matched". Skip entirely instead — a Stop without correlation is
    // unrecoverable noise.
    if (!toolUseId) {
      log.debug(`[subagent] stop without correlation_key — skipping (session=${sessionId})`);
      return {};
    }

    // Exact-match fallback: SELECT by correlation_key. Never guess by recency
    // — a double-fired SubagentStop on a session with multiple live subagents
    // would close the wrong row. If we can't match the toolUseId, we fall
    // through to the orphan-stop branch below. Only run this when we have a
    // real tool_use_id; an agent_id-only payload will NEVER match correlation_key
    // (PreToolUse writes `toolu_*`, agent_id is a different hex namespace), so
    // running the SELECT just wastes a round-trip.
    if (!subagentId && hasToolUseCorrelation) {
      const rows = await store.queryFirst<{ id: string }>(
        `SELECT id FROM subagent WHERE correlation_key = $cid LIMIT 1`,
        { cid: rawToolUseId },
      ).catch(() => []);
      subagentId = rows[0]?.id ? String(rows[0].id) : null;
    }

    // Wave 3 fix: when SubagentStop arrives with ONLY agent_id (no tool_use_id),
    // none of the lookups above can match. Claude Code does not propagate
    // the original PreToolUse tool_use_id to SubagentStop, so this is the
    // common case — not an edge case. The previous behavior fell through to
    // the orphan-write branch and spammed every Task→subagent lifecycle with
    // a bogus row + warn line + downstream `derived_from_session_fallback`.
    //
    // Resolve via the session's in-flight stash instead. When exactly one
    // spawn row is in_progress for this session, that must be the one
    // closing. When zero or multiple match, ambiguity is unrecoverable and
    // we silently skip (the spawn row stays in_progress and will be reaped
    // by the deferred-cleanup pass that already exists for orphaned sessions).
    if (!subagentId && !hasToolUseCorrelation && agentIdRaw && session) {
      const inflight = Array.from(session._activeSubagents.values());
      if (inflight.length === 1) {
        subagentId = inflight[0];
        log.debug(`[subagent] agent_id-only stop resolved via session in-flight stash (single in-progress): id=${subagentId.slice(-8)} agent_id=${agentIdRaw.slice(0, 8)}`);
        // Find the stash key so we can delete it after successful UPDATE.
        // We re-fetch the entries below to find the matching key.
      } else if (inflight.length > 1) {
        // Ambiguous — too risky to close the wrong row. Skip silently.
        log.debug(`[subagent] agent_id-only stop with ${inflight.length} in-flight subagents — cannot disambiguate, skipping. agent_id=${agentIdRaw.slice(0, 8)}`);
        return {};
      }
      // inflight.length === 0 falls through to the orphan-write branch
      // below, which now also gets debug-demoted for the agent_id-only case.
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
      if (session && rawToolUseId) {
        session._activeSubagents.delete(rawToolUseId);
      } else if (session && !hasToolUseCorrelation) {
        // Wave 3 in-flight resolution path: we matched via the stash's only
        // entry. Find and delete that key so a subsequent SubagentStop won't
        // re-close the same row (now it's the new "only in-flight").
        for (const [key, val] of session._activeSubagents) {
          if (val === subagentId) {
            session._activeSubagents.delete(key);
            break;
          }
        }
      }
      log.info(`[subagent] stopped: id=${subagentId.slice(-8)} outcome=${outcome}`);
    } else {
      // Orphan stop: no matching start — write a bare row so we don't drop
      // the signal. Dedup by correlation_key first; if a row already exists
      // (e.g. SubagentStop re-fired and the first invocation already wrote
      // the orphan row), skip the CREATE. Agent 1's UNIQUE index on
      // correlation_key would reject the duplicate at the DB layer anyway.
      // Prefer tool_use_id when present (clean correlation), fall back to
      // agent_id (still globally unique per spawn), then to "orphan" sentinel.
      const corrKey = rawToolUseId || agentIdRaw || "orphan";
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
                // W2-21 (2026-06-10): schema contract (schema.surql:779-787) —
                // every subagent CREATE must set run_id too; SurrealDB
                // collapses multiple NONEs into one UNIQUE bucket, so omitting
                // it let only the FIRST orphan row ever land and silently
                // dropped every later one as a fake "sibling won race".
                run_id: corrKey,
              },
            },
          );
          // Wave 3: when the Stop arrived with only agent_id (and we had
          // zero in-flight subagents to match), this is diagnostic noise —
          // the spawn row may have been written to a DIFFERENT session row
          // (Claude Code creates a new session row on each resume; same
          // kc_session_id maps to multiple session record ids). Demote to
          // debug to keep the warn channel clean for real failures.
          if (hasToolUseCorrelation) {
            log.warn(`[subagent] orphan stop: no spawn row matched. session=${sessionId} agent_type=${agentType}`);
          } else {
            log.debug(`[subagent] orphan stop (agent_id-only, no in-flight stash). session=${sessionId} agent_type=${agentType}`);
          }
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
