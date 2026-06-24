/**
 * ISMAR-GENT Orchestration Layer
 *
 * Pre/post processing pipeline between user input and agent.prompt().
 * Classifies intent, adapts agent configuration, records metrics.
 * Target: <25ms for non-trivial prompts, <1ms for simple ones.
 *
 * Ported from laqrumbrain — takes EmbeddingService + SurrealStore as params
 * instead of module-level singletons. Per-session state via SessionState.
 */
import { classifyIntent, estimateComplexity } from "./intent.js";
import { getRecentUtilizationAvg } from "./retrieval-quality.js";
import { swallow } from "./errors.js";
import { clamp } from "./math.js";
// Detects inputs that reference memory/history
const MEMORY_REFERENCE_RE = /\b(we|our|yesterday|earlier|before|last time|prior|remember|recall|previous|discussed|decided|talked about|worked on|you said|you mentioned)\b/i;
// --- Default config ---
export const DEFAULT_ADAPTIVE_CONFIG = {
    thinkingLevel: "medium",
    toolLimit: 15,
    tokenBudget: 6000,
    retrievalShare: 0.15,
    vectorSearchLimits: { turn: 25, identity: 10, concept: 20, memory: 20, artifact: 10 },
};
// --- Intent → Config mapping ---
const INTENT_CONFIG = {
    "simple-question": {
        thinkingLevel: "low",
        toolLimit: 3,
        tokenBudget: 4000,
        retrievalShare: 0.10,
        vectorSearchLimits: { turn: 15, identity: 5, concept: 12, memory: 12, artifact: 3 },
    },
    "code-read": {
        thinkingLevel: "medium",
        toolLimit: 5,
        tokenBudget: 6000,
        retrievalShare: 0.15,
        vectorSearchLimits: { turn: 25, identity: 8, concept: 20, memory: 20, artifact: 10 },
    },
    "code-write": {
        thinkingLevel: "high",
        toolLimit: 8,
        tokenBudget: 8000,
        retrievalShare: 0.20,
        vectorSearchLimits: { turn: 30, identity: 10, concept: 20, memory: 20, artifact: 15 },
    },
    "code-debug": {
        thinkingLevel: "high",
        toolLimit: 10,
        tokenBudget: 8000,
        retrievalShare: 0.20,
        vectorSearchLimits: { turn: 30, identity: 8, concept: 20, memory: 25, artifact: 15 },
    },
    "deep-explore": {
        thinkingLevel: "medium",
        toolLimit: 15,
        tokenBudget: 6000,
        retrievalShare: 0.15,
        vectorSearchLimits: { turn: 25, identity: 8, concept: 15, memory: 15, artifact: 8 },
    },
    "reference-prior": {
        thinkingLevel: "medium",
        toolLimit: 5,
        tokenBudget: 10000,
        retrievalShare: 0.25,
        vectorSearchLimits: { turn: 40, identity: 10, concept: 25, memory: 30, artifact: 10 },
    },
    "meta-session": {
        thinkingLevel: "low",
        toolLimit: 2,
        tokenBudget: 3000,
        retrievalShare: 0.07,
        skipRetrieval: false,
        vectorSearchLimits: { turn: 8, identity: 5, concept: 5, memory: 8, artifact: 0 },
    },
    "multi-step": {
        thinkingLevel: "high",
        toolLimit: 12,
        tokenBudget: 8000,
        retrievalShare: 0.20,
        vectorSearchLimits: { turn: 30, identity: 10, concept: 20, memory: 20, artifact: 15 },
    },
    "continuation": {
        thinkingLevel: "low",
        toolLimit: 8,
        tokenBudget: 4000,
        skipRetrieval: true,
        vectorSearchLimits: { turn: 0, identity: 0, concept: 0, memory: 0, artifact: 0 },
    },
    "unknown": { ...DEFAULT_ADAPTIVE_CONFIG },
};
const sessionOrchState = new WeakMap();
function getOrchState(session) {
    let state = sessionOrchState.get(session);
    if (!state) {
        state = {
            lastConfig: { ...DEFAULT_ADAPTIVE_CONFIG },
            turnIndex: 0,
            currentTurnTools: [],
            steeringCandidates: [],
            cachedUtilAvg: null,
            utilAvgTurn: 0,
        };
        sessionOrchState.set(session, state);
    }
    return state;
}
// --- Public API ---
export async function preflight(input, session, embeddings, retrievalBudgetTokens = 42000, store) {
    const start = performance.now();
    const orch = getOrchState(session);
    orch.turnIndex++;
    orch.currentTurnTools = [];
    orch.steeringCandidates = [];
    // Fast path: trivial first-turn inputs
    const isTrivial = orch.turnIndex <= 1 && input.length < 20 && !input.includes("?");
    if (isTrivial) {
        const config = {
            thinkingLevel: "low", toolLimit: 15, tokenBudget: 300, skipRetrieval: true,
            vectorSearchLimits: { turn: 0, identity: 0, concept: 0, memory: 0, artifact: 0 },
        };
        orch.lastConfig = config;
        return {
            intent: { category: "unknown", confidence: 0, scores: [] },
            complexity: { level: "simple", estimatedToolCalls: 0, suggestedThinking: "low" },
            config,
            preflightMs: performance.now() - start,
            fastPath: true,
        };
    }
    // Non-first-turn short inputs → continuation
    if (orch.turnIndex > 1 && input.length < 20 && !input.includes("?")) {
        const inheritedLimit = Math.min(orch.lastConfig.toolLimit, 25);
        const config = {
            ...orch.lastConfig, toolLimit: inheritedLimit, skipRetrieval: true,
            vectorSearchLimits: { turn: 0, identity: 0, concept: 0, memory: 0, artifact: 0 },
        };
        orch.lastConfig = config;
        return {
            intent: { category: "continuation", confidence: 0.9, scores: [] },
            complexity: { level: "moderate", estimatedToolCalls: 15, suggestedThinking: "medium" },
            config,
            preflightMs: performance.now() - start,
            fastPath: true,
        };
    }
    // Full classification
    const intent = await classifyIntent(input, embeddings);
    const complexity = estimateComplexity(input, intent);
    const LOW_CONFIDENCE_CONFIG = {
        thinkingLevel: "low", toolLimit: 15, tokenBudget: 3000, retrievalShare: 0.08,
        vectorSearchLimits: { turn: 12, identity: 5, concept: 8, memory: 12, artifact: 3 },
    };
    let config;
    if (intent.category === "continuation") {
        config = { ...orch.lastConfig };
        config.toolLimit = Math.max(config.toolLimit, 15);
    }
    else if (intent.confidence < 0.40) {
        config = { ...LOW_CONFIDENCE_CONFIG };
    }
    else {
        config = { ...(INTENT_CONFIG[intent.category] ?? DEFAULT_ADAPTIVE_CONFIG) };
    }
    config.intent = intent.category;
    // Gate retrieval for trivial intents (unless memory-referencing)
    if ((intent.category === "simple-question" || intent.category === "meta-session") &&
        intent.confidence >= 0.70 &&
        !MEMORY_REFERENCE_RE.test(input)) {
        config.skipRetrieval = true;
        config.vectorSearchLimits = { turn: 0, identity: 0, concept: 0, memory: 0, artifact: 0 };
    }
    // Derive tokenBudget from retrieval budget
    if (config.retrievalShare != null && config.retrievalShare > 0) {
        config.tokenBudget = Math.round(retrievalBudgetTokens * config.retrievalShare);
    }
    // Override thinking if complexity demands it
    if (complexity.suggestedThinking === "high" && config.thinkingLevel !== "high") {
        config.thinkingLevel = "high";
    }
    // Override tool limit from complexity estimate (capped at 1.5x, max 20)
    if (complexity.estimatedToolCalls > config.toolLimit) {
        config.toolLimit = Math.min(complexity.estimatedToolCalls, Math.ceil(config.toolLimit * 1.5), 20);
    }
    // Adaptive token budget from rolling retrieval quality (cached, refreshed every 10 turns)
    if (!config.skipRetrieval) {
        if (orch.cachedUtilAvg === null || orch.turnIndex - orch.utilAvgTurn >= 10) {
            orch.cachedUtilAvg = await getRecentUtilizationAvg(session.sessionId, 10, store).catch(() => null);
            orch.utilAvgTurn = orch.turnIndex;
        }
        if (orch.cachedUtilAvg !== null) {
            const scale = clamp(0.5 + orch.cachedUtilAvg * 0.8, 0.5, 1.3);
            config.tokenBudget = Math.round(config.tokenBudget * scale);
        }
    }
    orch.lastConfig = config;
    return {
        intent,
        complexity,
        config,
        preflightMs: performance.now() - start,
        fastPath: false,
    };
}
/** Record a tool call for steering analysis. */
export function recordToolCall(session, name, args) {
    const orch = getOrchState(session);
    orch.currentTurnTools.push({ name, args });
    if (orch.currentTurnTools.length >= 5) {
        const last5 = orch.currentTurnTools.slice(-5);
        if (last5.every((t) => t.name === last5[0].name)) {
            orch.steeringCandidates.push({
                type: "runaway",
                toolCall: orch.currentTurnTools.length,
                detail: `${last5[0].name} called 5+ times consecutively`,
            });
        }
    }
    const budgetWarnAt = Math.floor(orch.lastConfig.toolLimit * 0.85);
    if (orch.lastConfig.toolLimit !== Infinity && orch.currentTurnTools.length >= budgetWarnAt) {
        orch.steeringCandidates.push({
            type: "budget_warning",
            toolCall: orch.currentTurnTools.length,
            detail: `${orch.currentTurnTools.length}/${orch.lastConfig.toolLimit} tool calls used`,
        });
    }
}
/** Record metrics to SurrealDB (non-blocking).
 *
 *  Sections that may be added here in the future (token recording, ACAN
 *  sample write, retrieval grade write) each get their own try/catch so a
 *  failure in one section doesn't silently swallow the whole metrics
 *  pipeline — the previous single-blanket catch would have hidden a metrics
 *  CREATE failure behind any earlier section's error. */
