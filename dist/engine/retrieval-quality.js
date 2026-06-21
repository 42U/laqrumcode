/**
 * Retrieval Quality Tracker
 *
 * Measures whether retrieved context was actually useful, not just relevant.
 * Tracks 6 signals from research:
 * 1. Referenced in response (text overlap)
 * 2. Task success (tool executions)
 * 3. Retrieval stability
 * 4. Access patterns
 * 5. Context waste
 * 6. Contradiction detection
 *
 * Ported from kongbrain — uses SurrealStore instead of module-level DB.
 */
import { swallow } from "./errors.js";
import { crossEncoderScorePairs } from "./graph-context.js";
import { recordSkillOutcome, shouldRecordSkillOutcome } from "./skills.js";
import { parseDatetimeMs } from "./observability.js";
export function classifyItem(item) {
    const table = item.table;
    if (table === "concept" || table === "artifact")
        return "knowledge";
    if (table === "identity_chunk")
        return "behavioral";
    if (table === "monologue" || table === "turn" || table === "skill")
        return "context";
    if (table === "memory") {
        const cat = item.category ?? "";
        if (cat === "preference" || cat === "correction")
            return "behavioral";
        return "knowledge";
    }
    return "knowledge";
}
const _pendingRetrievalBySession = new Map();
// K2: bound the cross-encoder work done per Stop evaluation. Each staged item
// would otherwise get its own crossEncoderScorePairs call — unbounded CE
// throughput on the turn-boundary hot path (CE cost is ~linear in tokens on
// CPU). We CE-score only the top-K items by finalScore, under a cumulative
// token budget (mirrors rerankResults' RERANK_TOTAL_TOKEN_BUDGET); the tail is
// scored lexical-only. The top items dominate utilization signal anyway, so the
// tail's CE rarely changed the stored row. All env-tunable.
const EVAL_CE_TOP_K = Number(process.env.KONGCODE_EVAL_CE_TOP_K) || 10;
const EVAL_CE_TOKEN_BUDGET = Number(process.env.KONGCODE_EVAL_CE_TOKEN_BUDGET) || 8192;
/** Register a session-removal cleanup so removed sessions purge their entry.
 *  Call once at daemon boot with the GlobalPluginState — re-registration is
 *  safe (no-op via WeakSet guard). Modeled on core-memory.ts's pattern so a
 *  hot-reload doesn't strand stale callbacks. */
const _registeredStates = new WeakSet();
export function registerRetrievalQualityCleanup(state) {
    if (_registeredStates.has(state))
        return;
    _registeredStates.add(state);
    state.onSessionRemoved((sessionId) => {
        _pendingRetrievalBySession.delete(sessionId);
    });
}
export function getStagedItems(sessionId) {
    const entry = _pendingRetrievalBySession.get(sessionId);
    return entry?.items ? [...entry.items] : [];
}
export function stageRetrieval(sessionId, items, queryEmbedding, indexMap) {
    // A staged-while-evaluating window is normal: evaluator marks the entry
    // `evaluating` and leaves it in the map so a late recordToolOutcome still
    // lands. Overwriting here is correct — the next turn's retrieval replaces
    // the previous turn's staged record. The evaluator's finally checks
    // identity before deleting, so it won't clobber this fresh entry.
    _pendingRetrievalBySession.set(sessionId, {
        items,
        toolResults: [],
        queryEmbedding,
        indexMap,
    });
}
export function recordToolOutcome(sessionId, success) {
    const entry = _pendingRetrievalBySession.get(sessionId);
    if (entry) {
        entry.toolResults.push({ success });
    }
}
export function stageSkills(sessionId, skills) {
    const entry = _pendingRetrievalBySession.get(sessionId);
    if (entry && skills.length > 0) {
        entry.skillDocs = skills;
        entry.skillStageTime = Date.now();
    }
}
/**
 * Evaluate retrieval quality after assistant response.
 */
