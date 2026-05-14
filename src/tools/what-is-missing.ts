/**
 * what_is_missing MCP tool — proactive gap detection.
 *
 * Plain recall is reactive: "what is similar to X?". what_is_missing is
 * prospective: "given X, what ELSE in the graph might be relevant that
 * pure similarity wouldn't surface?"
 *
 * Algorithm:
 *   1. Vector-search the context for a seed set of concepts (top-N)
 *   2. Traverse narrower/broader/related_to edges from that seed
 *   3. Concepts reachable via the graph but NOT in the similarity top-N
 *      are the "gaps" — semantically adjacent content that plain recall
 *      wouldn't have pulled.
 *
 * The turn from reactive memory tool → brain is exactly this: a brain
 * volunteers "what you might be forgetting," a memory tool waits to be
 * asked.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { swallow, safeId } from "../engine/errors.js";
import { clamp } from "../engine/math.js";
import { stripStructuralTags } from "../engine/sanitize.js";

interface ConceptNode {
  id: string;
  content: string;
  score?: number;
}

/** High-frequency low-content tokens that auto-extraction has dumped into
 *  the graph as standalone concepts. They never represent a meaningful gap. */
const LOW_QUALITY_STOPLIST = new Set<string>([
  "WORK", "AND", "OR", "NOT", "ONE", "TWO", "ALL", "ANY", "NEW", "OLD",
  "CI", "CD", "OS", "DB", "ID", "PR", "QA", "API", "URL", "RPC", "SDK",
  "ATR", "EMA", "HIT", "POST", "GET", "PUT", "TCP",
  "function", "method", "class", "interface", "type", "Type", "Variant",
  "Node", "Edge", "Graph", "List", "Map", "Set", "Array", "Object",
  "test", "Test", "build", "Build", "true", "false", "null", "undefined",
]);

/** Reject concepts that are too short, too generic, or pure uppercase
 *  tokens — these are auto-extraction artifacts, not real concepts. */
function isLowQualityGap(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 5) return true;
  if (LOW_QUALITY_STOPLIST.has(trimmed)) return true;
  // Pure uppercase token of ≤ 6 chars (e.g. "WORK", "POST", "WHILE")
  if (/^[A-Z]{1,6}$/.test(trimmed)) return true;
  return false;
}

async function seedConceptsFromContext(
  state: GlobalPluginState,
  context: string,
  limit: number,
): Promise<ConceptNode[]> {
  if (!state.embeddings.isAvailable()) return [];
  try {
    const vec = await state.embeddings.embed(context);
    if (!vec?.length) return [];
    const rows = await state.store.queryFirst<{ id: string; content: string; score: number }>(
      `SELECT id, content, vector::similarity::cosine(embedding, $vec) AS score
       FROM concept
       WHERE embedding != NONE AND array::len(embedding) > 0 AND superseded_at IS NONE
       ORDER BY score DESC
       LIMIT $lim`,
      { vec, lim: limit },
    );
    return rows
      .filter(r => r.score >= 0.55)
      .map(r => ({
        id: safeId(r.id),
        content: String(r.content),
        score: Number(r.score),
      }))
      .filter(r => r.id);
  } catch (e) {
    swallow("whatIsMissing:seed", e);
    return [];
  }
}

