/**
 * Shared concept-extraction helpers.
 *
 * Regex-based extraction of concept names from text, plus helpers to
 * upsert extracted concepts and link them via arbitrary edge types.
 */
import { swallow } from "./errors.js";
import { commitKnowledge } from "./commit.js";
// Re-exports so downstream callers that imported these from concept-extract.js
// don't break after the 0.4.0 split (the functions moved to concept-links.ts).
export { linkToRelevantConcepts, linkConceptHierarchy } from "./concept-links.js";
// Verb-triggered extractor: captures a CapitalizedNoun (or two) that follows
// an action verb. Expanded beyond the original handful to cover conversational
// patterns like "fix X", "deploy X", "ship X", "run X", and trading actions.
export const CONCEPT_RE = /\b(?:use|using|implement|create|add|configure|setup|install|import|fix|deploy|ship|launch|run|test|check|monitor|update|hedge|build|refactor|audit|extract|classify|trigger)\s+([A-Z][a-zA-Z0-9_-]+(?:\s+[A-Z][a-zA-Z0-9_-]+)?)/g;
// Generic tech nouns — kept for backwards compatibility but the identifier
// patterns below surface the domain-specific jargon that actually matters.
const TECH_TERMS = /\b(api|database|schema|migration|endpoint|middleware|component|service|module|handler|controller|model|interface|type|class|function|method|hook|plugin|extension|config|cache|queue|worker|daemon)\b/gi;
// snake_case or dotted identifiers: smart_mm_bot, hedge_lock, reply_log.csv
const IDENT_SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/g;
// kebab-case identifiers: follow-up, hedge-lock, reply-banner
const IDENT_KEBAB = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+){1,})\b/g;
// All-caps tickers/acronyms of length >= 3: KXETH, KXFED, SMTP, IMAP, SMS
const ACRONYM = /\b([A-Z]{3,}[A-Z0-9]*)\b/g;
// Tokens that look like project/product nouns: repeated CapWords (2 occurrences => keep)
const CAP_WORD = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
const STOPWORDS = new Set([
    "this", "that", "these", "those", "there", "here", "when", "where",
    "what", "which", "while", "with", "from", "into", "onto", "about",
    "after", "before", "between", "through",
]);
// Common log/status acronyms and English words that pass the ACRONYM regex
// but carry no concept value. Without this stoplist, error logs, headers,
// and conversational text generate noise concepts that pollute recall.
const STOPLIST_ACRONYMS = new Set([
    // Status/log noise
    "RED", "GREEN", "OK", "ERROR", "FAIL", "FAILED", "PASS", "PASSED",
    "UP", "DOWN", "ON", "OFF", "TRUE", "FALSE", "NULL", "NONE",
    "PID", "TID", "UID", "GID", "TODO", "FIXME", "DEBUG", "INFO", "WARN", "WARNING",
    // HTTP methods
    "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD",
    // Format/protocol
    "HTTP", "HTTPS", "URL", "URI", "JSON", "YAML", "CSV", "XML", "HTML", "CSS",
    // Hardware
    "CPU", "RAM", "GPU", "IO", "OS",
    // Currency
    "USD", "EUR", "GBP", "JPY",
    // Common English words that appear in ALL-CAPS in logs, headers, chat
    "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER",
    "WAS", "ONE", "OUR", "OUT", "HAS", "HIS", "HOW", "ITS", "LET", "MAY",
    "NEW", "NOW", "OLD", "SEE", "WAY", "WHO", "DID", "GOT", "HAS", "HIM",
    "SAY", "SHE", "TOO", "USE", "SET", "RUN", "TRY", "ASK", "OWN", "WHY",
    "YOUR", "THAT", "WITH", "THIS", "WILL", "EACH", "MAKE", "LIKE", "LONG",
    "LOOK", "MANY", "THEM", "THEN", "SOME", "THAN", "WHAT", "WHEN", "WERE",
    "BEEN", "HAVE", "SAID", "FROM", "THEY", "ALSO", "BACK", "BEEN", "CALL",
    "COME", "JUST", "KNOW", "TAKE", "WANT", "GIVE", "MOST", "ONLY", "OVER",
    "SUCH", "TELL", "VERY", "EVEN", "FIND", "HERE", "KEEP", "LAST", "MUCH",
    "NAME", "NEXT", "NEED", "PART", "SAME", "SHOW", "SIDE", "WELL", "WENT",
    "WORK", "DOES", "DONE", "ELSE", "GOOD", "HELP", "INTO", "MADE",
    "TIME", "USED", "SURE", "MOVE", "NICE", "PLEASE", "THINK", "COULD",
    "WOULD", "SHOULD", "AFTER", "FIRST", "STILL", "ABOUT", "THESE", "THOSE",
    "OTHER", "BEING", "WHERE", "THERE", "THEIR", "WHICH", "RIGHT", "EVERY",
    "NEVER", "START", "MIGHT", "WHILE", "ABOVE", "BELOW", "MAYBE",
    "NOTE", "STEP", "FILE", "LINE", "CODE", "DATA", "TYPE", "TEXT",
    "STOP", "SKIP", "OPEN", "SAVE", "LOAD", "SEND", "READ", "EDIT",
    "TEST", "PUSH", "PULL", "SORT", "WAIT", "EXIT", "ZERO",
    "POP", "ADD", "END", "TOP", "ROW", "KEY", "TAG", "LOG", "MAP", "FIX",
]);
/** Default upper bound on concepts returned per text. Override per call. */
export const DEFAULT_CONCEPT_CAP = 20;
/** Extract concept name strings from free text using regex heuristics. */
export function extractConceptNames(text, max = DEFAULT_CONCEPT_CAP) {
    const concepts = new Set();
    // 1. Verb-triggered concept names (CapitalizedNoun after action verbs)
    let match;
    const re1 = new RegExp(CONCEPT_RE.source, CONCEPT_RE.flags);
    while ((match = re1.exec(text)) !== null) {
        concepts.add(match[1].trim());
    }
    // 2. Generic tech nouns (lowercased)
    const re2 = new RegExp(TECH_TERMS.source, TECH_TERMS.flags);
    while ((match = re2.exec(text)) !== null) {
        concepts.add(match[1].toLowerCase());
    }
    // 3. snake_case, kebab-case, ALLCAPS identifiers. Surfaces domain-specific
    //    jargon: smart_mm_bot, hedge-lock, KXETH, check_replies_imap.
    const counts = new Map();
    const bump = (s) => counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const re of [IDENT_SNAKE, IDENT_KEBAB, ACRONYM, CAP_WORD]) {
        const r = new RegExp(re.source, re.flags);
        while ((match = r.exec(text)) !== null) {
            const tok = match[1];
            if (!tok || tok.length < 3)
                continue;
            if (STOPWORDS.has(tok.toLowerCase()))
                continue;
            if (STOPLIST_ACRONYMS.has(tok))
                continue;
            bump(tok);
        }
    }
    // Only keep identifier-like tokens that either appear 2+ times OR match a
    // high-signal shape (snake_case / kebab-case / ALLCAPS with digits).
    for (const [tok, n] of counts) {
        if (n >= 2) {
            concepts.add(tok);
            continue;
        }
        if (/[_-]/.test(tok) || /^[A-Z0-9]+$/.test(tok)) {
            concepts.add(tok);
        }
    }
    return [...concepts].slice(0, Math.max(0, max));
}
/**
 * Upsert concepts from text and link them to a source node via the given edge.
 *
 * Used for:
 *  - turn  → "mentions"          → concept  (existing behaviour)
 *  - memory → "about_concept"    → concept  (Fix 1)
 *  - artifact → "artifact_mentions" → concept (Fix 2)
 */
