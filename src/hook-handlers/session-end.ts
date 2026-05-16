/**
 * SessionEnd hook handler.
 *
 * Queues cognitive work (extraction, reflection, skills, soul) to the
 * pending_work table for processing by a subagent on the next session.
 * No LLM calls — all intelligence runs through Claude subagents.
 *
 * Concurrency: the atomic `claimSessionForCleanup(id)` UPDATE on the
 * session record is the sole arbiter for "who handles this session" —
 * the prior `session.cleanedUp` in-memory guard was defeated by
 * `state.removeSession()` (a follow-up event recreated a fresh
 * SessionState with cleanedUp=false), and never coordinated against
 * deferredCleanup running on a sibling SessionStart.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { hasSoul, checkStageTransition } from "../engine/soul.js";
import { writeHandoffFileSync } from "../engine/handoff-file.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { triggerDrainCheck } from "../daemon/auto-drain.js";

export async function handleSessionEnd(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  log.info(`Session end: ${sessionId}`);

  const { store } = state;
  if (!store.isAvailable()) return {};

  // The atomic DB claim is now the single source of truth for "this session
  // has been cleaned up". Without a surrealSessionId there is no row to claim,
  // so just bail — there's nothing to queue against.
  if (!session.surrealSessionId) {
    state.removeSession(sessionId);
    return {};
  }

  let won = false;
  try {
    won = await store.claimSessionForCleanup(session.surrealSessionId);
  } catch (e) {
    swallow.warn("sessionEnd:claim", e);
    // Claim failed for an unexpected reason — don't proceed. Don't remove
    // session state either: the next SessionEnd retry (or deferredCleanup
    // on the next boot) needs a chance to handle it.
    return {};
  }
  if (!won) {
    // A sibling (deferredCleanup, or a duplicate SessionEnd event) already
    // claimed this session. They will queue the work and write the handoff
    // file; we just drop our in-memory state.
    log.info(`Session end: ${sessionId} already claimed; skipping`);
    state.removeSession(sessionId);
    return {};
  }

  // We won the claim. From here on out, on any total failure we must
  // releaseSessionClaim() so the next boot retries.

  // Queue cognitive work for subagent processing on next session
  const queueOps: Promise<unknown>[] = [];

  // Coalesced extraction — combines extraction + handoff + reflection + skills
  if (session.userTurnCount >= 2) {
    queueOps.push(
      store.queryExec(`CREATE pending_work CONTENT $data`, {
        data: {
          work_type: "coalesced_extraction",
          session_id: session.sessionId,
          surreal_session_id: session.surrealSessionId,
          task_id: session.taskId,
          project_id: session.projectId,
          payload: {
            turn_count: session.userTurnCount,
            include_handoff: true,
            include_reflection: session.userTurnCount >= 3,
          },
          priority: 1,
        },
      }),
    );
  }

  // Causal chain graduation
  queueOps.push(
    store.queryExec(`CREATE pending_work CONTENT $data`, {
      data: {
        work_type: "causal_graduate",
        session_id: session.sessionId,
        surreal_session_id: session.surrealSessionId,
        task_id: session.taskId,
        project_id: session.projectId,
        priority: 7,
      },
    }),
  );

  // Soul graduation or evolution
  const soulExists = await hasSoul(store).catch(() => false);
  queueOps.push(
    store.queryExec(`CREATE pending_work CONTENT $data`, {
      data: {
        work_type: soulExists ? "soul_evolve" : "soul_generate",
        session_id: session.sessionId,
        surreal_session_id: session.surrealSessionId,
        task_id: session.taskId,
        project_id: session.projectId,
        priority: 9,
      },
    }),
  );

  const results = await Promise.allSettled(queueOps);
  const failures = results.filter(r => r.status === "rejected");
  for (const f of failures) {
    if (f.status === "rejected") swallow.warn("sessionEnd:queue", f.reason);
  }
  // If every CREATE failed (e.g. all rejected by Agent 1's UNIQUE index
  // because a sibling already queued them), our claim is unhelpful — release
  // so the next boot's deferredCleanup can re-attempt. If at least one
  // landed, treat the claim as honored: the survivors will run, and a
  // partial repeat next boot would itself hit the same UNIQUE index.
  if (failures.length === results.length && results.length > 0) {
    await store.releaseSessionClaim(session.surrealSessionId).catch(e =>
      swallow("sessionEnd:release", e),
    );
    log.info(`Session end: all ${results.length} CREATEs rejected for ${sessionId}; released claim`);
    state.removeSession(sessionId);
    return {};
  }

  // Stage transition check (no LLM needed — reads DB directly)
  try {
    const transition = await checkStageTransition(store);
    if (transition.transitioned) {
      log.info(`[MATURITY] ${transition.previousStage ?? "nascent"} → ${transition.currentStage}`);
    }
  } catch (e) {
    swallow("sessionEnd:stageTransition", e);
  }

  // Write handoff file (sync, for crash safety). Only the claim-winner
  // writes the handoff — a losing sibling would just stomp identical data.
  try {
    writeHandoffFileSync({
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      userTurnCount: session.userTurnCount,
      lastUserText: session.lastUserText.slice(0, 500),
      lastAssistantText: session.lastAssistantText.slice(0, 500),
      unextractedTokens: 0,
    }, state.workspaceDir ?? process.cwd());
  } catch (e) {
    swallow.warn("sessionEnd:handoff", e);
  }

  // Cleanup session from state
  state.removeSession(sessionId);

  // Clear the cleanup_claim_token now that the work is queued and the handoff
  // is written. The token is only useful between claim and completion;
  // leaving it makes every successful SessionEnd accumulate a UUID-sized
  // field that never gets reused. clearSessionClaim leaves cleanup_completed
  // = true so the row stays "done". Only fires on the win path (we held the
  // claim) — losing paths above bail before reaching here and the winner is
  // responsible for token cleanup.
  // Retry-once with 1s backoff: same rationale as the deferred-cleanup
  // path — a transient SurrealDB blip shouldn't leave the cleanup_claim_token
  // stranded on the row when one quick retry would clear it. swallow.warn
  // fires only after both attempts fail.
  await store.clearSessionClaim(session.surrealSessionId).catch(async (e1) => {
    await new Promise(r => setTimeout(r, 1000));
    await store.clearSessionClaim(session.surrealSessionId).catch(e2 => {
      // swallow.warn does String(err) for non-Error → "[object Object]".
      // Build a synthetic Error so both attempts surface in the warn line.
      const combined = new Error(
        `first=${e1 instanceof Error ? e1.message : String(e1)} | retry=${e2 instanceof Error ? e2.message : String(e2)}`,
      );
      swallow.warn("session-end:clearSessionClaim", combined);
    });
  });

  // Trigger auto-drain — this session just queued 2-3 items; let the
  // scheduler decide whether to spawn a headless extractor right now
  // (gated by threshold + PID-file lock). Fire-and-forget. No-op when
  // KONGCODE_AUTO_DRAIN=0 or queue is below threshold.
  triggerDrainCheck(
    state,
    {
      threshold: Number(process.env.KONGCODE_AUTO_DRAIN_THRESHOLD ?? 5),
      intervalMs: 0,
      cacheDir: state.config.paths.cacheDir,
      maxDaily: Number(process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY ?? 50),
    },
    "session-end",
  );

  return {};
}
