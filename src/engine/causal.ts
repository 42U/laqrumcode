/**
 * Causal Memory Graph
 *
 * Activates the dormant caused_by/supports/contradicts edges in the graph.
 * At session end, analyzes the conversation for cause-effect sequences
 * (bug->investigation->fix->outcome) and creates causal chains linking memories.
 * During retrieval, traverses causal edges to pull full chains as context.
 *
 * Ported from laqrumbrain — takes SurrealStore/EmbeddingService as params.
 */

import type { EmbeddingService } from "./embeddings.js";
import type { SurrealStore, VectorSearchResult } from "./surreal.js";
import { swallow, RECORD_ID_RE } from "./errors.js";
import { assertRecordId } from "./surreal.js";
import { commitKnowledge } from "./commit.js";

// --- Types ---

export interface CausalChain {
  triggerText: string;
  outcomeText: string;
  chainType: "debug" | "refactor" | "feature" | "fix";
  success: boolean;
  confidence: number;
  description: string;
}

/**
 * Create memory nodes for each end of the chain and link them with
 * caused_by/supports/contradicts edges.
 */
export async function linkCausalEdges(
  chains: CausalChain[],
  sessionId: string,
  store: SurrealStore,
  embeddings: EmbeddingService,
): Promise<void> {
  if (chains.length === 0 || !store.isAvailable()) return;

  for (const chain of chains) {
    try {
      // Create trigger + outcome memories via commitKnowledge so each one
      // auto-seals about_concept edges. Previously these memories landed as
      // island nodes — connected to each other via causal edges but never
      // wired to the concept graph, so recalling "debug" or "timeout" never
      // surfaced the causal chain.
      const { id: triggerId } = await commitKnowledge(
        { store, embeddings },
        {
          kind: "memory",
          text: chain.triggerText,
          importance: 5,
          category: `causal_trigger_${chain.chainType}`,
          sessionId,
        },
      );

      const { id: outcomeId } = await commitKnowledge(
        { store, embeddings },
        {
          kind: "memory",
          text: chain.outcomeText,
          importance: 6,
          category: `causal_outcome_${chain.chainType}`,
          sessionId,
        },
      );

      if (!triggerId || !outcomeId) continue;

      // W2-11 (2026-06-10): the chain-row existence check used to run AFTER
      // the edges were written, so re-extracting the same transcript (daemon
      // retries) duplicated caused_by/supports/contradicts/describes while
      // the row write correctly no-op'd against its UNIQUE index. Check FIRST
      // and skip the whole chain when it already exists. (trigger_memory/
      // outcome_memory are TYPE string — schema.surql:399 — so these string
      // bindings are correct, unlike the record-id traps.)
      try {
        const dup = await store.queryFirst<{ id: string }>(
          `SELECT id FROM causal_chain
             WHERE trigger_memory = $t AND outcome_memory = $o AND chain_type = $type
             LIMIT 1`,
          { t: triggerId, o: outcomeId, type: chain.chainType },
        );
        if (dup.length > 0) continue;
      } catch (e) { swallow.warn("causal:dupCheck", e); }

      // Create causal edges
      await store.relate(outcomeId, "caused_by", triggerId).catch(e => swallow.warn("causal:relateCausedBy", e));
      if (chain.success) {
        await store.relate(outcomeId, "supports", triggerId).catch(e => swallow.warn("causal:relateSupports", e));
      } else {
        await store.relate(outcomeId, "contradicts", triggerId).catch(e => swallow.warn("causal:relateContradicts", e));
      }

      // Embed the description as a searchable memory node
      let descriptionId: string | null = null;
      if (chain.description && chain.description.length > 10) {
        const descText = `[${chain.chainType}${chain.success ? "" : " FAILED"}] ${chain.description}`;
        const descResult = await commitKnowledge(
          { store, embeddings },
          {
            kind: "memory",
            text: descText,
            importance: 5,
            category: `causal_description_${chain.chainType}`,
            sessionId,
          },
        );
        descriptionId = descResult.id;
        if (descriptionId) {
          await store.relate(descriptionId, "describes", triggerId).catch(e => swallow.warn("causal:relateDescTrigger", e));
          await store.relate(descriptionId, "describes", outcomeId).catch(e => swallow.warn("causal:relateDescOutcome", e));
        }
      }

      // Store chain metadata. The (trigger, outcome, chain_type) dedup
      // pre-check now runs at the TOP of the loop (W2-11) — before the edges
      // — so reaching here means the tuple was absent moments ago. CREATE
      // directly; the UNIQUE index remains the hard backstop for the
      // pre-check-to-CREATE race (violation lands in the catch below).
      try {
        await store.queryExec(`CREATE causal_chain CONTENT $data`, {
          data: {
            session_id: String(sessionId),
            trigger_memory: triggerId,
            outcome_memory: outcomeId,
            description_memory: descriptionId,
            chain_type: chain.chainType,
            success: chain.success,
            confidence: chain.confidence,
            description: chain.description,
          },
        });
      } catch (e) {
        swallow.warn("causal:storeChain", e);
      }
    } catch (e) {
      // Upgraded from swallow → swallow.warn: a failure here means an entire
      // causal chain was lost, which is rare-but-real and worth surfacing.
      swallow.warn("causal:silent", e);
    }
  }
}

