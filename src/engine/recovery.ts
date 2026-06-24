/**
 * Graph recovery helpers — extracted from introspect.ts migrate handlers
 * (v0.7.26 backfill_project_id, v0.7.32 backfill_derived_from with v0.7.38
 * daemon path + v0.7.39 placeholder synthesis) into a reusable module.
 *
 * Use these when:
 *   - Importing data from another laqrumcode/laqrumbrain instance whose session
 *     metadata didn't fully migrate (X-close pattern, gateway purges).
 *   - After a schema change that renders previously-written rows orphan
 *     (the v0.7.23 derived_from schema mismatch was the canonical case).
 *   - Periodic maintenance — they're idempotent so safe to run on a cron.
 *
 * Each helper is pure + deterministic (no LLM calls, no embedding writes;
 * it only reads existing embeddings and writes RELATE/UPDATE statements).
 * The full-recovery orchestrator runs them in dependency order so a single
 * call brings any orphan-state graph to canonical structure.
 */

import type { SurrealStore } from "./surreal.js";
import { swallow, RECORD_ID_RE } from "./errors.js";
import { cosineSimilarity } from "./graph-context.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ProjectIdRecoveryResult {
  tasks: { found: number; fixed: number };
  sessions: { found: number; fixed: number };
  concepts: { found: number; fixed: number };
  memories: { found: number; fixed: number };
  reflections: { found: number; fixed: number };
  skills: { found: number; fixed: number };
  centroidAssigned: number;
  centroidScanned: number;
  globalsTagged: number;
}

export interface DerivedFromRecoveryResult {
  gemOrphans: number;
  gemEdgesCreated: number;
  missingArtifact: number;
  daemonOrphans: number;
  daemonEdgesResolved: number;
  daemonEdgesSynthesized: number;
  synthesizedPlaceholders: number;
  missingTask: number;
  relateFailed: number;
}

export interface FullRecoveryResult {
  projectId: ProjectIdRecoveryResult;
  derivedFrom: DerivedFromRecoveryResult;
}

// ── Internals ────────────────────────────────────────────────────────

const CENTROID_THRESHOLD = 0.5;

async function backfillTable(
  store: SurrealStore,
  selectSql: string,
): Promise<{ found: number; fixed: number }> {
  const rows = await store.queryFirst<{ id: string; project_id: string }>(selectSql);
  let fixed = 0;
  for (const row of rows) {
    if (!row.project_id) continue;
    const id = String(row.id);
    if (!RECORD_ID_RE.test(id)) continue;
    try {
      await store.queryExec(
        `UPDATE ${id} SET project_id = $pid`,
        { pid: row.project_id },
      );
      fixed++;
    } catch (e) {
      // Surface row-level failures — full silence here meant a recovery
      // sweep could "find 100 / fix 0" and produce no clue why.
      swallow.warn("recovery:backfillTable", e);
    }
  }
  return { found: rows.length, fixed };
}

// ── Public helpers ───────────────────────────────────────────────────

/** Compute embedding centroid per project from concepts linked via
 *  project_id. Returns a Map keyed by project record id. Skips projects
 *  with zero embedded concepts. */