export async function evaluateRetrieval(sessionId, responseTurnId, responseText, store) {
    // Mark the entry as evaluating but leave it in the map so a late
    // recordToolOutcome (Stop hook arriving after this evaluator starts) still
    // appends to the same toolResults array we'll read below. The prior code
    // deleted synchronously before any await, which dropped any tool outcomes
    // produced during the evaluate window — those turns landed with
    // tool_success=null even though Claude had successfully executed tools.
    // We delete in the finally to guarantee cleanup whether evaluate succeeds,
    // throws, or short-circuits.
    const pending = _pendingRetrievalBySession.get(sessionId);
    if (!pending || (pending.items.length === 0 && !pending.skillDocs?.length)) {
        _pendingRetrievalBySession.delete(sessionId);
        return;
    }
    pending.evaluating = true;
    try {
        return await evaluateRetrievalInner(sessionId, responseTurnId, responseText, store, pending);
    }
    finally {
        // Only delete if this evaluator still owns the entry. A racing
        // stageRetrieval can replace it with a fresh entry mid-evaluate, in
        // which case we must not clobber the new staging.
        const current = _pendingRetrievalBySession.get(sessionId);
        if (current === pending)
            _pendingRetrievalBySession.delete(sessionId);
    }
}
async function evaluateRetrievalInner(sessionId, responseTurnId, responseText, store, pending) {
    const { items, toolResults, queryEmbedding, indexMap, skillDocs, skillStageTime } = pending;
    // toolSuccess: did a majority of this turn's tools succeed? null = no tools
    // ran. Used for skill attribution (below) and memory signal scoring (later).
    const toolSuccess = toolResults.length > 0
        ? toolResults.filter((r) => r.success).length / toolResults.length >= 0.5
        : null;
    // Skill outcome (v0.8.x step 3a): attribute the turn outcome ONLY to skills
    // the response actually ENGAGED, and only when there's a real tool outcome to
    // judge. Engagement = lexical overlap of skill-text vs response (always
    // available, deterministic — same blend as computeSignals) combined with the
    // cross-encoder when the reranker is loaded (70/30, mirroring the memory
    // path); reranker offline → lexical-only, still works. Replaces the old
    // blanket `toolSuccess ?? true` that credited EVERY injected skill on every
    // OK/no-tool turn — the bias that left failure_count=0 corpus-wide. Skill
    // texts are staged at retrieval time, so no per-eval DB fetch.
    if (skillDocs && skillDocs.length > 0 && responseText.length > 0) {
        const elapsed = skillStageTime ? Date.now() - skillStageTime : 0;
        const respLower = responseText.toLowerCase();
        await Promise.allSettled(skillDocs.map(async ({ id, text }) => {
            if (!text)
                return;
            const specific = Math.max(keyTermOverlap(text, respLower), trigramOverlap(text, respLower));
            const lexical = 0.6 * specific + 0.4 * unigramOverlap(text, respLower);
            const ce = await crossEncoderScorePairs(text, [responseText]);
            const engagement = (ce && ce[0] != null) ? 0.7 * ce[0] + 0.3 * lexical : lexical;
            const verdict = shouldRecordSkillOutcome(engagement, toolSuccess);
            if (verdict)
                await recordSkillOutcome(id, verdict.success, elapsed, store);
        }));
    }
    // Skip scoring for tool-heavy turns with minimal assistant text.
    // CE scoring can't meaningfully compare a 20-char transition phrase
    // against retrieved items. Writing near-zero utilization rows for
    // these turns pollutes the quality gate's 14-day average with noise.
    if (responseText.length < 100 && toolResults.length > 0)
        return;
    if (items.length === 0)
        return;
    // Skip scoring when retrieval found nothing meaningful. Items with
    // near-zero relevance scores are background noise, not real retrieval
    // hits — scoring utilization on them drags the average down with junk.
    const maxRetrievalScore = Math.max(...items.map(it => it.finalScore ?? 0));
    if (maxRetrievalScore < 0.1)
        return;
    const responseLower = responseText.toLowerCase();
    // 0.7.27: parse [#N] citations from the response. Build a set of cited
    // memory_ids by intersecting parsed indexes with the indexMap built at
    // injection time. This is the structural-citation signal — distinct from
    // (and stronger than) the lexical utilization signal computed below.
    const citedIds = new Set();
    if (indexMap) {
        const matches = responseText.matchAll(/\[#(\d+)\]/g);
        for (const m of matches) {
            const idx = parseInt(m[1], 10);
            const id = indexMap.get(idx);
            if (id)
                citedIds.add(id);
        }
    }
    // Cross-encoder semantic utilization: score each (item, response) pair.
    // Item text is the "query" (short), response is the "document" (long) —
    // matches the (query, passage) training distribution of bge-reranker-v2-m3.
    // Reversed from the naive (response, item) ordering which produced near-zero
    // scores due to the long anchor diluting relevance signal.
    //
    // K2: bound CE work. Rank items by finalScore and CE-score only the top-K
    // under a cumulative token budget; the tail is scored lexical-only (ceScore
    // = null → computeSignals falls back to the lexical blend). Without this the
    // Stop hot path issued one CE call per staged item, unbounded. ceByIndex is
    // aligned to `items` so the per-item loop below reads it positionally.
    const ceByIndex = new Array(items.length).fill(null);
    const ceEligible = items
        .map((_, idx) => idx)
        .sort((a, b) => (items[b].finalScore ?? 0) - (items[a].finalScore ?? 0));
    const ceTargets = [];
    let ceTokenBudget = EVAL_CE_TOKEN_BUDGET;
    for (const idx of ceEligible) {
        if (ceTargets.length >= EVAL_CE_TOP_K)
            break;
        const approxTokens = Math.ceil((items[idx].text ?? "").length / 4);
        // Always admit the first item; afterward stop once the budget would blow.
        if (ceTargets.length > 0 && approxTokens > ceTokenBudget)
            break;
        ceTokenBudget -= approxTokens;
        ceTargets.push(idx);
    }
    await Promise.all(ceTargets.map(async (idx) => {
        const text = items[idx].text ?? "";
        if (!text)
            return;
        const s = await crossEncoderScorePairs(text, [responseText]);
        ceByIndex[idx] = s?.[0] ?? null;
    }));
    // K23: build every row in memory, then do ONE batched existence read +
    // ONE bulk insert — replacing the prior N serial SELECT + N serial CREATE
    // round-trips (2N awaits per turn on the Stop path). memory_id is a TYPE
    // string column, so all ids are already stringified for the IN bind.
    const rows = [];
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const idStr = String(item.id);
        const wasCited = citedIds.has(idStr);
        const ceScore = ceByIndex[idx];
        const signals = computeSignals(item, responseLower, toolSuccess, wasCited, ceScore);
        const record = {
            session_id: sessionId,
            turn_id: responseTurnId,
            memory_id: idStr,
            memory_table: item.table,
            retrieval_score: item.finalScore ?? 0,
            utilization: signals.utilization,
            context_tokens: signals.contextTokens,
            was_neighbor: signals.wasNeighbor,
            importance: ((item.importance ?? 5) / 10),
            access_count: Math.min((item.accessCount ?? 0) / 50, 1),
            recency: signals.recency,
        };
        if (signals.toolSuccess != null) {
            record.tool_success = signals.toolSuccess;
        }
        if (ceScore != null) {
            record.ce_utilization = ceScore;
        }
        if (queryEmbedding) {
            record.query_embedding = queryEmbedding;
        }
        if (indexMap) {
            if (wasCited) {
                record.cited = true;
                record.citation_method = "index";
            }
            else if (signals.utilization >= 0.5) {
                record.cited = true;
                record.citation_method = "lexical";
            }
            else {
                record.cited = false;
                record.citation_method = "none";
            }
        }
        rows.push(record);
        // W2-03 (2026-06-10): guaranteed-inclusion recent turns carry synthetic
        // ids ("guaranteed:<timestamp>", graph-context.ts) with no utility row —
        // updateUtilityCache's record-id assertion rejected them on every turn
        // ("Invalid record ID format: guaranteed:…" daemon.log spam). Only
        // record-shaped ids have a cache row to update.
        if (/^[a-z_][a-z0-9_]*:[a-zA-Z0-9_]+$/i.test(idStr)) {
            store.updateUtilityCache(idStr, signals.utilization)
                .catch(e => swallow.warn("retrieval-quality:utilityCache", e));
        }
    }
    try {
        // ONE batched read on (session_id, turn_id, memory_id IN $ids) — the
        // composite covered by the retoutc_unique index. Re-evaluating the same
        // turn (rare retry) or a concurrent loop must not double-insert; the UNIQUE
        // index is the hard backstop, this skips the rows it would reject.
        const ids = rows.map((r) => r.memory_id);
        const existing = await store.queryFirst(`SELECT memory_id FROM retrieval_outcome
         WHERE session_id = $sid AND turn_id = $tid AND memory_id IN $ids`, { sid: sessionId, tid: responseTurnId, ids });
        const existingIds = new Set(existing.map((e) => String(e.memory_id)));
        const toInsert = rows.filter((r) => !existingIds.has(r.memory_id));
        if (toInsert.length > 0) {
            // Bulk INSERT in a single round-trip. INSERT (not CREATE) accepts an
            // array of records, so N rows = 1 statement. ON DUPLICATE KEY UPDATE
            // memory_id = memory_id makes a residual race (a concurrent evaluator
            // inserting the same (session,turn,memory) tuple between our read and
            // this write) a no-op on the existing row instead of throwing — verified
            // on SurrealDB 3.0.1 that a single in-batch collision otherwise aborts
            // the WHOLE INSERT, which would drop every other row's outcome.
            await store.queryExec(`INSERT INTO retrieval_outcome $rows ON DUPLICATE KEY UPDATE memory_id = memory_id`, { rows: toInsert });
        }
    }
    catch (e) {
        swallow.warn("retrieval-quality:outcome", e);
    }
    // Per-turn context utilization: MAX of knowledge items' CE scores.
    // Only knowledge items contribute — behavioral (rules/preferences) and
    // context (monologue/turns) shape behavior without appearing in text.
    // K2: ceByIndex only carries the top-K items' CE scores (the tail is null).
    // contextUtil is the MAX over knowledge items, and the top-K-by-finalScore
    // contains the highest-scoring knowledge items, so the MAX is preserved.
    const knowledgeCeScores = items
        .map((item, idx) => ({ purpose: classifyItem(item), ce: ceByIndex[idx] }))
        .filter(x => x.purpose === "knowledge" && x.ce !== null)
        .map(x => x.ce);
    const contextUtil = knowledgeCeScores.length > 0
        ? Math.max(...knowledgeCeScores)
        : null;
    // Pre-check on (session_id, turn_id) — the UNIQUE index tuple — and skip
    // if a row already exists. Same retry/concurrent-loop concern as
    // retrieval_outcome above. The UNIQUE index is the hard backstop.
    (async () => {
        try {
            const existing = await store.queryFirst(`SELECT id FROM turn_score
           WHERE session_id = $sid AND turn_id = $tid LIMIT 1`, { sid: sessionId, tid: responseTurnId });
            if (existing.length === 0) {
                await store.queryExec(`CREATE turn_score CONTENT $data`, { data: { session_id: sessionId, turn_id: responseTurnId, context_util: contextUtil } });
            }
        }
        catch (e) {
            swallow("retrieval-quality:turnScore", e);
        }
    })();
}
/** 0.7.27: count how many high-salience items the assistant ignored last
 *  turn. Used by cognitive-check to inject a Reflexion-style nudge. */
export async function getLastTurnGroundingTrace(sessionId, store) {
    try {
        // W2-19 (2026-06-10): rewritten as two queries. The old single query was
        // triple-dead — the subquery lacked VALUE (object rows never match
        // turn_id), MAX() is not a SurrealQL function, and patchOrderByFields
        // corrupted the outer select — so this returned null on every call and
        // the 0.7.27 Reflexion nudge never fired once.
        const latest = await store.queryFirst(`SELECT turn_id FROM retrieval_outcome
       WHERE session_id = $sid
       ORDER BY created_at DESC LIMIT 1`, { sid: sessionId });
        const lastTurnId = latest[0]?.turn_id;
        if (!lastTurnId)
            return null;
        const rows = await store.queryFirst(`SELECT memory_id, retrieval_score, cited FROM retrieval_outcome
       WHERE session_id = $sid AND turn_id = $tid`, { sid: sessionId, tid: lastTurnId });
        if (rows.length === 0)
            return null;
        const cited = rows.filter((r) => r.cited === true).length;
        const ignored = rows
            .filter((r) => r.cited !== true && (r.retrieval_score ?? 0) >= 0.6)
            .map((r) => String(r.memory_id));
        return { injected: rows.length, cited, ignored_high_salience: ignored };
    }
    catch {
        return null;
    }
}
// --- Signal computation ---
export function computeSignals(item, responseLower, toolSuccess, cited, ceScore) {
    const rawText = item.text ?? "";
    const memText = rawText.toLowerCase();
    const contextTokens = Math.ceil(rawText.length / 4);
    // Lexical signals (fallback when reranker is offline)
    const keyTermScore = keyTermOverlap(rawText, responseLower);
    const trigramScore = trigramOverlap(memText, responseLower);
    const unigramScore = unigramOverlap(memText, responseLower);
    const specific = Math.max(keyTermScore, trigramScore);
    const lexical = 0.6 * specific + 0.4 * unigramScore;
    const toolBoost = toolSuccess === true ? 0.2 : 0;
    const lexicalUtil = Math.min(1, lexical + toolBoost);
    // Primary signal: cross-encoder semantic score. The reranker measures
    // meaning overlap between the response and each retrieved item — catches
    // paraphrasing, reasoning-from-context, and synthesis that lexical overlap
    // misses. When available, blend CE (70%) with lexical (30%) so both
    // structural reuse and semantic influence contribute. When offline, fall
    // back to lexical-only.
    let utilization;
    if (ceScore != null) {
        utilization = 0.7 * ceScore + 0.3 * lexicalUtil;
    }
    else {
        utilization = lexicalUtil;
    }
    if (cited)
        utilization = Math.max(utilization, 0.7);
    // Implicit citation: if the response mentions a file path or backtick-
    // quoted identifier from the item, the item influenced the response even
    // if CE/lexical scoring is low. This catches "I'll fix src/engine/soul.ts"
    // referencing an injected artifact without [#N] citation.
    if (!cited && utilization < 0.4) {
        const pathHit = extractPaths(rawText).some(p => responseLower.includes(p.toLowerCase()));
        const identHit = extractBacktickIdents(rawText).some(id => responseLower.includes(id.toLowerCase()));
        if (pathHit || identHit)
            utilization = Math.max(utilization, 0.4);
    }
    let recency = 0.5;
    if (item.timestamp) {
        const ms = parseDatetimeMs(item.timestamp);
        if (ms != null) {
            const ageHours = (Date.now() - ms) / 3_600_000;
            recency = Math.exp(-ageHours / 168);
        }
        // ms == null: leave recency at safe default 0.5
    }
    return { utilization, toolSuccess, contextTokens, wasNeighbor: item.fromNeighbor ?? false, recency };
}
function stripPunctuation(text) {
    return text.replace(/[.,;:!?()"'\[\]{}<>—–…]/g, " ");
}
const KEY_TERM_PATTERNS = [
    /`([^`]{2,60})`/g,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\b([A-Z]{2,}(?:[-_][A-Z0-9]+)*)\b/g,
    /\b([A-Z][a-z]*[A-Z]\w*)\b/g,
    /\b([A-Z][a-z]{2,})\b/g,
    /\b(\w+(?:[-_]\w+){1,3})\b/g,
];
const STOP_WORDS = new Set([
    "the", "a", "an", "but", "and", "or", "if", "when", "this", "that",
    "for", "with", "from", "into", "not", "are", "was", "were", "has",
    "have", "been", "its", "can", "will", "may", "also", "just", "then",
    "than", "too", "very", "such", "each", "all", "any", "most", "more",
    "some", "other", "about", "over", "only", "new", "used", "how", "where",
    "what", "which", "who", "whom", "does", "did", "had", "could", "would",
    "should", "shall", "let", "get", "got", "set", "put", "run", "see",
    "try", "use", "one", "two", "now", "way", "own", "same", "here",
    "there", "still", "yet", "both", "few", "many", "much", "well",
]);
function extractKeyTerms(text) {
    const terms = new Set();
    for (const pattern of KEY_TERM_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const term = match[1].trim().toLowerCase();
            if (term.length >= 3 && !STOP_WORDS.has(term))
                terms.add(term);
        }
    }
    return terms;
}
function keyTermOverlap(source, targetLower) {
    const terms = extractKeyTerms(source);
    if (terms.size === 0)
        return 0;
    const cleanTarget = stripPunctuation(targetLower);
    let found = 0;
    for (const term of terms) {
        if (cleanTarget.includes(term))
            found++;
    }
    return found / terms.size;
}
function trigramOverlap(source, target) {
    const srcGrams = extractNgrams(stripPunctuation(source));
    if (srcGrams.size === 0)
        return 0;
    const tgtGrams = extractNgrams(stripPunctuation(target));
    let matches = 0;
    for (const gram of srcGrams) {
        if (tgtGrams.has(gram))
            matches++;
    }
    return matches / srcGrams.size;
}
function extractNgrams(text) {
    const words = text.split(/\s+/).filter((w) => w.length > 2);
    const grams = new Set();
    if (words.length >= 3) {
        for (let i = 0; i <= words.length - 3; i++) {
            grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
        }
    }
    else if (words.length === 2) {
        grams.add(`${words[0]} ${words[1]}`);
    }
    else if (words.length === 1) {
        grams.add(words[0]);
    }
    return grams;
}
function unigramOverlap(source, target) {
    const srcWords = new Set(stripPunctuation(source).split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)));
    if (srcWords.size === 0)
        return 0;
    const cleanTarget = " " + stripPunctuation(target) + " ";
    let found = 0;
    for (const word of srcWords) {
        if (cleanTarget.includes(` ${word} `) || cleanTarget.includes(` ${word}s `))
            found++;
    }
    return found / srcWords.size;
}
// --- Historical utility queries ---
export async function getHistoricalUtilityBatch(ids, store) {
    const result = new Map();
    if (ids.length === 0 || !store)
        return result;
    try {
        // K22: memory_id is a TYPE string column. A RecordId Thing never == a
        // same-text JS string in SurrealDB v3, so coerce every id to string
        // before binding into `WHERE memory_id IN $ids` or the IN match is empty.
        const stringIds = ids.map(String);
        const flat = await store.queryFirst(`SELECT memory_id,
        math::mean(IF llm_relevance != NONE THEN llm_relevance ELSE utilization END) AS avg
       FROM retrieval_outcome
       WHERE memory_id IN $ids AND (utilization > 0 OR llm_relevance != NONE)
       GROUP BY memory_id`, { ids: stringIds });
        for (const row of flat) {
            if (row.avg != null)
                result.set(String(row.memory_id), row.avg);
        }
    }
    catch (e) {
        swallow("retrieval-quality:batch", e);
    }
    return result;
}
const PATH_RE = /(?:^|\s|["'`(])(\/?(?:src|dist|test|lib|bin|scripts|config|\.claude)\/[\w./-]{3,80})/g;
function extractPaths(text) {
    const paths = [];
    for (const m of text.matchAll(PATH_RE))
        paths.push(m[1]);
    return paths;
}
function extractBacktickIdents(text) {
    const idents = [];
    for (const m of text.matchAll(/`([A-Za-z][\w.]{2,40})`/g)) {
        if (!STOP_WORDS.has(m[1].toLowerCase()))
            idents.push(m[1]);
    }
    return idents;
}
export async function getRecentUtilizationAvg(sessionId, windowSize = 10, store) {
    if (!store)
        return null;
    try {
        // T5 (2026-06-10, QA item 3): without GROUP ALL, SurrealDB 3.x throws
        // "Expected `array<number>` but found `0f`" whenever rows exist — the
        // aggregate ran per-row, so this signal had been permanently null behind
        // the bare catch since introduction. Probed live both ways.
        const rows = await store.queryFirst(`SELECT math::mean(utilization) AS avg FROM (SELECT utilization, created_at FROM retrieval_outcome WHERE session_id = $sid ORDER BY created_at DESC LIMIT $lim) GROUP ALL`, { sid: sessionId, lim: windowSize });
        // Guard against NaN: math::mean over an empty window returns NaN in
        // SurrealDB, which would propagate through orchestrator.ts:266
        // (`orch.cachedUtilAvg !== null` accepts NaN, then poisons tokenBudget
        // math). Coerce non-finite values to null so callers see "no signal".
        const avg = rows[0]?.avg ?? null;
        return Number.isFinite(avg) ? avg : null;
    }
    catch {
        return null;
    }
}
