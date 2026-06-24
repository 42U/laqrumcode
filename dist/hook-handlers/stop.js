/**
 * Stop hook handler.
 *
 * Turn boundary marker: ingests the assistant response, updates token
 * counters, and evaluates retrieval quality.
 */
import { ingestTurn } from "../context-assembler.js";
import { evaluateRetrieval } from "../engine/retrieval-quality.js";
import { postflight } from "../engine/orchestrator.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";
import { readLatestAssistantText, readTurnTokenUsage } from "../engine/transcript-reader.js";
import { rollupDailyMetrics, pruneRawMetrics } from "../engine/observability.js";
import { todayUtc } from "../daemon/auto-drain.js";
// K49: the day the daily rollup is CURRENTLY in flight for. Guards against the
// concurrent double-fire — many Stop hooks can land in the window between the
// fire and `state.lastRollupDay` being committed (which we now defer until the
// async rollup actually resolves), and without this each would re-fire the
// expensive rollup+prune. Module-scoped (one daemon owns the rollup) and reset
// in the promise's finally so a failed run is retried on the next turn.
let _rollupInFlightDay = null;
export async function handleStop(state, payload) {
    const sessionId = payload.session_id ?? "default";
    const session = state.getSession(sessionId);
    if (!session)
        return {};
    const { store } = state;
    // Pull the assistant's response text from the transcript. Stop is the
    // only place where the just-completed response is observable, and it
    // doesn't ride in the hook payload — only `transcript_path` does. This
    // replaces the previous reliance on `session.lastAssistantText`, which
    // was never populated in production (the engine-side llm-output handler
    // that sets it is test-only).
    const transcriptPath = payload.transcript_path ?? "";
    const assistantText = transcriptPath ? readLatestAssistantText(transcriptPath) : "";
    if (assistantText)
        session.lastAssistantText = assistantText;
    // Pull per-turn token usage from the transcript and bump the cumulative
    // session counters. Without this, _pendingInputTokens stays at 0 (the
    // engine-side llm-output handler that bumps it is test-only), the delta
    // math below always yields 0, and postflight stamps every
    // orchestrator_metrics row with actual_tokens_in/out=0. Same dead-code
    // pattern as the v0.4.2 Stop fix — close the loop via transcript_path.
    if (transcriptPath) {
        const usage = readTurnTokenUsage(transcriptPath);
        if (usage) {
            session._pendingInputTokens += usage.inputTokens;
            session._pendingOutputTokens += usage.outputTokens;
        }
    }
    // Ingest assistant response (await — evaluateRetrieval below needs the
    // assistant turn id this call sets on the session). Previously this was
    // fire-and-forget, so the very next line read an empty turn id and
    // skipped retrieval evaluation entirely.
    if (session.lastAssistantText) {
        try {
            await ingestTurn(state, session, "assistant", session.lastAssistantText);
        }
        catch (e) {
            swallow.warn("stop:ingestAssistant", e);
        }
    }
    // Evaluate retrieval quality for ACAN training. K2: fire-and-forget — do
    // NOT await. evaluateRetrieval cross-encodes staged items, which is bounded
    // (top-K + token budget) but still CPU work the user shouldn't wait on at the
    // turn boundary. Awaiting it here put CE throughput directly on the
    // user-visible Stop latency. Staging is race-safe across the gap: the
    // evaluator marks its entry `evaluating` and only deletes the entry it still
    // owns, so a next-turn stageRetrieval can replace it without being clobbered.
    // We snapshot turnId/text into locals because the session fields can be
    // overwritten by the next turn before the async evaluator reads them.
    if (store.isAvailable() && session.lastAssistantTurnId) {
        const evalSessionId = session.sessionId;
        const evalTurnId = session.lastAssistantTurnId;
        const evalText = session.lastAssistantText;
        // R3: register the detached eval with the daemon-level pending-task set so
        // graceful shutdown drains it (bounded) BEFORE disposing the reranker /
        // force-closing Surreal. Still fire-and-forget for the user-visible turn —
        // we do NOT await here — but the LAST turn's ACAN rows (retrieval_outcome +
        // turn_score) survive a close that lands right after Stop. The .catch keeps
        // it from rejecting the awaitPendingTasks allSettled with an unhandled error.
        const evalPromise = evaluateRetrieval(evalSessionId, evalTurnId, evalText, store)
            .catch(e => swallow("stop:retrievalQuality", e));
        state.registerPendingTask(evalPromise);
    }
    // Postflight: write the per-turn orchestrator_metrics row. The writer
    // in orchestrator.ts had been intact since the port but with zero
    // callers — the preflight side stashed fields on session at context
    // assembly time so we could reach them here across the hook boundary.
    // Table had 0 rows pre-0.4.0 entirely because of this missing call.
    if (store.isAvailable() && session._pendingPreflight) {
        const pending = session._pendingPreflight;
        const tokensIn = session._pendingInputTokens - session._turnTokensInStart;
        const tokensOut = session._pendingOutputTokens - session._turnTokensOutStart;
        const turnDurationMs = Date.now() - session._pendingPreflightAt;
        postflight(session._pendingPreflightInput, pending, session._turnToolCalls, Math.max(0, tokensIn), Math.max(0, tokensOut), turnDurationMs, session, store).catch(e => swallow("stop:postflight", e));
        // Clear the pending stash so the next turn starts fresh
        session._pendingPreflight = null;
        session._pendingPreflightInput = "";
        session._turnToolCalls = 0;
    }
    // Flush per-turn token deltas to the session row. turn_count is no
    // longer incremented here as of 0.7.12 — that moved to UserPromptSubmit
    // (reliable hook, fires at turn start). Stop only owns token accounting
    // because token counts aren't known until the assistant has responded.
    if (store.isAvailable() && session.surrealSessionId) {
        const tokensIn = Math.max(0, session._pendingInputTokens - session._turnTokensInStart);
        const tokensOut = Math.max(0, session._pendingOutputTokens - session._turnTokensOutStart);
        store.addSessionTokens(session.surrealSessionId, tokensIn, tokensOut)
            .catch(e => swallow("stop:sessionTokens", e));
    }
    // Daily rollup trigger — turn-driven (no setInterval drift). On the
    // first Stop after midnight UTC, roll up yesterday's metrics into
    // orchestrator_metrics_daily and prune raw rows older than 30d. Cheap
    // when the day hasn't changed (one string compare); the actual rollup
    // and prune fire at most once per day per running MCP.
    //
    // K49: only COMMIT state.lastRollupDay after the rollup+prune actually
    // resolves (in .then), and leave it unchanged on failure so the next turn
    // retries — the prior code advanced it synchronously before the promise
    // settled, so a transient rollup/prune failure permanently skipped the day.
    // _rollupInFlightDay prevents the concurrent re-fire in the gap between
    // launch and commit; it's cleared in finally so a failed run isn't wedged.
    if (store.isAvailable()) {
        const today = todayUtc();
        if (state.lastRollupDay !== today && _rollupInFlightDay !== today) {
            _rollupInFlightDay = today;
            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            rollupDailyMetrics(store, yesterday)
                .then(() => pruneRawMetrics(store, 30))
                .then(() => { state.lastRollupDay = today; })
                .catch(e => swallow.warn("stop:dailyRollup", e))
                .finally(() => { _rollupInFlightDay = null; });
        }
    }
    log.debug(`Stop: turn=${session.userTurnCount}, tokens=${session.cumulativeTokens}`);
    if (session._pushDetected) {
        session._pushDetected = false;
        return {
            decision: "block",
            reason: "[LaqrumCode] Remember your tier0 directives are important to the user and make you more helpful. " +
                "You just ran git push. Before declaring done: " +
                "(1) Check CI status with `gh run list` or `gh run watch`. " +
                "(2) If CI hasn't triggered (e.g. only fires on tags), state that explicitly. " +
                "(3) Do NOT say 'pushed' or 'done' without verifying. " +
                "Read and follow the Tier-0 rules. " +
                "And remember to save knowledge gems along the way.",
        };
    }
    return {};
}
