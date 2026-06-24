/**
 * SessionStart hook handler.
 *
 * Bootstraps the session: creates 5-pillar graph nodes, applies schema,
 * synthesizes wakeup briefing, runs deferred cleanup.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { seedIdentity } from "../engine/identity.js";
import { seedCognitiveBootstrap } from "../engine/cognitive-bootstrap.js";
import { seedHookProfileDirective } from "../engine/hooks/profile.js";
import { listGates } from "../engine/hooks/gate-registry.js";
import { synthesizeWakeup } from "../engine/wakeup.js";
import { runDeferredCleanup } from "../engine/deferred-cleanup.js";
import { getSoul } from "../engine/soul.js";
import { hasMigratableFiles } from "../engine/workspace-migrate.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { assertRecordId } from "../engine/surreal.js";
import { runBootstrapMaintenance } from "../engine/maintenance.js";
import { checkStageTransition } from "../engine/soul.js";
import { countActionablePendingWork } from "../tools/pending-work.js";

export async function handleSessionStart(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getOrCreateSession(sessionId, sessionId);

  log.info(`Session start: ${sessionId}`);

  const { store, embeddings } = state;

  // Schema is applied during store.initialize() — no separate call needed.

  // Bootstrap 5-pillar nodes
  if (store.isAvailable()) {
    try {
      session.agentId = await store.ensureAgent("laqrumcode", "claude");

      const cwd = (payload.cwd as string) ?? state.workspaceDir ?? process.cwd();
      const projectName = cwd.split("/").pop() ?? "unknown";
      session.projectId = await store.ensureProject(projectName);

      // T5: pillar wiring failures were silent for their entire life (the
      // linkToProject no-op shipped invisibly for months) — warn from now on.
      await store.linkAgentToProject(session.agentId, session.projectId)
        .catch(e => swallow.warn("sessionStart:linkAgentToProject", e));

      session.taskId = await store.createTask(`Session in ${projectName}`, session.projectId);
      await store.linkAgentToTask(session.agentId, session.taskId)
        .catch(e => swallow.warn("sessionStart:linkAgentToTask", e));
      await store.linkTaskToProject(session.taskId, session.projectId)
        .catch(e => swallow.warn("sessionStart:linkTaskToProject", e));

      session.surrealSessionId = await store.createSession(session.agentId, session.sessionId, session.projectId);
      // Loud-fail if createSession resolved to an empty string. SurrealDB
      // returning NONE that gets coerced silently leaves this field empty
      // and downstream commits (commit:subagent:*:derived_from_session_fallback)
      // then reject with "Invalid record ID format" far away from the actual
      // origin. We log.error here so the failure surfaces at the point of
      // origin; we do NOT throw — the session proceeds in degraded mode
      // rather than killing all hooks for the session. The error is the
      // diagnostic signal.
      if (!session.surrealSessionId) {
        log.error(`[session-start] store.createSession returned empty surrealSessionId for session=${sessionId}; downstream commits will fail`);
      }
      await store.markSessionActive(session.surrealSessionId)
        .catch(e => swallow.warn("sessionStart:markActive", e));
      await store.linkSessionToTask(session.surrealSessionId, session.taskId)
        .catch(e => swallow.warn("sessionStart:linkSessionToTask", e));

      // Seed identity and cognitive bootstrap (idempotent). T5: failed
      // seeding was the 0/15 fresh-install bug class — warn, never silent.
      await seedIdentity(store, embeddings).catch(e => swallow.warn("sessionStart:identity", e));
      await seedCognitiveBootstrap(store, embeddings).catch(e => swallow.warn("sessionStart:cognitive", e));
      await seedHookProfileDirective(store, listGates()).catch(e => swallow.warn("sessionStart:hookProfile", e));

      // Run deferred cleanup for orphaned sessions (warn per the severity
      // contract: cleanup failure is "unexpected but recoverable")
      await runDeferredCleanup(store).catch(e => swallow.warn("sessionStart:deferredCleanup", e));

      // Check for unacknowledged graduation events from previous sessions
      try {
        const gradEvents = await store.queryFirst<{
          id: string; quality_score: number; volume_score: number;
        }>(`SELECT * FROM graduation_event WHERE acknowledged = false ORDER BY created_at DESC LIMIT 1`);
        if (gradEvents.length > 0) {
          const evt = gradEvents[0];
          const soul = await getSoul(store);
          if (soul) {
            session._graduationCelebration = {
              qualityScore: evt.quality_score,
              volumeScore: evt.volume_score,
              soulSummary: "Working style: " + soul.working_style.join("; ") +
                "\nSelf-observations: " + soul.self_observations.join("; "),
            };
            // Mark as acknowledged
            try {
              assertRecordId(evt.id);
              await store.queryExec(
                `UPDATE ${evt.id} SET acknowledged = true, acknowledged_at = time::now(), acknowledged_session = $sid`,
                { sid: session.sessionId },
              );
            } catch (e) {
              swallow("sessionStart:ackGraduation", e);
            }
            log.info("[GRADUATION] Celebration queued for context injection");
          }
        }
      } catch (e) {
        swallow("sessionStart:graduationCheck", e);
      }

      // Check for migratable workspace files
      session._hasMigratableFiles = await hasMigratableFiles(cwd)
        .catch(() => false);
    } catch (e) {
      swallow.warn("sessionStart:bootstrap", e);
    }

    // Bootstrap-maintenance retry hook (0.7.118): the daemon boot is the
    // canonical caller and a once-per-process guard makes this a no-op in
    // the normal case. It still matters on a DEGRADED boot — when the store
    // was down at daemon start the guard stays unlatched, and this call
    // (plus the 5-min self-retry) runs maintenance once the store recovers.
    runBootstrapMaintenance(state);

    // Record maturity stage at every session-start. Previously this only
    // fired from midSessionCleanup (gated on 25K+ tokens in one session),
    // so short/frequent sessions never wrote a maturity_stage row — the
    // table stayed empty. Now every session baselines the current stage,
    // and transitions are captured in real time.
    checkStageTransition(store)
      .then(t => {
        if (t.transitioned) {
          log.info(`[MATURITY] ${t.previousStage ?? "nascent"} → ${t.currentStage}. Quality ${t.report.qualityScore.toFixed(2)}`);
        }
      })
      .catch(e => swallow.warn("sessionStart:maturity", e));
  }

  // Synthesize wakeup briefing (async, result cached for UserPromptSubmit)
  if (store.isAvailable() && embeddings.isAvailable()) {
    session._wakeupPromise = synthesizeWakeup(store, session.sessionId)
      .catch(e => { swallow("sessionStart:wakeup", e); return null; });
  }

  // If wakeup is fast, include it in the session start response.
  //
  // Promise.race timer cleanup: mirrors the embeddings.ts:159-195 pattern.
  // Without clearTimeout on the timeout handle, the underlying Timer stays
  // armed for the full 5s even after the wakeup promise resolves first —
  // keeping the Node event loop alive that long past actual completion. On
  // a short-lived hook process (the daemon will eventually exit between
  // sessions) that's a meaningful lifetime extension. capture handle,
  // clearTimeout in `.finally()` on every exit path (race win, race loss,
  // wakeup throw).
  let wakeupText: string | null = null;
  if (session._wakeupPromise) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      wakeupText = await Promise.race([
        session._wakeupPromise,
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), 5000);
        }),
      ]);
    } catch { /* wakeup will be injected on next UserPromptSubmit */ }
    finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Surface pending_work backlog so the assistant knows to drain. The queue
  // is consumer-pull (subagents call fetch_pending_work) and items are
  // silently GC'd after 7d if not processed (issue #5). Lowered threshold
  // from `>= 5` to `>= 1` so small backlogs don't sit invisible on short
  // sessions and quietly age out. Imperative copy so the assistant treats
  // it as a directive, not info. user-prompt-submit also surfaces this on
  // every first turn — both paths together close the visibility gap that
  // the original `>= 5` threshold opened.
  let pendingNote: string | null = null;
  if (store.isAvailable()) {
    try {
      // Actionable count, not raw queue depth. W2-04 added the active filter so
      // soft-archived rows stopped triggering phantom drains; this is the next
      // layer (2026-06-18): session-end ALWAYS enqueues causal_graduate +
      // soul_evolve regardless of eligibility, and those self-complete empty
      // when drained. countActionablePendingWork runs the builders' own global
      // eligibility probes so the banner only fires when a drain would yield
      // real knowledge — fixing the recurring "DRAIN NOW, N items → empty
      // drain" report.
      const count = await countActionablePendingWork(store);
      if (count >= 1) {
        pendingNote = `[PENDING WORK — DRAIN NOW]\n${count} background item${count === 1 ? "" : "s"} waiting. Items older than 7 days are silently purged, so don't postpone. Spawn a laqrumcode:memory-extractor subagent (opus, run_in_background=true) and have it loop fetch_pending_work → commit_work_results until empty. Light types (reflection, handoff_note) can run inline.`;
      }
    } catch (e) {
      swallow("sessionStart:pendingWorkCheck", e);
    }
  }

  const parts = [wakeupText, pendingNote].filter((p): p is string => !!p);
  const additionalContext = parts.join("\n\n") || undefined;
  return makeHookOutput("SessionStart", additionalContext);
}