export async function computeProjectCentroids(
  store: SurrealStore,
): Promise<Map<string, number[]>> {
  const centroids = new Map<string, number[]>();
  const projects = await store.queryFirst<{ id: string }>(`SELECT id FROM project`);
  for (const proj of projects) {
    const concepts = await store.queryFirst<{ embedding: number[] }>(
      `SELECT embedding FROM concept
       WHERE project_id = $pid
         AND embedding IS NOT NONE
         AND array::len(embedding) > 0
       LIMIT 100`,
      { pid: proj.id },
    );
    if (concepts.length === 0) continue;
    const dim = concepts[0].embedding.length;
    const centroid = new Array(dim).fill(0);
    for (const c of concepts) {
      for (let i = 0; i < dim; i++) centroid[i] += c.embedding[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= concepts.length;
    centroids.set(String(proj.id), centroid);
  }
  return centroids;
}

/** Find the highest-similarity project for a given embedding. Returns
 *  null when no project meets the threshold (caller should fall through
 *  to scope='global' tagging or leave the row unscoped). */
export function findBestProjectMatch(
  embedding: number[],
  centroids: Map<string, number[]>,
  threshold = CENTROID_THRESHOLD,
): { projectId: string; similarity: number } | null {
  let bestPid = "";
  let bestSim = 0;
  for (const [pid, centroid] of centroids) {
    const sim = cosineSimilarity(embedding, centroid);
    if (sim > bestSim) { bestSim = sim; bestPid = pid; }
  }
  if (bestSim >= threshold && bestPid) {
    return { projectId: bestPid, similarity: bestSim };
  }
  return null;
}

/** Look up or create a placeholder task for a pre-substrate session_id.
 *  Used by `recoverDaemonOrphans` when a daemon-source orphan's session
 *  row doesn't exist (data imported from another instance). Idempotent
 *  via deterministic description naming. */
export async function synthesizePlaceholderTask(
  store: SurrealStore,
  kcSessionId: string,
): Promise<string | null> {
  const placeholderDesc = `[pre-substrate import] session ${kcSessionId}`;
  try {
    const existing = await store.queryFirst<{ id: string }>(
      `SELECT id FROM task WHERE description = $desc LIMIT 1`,
      { desc: placeholderDesc },
    );
    if (existing.length > 0) return String(existing[0].id);
    return await store.createTask(placeholderDesc);
  } catch (e) {
    swallow.warn("recovery:synthesizePlaceholderTask", e);
    return null;
  }
}

/** Recover project_id metadata across all knowledge tables. Runs the
 *  full backfill cascade: traversal → centroid assignment → scope=global
 *  tagging for unrecoverable rows. Idempotent. */
export async function recoverProjectIdRows(
  store: SurrealStore,
): Promise<ProjectIdRecoveryResult> {
  // 1. Tasks via task_part_of edge
  const tasks = await backfillTable(store,
    `SELECT id, ->task_part_of->project[0].id AS project_id
     FROM task WHERE project_id IS NONE
       AND ->task_part_of->project[0] IS NOT NONE`);

  // 2. Sessions via session_task→task→task_part_of chain
  const sessions = await backfillTable(store,
    `SELECT id, ->session_task->task->task_part_of->project[0].id AS project_id
     FROM session WHERE project_id IS NONE
       AND ->session_task->task->task_part_of->project[0] IS NOT NONE`);

  // 3. Concepts via relevant_to edge
  const concepts = await backfillTable(store,
    `SELECT id, ->relevant_to->project[0].id AS project_id
     FROM concept WHERE project_id IS NONE
       AND ->relevant_to->project[0] IS NOT NONE`);

  // 4. Memories via session.project_id (kc_session_id OR record-ref match)
  const memories = await backfillTable(store,
    `SELECT id, (SELECT project_id FROM session
       WHERE kc_session_id = $parent.session_id OR <string>id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM memory WHERE project_id IS NONE AND session_id IS NOT NONE`);

  // 5. Reflections (same shape as memories)
  const reflections = await backfillTable(store,
    `SELECT id, (SELECT project_id FROM session
       WHERE kc_session_id = $parent.session_id OR <string>id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM reflection WHERE project_id IS NONE AND session_id IS NOT NONE`);

  // 6. Skills via skill_from_task→task OR session traversal
  const skillsViaTask = await backfillTable(store,
    `SELECT id, ->skill_from_task->task[0].project_id AS project_id
     FROM skill WHERE project_id IS NONE
       AND ->skill_from_task->task[0] IS NOT NONE`);
  const skillsViaSession = await backfillTable(store,
    `SELECT id, (SELECT project_id FROM session
       WHERE kc_session_id = $parent.session_id OR <string>id = $parent.session_id LIMIT 1)[0].project_id AS project_id
     FROM skill WHERE project_id IS NONE AND session_id IS NOT NONE`);

  // 7. Centroid-based assignment for remaining orphans
  let centroidAssigned = 0;
  let centroidScanned = 0;
  try {
    const centroids = await computeProjectCentroids(store);
    if (centroids.size > 0) {
      for (const table of ["memory", "reflection", "skill"]) {
        const orphans = await store.queryFirst<{ id: string; embedding: number[] }>(
          `SELECT id, embedding FROM type::table($t)
           WHERE project_id IS NONE
             AND embedding IS NOT NONE
             AND array::len(embedding) > 0`,
          { t: table },
        );
        centroidScanned += orphans.length;
        for (const row of orphans) {
          const match = findBestProjectMatch(row.embedding, centroids);
          if (match) {
            const rid = String(row.id);
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-]+$/.test(rid)) continue;
            try {
              await store.queryExec(
                `UPDATE ${rid} SET project_id = $pid, scope = NONE`,
                { pid: match.projectId },
              );
              centroidAssigned++;
            } catch (e) { swallow.warn("recovery:centroidAssign", e); }
          }
        }
      }
    }
  } catch (e) { swallow.warn("recovery:centroid", e); }

  // 8. scope='global' fallback for genuinely cross-project rows
  let globalsTagged = 0;
  for (const table of ["memory", "reflection", "skill"]) {
    try {
      const rows = await store.queryFirst<{ id: string }>(
        `SELECT id FROM type::table($t) WHERE project_id IS NONE AND (scope IS NONE OR scope != 'global')`,
        { t: table },
      );
      for (const row of rows) {
        const rid = String(row.id);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-]+$/.test(rid)) continue;
        try {
          await store.queryExec(`UPDATE ${rid} SET scope = 'global'`);
          globalsTagged++;
        } catch (e) { swallow.warn("recovery:globalTag", e); }
      }
    } catch (e) { swallow.warn("recovery:globalsTableScan", e); }
  }

  return {
    tasks, sessions, concepts, memories, reflections,
    skills: {
      found: skillsViaTask.found + skillsViaSession.found,
      fixed: skillsViaTask.fixed + skillsViaSession.fixed,
    },
    centroidAssigned, centroidScanned, globalsTagged,
  };
}