async function collectGraphNeighbors(
  state: GlobalPluginState,
  seedIds: string[],
): Promise<ConceptNode[]> {
  if (seedIds.length === 0) return [];

  // Two-step: (1) collect neighbor concept IDs by traversing outgoing
  // hierarchy/related_to edges from each seed; (2) fetch id+content for
  // the unique neighbors in one batch.
  //
  // Pre-0.7.46 the inner queries projected `->broader->concept AS hits`
  // — but `hits` is an array of concept ids, not an object with id/
  // content fields. The outer `SELECT id, content` had no scalar fields
  // to extract, the receiver's parser fell through to `r.hits` which
  // it treated as an id (it's an array), and nothing was collected.
  // Result: gaps_found was 0 even on dense graph topics.
  const neighborIds = new Set<string>();
  for (const sid of seedIds) {
    try {
      const rows = await state.store.queryFirst<{ neighbors: string[] }>(
        `SELECT array::distinct(array::flatten([
           ->broader->concept,
           ->narrower->concept,
           ->related_to->concept
         ])) AS neighbors FROM ${sid}`,
      ).catch(() => []);
      const nbrs = Array.isArray(rows[0]?.neighbors) ? rows[0].neighbors : [];
      for (const n of nbrs) {
        const id = String(n ?? "");
        if (id) neighborIds.add(id);
      }
    } catch (e) {
      swallow("whatIsMissing:traverse", e);
    }
  }

  if (neighborIds.size === 0) return [];

  // Fetch content for the collected neighbor ids. We use a per-id loop here
  // because SurrealDB's `WHERE id IN $list` parameter binding for record-id
  // arrays is finicky across versions; one-by-one is correct and small.
  const collected: ConceptNode[] = [];
  for (const id of neighborIds) {
    try {
      const rows = await state.store.queryFirst<{ id: string; content: string }>(
        `SELECT id, content FROM ${id}`,
      ).catch(() => []);
      const r = rows[0];
      const rid = safeId(r?.id);
      if (rid && r?.content) {
        collected.push({ id: rid, content: String(r.content) });
      }
    } catch (e) {
      swallow("whatIsMissing:fetchContent", e);
    }
  }

  return collected;
}

export async function handleWhatIsMissing(
  state: GlobalPluginState,
  _session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const context = String(args.context ?? "").trim();
  const seedLimit = clamp(Number(args.seed_limit) || 6, 3, 10);
  const gapLimit = clamp(Number(args.gap_limit) || 10, 5, 20);

  if (!context || context.length < 10) {
    return {
      content: [{
        type: "text",
        text: "Error: `context` is required and should be at least 10 characters describing the current focus.",
      }],
    };
  }
  if (!state.store.isAvailable()) {
    return { content: [{ type: "text", text: "Error: store unavailable." }] };
  }

  // 1. Seed concepts from the context (what similarity would surface).
  const seeds = await seedConceptsFromContext(state, context, seedLimit);
  if (seeds.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          context: context.slice(0, 100),
          seeds_found: 0,
          gaps: [],
          note: "No concepts above similarity threshold matched the context. Graph may be sparse on this topic; consider recording a finding first.",
        }, null, 2),
      }],
    };
  }
  const seedIds = new Set(seeds.map(s => s.id));

  // 2. Collect graph-neighbor concepts — what's reachable via hierarchy /
  //    related_to from the seed set.
  const neighbors = await collectGraphNeighbors(state, [...seedIds]);

  // 3. Gaps = neighbors NOT already in the seed set, filtered to remove
  //    low-quality concept stubs that pollute gap output. The graph
  //    accumulates short single-token concepts (e.g. "WORK", "AND", "Node",
  //    "ATR", "function") from past auto-extraction passes — they are real
  //    edge-neighbors but represent no meaningful gap. Filter heuristic:
  //    drop content < 5 chars, drop pure-uppercase tokens of ≤ 5 chars,
  //    drop a small stoplist of high-frequency low-content tokens.
  //    Conservative — keeps hyphenated identifiers and prose concepts.
  const gaps = neighbors
    .filter(n => !seedIds.has(n.id) && n.content && !isLowQualityGap(n.content))
    .slice(0, gapLimit);

  // 4. Compose suggested recall queries so the caller can pull full content.
  const suggestedRecalls = gaps.slice(0, 5).map(g => g.content.slice(0, 80));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        context_preview: context.slice(0, 100),
        seeds_found: seeds.length,
        gaps_found: gaps.length,
        seeds: seeds.map(s => ({ id: s.id, preview: stripStructuralTags(s.content.slice(0, 80)), score: Number((s.score ?? 0).toFixed(3)) })),
        gaps: gaps.map(g => ({ id: g.id, preview: stripStructuralTags(g.content.slice(0, 120)) })),
        suggested_recalls: suggestedRecalls,
      }, null, 2),
    }],
  };
}
