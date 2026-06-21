/**
 * Context assembler — extracts graph context as a string for Claude Code hooks.
 *
 * Calls the engine's graphTransformContext and extracts the text content
 * from the injected context message + system prompt section. This preserves
 * 100% of the retrieval logic while adapting the output for hook additionalContext.
 */
import { graphTransformContext } from "./engine/graph-context.js";
import { preflight } from "./engine/orchestrator.js";
import { upsertAndLinkConcepts } from "./engine/concept-extract.js";
import { swallow } from "./engine/errors.js";
import { log } from "./engine/log.js";
import { loadPrivacyConfig, redactSecrets, isIgnoredProject } from "./engine/redact.js";
/**
 * Run the full context retrieval pipeline and return a formatted string
 * suitable for injection as a Claude Code hook additionalContext.
 *
 * Flow: classifyIntent → vectorSearch → graphExpand → WMR/ACAN scoring
 *       → dedup → budgetTrim → formatContextMessage → extract text
 */
export async function assembleContextString(state, session, userPrompt) {
    const { store, embeddings } = state;
    if (!store.isAvailable() || !embeddings.isAvailable()) {
        log.warn(`Context assembly skipped: store=${store.isAvailable()}, embeddings=${embeddings.isAvailable()}`);
        return undefined;
    }
    // Run orchestrator preflight to classify intent and set adaptive config
    try {
        const preflightResult = await preflight(userPrompt, session, embeddings, 42000, store);
        session.currentConfig = preflightResult.config;
        if (preflightResult.config.toolLimit != null) {
            session.toolLimit = preflightResult.config.toolLimit;
        }
        session._pendingPreflight = preflightResult;
        session._pendingPreflightAt = Date.now();
        session._pendingPreflightInput = userPrompt;
        session._turnToolCalls = 0;
        session._turnTokensInStart = session._pendingInputTokens;
        session._turnTokensOutStart = session._pendingOutputTokens;
    }
    catch (e) {
        swallow.warn("assembleContext:preflight", e);
    }
    // Build a minimal message array for graphTransformContext.
    // In Claude Code, we don't have the full message history — we only have
    // the current user prompt. The engine will retrieve relevant context from
    // the graph to supplement this.
    const messages = [
        { role: "user", content: userPrompt },
    ];
    // K6-ca: graphTransformContext has its OWN internal race-timeout that returns
    // passthrough messages while graphTransformInner keeps running in the
    // background (embeddings, DB queries, scoring). Nothing cancelled that
    // post-deadline work, so a slow inner pipeline kept burning CPU/IO after the
    // caller already moved on — and on every user prompt this compounds on a
    // long-lived daemon. Drive an AbortController whose signal the inner pipeline
    // honors, and abort it as soon as graphTransformContext resolves (real result
    // OR post-timeout passthrough) or throws, cancelling any lingering inner work.
    const transformAbort = new AbortController();
    try {
        const result = await graphTransformContext({
            messages,
            session,
            store,
            embeddings,
            contextWindow: 200_000,
            signal: transformAbort.signal,
        });
        const parts = [];
        // System prompt section (pillars + tier 0 core directives)
        if (result.systemPromptSection) {
            parts.push(result.systemPromptSection);
        }
        // Extract text from injected context messages.
        // graphTransformContext prepends a context message to the message array.
        // We need to find it and extract its text content.
        // 0.7.45 renamed the envelope from <graph_context> to <recalled_memory>;
        // accept both so a future rename can't silently drop the payload again.
        for (const msg of result.messages) {
            if (msg.role === "user") {
                const text = extractText(msg);
                if (text && (text.includes("<recalled_memory>") || text.includes("<graph_context>"))) {
                    parts.push(text);
                    break;
                }
            }
        }
        // Include wakeup briefing if available and this is the first turn
        if (session.userTurnCount <= 1 && session._wakeupPromise) {
            let wakeupTimer;
            try {
                const wakeup = await Promise.race([
                    session._wakeupPromise,
                    new Promise(resolve => {
                        wakeupTimer = setTimeout(() => resolve(null), 2000);
                    }),
                ]);
                if (wakeup)
                    parts.push(wakeup);
            }
            catch { /* non-critical */ }
            finally {
                // Clear so a fast-resolving wakeupPromise doesn't leak a 2s pending
                // Timeout per first-turn context assembly.
                if (wakeupTimer !== undefined)
                    clearTimeout(wakeupTimer);
            }
        }
        // Include compaction summary if present
        if (session._compactionSummary) {
            parts.push(session._compactionSummary);
            session._compactionSummary = undefined;
        }
        // Include graduation celebration if present
        if (session._graduationCelebration) {
            const gc = session._graduationCelebration;
            parts.push(`[SOUL GRADUATION] Quality: ${gc.qualityScore.toFixed(2)} | Volume: ${gc.volumeScore.toFixed(2)}\n` +
                gc.soulSummary);
            session._graduationCelebration = undefined;
        }
        if (parts.length === 0)
            return undefined;
        // Store retrieval summary for planning gate
        session.lastRetrievalSummary = `${result.stats.graphNodes} graph nodes, ${result.stats.neighborNodes} neighbors`;
        session.lastQueryVec = null; // Will be set by the retrieval pipeline internally
        log.debug(`Context assembled: ${result.stats.graphNodes} nodes, ${result.stats.mode} mode`);
        // Phase 2: prepend a RETRIEVAL RATIONALE preamble so Claude can see WHY
        // this context was retrieved, not just WHAT was retrieved. Keywords echoed
        // from the prompt make relevance explicit rather than implicit, moving
        // grounding from inference to reading.
        //
        // The keyword extraction strategy has two passes:
        //   1. PRIORITY: pull "technical-looking" tokens — camelCase, hyphenated,
        //      contains digit/dot/slash/underscore. These are far more likely to
        //      be meaningful identifiers (file paths, function names, IDs) than
        //      plain English words.
        //   2. FALLBACK: plain words >= 4 chars that aren't in the stopword set.
        //      The stopword set is much larger than the original 19-word list to
        //      filter out common conversational noise like "completely",
        //      "incorrect", "search", "context", which produced misleading
        //      retrieval rationales like "based on prompt keywords: context,
        //      search, completely, incorrect".
        const STOP = new Set([
            // Articles, pronouns, basic verbs
            "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
            "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall",
            "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "about", "between",
            "through", "during", "it", "its", "this", "that", "these", "those", "i", "you", "we", "they",
            "my", "your", "our", "their", "what", "which", "who", "how", "when", "where", "why", "not",
            "no", "and", "or", "but", "if", "so", "any", "all", "some", "more", "just", "also", "than",
            "very", "too", "much", "many",
            // Common conversational filler / adjectives / adverbs
            "completely", "incorrect", "correct", "wrong", "right", "broken", "working", "missing",
            "really", "actually", "probably", "maybe", "perhaps", "clearly", "obviously", "exactly",
            "again", "still", "even", "well", "good", "bad", "great", "fine", "okay", "yeah", "yes",
            "actually", "basically", "mostly", "kind", "sort", "like", "want", "need", "make", "made",
            "take", "took", "give", "gave", "tell", "told", "show", "shown", "said", "says", "know",
            "knew", "think", "thought", "going", "doing", "done", "got", "get", "getting", "find",
            "found", "look", "looks", "looking", "seem", "seems", "mean", "means", "meant",
            // Common nouns
            "thing", "things", "stuff", "way", "ways", "time", "times", "place", "places", "part",
            "parts", "point", "points", "case", "issue", "issues", "problem", "problems", "fix",
            "fixes", "bug", "bugs", "error", "errors", "change", "changes", "update", "updates",
            "version", "versions", "question", "questions", "answer", "answers", "reason", "reasons",
            "context", "search", "report", "reports", "check", "checks", "status", "state", "states",
            // Common verbs (4+ chars)
            "make", "made", "running", "runs", "ran", "start", "started", "stop", "stopped", "keep",
            "kept", "work", "works", "worked", "help", "helps", "helped", "need", "needs", "needed",
            "want", "wanted", "wants", "seem", "seems", "tried", "trying", "done", "using", "used",
            "uses", "used",
            // Modal-ish
            "well", "just", "such", "then", "than", "also", "over", "under", "both", "each", "every",
            "before", "after", "above", "below", "while", "again", "both", "other", "others", "same",
            "different", "new", "old",
        ]);
        const allWords = userPrompt
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length >= 3);
        // Pass 1: technical-looking tokens (preserve case for display).
        // Match in original text to keep camelCase visible.
        const original = userPrompt.split(/\s+/).filter(w => w.length >= 3);
        const technicalRe = /[a-z][A-Z]|[A-Z][a-z]|[a-z0-9]-[a-z0-9]|[a-z0-9]\.[a-z0-9]|[a-z0-9]\/[a-z0-9]|[a-z0-9]_[a-z0-9]|[0-9]/;
        const technicalTokens = original
            .map(w => w.replace(/[^a-zA-Z0-9_./-]/g, ""))
            .filter(w => w.length >= 3 && technicalRe.test(w));
        // Pass 2: fallback to plain English words if we didn't get enough technical tokens
        const plain = allWords
            .map(w => w.replace(/[^a-z0-9]/g, ""))
            .filter(w => w.length >= 4 && !STOP.has(w));
        // Dedup while preserving order
        const seen = new Set();
        const keywords = [];
        for (const w of [...technicalTokens, ...plain]) {
            const lower = w.toLowerCase();
            if (seen.has(lower))
                continue;
            seen.add(lower);
            keywords.push(w);
            if (keywords.length >= 6)
                break;
        }
        const rationale = "=== RETRIEVAL RATIONALE ===\n" +
            `Retrieved ${result.stats.graphNodes} graph nodes + ${result.stats.neighborNodes} neighbors ` +
            `based on prompt keywords: ${keywords.length > 0 ? keywords.join(", ") : "(general)"}.` +
            (result.stats.mode ? ` Mode: ${result.stats.mode}.` : "") +
            "\nScan items below; items matching your user's intent should be grounded in your reply.";
        return [rationale, ...parts].join("\n\n");
    }
    catch (e) {
        swallow.warn("assembleContext:transform", e);
        return undefined;
    }
    finally {
        // K6-ca: cancel any inner pipeline work still running after
        // graphTransformContext's own race resolved (its internal timeout returns
        // passthrough while graphTransformInner continues in the background).
        transformAbort.abort();
    }
}
/**
 * Ingest a user or assistant message into the graph database.
 * Embeds the text and stores it as a turn record with relations.
 */