export async function postflight(input, result, actualToolCalls, actualTokensIn, actualTokensOut, turnDurationMs, session, store) {
    const orch = getOrchState(session);
    if (!store.isAvailable())
        return;
    // Section: metrics CREATE — highest priority. A failure here means
    // orchestrator_metrics rows stop landing entirely, blinding observability
    // dashboards and feeding null retrieval-budget math on subsequent turns.
    // Surface loudly so the silent-degradation symptom (empty orchestrator_metrics
    // table) doesn't pass for "everything's fine."
    //
    // Idempotency (Round 9, Option A): Claude Code can re-deliver Stop hook
    // events, causing postflight() to fire multiple times for the same
    // (session_id, turn_index). The UNIQUE index `orchm_unique` correctly
    // rejects duplicates, but the resulting error trips swallow.warn and
    // pollutes the "metrics pipeline degraded" channel. SELECT-check first
    // and skip the CREATE if a row already exists. Mirrors the LET/IF
    // pattern in observability.ts rollupDailyMetrics(). Race window between
    // SELECT and CREATE remains protected by the UNIQUE index, so a true
    // concurrent double-fire still surfaces via the existing swallow.warn.
    try {
        const existing = await store.queryFirst(`SELECT id FROM orchestrator_metrics
         WHERE session_id = $session_id AND turn_index = $turn_index
         LIMIT 1`, { session_id: session.sessionId, turn_index: orch.turnIndex });
        if (existing.length > 0) {
            // Re-fire of Stop hook for an already-recorded turn. No-op.
            return;
        }
        await store.queryExec(`CREATE orchestrator_metrics CONTENT $data`, {
            data: {
                session_id: session.sessionId,
                turn_index: orch.turnIndex,
                input_length: input.length,
                intent: result.intent.category,
                intent_confidence: result.intent.confidence,
                complexity: result.complexity.level,
                thinking_level: result.config.thinkingLevel,
                tool_limit: result.config.toolLimit === Infinity ? -1 : result.config.toolLimit,
                token_budget: result.config.tokenBudget,
                actual_tool_calls: actualToolCalls,
                actual_tokens_in: actualTokensIn,
                actual_tokens_out: actualTokensOut,
                preflight_ms: result.preflightMs,
                turn_duration_ms: turnDurationMs,
                steering_candidates: orch.steeringCandidates.length,
                steering_details: orch.steeringCandidates.length > 0
                    ? orch.steeringCandidates.map((c) => `${c.type}: ${c.detail}`).join("; ")
                    : undefined,
                fast_path: result.fastPath,
            },
        });
    }
    catch (e) {
        swallow.warn("orchestrator:postflight:metricsCreate — metrics pipeline silently degraded", e);
    }
}
export function getLastPreflightConfig(session) {
    return getOrchState(session).lastConfig;
}
export function getSteeringCandidates(session) {
    return getOrchState(session).steeringCandidates;
}
