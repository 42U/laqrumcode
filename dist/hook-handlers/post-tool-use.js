/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training and tracks artifact mutations.
 */
import { swallow } from "../engine/errors.js";
import { commitKnowledge } from "../engine/commit.js";
import { recordToolOutcome } from "../engine/retrieval-quality.js";
import { loadPrivacyConfig, isIgnoredPath } from "../engine/redact.js";
/** Tools whose result text is worth scanning for file paths. recall surfaces
 *  paths from prior turns; Grep/Glob return path lists by definition.
 *  Each match feeds session._observedFilePaths so a follow-up Edit on a
 *  surfaced path clears the edit-gate immediately — without this, the
 *  Tier-0 directive's "recall it" advice was a lie. 0.7.48 fix. */
const PATH_OBSERVING_TOOLS = ["Grep", "Glob"];
function isPathObservingTool(toolName) {
    if (PATH_OBSERVING_TOOLS.includes(toolName))
        return true;
    // MCP-routed tool names look like `mcp__<plugin>__<name>` — match any
    // recall variant so kongcode's own and any forked recall tool count.
    return toolName.includes("recall");
}
/** Extract path-shaped substrings from tool result text. Two patterns:
 *  (1) anything with a slash and printable non-whitespace tail, (2) bare
 *  filenames ending in a known source/config extension. Bias toward
 *  over-extraction — a false positive is a harmless Set entry, while a
 *  false negative re-locks the gate and forces an avoidable Read call. */
