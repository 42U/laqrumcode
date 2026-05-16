/**
 * Claude Code transcript reader.
 *
 * Stop hook needs the assistant's response text to evaluate retrieval
 * utilization (text overlap with retrieved items). The Stop payload itself
 * doesn't carry the response — only `transcript_path` to the JSONL file
 * Claude Code writes turn by turn. This module pulls the latest assistant
 * text from that file.
 *
 * Why this exists: previously the Stop hook read `session.lastAssistantText`,
 * but nothing in the production hook chain ever set that field — the
 * llm-output engine handler that populates it is test-only, never wired.
 * As a result, `evaluateRetrieval` always early-returned (no turn id, no
 * response text) and `retrieval_outcome` writes silently stopped on
 * Apr 15. This reader closes that loop.
 */
import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
const READ_TAIL_BYTES = 256 * 1024; // 256 KB tail is enough for the last assistant turn
/**
 * Read the latest assistant message text from a Claude Code transcript.
 *
 * Reads only the file's tail (256 KB) for performance. Returns "" if
 * the file is missing, unreadable, or contains no assistant message
 * with text content.
 */
export function readLatestAssistantText(transcriptPath) {
    if (!transcriptPath)
        return "";
    let raw;
    try {
        const stats = statSync(transcriptPath);
        if (stats.size > READ_TAIL_BYTES) {
            // Read tail only — open + seek + read window
            const buf = Buffer.alloc(READ_TAIL_BYTES);
            const fd = openSync(transcriptPath, "r");
            try {
                readSync(fd, buf, 0, READ_TAIL_BYTES, stats.size - READ_TAIL_BYTES);
            }
            finally {
                closeSync(fd);
            }
            raw = buf.toString("utf-8");
            // Drop the (likely partial) first line
            const nl = raw.indexOf("\n");
            if (nl >= 0)
                raw = raw.slice(nl + 1);
        }
        else {
            raw = readFileSync(transcriptPath, "utf-8");
        }
    }
    catch {
        return "";
    }
    let latestText = "";
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (obj.type !== "assistant")
            continue;
        const content = obj.message?.content;
        const text = extractAssistantText(content);
        if (text)
            latestText = text; // keep updating; last one wins
    }
    return latestText;
}
function extractAssistantText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        if (block && typeof block === "object" && block.type === "text") {
            const t = block.text;
            if (typeof t === "string" && t.trim())
                parts.push(t);
        }
    }
    return parts.join("\n");
}
/**
 * Read per-turn token usage from the transcript.
 *
 * Returns aggregate `{ inputTokens, outputTokens }` for the most-recent
 * assistant turn:
 *   - `inputTokens` is the LATEST assistant message's usage.input_tokens
 *     plus its cache_read + cache_creation tokens. Cumulative-by-position
 *     in Anthropic's API; the latest message reflects the full turn input.
 *   - `outputTokens` is the SUM of output_tokens across all assistant
 *     messages in the current turn (possibly multiple if tool use happened).
 *
 * "Current turn" = assistant messages after the most recent user message
 * whose content isn't purely tool_result blocks.
 *
 * Returns null if no usage data is found. Powers postflight()'s
 * orchestrator_metrics fields actual_tokens_in / actual_tokens_out, which
 * had been stuck at 0 because nothing populated session._pendingInputTokens
 * in production (the engine-side llm-output handler that sets it is
 * test-only, same dead-code shape as the v0.4.2 fixes).
 */
export function readTurnTokenUsage(transcriptPath) {
    if (!transcriptPath)
        return null;
    let raw;
    try {
        const stats = statSync(transcriptPath);
        if (stats.size > READ_TAIL_BYTES) {
            const buf = Buffer.alloc(READ_TAIL_BYTES);
            const fd = openSync(transcriptPath, "r");
            try {
                readSync(fd, buf, 0, READ_TAIL_BYTES, stats.size - READ_TAIL_BYTES);
            }
            finally {
                closeSync(fd);
            }
            raw = buf.toString("utf-8");
            const nl = raw.indexOf("\n");
            if (nl >= 0)
                raw = raw.slice(nl + 1);
        }
        else {
            raw = readFileSync(transcriptPath, "utf-8");
        }
    }
    catch {
        return null;
    }
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    // Walk bottom-up: sum assistant output_tokens; capture latest input_tokens;
    // stop at the first real (non-tool_result) user message.
    let outputSum = 0;
    let latestInput = null;
    let sawAssistant = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        let obj;
        try {
            obj = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        if (obj.type === "assistant") {
            const usage = obj.message?.usage;
            if (usage) {
                if (typeof usage.output_tokens === "number")
                    outputSum += usage.output_tokens;
                if (latestInput == null) {
                    // Most recent assistant — its input_tokens captures the full turn input.
                    // Include cache reads/creates as they're real tokens billed.
                    latestInput = (usage.input_tokens ?? 0)
                        + (usage.cache_read_input_tokens ?? 0)
                        + (usage.cache_creation_input_tokens ?? 0);
                }
                sawAssistant = true;
            }
            continue;
        }
        if (obj.type === "user") {
            // Tool-result-only user messages are part of the assistant's tool loop,
            // not a turn boundary. A turn boundary is a user message with text content.
            const c = obj.message?.content;
            const isOnlyToolResult = Array.isArray(c)
                && c.every(b => b && typeof b === "object" && b.type === "tool_result");
            if (!isOnlyToolResult && sawAssistant)
                break; // hit the prompt that started this turn
        }
    }
    if (latestInput == null && outputSum === 0)
        return null;
    return { inputTokens: latestInput ?? 0, outputTokens: outputSum };
}
