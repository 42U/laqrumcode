/**
 * Predictive Context Prefetching — Phase 7d
 *
 * After preflight classifies intent, predict 2-4 follow-up queries and fire
 * vector searches in the background. Results are cached in an LRU with 5-min TTL.
 *
 * Ported from kongbrain — takes SurrealStore/EmbeddingService as params.
 */
import { findRelevantSkills } from "./skills.js";
import { retrieveReflections } from "./reflection.js";
import { swallow } from "./errors.js";
import { isRerankerActive } from "./graph-context.js";
let _cacheKeyCounter = 0;
// --- LRU Cache ---
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 20;
const CACHE_HIT_THRESHOLD = 0.82;
const warmCache = new Map();
// --- Hit rate telemetry ---
let _prefetchHits = 0;
let _prefetchMisses = 0;
export function recordPrefetchHit() { _prefetchHits++; }
export function recordPrefetchMiss() { _prefetchMisses++; }
export function getPrefetchHitRate() {
    const attempts = _prefetchHits + _prefetchMisses;
    return { hits: _prefetchHits, misses: _prefetchMisses, attempts, hitRate: attempts > 0 ? _prefetchHits / attempts : 0 };
}
function evictStale() {
    const now = Date.now();
    const staleKeys = [];
    for (const [key, entry] of warmCache) {
        if (now - entry.timestamp > CACHE_TTL_MS)
            staleKeys.push(key);
    }
    for (const key of staleKeys)
        warmCache.delete(key);
    while (warmCache.size > MAX_CACHE_SIZE) {
        const oldest = warmCache.keys().next().value;
        if (oldest)
            warmCache.delete(oldest);
    }
}
// --- Query Prediction ---
export function predictQueries(input, intent) {
    const queries = [];
    const filePaths = input.match(/[\w./\\-]+\.\w{1,10}/g) ?? [];
    for (const fp of filePaths.slice(0, 2))
        queries.push(fp);
    const quoted = input.match(/[`"']([^`"']{3,60})[`"']/g) ?? [];
    for (const q of quoted.slice(0, 2))
        queries.push(q.replace(/[`"']/g, ""));
    switch (intent) {
        case "code-debug":
            queries.push(`error ${extractKeyTerms(input)}`);
            queries.push(`fix ${extractKeyTerms(input)}`);
            break;
        case "code-write":
            queries.push(`implementation pattern ${extractKeyTerms(input)}`);
            queries.push(`test ${extractKeyTerms(input)}`);
            break;
        case "code-read":
            queries.push(`architecture ${extractKeyTerms(input)}`);
            break;
        case "multi-step":
            queries.push(`procedure ${extractKeyTerms(input)}`);
            queries.push(`workflow ${extractKeyTerms(input)}`);
            break;
        case "reference-prior":
            queries.push(extractKeyTerms(input));
            break;
        default:
            break;
    }
    return [...new Set(queries.filter((q) => q.length > 3))].slice(0, 4);
}
function extractKeyTerms(input) {
    const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "have", "will", "can", "not", "are", "was", "but"]);
    return input.split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()))
        .slice(0, 6)
        .join(" ");
}
// --- Prefetching ---
export async function prefetchContext(queries, sessionId, embeddings, store, projectId) {
    if (!embeddings.isAvailable() || !store.isAvailable())
        return;
    if (queries.length === 0)
        return;
    evictStale();
    await Promise.all(queries.map(async (query) => {
        try {
            const queryVec = await embeddings.embed(query);
            const results = await store.vectorSearch(queryVec, sessionId, {
                turn: 5, identity: 2, concept: 3, memory: 3, artifact: 2,
            }, false, projectId);
            const topIds = results
                .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                .slice(0, 5)
                .map((r) => r.id);
            let neighbors = [];
            if (topIds.length > 0) {
                try {
                    const expanded = await store.graphExpand(topIds, queryVec);
                    const existingIds = new Set(results.map((r) => r.id));
                    neighbors = expanded.filter((n) => !existingIds.has(n.id));
                }
                catch (e) {
                    swallow("prefetch:graphExpand", e);
                }
            }
            const [skills, reflections] = await Promise.all([
                findRelevantSkills(queryVec, 2, store).catch(() => []),
                retrieveReflections(queryVec, 2, store, projectId).catch(() => []),
            ]);
            warmCache.set(query, {
                queryVec,
                results: [...results, ...neighbors],
                skills,
                reflections,
                timestamp: Date.now(),
                rerankerWasActive: isRerankerActive(),
            });
        }
        catch (e) {
            swallow("prefetch:query", e);
        }
    }));
}
// --- Cache Lookup ---
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}
export function getCachedContext(queryVec) {
    evictStale();
    // v0.7.34: cache hits where reranker state has flipped since write are
    // rejected. A cached result from an offline-reranker turn won't have band
    // tags; serving it now (when online) would mismatch the directive.
    const currentRerankerActive = isRerankerActive();
    let bestMatch = null;
    let bestKey = null;
    let bestSim = 0;
    for (const [key, entry] of warmCache) {
        if (entry.rerankerWasActive !== currentRerankerActive)
            continue;
        const sim = cosineSimilarity(queryVec, entry.queryVec);
        if (sim > bestSim) {
            bestSim = sim;
            bestMatch = entry;
            bestKey = key;
        }
    }
    if (bestMatch && bestKey && bestSim >= CACHE_HIT_THRESHOLD) {
        // Re-insert to refresh LRU position (Map iterates in insertion order)
        warmCache.delete(bestKey);
        warmCache.set(bestKey, bestMatch);
        return { results: bestMatch.results, skills: bestMatch.skills, reflections: bestMatch.reflections };
    }
    return null;
}
export function setCachedContext(queryVec, results, skills, reflections) {
    evictStale();
    const key = `__pipeline_${Date.now()}_${_cacheKeyCounter++}`;
    warmCache.set(key, {
        queryVec,
        results,
        skills,
        reflections,
        timestamp: Date.now(),
        rerankerWasActive: isRerankerActive(),
    });
}
export function getPrefetchStats() {
    evictStale();
    return { entries: warmCache.size, maxSize: MAX_CACHE_SIZE };
}
export function clearPrefetchCache() {
    warmCache.clear();
}
