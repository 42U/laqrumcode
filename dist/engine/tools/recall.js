/**
 * Recall tool — search the persistent memory graph.
 * Ported from laqrumbrain with SurrealStore/EmbeddingService injection.
 */
import { Type } from "@sinclair/typebox";
import { findRelevantSkills, formatSkillContext } from "../skills.js";
import { swallow } from "../errors.js";
import { stripStructuralTags } from "../sanitize.js";
import { deduplicateResults, rerankResults } from "../graph-context.js";
const recallSchema = Type.Object({
    query: Type.String({ description: "What to search for in memory. Can be a concept, topic, decision, file path, or natural language description." }),
    scope: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("memories"),
        Type.Literal("concepts"),
        Type.Literal("turns"),
        Type.Literal("artifacts"),
        Type.Literal("skills"),
    ], { description: "Limit search to a specific memory type. Default: all." })),
    limit: Type.Optional(Type.Number({ description: "Max results to return. Default: 5, max: 15." })),
});
export function createRecallToolDef(state, session) {
    return {
        name: "recall",
        label: "Memory Recall",
        description: "Search your persistent memory graph for past conversations, decisions, concepts, files, and context from previous sessions. Context from past sessions is already auto-injected — check what you have before calling this.",
        parameters: recallSchema,
        execute: async (_toolCallId, params) => {
            const { store, embeddings } = state;
            if (!embeddings.isAvailable() || !store.isAvailable()) {
                return { content: [{ type: "text", text: "Memory system unavailable." }], details: null };
            }
            const maxResults = Math.min(params.limit ?? 5, 15);
            try {
                const queryVec = await embeddings.embed(params.query);
                const scope = params.scope ?? "all";
                if (scope === "skills") {
                    const skills = await findRelevantSkills(queryVec, maxResults, store);
                    if (skills.length === 0) {
                        return { content: [{ type: "text", text: `No skills found matching "${params.query}".` }], details: null };
                    }
                    return {
                        content: [{ type: "text", text: `Found ${skills.length} relevant skills:\n${formatSkillContext(skills)}` }],
                        details: { count: skills.length, ids: skills.map((s) => s.id) },
                    };
                }
                const limits = {
                    turn: scope === "all" || scope === "turns" ? maxResults : 0,
                    identity: 0,
                    concept: scope === "all" || scope === "concepts" ? maxResults : 0,
                    memory: scope === "all" || scope === "memories" ? maxResults : 0,
                    artifact: scope === "all" || scope === "artifacts" ? maxResults : 0,
                };
                const results = await store.vectorSearch(queryVec, session.sessionId, limits);
                const topIds = results
                    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                    .slice(0, Math.min(maxResults, 8))
                    .map((r) => r.id);
                let neighbors = [];
                if (topIds.length > 0) {
                    try {
                        const expanded = await store.graphExpand(topIds, queryVec);
                        const existingIds = new Set(results.map((r) => r.id));
                        neighbors = expanded.filter((n) => !existingIds.has(n.id));
                    }
                    catch (e) {
                        swallow("recall:graphExpand", e);
                    }
                }
                // Phase 2: keep neighbors separate so output surfaces graph-walk neighborhood
                // distinctly from primary vector hits. Gives grounding skills a clearer
                // signal about which items are direct matches vs. cross-linked context.
                // Rank primary results through the real stack — semantic dedup + the
                // bge-reranker-v2-m3 cross-encoder — instead of raw cosine. Deliberate
                // recalls were previously ranked WORSE than passive auto-injection.
                // (ACAN/WMR are intentionally skipped here: their recency/utility signals
                //  suit auto-injection; a deliberate recall wants pure semantic relevance.)
                const scored = results.map((r) => ({ ...r, finalScore: r.score ?? 0 }));
                const deduped = deduplicateResults(scored.sort((a, b) => b.finalScore - a.finalScore));
                const reranked = await rerankResults(deduped, params.query);
                const primary = reranked.sort((a, b) => b.finalScore - a.finalScore).slice(0, maxResults);
                const primaryIds = new Set(primary.map(r => r.id));
                const neighborList = neighbors.filter(n => !primaryIds.has(n.id)).slice(0, 5);
                const all = primary;
                if (all.length === 0) {
                    return { content: [{ type: "text", text: `No memories found matching "${params.query}".` }], details: null };
                }
                const formatted = all.map((r, i) => {
                    const tag = r.table === "turn" ? `[${r.role ?? "turn"}]` : `[${r.table}]`;
                    const time = r.timestamp ? ` (${new Date(r.timestamp).toLocaleDateString()})` : "";
                    const score = ` score:${r.finalScore.toFixed(2)}`;
                    return `${i + 1}. ${tag}${time}${score}\n   ${stripStructuralTags((r.text ?? "").slice(0, 300))}`;
                }).join("\n\n");
                const neighborBlock = neighborList.length > 0
                    ? "\n\n=== GRAPH NEIGHBORS (" + neighborList.length + ") ===\n" +
                        neighborList.map((n, i) => {
                            const tag = `[${n.table}]`;
                            const score = n.score ? ` score:${n.score.toFixed(2)}` : "";
                            return `${i + 1}. ${tag}${score}\n   ${stripStructuralTags((n.text ?? "").slice(0, 200))}`;
                        }).join("\n\n")
                    : "";
                return {
                    content: [{ type: "text", text: `Found ${all.length} results for "${params.query}":\n\n${formatted}${neighborBlock}` }],
                    details: { count: all.length, ids: all.map((r) => r.id), neighbor_count: neighborList.length },
                };
            }
            catch (err) {
                return { content: [{ type: "text", text: `Memory search failed: ${err}` }], details: null };
            }
        },
    };
}