export async function ingestTurn(state, session, role, text) {
    const { store, embeddings } = state;
    // C3: clear the assistant-turn pointer up front. If this assistant turn is
    // empty / ignored-project / filler and early-returns below without creating a
    // turn row, the pointer must NOT keep referencing a PRIOR assistant turn —
    // stop.ts attributes retrieval_outcome (ACAN training) rows to
    // lastAssistantTurnId, and a stale id mis-attributes them to the wrong turn
    // (or collides on the (session,turn,memory) UNIQUE and silently drops them).
    if (role === "assistant")
        session.lastAssistantTurnId = "";
    if (!store.isAvailable() || !text)
        return;
    // GH #16 privacy: never persist content from an ignored project, and strip
    // secrets BEFORE the text is embedded or stored — so the graph never holds
    // them, and downstream extractions inherit the redaction (concept/memory
    // extraction derives from this stored turn text).
    const privacy = loadPrivacyConfig();
    if (isIgnoredProject(session.projectId, privacy))
        return;
    const redacted = redactSecrets(text, privacy.redactPatterns);
    if (redacted !== text) {
        log.warn(`[privacy] redacted secret(s) from a ${role} turn before storage`);
        text = redacted;
    }
    // Skip filler messages
    const trimmed = text.trim().toLowerCase();
    if (trimmed.length < 5 || ["ok", "sure", "yes", "no", "thanks"].includes(trimmed))
        return;
    try {
        let embedding = null;
        if (embeddings.isAvailable()) {
            // K43: BGE-M3 has an 8192-token context window; text longer than it
            // throws "Input is longer than the context size" and the embed fails.
            // The 22,282-char slice exceeded that window for dense text, so a long
            // turn either failed to embed or (pre-K5) aborted the whole upsert. Match
            // the maintenance turn/memory backfill's documented safe target of 6000
            // chars (surreal.ts: "safely below ~7800 tokens worst case for English")
            // so the live-ingest cohort and the backfill cohort embed the SAME prefix
            // — otherwise an un-embedded long turn would heal to a different vector
            // than the one it would have gotten live.
            const INGEST_EMBED_CHAR_LIMIT = 6_000;
            // K5: wrap ONLY the embed. Previously a transient embed failure (model
            // not yet warm, OOM, an over-window text that still slips through) threw
            // out to the outer catch BEFORE upsertTurn ran, so the turn row was never
            // written and the conversation turn was lost forever. Degrade to a null
            // embedding instead: upsertTurn stores an un-embedded row and the
            // maintenance turn-backfill (WHERE embedding IS NONE) heals it later.
            try {
                embedding = await embeddings.embed(text.slice(0, INGEST_EMBED_CHAR_LIMIT));
            }
            catch (e) {
                swallow("ingest:embed", e);
                embedding = null;
            }
        }
        // Stash user embedding for reuse in context retrieval
        if (role === "user" && embedding) {
            session.lastUserEmbedding = embedding;
        }
        const turnId = await store.upsertTurn({
            session_id: session.sessionId,
            role,
            text,
            embedding,
        });
        if (turnId) {
            // Link to session
            if (session.surrealSessionId) {
                await store.relate(turnId, "part_of", session.surrealSessionId)
                    .catch(e => swallow("ingest:relate", e));
            }
            // responds_to edge
            if (role === "assistant" && session.lastUserTurnId) {
                await store.relate(turnId, "responds_to", session.lastUserTurnId)
                    .catch(e => swallow("ingest:responds_to", e));
            }
            // Auto-seal: extract concept names from the turn text and wire
            // `mentions` edges (turn → concept). Previously this linking was
            // only done by the dormant memory-daemon, so live-session turns
            // left the concept graph unaware of what was being discussed.
            // Bounded to 10 concepts/turn via upsertAndLinkConcepts's internal
            // extractConceptNames cap — hot path, but cheap per call.
            upsertAndLinkConcepts(turnId, "mentions", text, store, embeddings, "ingest:turn", { taskId: session.taskId, projectId: session.projectId }).catch(e => swallow("ingest:mentions", e));
        }
        if (role === "user") {
            session.lastUserTurnId = turnId;
            // Increment lost in 4f7b962 (SDK removal). Without this every SessionEnd
            // sees userTurnCount=0, skipping extraction/reflection/skill_extract/
            // handoff_note — only the unconditional causal_graduate + soul_generate
            // pair queues, both auto-skip-complete, and monologue/causal_chain
            // never get written.
            session.userTurnCount++;
        }
        else {
            session.lastAssistantTurnId = turnId;
        }
    }
    catch (e) {
        swallow.warn("ingestTurn", e);
    }
}
/** Extract text content from a message. */
function extractText(msg) {
    if (typeof msg.content === "string")
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((b) => b.type === "text")
            .map(b => b.text)
            .join("\n");
    }
    return null;
}
