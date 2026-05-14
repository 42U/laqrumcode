/**
 * cluster_scan MCP tool — recall with grouped output.
 *
 * Plain recall returns a flat score-sorted list. For questions like "what do
 * I know about X?", a cluster view is more useful than a ranked list:
 *   - Groups results by their shared concept neighbors (if any)
 *   - Labels each cluster by the concepts all members reference
 *   - Surfaces singleton results separately
 *
 * The substrate shape (turns → mentions → concepts ← about_concept ← memories)
 * already makes clustering cheap: two result nodes share a cluster if they
 * overlap significantly on the concept neighbors the graph returned.
 *
 * Wraps the existing vectorSearch primitive; does no new retrieval, just
 * re-shapes the output.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { swallow, safeId } from "../engine/errors.js";
import { clamp } from "../engine/math.js";
import { stripStructuralTags } from "../engine/sanitize.js";

interface ResultItem {
  id: string;
  text: string;
  table: string;
  score: number;
  neighbors?: string[];  // concept ids that this result is edge-adjacent to
}

interface Cluster {
  label: string;
  concepts: string[];  // concept contents (not ids) that anchor this cluster
  members: ResultItem[];
}

async function fetchNeighborConcepts(
  state: GlobalPluginState,
  resultIds: string[],
): Promise<Map<string, string[]>> {
  const neighborMap = new Map<string, string[]>();
  if (resultIds.length === 0) return neighborMap;

  // Fetch concept ids adjacent to each result via any of three edge types
  // (turn→mentions→concept, memory→about_concept→concept, artifact→
  // artifact_mentions→concept). One row per source id, neighbors as a flat
  // deduped array. Pre-0.7.46 this used `SELECT VALUE …->concept AS out`
  // — but `SELECT VALUE` unwraps to bare values so the `AS out` alias
  // never landed, the per-row parser found nothing, every item got an
  // empty neighbor list, and clusterByOverlap dropped everything into a
  // single singleton bucket. The clustering layer was effectively dead.
  // For each result, gather the concepts it's adjacent to via any direction
  // and any of the relevant edge types. Result types:
  //   turn      → ->mentions->concept (outgoing)
  //   memory    → ->about_concept->concept (outgoing)
  //   artifact  → ->artifact_mentions->concept (outgoing)
  //   concept   → ->{broader|narrower|related_to}->concept (outgoing) AND
  //               <-{about_concept|mentions|artifact_mentions}<-* (incoming;
  //               we then re-project to that node's concept neighbors via
  //               the same edges) — but since incoming nodes are turns/
  //               memories/artifacts and we want CONCEPTS as neighbors, the
  //               simplest stable signal is just outgoing hierarchy edges.
  // Pre-0.7.46 the query used `SELECT VALUE …->concept AS out` — VALUE
  // unwraps to bare values so AS-aliasing never landed and every neighbor
  // list was empty. Concepts had no neighbors at all because the query
  // only looked outward via edges that don't originate from concepts.
  for (const rid of resultIds) {
    try {
      const rows = await state.store.queryFirst<{ neighbors: string[] }>(
        `SELECT array::distinct(array::flatten([
           ->mentions->concept,
           ->about_concept->concept,
           ->artifact_mentions->concept,
           ->broader->concept,
           ->narrower->concept,
           ->related_to->concept
         ])) AS neighbors FROM ${rid}`,
      ).catch(() => []);
      const nbrs = Array.isArray(rows[0]?.neighbors)
        ? rows[0].neighbors.map(String).filter(Boolean)
        : [];
      if (nbrs.length > 0) neighborMap.set(rid, nbrs);
    } catch (e) {
      swallow("clusterScan:neighbors", e);
    }
  }

  return neighborMap;
}

function clusterByOverlap(items: ResultItem[]): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  // Greedy pass: for each unassigned item, find other items whose neighbor
  // lists overlap by >= 2 concepts. Form a cluster.
  for (const item of items) {
    if (assigned.has(item.id)) continue;
    const neighbors = new Set(item.neighbors ?? []);
    if (neighbors.size === 0) {
      // Will be surfaced as a singleton below
      continue;
    }

    const members: ResultItem[] = [item];
    const sharedConcepts = new Set(neighbors);

    for (const other of items) {
      if (other.id === item.id || assigned.has(other.id)) continue;
      const otherNeighbors = new Set(other.neighbors ?? []);
      if (otherNeighbors.size === 0) continue;
      let overlap = 0;
      for (const n of neighbors) if (otherNeighbors.has(n)) overlap++;
      if (overlap >= 2) {
        members.push(other);
        for (const n of otherNeighbors) sharedConcepts.add(n);
        assigned.add(other.id);
      }
    }

    if (members.length >= 2) {
      assigned.add(item.id);
      clusters.push({
        label: `${members.length} items sharing ${[...sharedConcepts].length} concepts`,
        concepts: [...sharedConcepts].slice(0, 5),
        members,
      });
    }
  }

  // Singletons go into their own "ungrouped" bucket so the caller still sees them
  const singletons = items.filter(i => !assigned.has(i.id));
  if (singletons.length > 0) {
    clusters.push({
      label: `${singletons.length} ungrouped`,
      concepts: [],
      members: singletons,
    });
  }

  return clusters;
}

export async function handleClusterScan(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = String(args.query ?? "").trim();
  const limit = clamp(Number(args.limit) || 10, 5, 15);

  if (!query) {
    return { content: [{ type: "text", text: "Error: `query` is required." }] };
  }

  const { store, embeddings } = state;
  if (!embeddings.isAvailable() || !store.isAvailable()) {
    return { content: [{ type: "text", text: "Error: embeddings or store unavailable." }] };
  }

  // 1. Vector search — reuse the existing recall primitive shape.
  let vec: number[];
  try {
    vec = await embeddings.embed(query);
  } catch (e) {
    return { content: [{ type: "text", text: `Error embedding query: ${e instanceof Error ? e.message : "unknown"}` }] };
  }

  const searchResults = await store.vectorSearch(vec, session.sessionId, {
    turn: Math.ceil(limit / 2),
    concept: limit,
    memory: limit,
    artifact: Math.ceil(limit / 2),
  }).catch(() => []);

  const items: ResultItem[] = searchResults
    .slice(0, limit * 2)
    .map((r: any) => ({
      id: safeId(r.id),
      text: stripStructuralTags(String(r.text ?? "").slice(0, 200)),
      table: String(r.table ?? ""),
      score: Number(r.score ?? 0),
    }))
    .filter((r: ResultItem) => r.id);

  if (items.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, query, clusters: [], note: "No results above similarity threshold." }, null, 2),
      }],
    };
  }

  // 2. Fetch concept neighbors for each result so we can cluster.
  const neighbors = await fetchNeighborConcepts(state, items.map(i => i.id));
  for (const item of items) {
    item.neighbors = neighbors.get(item.id) ?? [];
  }

  // 3. Group by neighbor overlap.
  const clusters = clusterByOverlap(items);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        query,
        total_results: items.length,
        cluster_count: clusters.length,
        clusters: clusters.map(c => ({
          label: c.label,
          concept_anchors: c.concepts.slice(0, 3),
          members: c.members.map(m => ({
            table: m.table,
            score: Number(m.score.toFixed(3)),
            preview: m.text,
          })),
        })),
      }, null, 2),
    }],
  };
}
