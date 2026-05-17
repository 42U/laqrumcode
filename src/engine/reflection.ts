/**
 * Metacognitive Reflection
 *
 * At session end, reviews own performance: tool failures, runaway detections,
 * low retrieval utilization, wasted tokens. If problems exceeded thresholds,
 * generates a structured reflection via the configured LLM, stored as high-importance memory.
 * Retrieved when similar situations arise in future sessions.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */

import type { SurrealStore } from "./surreal.js";
import { swallow, safeId } from "./errors.js";
import { cosineSimilarity } from "./graph-context.js";

// --- Types ---

export interface Reflection {
  id: string;
  text: string;
  category: string;
  severity: string;
  importance: number;
  score?: number;
}

// --- Reflection Retrieval ---

/**
 * Vector search on the reflection table.
 *
 * 0.7.26: optional projectId scopes reflections to those originating from
 * sessions in the same project (or marked scope='global'). Reflections are
 * session-keyed and sessions are project-keyed via task_part_of, so we filter
 * by traversing reflection.session_id → session.project_id. Soft filter:
 * reflections without a resolvable project still surface (back-compat).
 */
export async function retrieveReflections(
  queryVec: number[],
  limit = 3,
  store?: SurrealStore,
  projectId?: string,
): Promise<Reflection[]> {
  if (!store?.isAvailable()) return [];

  try {
    const projectFilter = projectId
      ? ` AND (project_id IS NONE OR project_id = $pid OR scope = 'global'
               OR session_id IN (SELECT id FROM session WHERE project_id = $pid))`
      : "";
    const bindings: Record<string, unknown> = { vec: queryVec, lim: limit };
    if (projectId) bindings.pid = projectId;
    const rows = await store.queryFirst<any>(
      `SELECT id, text, category, severity, importance, embedding,
              vector::similarity::cosine(embedding, $vec) AS score
       FROM reflection
       WHERE embedding != NONE AND array::len(embedding) > 0
         AND (active = true OR active IS NONE)${projectFilter}
       ORDER BY score DESC LIMIT $lim`,
      bindings,
    );

    const filtered = rows.filter((r: any) => (r.score ?? 0) > 0.35);

    // Cosine dedup: near-duplicate reflections waste context budget.
    // Jaccard fails on long texts with high semantic but low lexical overlap.
    // Pairwise cosine on embeddings catches semantic duplicates reliably.
    const deduped: typeof filtered = [];
    for (const r of filtered) {
      if (!r.embedding?.length) { deduped.push(r); continue; }
      const isDup = deduped.some((existing) => {
        if (!existing.embedding?.length) return false;
        return cosineSimilarity(r.embedding, existing.embedding) > 0.80;
      });
      if (!isDup) deduped.push(r);
    }

    return deduped.map((r: any) => ({
      id: safeId(r.id),
      text: r.text ?? "",
      category: r.category ?? "efficiency",
      severity: r.severity ?? "minor",
      importance: Number(r.importance ?? 7.0),
      score: r.score,
    })).filter(r => r.id);
  } catch (e) {
    swallow.warn("reflection:retrieve", e);
    return [];
  }
}

/**
 * Format reflections as a context block for the LLM.
 */
export function formatReflectionContext(reflections: Reflection[]): string {
  if (reflections.length === 0) return "";

  const lines = reflections.map((r) => {
    return `[reflection/${r.category}] ${r.text}`;
  });

  return `\n<reflection_context>\n[Lessons from past sessions — avoid repeating these mistakes]\n${lines.join("\n\n")}\n</reflection_context>`;
}

/**
 * Get reflection count (for /stats display).
 */
export async function getReflectionCount(store: SurrealStore): Promise<number> {
  try {
    if (!store.isAvailable()) return 0;
    const rows = await store.queryFirst<{ count: number }>(
      `SELECT count() AS count FROM reflection
       WHERE (active = true OR active IS NONE)
       GROUP ALL`,
    );
    return Number(rows[0]?.count ?? 0);
  } catch (e) {
    swallow.warn("reflection:count", e);
    return 0;
  }
}