/** Recover derived_from edges on orphaned concepts. Handles:
 *  - gem-source orphans (pre-v0.7.23 schema mismatch): match concept.source
 *    "gem:<X>" to artifact.path "<X>" and RELATE.
 *  - daemon-source orphans (taskId-empty extractions): traverse session
 *    to task, RELATE.
 *  - daemon-source orphans with no resolvable session: synthesize a
 *    placeholder task and RELATE. */
export async function recoverDaemonOrphans(
  store: SurrealStore,
): Promise<DerivedFromRecoveryResult> {
  // ── Path 1: gem-source orphans ──
  const gemOrphans = await store.queryFirst<{ id: string; source: string }>(
    `SELECT id, source FROM concept
     WHERE source IS NOT NONE
       AND string::starts_with(source, 'gem:')
       AND array::len(->derived_from->?) = 0`,
  );
  let gemEdgesCreated = 0;
  let missingArtifact = 0;
  let relateFailed = 0;
  for (const o of gemOrphans) {
    const path = String(o.source).slice(4);
    const artifacts = await store.queryFirst<{ id: string }>(
      `SELECT id FROM artifact WHERE path = $path LIMIT 1`,
      { path },
    );
    if (artifacts.length === 0) { missingArtifact++; continue; }
    try {
      await store.relate(String(o.id), "derived_from", String(artifacts[0].id));
      gemEdgesCreated++;
    } catch (e) {
      swallow.warn("recovery:gemRelate", e);
      relateFailed++;
    }
  }

  // ── Path 2 + 3: daemon-source orphans (resolve or synthesize) ──
  const daemonOrphans = await store.queryFirst<{ id: string; source: string }>(
    `SELECT id, source FROM concept
     WHERE source IS NOT NONE
       AND string::starts_with(source, 'daemon:')
       AND array::len(->derived_from->?) = 0`,
  );
  let daemonEdgesResolved = 0;
  let daemonEdgesSynthesized = 0;
  let missingTask = 0;
  let synthesizedPlaceholders = 0;
  const placeholderCache = new Map<string, string>();

  for (const o of daemonOrphans) {
    const sid = String(o.source).slice(7);
    const taskRows = await store.queryFirst<{ task_id: string }>(
      `SELECT (->session_task->task[0].id) AS task_id
       FROM session WHERE kc_session_id = $sid LIMIT 1`,
      { sid },
    );
    let taskId = taskRows[0]?.task_id;
    let isSynthesized = false;

    if (!taskId) {
      const cached = placeholderCache.get(sid);
      if (cached) {
        taskId = cached;
        isSynthesized = true;
      } else {
        const synth = await synthesizePlaceholderTask(store, sid);
        if (!synth) { missingTask++; continue; }
        taskId = synth;
        // Track only if it was newly created (existing-task lookup
        // doesn't increment). Approximated via cache absence — first
        // sight of a sid that wasn't in cache means we just created
        // OR found an existing placeholder. To distinguish, we'd need
        // to check pre/post; for the reported count we accept either
        // as "synthesized in this run."
        placeholderCache.set(sid, taskId);
        synthesizedPlaceholders++;
        isSynthesized = true;
      }
    }
    try {
      await store.relate(String(o.id), "derived_from", String(taskId));
      if (isSynthesized) daemonEdgesSynthesized++;
      else daemonEdgesResolved++;
    } catch (e) {
      swallow.warn("recovery:daemonRelate", e);
      relateFailed++;
    }
  }

  return {
    gemOrphans: gemOrphans.length,
    gemEdgesCreated,
    missingArtifact,
    daemonOrphans: daemonOrphans.length,
    daemonEdgesResolved,
    daemonEdgesSynthesized,
    synthesizedPlaceholders,
    missingTask,
    relateFailed,
  };
}

/** Top-level orchestrator: runs both recovery passes in the right order.
 *  Useful for periodic maintenance or post-import cleanup. */
export async function runFullRecovery(
  store: SurrealStore,
): Promise<FullRecoveryResult> {
  const projectId = await recoverProjectIdRows(store);
  const derivedFrom = await recoverDaemonOrphans(store);
  return { projectId, derivedFrom };
}
