/**
 * Deferred Cleanup — queue work for orphaned sessions.
 *
 * When the process dies abruptly (Ctrl+C×2, terminal X-button, WSL pause),
 * SessionEnd never fires. On every SessionStart, this module finds orphaned
 * sessions (started but never marked cleanup_completed), queues the same
 * pending_work items SessionEnd would have queued, and marks them ended.
 *
 * No LLM calls — all intelligence runs through Claude subagents via pending_work.
 */
import type { SurrealStore } from "./surreal.js";
import { hasSoul } from "./soul.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

// Per-process Set of surreal session record ids already processed this MCP boot.
// Replaces the prior once-per-process guard so new orphans accumulating during
// a long-running MCP get caught on each SessionStart, but already-queued ones
// are never re-queued.
const processedKey = Symbol.for("kongcode.deferredCleanup.processed");
const _g = globalThis as Record<symbol, unknown>;
function processed(): Set<string> {
  let s = _g[processedKey] as Set<string> | undefined;
  if (!s) {
    s = new Set<string>();
    _g[processedKey] = s;
  }
  return s;
}

const ORPHAN_LIMIT = 20;

export async function runDeferredCleanup(
  store: SurrealStore,
): Promise<number> {
  if (!store.isAvailable()) return 0;

  // Backfill kc_session_id on pre-0.5.5 session rows by walking part_of edges
  // to existing turn records. Without this, orphans created before 0.5.5 would
  // only get the unconditional causal_graduate/soul_evolve pair queued — their
  // transcripts would stay unrecoverable.
  try {
    const backfilled = await store.backfillOrphanKcSessionIds(50);
    if (backfilled > 0) log.info(`[deferred] backfilled kc_session_id on ${backfilled} pre-0.5.5 orphan sessions`);
  } catch (e) {
    swallow.warn("deferredCleanup:backfill", e);
  }

  let orphans;
  try {
    orphans = await store.getOrphanedSessions(ORPHAN_LIMIT);
  } catch (e) {
    swallow.warn("deferredCleanup:fetch", e);
    return 0;
  }
  if (orphans.length === 0) return 0;

  const seen = processed();
  let queued = 0;

  const soulExists = await hasSoul(store).catch(() => false);

  for (const session of orphans) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);

    try {
      const kcSid = session.kc_session_id ?? "";
      const turnCount = kcSid ? await store.countTurnsForSession(kcSid).catch(() => 0) : 0;

      const ops: Promise<unknown>[] = [];
      const queue = (data: Record<string, unknown>) => {
        ops.push(
          store.queryExec(`CREATE pending_work CONTENT $data`, { data })
            .catch(e => swallow("deferred:queue", e)),
        );
      };

      // Coalesced extraction — mirrors SessionEnd's coalesced approach.
      // If we don't have a kc_session_id (older row), skip to unconditional pair.
      if (kcSid && turnCount >= 2) {
        queue({
          work_type: "coalesced_extraction",
          session_id: kcSid,
          surreal_session_id: session.id,
          payload: {
            turn_count: turnCount,
            include_handoff: true,
            include_reflection: turnCount >= 3,
            source: "deferred_cleanup",
          },
          priority: 1,
        });
      }
      // Unconditional pair — no transcript needed; both auto-skip-complete
      // when nothing is eligible. Queueing them here gives orphan sessions
      // the same chance at causal graduation / soul evolution as graceful ones.
      queue({ work_type: "causal_graduate", session_id: kcSid || session.id, priority: 7 });
      queue({ work_type: soulExists ? "soul_evolve" : "soul_generate", session_id: kcSid || session.id, priority: 9 });

      await Promise.allSettled(ops);
      await store.markSessionEnded(session.id).catch(e => swallow("deferred:markEnded", e));

      log.info(`[deferred] queued ${ops.length} items for orphan ${session.id} (turns=${turnCount})`);
      queued += ops.length;
    } catch (e) {
      swallow.warn("deferredCleanup:session", e);
    }
  }

  return queued;
}