export async function upsertAndLinkConcepts(sourceId, edgeName, text, store, embeddings, logTag, opts) {
    const names = extractConceptNames(text);
    if (names.length === 0)
        return;
    for (const name of names) {
        try {
            // Route every concept creation through commitKnowledge so hierarchy
            // (narrower/broader) + related_to auto-seal for this concept. Before
            // 0.4.0 this function called store.upsertConcept directly and only
            // wired the source→concept edge — every caller (ingestTurn,
            // after-tool-call, gems pre-Stage-B, etc.) was silently leaving
            // concepts unlinked within the concept graph itself.
            const { id: conceptId } = await commitKnowledge({ store, embeddings }, {
                kind: "concept",
                name,
                sourceId,
                edgeName,
                source: logTag,
                projectId: opts?.projectId,
                // v0.7.78: derived_from→task and relevant_to→project are now
                // auto-sealed inside commitConcept (via derivedFromTargetId +
                // projectId/linkToProject). The two hand-wired writes that used
                // to live here have been retired.
                derivedFromTargetId: opts?.taskId,
            });
        }
        catch (e) {
            swallow(`${logTag}:upsert`, e);
        }
    }
}
// linkToRelevantConcepts and linkConceptHierarchy moved to concept-links.ts
// in 0.4.0 to break the potential circular import between this file and
// commit.ts. They remain re-exported from this module at the top so
// existing callers don't need to change imports.