const SLASH_PATH_RE = /[/~][^\s'"`<>{}()\[\],]+/g;
// Token splitter for the extension scan. Same delimiter class as SLASH_PATH_RE's
// negated set so wrapping punctuation `(foo.ts)` / `"foo.ts"` splits cleanly.
// S7: backslash is a delimiter too. A Windows path `C:\Users\x\foo.ts` is one
// whitespace-delimited token; without `\\` in the split class the leading `C:`
// makes EXT_TOKEN_RE's head class (`[\w./~-]*`, no `:`) fail and the whole path
// is silently dropped — a functional regression vs the old `\b`-anchored
// EXT_PATH_RE on Windows. Splitting on `\\` peels the tail `foo.ts` so the
// FILES: compaction hint still names the file (it need not reconstruct the full
// backslash path, and this token is only a hint — it does not clear the
// edit-gate, which keys on the surfaced path verbatim).
const TOKEN_SPLIT_RE = /[\s'"`<>{}()\[\],\\]+/;
// Anchored, per-token extension tester. CRITICAL (R4 ReDoS fix): this is matched
// against a single short token with ^...$ anchors, NOT scanned globally over the
// whole text. The previous `EXT_PATH_RE` ( `/[\w./~-]+\.(?:ext)\b/g` ) put `.`
// inside the `+` class AND required a literal `\.` after it; on an adversarial
// dot-heavy run those two overlap at every position, so a failed extension match
// forces the engine to retry every partition — catastrophic O(n^2)+ backtracking
// (~4s per 64KB slice on the shared daemon event loop). Anchoring + the
// MAX_PATH_TOKEN length cap below make the work strictly bounded per token, and
// String.split is linear, so a 64KB all-dots / "x."*N input is now sub-ms.
const EXT_TOKEN_RE = /^[\w./~-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|md|markdown|json|jsonc|yaml|yml|toml|sql|sh|bash|html|css|scss|sass|xml|env|surql|gradle|tf|tfvars)$/;
// Recover a leading `path.ext` from a `path.ext:line[:col]match` token where the
// matched line has NO whitespace (e.g. grep -n on a minified line) so the token
// never split. The head class excludes `:`, so it cannot overlap the `:\d`
// separator that follows — still linear (anchored, bounded token). This is what
// the old `\b`-anchored global regex got for free; without it `bar.js:7:hit`
// would silently drop `bar.js` from the gate / compaction summary.
const EXT_HEAD_RE = /^([\w./~-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|md|markdown|json|jsonc|yaml|yml|toml|sql|sh|bash|html|css|scss|sass|xml|env|surql|gradle|tf|tfvars)):\d/;
// A real path token is short. Anything longer is junk (e.g. a multi-KB dot-run
// crafted to trigger backtracking) — reject before the regex ever sees it.
const MAX_PATH_TOKEN = 512;
/** Strip a trailing grep/compiler `:line[:col]` and/or sentence punctuation from
 *  a token, in one linear reverse pass. Equivalent to the old
 *  `/(?::\d+|[.,:;!?])+$/` replace, but NON-backtracking.
 *
 *  S3: the regex form was still residually QUADRATIC. The outer `(...)+` wraps an
 *  alternation whose `:\d+` branch itself contains `\d+`; on a token like
 *  `:1:1:1…X` (a `:digit` run whose final char breaks the `$` anchor) the engine
 *  tries every way to partition the run across the two nested quantifiers —
 *  measured O(n^2): ~16ms @4KB, ~260ms @16KB, ~4200ms @64KB. The MAX_PATH_TOKEN
 *  cap bounds a single live token to ~1ms, but the primitive itself stays a
 *  latent footgun and the R4/R16 "linear" claim was false for this line.
 *
 *  Reverse scan reads the suffix grammar `(?::\d+|[.,:;!?])+` backward:
 *   - a char in [.,:;!?] (this includes a bare `:`) is a single-char atom;
 *   - a run of digits counts only when immediately preceded by `:` (a `:\d+`
 *     group); bare digits are not in the grammar, so we stop.
 *  We peel maximal atoms off the end until none matches — the largest suffix the
 *  greedy `(atom)+$` regex would have matched. Verified byte-identical to the
 *  regex across the documented cases (`foo.ts:42:`, `foo.ts:12:5`, `foo.ts.`,
 *  `bar.js:7:hit`) and O(n) (sub-0.1ms on the 64KB `:1`-bomb). */
function stripPathSuffix(tok) {
    let end = tok.length;
    for (;;) {
        if (end === 0)
            break;
        const last = tok.charCodeAt(end - 1);
        // digit (0-9): tail of a possible `:\d+` group
        if (last >= 0x30 && last <= 0x39) {
            let j = end;
            while (j > 0) {
                const c = tok.charCodeAt(j - 1);
                if (c >= 0x30 && c <= 0x39)
                    j--;
                else
                    break;
            }
            // need a ':' immediately before the digit run to form `:\d+`
            if (j > 0 && tok.charCodeAt(j - 1) === 0x3a /* ':' */) {
                end = j - 1;
                continue;
            }
            break; // bare digits — not in the suffix grammar
        }
        // single-char punct atom: . , : ; ! ?
        if (last === 0x2e /* . */ || last === 0x2c /* , */ || last === 0x3a /* : */ ||
            last === 0x3b /* ; */ || last === 0x21 /* ! */ || last === 0x3f /* ? */) {
            end -= 1;
            continue;
        }
        break;
    }
    return end === tok.length ? tok : tok.slice(0, end);
}
/** Shared hardened extension-path extractor (R4/R16). Tokenizes on whitespace
 *  and wrapping punctuation, length-caps each token, then anchor-tests it. This
 *  is the single ReDoS-safe primitive reused by post-tool-use AND pre-compact so
 *  the fix cannot drift back into a vulnerable inline regex. Exported for
 *  pre-compact.ts (key-file extraction over joined transcript turns). */
export function extractExtPaths(text, observe) {
    for (const tok of text.split(TOKEN_SPLIT_RE)) {
        if (tok.length === 0 || tok.length > MAX_PATH_TOKEN)
            continue;
        // Strip a trailing grep/compiler line:col suffix and/or sentence
        // punctuation (`foo.ts:42:`, `foo.ts:12:5`, `foo.ts.`). The old `\b`-anchored
        // global regex got the clean path for free; stripPathSuffix replicates it so
        // `src/foo.ts:42:` still yields `src/foo.ts`. S3: this used to be a
        // `/(?::\d+|[.,:;!?])+$/` replace whose nested quantifiers backtracked
        // quadratically on a `:1:1…` token; the reverse scan is strictly O(n).
        const cleaned = stripPathSuffix(tok);
        if (cleaned.length > 1 && EXT_TOKEN_RE.test(cleaned)) {
            observe(cleaned);
            continue;
        }
        // Whole-token didn't match: try the `path.ext:line` head (grep/compiler).
        const head = EXT_HEAD_RE.exec(tok);
        if (head && head[1].length > 1)
            observe(head[1]);
    }
}
function extractPathsFromText(text, observe) {
    for (const m of text.match(SLASH_PATH_RE) ?? []) {
        const cleaned = m.replace(/[.,:;!?]+$/, "");
        if (cleaned.length > 1)
            observe(cleaned);
    }
    extractExtPaths(text, observe);
}
export async function handlePostToolUse(state, payload) {
    const sessionId = payload.session_id ?? "default";
    const session = state.getSession(sessionId);
    if (!session)
        return {};
    const { store, embeddings } = state;
    const toolName = payload.tool_name ?? "";
    // Claude Code's PostToolUse payload field is `tool_response` (object or
    // string). The previous `tool_result` read was wrong and never matched,
    // so cumulativeTokens was stuck at 0 and recordToolOutcome never fired.
    const toolResponse = payload.tool_response ?? payload.tool_result;
    const toolResultText = typeof toolResponse === "string"
        ? toolResponse
        : toolResponse != null ? JSON.stringify(toolResponse) : undefined;
    if (toolResultText) {
        session.cumulativeTokens += Math.ceil(toolResultText.length / 4);
        // Make recall / Grep / Glob results clear the edit-gate. Without this,
        // the deny message and the active-profile Tier-0 directive both told
        // the agent "recall it to clear the gate" — and the gate ignored it.
        // K48: cap the scanned slice. The two regex scans are O(n) over the WHOLE
        // tool result; a multi-MB Grep/recall payload runs the global regex across
        // every byte on this hot path. The edit-gate only needs recently-surfaced
        // paths, so the first 64KB is plenty — anything past that is over-scan that
        // costs CPU on every PostToolUse for no gate benefit.
        if (isPathObservingTool(toolName)) {
            const scanText = toolResultText.length > 64 * 1024
                ? toolResultText.slice(0, 64 * 1024)
                : toolResultText;
            // Route every extracted path through observeFilePath so the Set stays
            // bounded (K48) — extraction over a big Grep payload can yield thousands
            // of matches, and on a long-lived session it only grows otherwise.
            extractPathsFromText(scanText, (p) => session.observeFilePath(p));
        }
    }
    // Detect failure: top-level `error`, or tool_response object with
    // is_error=true (Anthropic tool_result convention).
    const isError = !!payload.error
        || (typeof toolResponse === "object" && toolResponse !== null
            && toolResponse.is_error === true);
    recordToolOutcome(session.sessionId, !isError);
    // Count tool calls for this turn — consumed by handleStop to feed
    // postflight()'s orchestrator_metrics write. Reset at preflight time.
    session._turnToolCalls += 1;
    // Track file artifacts from Write/Edit tools.
    // Look up args by tool_use_id (matching the PreToolUse write key) so
    // parallel Write calls don't read each other's args.
    if ((toolName === "Write" || toolName === "Edit") && store.isAvailable()) {
        const toolUseId = String(payload.tool_use_id ?? "");
        const toolInput = toolUseId
            ? session.pendingToolArgs.get(toolUseId)
            : undefined;
        const filePath = toolInput?.file_path;
        // GH #16 privacy: don't even record that an ignore_paths file was touched.
        if (filePath && !isIgnoredPath(filePath, loadPrivacyConfig())) {
            try {
                // Route through commitKnowledge so the file artifact auto-seals
                // artifact_mentions edges to concepts. Previously this write was
                // a bare createArtifact; the artifact landed without any edges
                // to the concept graph, so "what concepts is this file about?"
                // queries returned nothing.
                await commitKnowledge({ store, embeddings }, {
                    kind: "artifact",
                    path: filePath,
                    type: "file",
                    description: `${toolName}: ${filePath}`,
                });
            }
            catch (e) {
                // Upgrade from silent swallow to warn so commitKnowledge failures
                // surface in the log instead of silently dropping artifacts.
                swallow.warn("postToolUse:artifact", e);
            }
        }
        if (toolUseId)
            session.pendingToolArgs.delete(toolUseId);
    }
    return {};
}