// --- Causal Context Retrieval ---

/**
 * Given seed memory IDs from vector search, traverse causal edges
 * (caused_by, supports, contradicts) up to `hops` deep.
 * Computes cosine similarity server-side so results compete fairly in scoring.
 */
export async function queryCausalContext(
  seedIds: string[],
  queryVec: number[],
  hops = 2,
  minConfidence = 0.4,
  store?: SurrealStore,
): Promise<VectorSearchResult[]> {
  if (seedIds.length === 0 || !store?.isAvailable()) return [];

  const validIds = seedIds.filter((id) => RECORD_ID_RE.test(id)).slice(0, 10);
  if (validIds.length === 0) return [];

  const causalEdges = ["caused_by", "supports", "contradicts", "describes"];
  const seen = new Set<string>(validIds);
  let frontier = validIds;
  const results: VectorSearchResult[] = [];
  const bindings = { vec: queryVec };

  // COSINE_GUARD_OK: read-only causal-chain traversal scoring — no
  // destructive follow-on.
  const scoreExpr = `, IF embedding != NONE AND array::len(embedding) > 0
         THEN vector::similarity::cosine(embedding, $vec)
         ELSE 0 END AS score`;

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    // Batch all edge traversals for this hop in a single round-trip
    const selectFields = `SELECT id, text, importance, access_count AS accessCount,
                  created_at AS timestamp, category, meta::tb(id) AS table${scoreExpr}`;
    const stmts: string[] = [];
    for (const id of frontier) {
      assertRecordId(id);
      for (const edge of causalEdges) {
        if (!/^[a-z_]+$/.test(edge)) continue; // safety check
        stmts.push(`${selectFields} FROM ${id}->${edge}->? LIMIT 3`);
        stmts.push(`${selectFields} FROM ${id}<-${edge}<-? LIMIT 3`);
      }
    }

    // Per-edge SELECT rows projected to a {id, text, importance, accessCount,
    // timestamp, category, table, score} shape. Wire is unknown[][]; narrow
    // per-row with an explicit row type at the read site.
    type CausalRow = {
      id?: unknown;
      text?: unknown;
      importance?: unknown;
      accessCount?: unknown;
      timestamp?: unknown;
      category?: unknown;
      table?: unknown;
      score?: unknown;
    };
    let allQueryResults: unknown[][];
    try {
      allQueryResults = await store.queryBatch<unknown>(stmts, bindings);
    } catch (e) {
      swallow.warn("causal:batch", e);
      break;
    }
    const nextFrontier: string[] = [];

    for (const rawRows of allQueryResults) {
      const rows = rawRows as CausalRow[];
      for (const row of rows) {
        const nodeId = String(row.id);
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);

        const text = (row.text ?? "") as string;
        if (text) {
          results.push({
            id: nodeId,
            text,
            score: typeof row.score === "number" ? row.score : 0,
            importance: row.importance as number | undefined,
            accessCount: row.accessCount as number | undefined,
            timestamp: row.timestamp as string | undefined,
            table: String(row.table ?? "memory"),
            source: row.category as string | undefined,
          });
          if (RECORD_ID_RE.test(nodeId)) {
            nextFrontier.push(nodeId);
          }
        }
      }
    }

    frontier = nextFrontier.slice(0, 5);
  }

  // Filter by causal_chain confidence — only exclude nodes that appear
  // exclusively in low-confidence chains. Nodes reached via graph traversal
  // that aren't chain endpoints are kept unconditionally.
  if (results.length > 0 && minConfidence > 0) {
    const resultIds = results.map(r => r.id);
    try {
      const lowChains = await store.queryFirst<{ trigger_memory: string; outcome_memory: string }>(
        `SELECT trigger_memory, outcome_memory FROM causal_chain
         WHERE confidence < $minConf AND (trigger_memory IN $ids OR outcome_memory IN $ids)`,
        { minConf: minConfidence, ids: resultIds },
      );
      const highChains = await store.queryFirst<{ trigger_memory: string; outcome_memory: string }>(
        `SELECT trigger_memory, outcome_memory FROM causal_chain
         WHERE confidence >= $minConf AND (trigger_memory IN $ids OR outcome_memory IN $ids)`,
        { minConf: minConfidence, ids: resultIds },
      );
      const highIds = new Set<string>();
      for (const c of highChains) {
        highIds.add(String(c.trigger_memory));
        highIds.add(String(c.outcome_memory));
      }
      const lowOnlyIds = new Set<string>();
      for (const c of lowChains) {
        const t = String(c.trigger_memory);
        const o = String(c.outcome_memory);
        if (!highIds.has(t)) lowOnlyIds.add(t);
        if (!highIds.has(o)) lowOnlyIds.add(o);
      }
      return results.filter(r => !lowOnlyIds.has(r.id));
    } catch (e) {
      swallow.warn("causal:confidence-filter", e);
      return results;
    }
  }

  return results;
}

