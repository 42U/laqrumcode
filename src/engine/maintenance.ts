/**
 * Background maintenance — fired on MCP boot and on every SessionStart.
 *
 * Restores the five jobs that used to live in KongBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. KongCode has no such framework call, so these had been silently
 * not running since the port. See GitHub issue history around 2026-04-21.
 *
 * Each job is internally bounded (count<=200/2000/50 safety floors, LIMIT 50
 * on destructive operations) and idempotent, so it's safe to run on every
 * MCP boot AND on every SessionStart. The ACAN retrain carries its own
 * lockfile from acan.ts preventing concurrent retrains across sibling MCPs.
 *
 * Fire-and-forget — the caller should not await this. Errors go to
 * swallow.warn so they're visible without blocking startup.
 */

import type { GlobalPluginState } from "./state.js";
import { checkACANReadiness } from "./acan.js";
import { swallow } from "./errors.js";

export function runBootstrapMaintenance(state: GlobalPluginState): void {
  const { store, embeddings, config } = state;
  const deferMs = Number(process.env.KONGCODE_MAINTENANCE_DEFER_MS) || 30_000;

  // Group 1: cheap DB queries — safe to run immediately in parallel
  Promise.all([
    store.runMemoryMaintenance(),
    store.purgeStalePendingWork(),
    purgeStaleEmbedCache(state),
  ]).then(async () => {
    // Group 2: moderate cost — after cheap queries complete
    await store.archiveOldTurns().catch(e => swallow.warn("maintenance:archiveOldTurns", e));
    await store.garbageCollectMemories().catch(e => swallow.warn("maintenance:gcMemories", e));
    await store.garbageCollectConcepts().catch(e => swallow.warn("maintenance:gcConcepts", e));
    await backfillSessionTurnCounts(state);
  }).catch(e => swallow.warn("bootstrap:maintenance:group2", e));

  // Group 3: CPU-heavy — deferred so first-turn context assembly is uncontested
  const heavyTimer = setTimeout(async () => {
    try {
      await store.consolidateMemories((text) => embeddings.embed(text));
    } catch (e) { swallow.warn("maintenance:consolidate", e); }
    try {
      await checkACANReadiness(store, config.thresholds.acanTrainingThreshold);
    } catch (e) { swallow.warn("maintenance:acan", e); }
  }, deferMs);
  heavyTimer.unref?.();
}

/** One-shot reconciliation: every session row pre-0.7.12 has turn_count=0
 *  because the increment lived in Stop and Stop's been flaky. The `turn`
 *  table has the truth — every ingested turn carries its session_id.
 *  Reconstruct turn_count from turn rows for any session with turn_count=0
 *  or NONE. Idempotent (only updates rows where turn_count is missing/zero
 *  AND the turn table has matching rows), so running on every daemon
 *  startup is safe. Cheap: a single grouped query plus N small updates,
 *  where N = sessions-needing-backfill (one-time, drops to ~0 going forward
 *  since 0.7.12+ writes turn_count on UserPromptSubmit). */
async function backfillSessionTurnCounts(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  try {
    // turn.session_id stores the Claude Code session id (a UUID string), NOT
    // a SurrealDB record id. So we look up the matching session row via the
    // kc_session_id field, not by interpolating into the UPDATE target.
    // (Earlier 0.7.12 attempt did the wrong thing and tripped SurrealDB's
    // SQL parser on UUIDs that contain hex sequences read as arithmetic.)
    const counts = await state.store.queryFirst<{ session_id: string; n: number }>(
      `SELECT session_id, count() AS n FROM turn WHERE session_id IS NOT NONE GROUP BY session_id`,
    );
    if (!counts.length) return;
    for (const row of counts) {
      if (!row?.session_id || !row?.n) continue;
      try {
        await state.store.queryExec(
          `UPDATE session SET turn_count = $n
            WHERE kc_session_id = $kc
              AND (turn_count == 0 OR turn_count IS NONE)`,
          { n: row.n, kc: row.session_id },
        );
      } catch (e) {
        swallow.warn("maintenance:backfillTurnCount:update", e);
      }
    }
  } catch (e) {
    swallow.warn("maintenance:backfillTurnCount", e);
  }
}

async function purgeStaleEmbedCache(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  try {
    await state.store.queryExec(
      `DELETE FROM embedding_cache WHERE id IN (SELECT id FROM embedding_cache WHERE created_at < time::now() - 30d LIMIT 500)`,
    );
  } catch (e) {
    swallow.warn("maintenance:purgeEmbedCache", e);
  }
}
