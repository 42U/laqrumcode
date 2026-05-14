/**
 * llm_output hook — token tracking, text length accumulation,
 * dynamic budget parsing, and cognitive check triggering.
 */
import { parseClassificationFromText } from "./before-tool-call.js";
import { swallow } from "../errors.js";
export function createLlmOutputHandler(state) {
    return async (event, ctx) => {
        const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? "default";
        const session = state.getSession(sessionKey);
        if (!session)
            return;
        // Measure assistant text output (used for token estimation and planning gate)
        const textLen = event.assistantTexts.reduce((s, t) => s + t.length, 0);
        // Extract token counts — OpenClaw's getUsageTotals() returns CUMULATIVE totals
        // across all API calls in the session, not per-response values.
        // Compute the delta since last call to avoid quadratic overcounting.
        const reportedInput = event.usage?.input ?? 0;
        const reportedOutput = event.usage?.output ?? 0;
        const reportedCacheRead = event.usage?.cacheRead ?? 0;
        const reportedCacheWrite = event.usage?.cacheWrite ?? 0;
        const reportedTotal = reportedInput + reportedOutput + reportedCacheRead + reportedCacheWrite;
        let deltaTokens;
        if (reportedTotal > 0) {
            deltaTokens = Math.max(0, reportedTotal - session.lastSeenUsageTotal);
            session.lastSeenUsageTotal = reportedTotal;
        }
        else if (textLen > 0) {
            // No usage data — fall back to text-length estimate
            deltaTokens = Math.ceil(textLen / 4); // ~4 chars per token
        }
        else {
            deltaTokens = 0;
        }
        // DB stats: approximate input/output split from the delta
        const inputTokens = reportedTotal > 0 && deltaTokens > 0
            ? Math.round(deltaTokens * (reportedInput / reportedTotal))
            : 0;
        const outputTokens = reportedTotal > 0 && deltaTokens > 0
            ? Math.round(deltaTokens * (reportedOutput / reportedTotal))
            : (deltaTokens > 0 ? deltaTokens : Math.ceil(textLen / 4));
        // Batch session stats writes — accumulate in-memory, flush every 5th response
        if (session.surrealSessionId) {
            session._pendingInputTokens = (session._pendingInputTokens ?? 0) + inputTokens;
            session._pendingOutputTokens = (session._pendingOutputTokens ?? 0) + outputTokens;
            session._statsFlushCounter = (session._statsFlushCounter ?? 0) + 1;
            if (session._statsFlushCounter >= 5) {
                try {
                    await state.store.bumpSessionTurn(session.surrealSessionId);
                    await state.store.addSessionTokens(session.surrealSessionId, session._pendingInputTokens, session._pendingOutputTokens);
                }
                catch (e) {
                    swallow("hook:llmOutput:sessionStats", e);
                }
                session._pendingInputTokens = 0;
                session._pendingOutputTokens = 0;
                session._statsFlushCounter = 0;
            }
        }
        session.cumulativeTokens += deltaTokens;
        // Track accumulated text output for planning gate
        session.turnTextLength += textLen;
        if (textLen > 50) {
            session.toolCallsSinceLastText = 0;
        }
        // Dynamic budget: parse LOOKUP/EDIT/REFACTOR from first assistant text
        if (session.toolCallCount <= 1 && event.assistantTexts.length > 0) {
            const fullText = event.assistantTexts.join("");
            const classLimit = parseClassificationFromText(fullText);
            if (classLimit !== null) {
                session.toolLimit = classLimit;
            }
        }
        // Capture thinking blocks for monologue extraction
        const lastAssistant = event.lastAssistant;
        if (lastAssistant?.content && Array.isArray(lastAssistant.content)) {
            for (const block of lastAssistant.content) {
                if (block.type === "thinking") {
                    const thinking = block.thinking ?? block.text ?? "";
                    if (thinking.length > 50) {
                        session.pendingThinking.push(thinking);
                        // Cap to prevent unbounded growth in long sessions
                        const max = state.config.thresholds.maxPendingThinking;
                        if (session.pendingThinking.length > max) {
                            session.pendingThinking.splice(0, session.pendingThinking.length - max);
                        }
                    }
                }
            }
        }
        // Track lastAssistantText for downstream use (afterTurn, daemon batching).
        // Turn creation is handled by afterTurn() -> ingest() in context-engine.ts.
        if (event.assistantTexts.length > 0) {
            const text = event.assistantTexts.join("\n");
            if (text.length > 0) {
                session.lastAssistantText = text;
            }
        }
    };
}
