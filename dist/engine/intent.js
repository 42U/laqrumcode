/**
 * Zero-shot intent classification via BGE-M3 embeddings.
 * No LLM call — embed user input, cosine similarity against prototypes.
 * ~25ms total (16ms embed + 5ms cosine + heuristics).
 *
 * Ported from laqrumbrain — takes EmbeddingService instead of module-level embed.
 */
import { cosineSimilarity } from "./graph-context.js";
const PROTOTYPES = [
    { category: "simple-question", text: "What is two plus two?" },
    { category: "simple-question", text: "What is the capital of France?" },
    { category: "simple-question", text: "Explain what a linked list is." },
    { category: "simple-question", text: "What does async await mean in JavaScript?" },
    { category: "code-read", text: "Read the file src/agent.ts and explain what it does." },
    { category: "code-read", text: "Show me the contents of package.json." },
    { category: "code-read", text: "What functions are defined in utils.ts?" },
    { category: "code-write", text: "Write a new function that sorts an array." },
    { category: "code-write", text: "Create a new file called validator.ts with email validation." },
    { category: "code-write", text: "Implement a REST API endpoint for user registration." },
    { category: "code-debug", text: "Fix the bug in the authentication module." },
    { category: "code-debug", text: "Debug this TypeError: Cannot read property of undefined." },
    { category: "code-debug", text: "Fix the null pointer exception in the login handler." },
    { category: "deep-explore", text: "Analyze every file in this entire codebase and document the full architecture." },
    { category: "deep-explore", text: "Map out every module and its dependencies across the whole project." },
    { category: "reference-prior", text: "That bug we fixed yesterday, remember what we discussed?" },
    { category: "reference-prior", text: "What did we decide about the database schema earlier?" },
    { category: "meta-session", text: "What have we been working on? Summarize our progress." },
    { category: "meta-session", text: "Give me a summary of everything we accomplished today." },
    { category: "multi-step", text: "First refactor the auth module, then update the tests, then update the docs." },
    { category: "multi-step", text: "Step one: add the new field. Step two: migrate the database. Step three: update the API." },
    { category: "continuation", text: "Keep going. Continue. Yes do that." },
    { category: "continuation", text: "Go ahead. Yes, proceed with that approach." },
];
const CONFIDENCE_THRESHOLD = 0.65;
// --- Intent classifier (instance-based, caches centroids per EmbeddingService) ---
const centroidCache = new WeakMap();
const centroidInitPromise = new WeakMap();
async function ensurePrototypes(embeddings) {
    const existing = centroidCache.get(embeddings);
    if (existing)
        return existing;
    let promise = centroidInitPromise.get(embeddings);
    if (!promise) {
        promise = (async () => {
            try {
                const vecs = await embeddings.embedBatch(PROTOTYPES.map(p => p.text));
                const byCategory = new Map();
                for (let i = 0; i < PROTOTYPES.length; i++) {
                    const cat = PROTOTYPES[i].category;
                    if (!byCategory.has(cat))
                        byCategory.set(cat, []);
                    byCategory.get(cat).push(vecs[i]);
                }
                const centroids = [];
                for (const [category, catVecs] of byCategory) {
                    const dim = catVecs[0].length;
                    const centroid = new Array(dim).fill(0);
                    for (const v of catVecs) {
                        for (let d = 0; d < dim; d++)
                            centroid[d] += v[d];
                    }
                    for (let d = 0; d < dim; d++)
                        centroid[d] /= catVecs.length;
                    centroids.push({ category, vec: centroid });
                }
                centroidCache.set(embeddings, centroids);
            }
            catch (e) {
                centroidInitPromise.delete(embeddings);
                throw e;
            }
        })();
        centroidInitPromise.set(embeddings, promise);
    }
    await promise;
    return centroidCache.get(embeddings);
}
// --- Public API ---
export async function classifyIntent(text, embeddings) {
    if (!embeddings.isAvailable()) {
        return { category: "unknown", confidence: 0, scores: [] };
    }
    const prototypeVecs = await ensurePrototypes(embeddings);
    const inputVec = await embeddings.embed(text);
    const scores = [];
    for (const proto of prototypeVecs) {
        scores.push({ category: proto.category, score: cosineSimilarity(inputVec, proto.vec) });
    }
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0];
    if (top.score < CONFIDENCE_THRESHOLD) {
        return { category: "unknown", confidence: top.score, scores };
    }
    return { category: top.category, confidence: top.score, scores };
}
export function estimateComplexity(text, intent) {
    const words = text.split(/\s+/).length;
    const hasMultiStep = /\b(then|also|after that|next|finally|first|second)\b/i.test(text);
    const hasEvery = /\b(every|all|each|entire|whole|full)\b/i.test(text);
    const baseMap = {
        "simple-question": { level: "trivial", tools: 0, thinking: "low" },
        "code-read": { level: "simple", tools: 4, thinking: "medium" },
        "code-write": { level: "moderate", tools: 8, thinking: "high" },
        "code-debug": { level: "moderate", tools: 10, thinking: "high" },
        "deep-explore": { level: "deep", tools: 20, thinking: "medium" },
        "reference-prior": { level: "simple", tools: 4, thinking: "medium" },
        "meta-session": { level: "trivial", tools: 0, thinking: "low" },
        "multi-step": { level: "complex", tools: 15, thinking: "high" },
        "continuation": { level: "simple", tools: 8, thinking: "medium" },
        "unknown": { level: "moderate", tools: 10, thinking: "medium" },
    };
    const base = baseMap[intent.category];
    let { level, tools, thinking } = base;
    if (hasMultiStep && level !== "deep") {
        level = "complex";
        tools = Math.max(tools, 12);
        thinking = "high";
    }
    if (hasEvery && level !== "deep") {
        level = "deep";
        tools = Math.max(tools, 20);
    }
    if (words > 100) {
        tools = Math.max(tools, 12);
    }
    return { level, estimatedToolCalls: tools, suggestedThinking: thinking };
}
