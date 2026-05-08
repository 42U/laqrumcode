/**
 * UserPromptSubmit hook handler.
 *
 * The core context injection point. Runs the full retrieval pipeline:
 * intent classification → vector search → graph expand → WMR/ACAN scoring
 * → dedup → budget trim → format. Returns assembled context as additionalContext.
 *
 * On the first turn of a new session, also checks for pending background
 * work and instructs Claude to spawn a subagent to process it.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { assembleContextString, ingestTurn } from "../context-assembler.js";
import { swallow } from "../engine/errors.js";
import { stripStructuralTags } from "../engine/sanitize.js";
import { log } from "../engine/log.js";
import { detectAnomalies, formatAnomalyBlock } from "../engine/observability.js";


/** Wrap raw kongcode context in a system-reminder block. Claude Code's harness
 * gives system-reminder blocks higher attention weight than plain injected
 * text — empirically the plain-text injection was hitting ~10% retrieval
 * utilization because the model read it as ambient noise.
 *
 * 0.7.44: legend rewritten to align with Anthropic's documented prompt-
 * engineering guidance for Claude 4.5+:
 *  - "MUST" and "authoritative" softened — Anthropic explicitly warns these
 *    overtrigger on 4.5+ models.
 *  - Motivation-first: instruction frames the WHY (let the model decide
 *    relevance) rather than commanding compliance.
 *  - Quote-first grounding: ask for explicit reference-by-id when grounding,
 *    matching Anthropic's documented `<quotes>`-then-answer pattern.
 *
 * This is stage 2 of the v0.7.43-45 injection rework. Stages 3+ will move
 * the body itself to XML semantic tags and intent-gate the directive load. */
function wrapKongcodeContext(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return raw ?? "";
  // Strip any pre-existing <system-reminder>...</system-reminder> blocks from the
  // input before re-wrapping. Without this, kongcode's wrapper ends up nested
  // inside Claude Code's harness wrapper (or a prior hook's wrapper), which
  // shows visibly to the model and suggests sloppy concatenation.
  const stripped = stripStructuralTags(raw).trim();
  if (!stripped) return "";
  return [
    "<system-reminder>",
    "The following is supplementary context for this turn. Use items when",
    "they're relevant; ignore items that don't match the question.",
    "",
    "Salience tags help you prioritize: [load-bearing] items are most likely",
    "to be relevant — when answering, reference them by id (e.g. [#3]) so",
    "the user can trace your reasoning. [supporting] items add context.",
    "Untagged items are background — skip unless directly applicable.",
    "",
    "Before finalizing: check that factual claims about prior work are",
    "either grounded in items below or explicitly framed as inference.",
    "",
    stripped,
    "</system-reminder>",
  ].join("\n");
}

export async function handleUserPromptSubmit(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId) ?? state.getOrCreateSession(sessionId, sessionId);

  // Reset per-turn state
  session.resetTurn();

  // Backfill DB rows for resumed sessions. Claude Code does not refire
  // SessionStart on `claude --resume`, so without this every resumed
  // conversation lacks a session row — turns ingested OK but unattributable
  // (session.turn_count stays at 0, graduation thresholds undercount, the
  // X-close orphan pattern persists). ensureSessionRow is idempotent so
  // SessionStart can still own first-fire and this just no-ops on warm
  // sessions.
  if (state.store.isAvailable() && !session.surrealSessionId) {
    try {
      if (!session.agentId) {
        session.agentId = await state.store.ensureAgent("kongcode", "claude");
      }
      session.surrealSessionId = await state.store.ensureSessionRow(
        session.sessionId,
        session.agentId,
        session.projectId || undefined,
      );
      log.info(`[user-prompt-submit] backfilled session row for ${sessionId} → ${session.surrealSessionId}`);
    } catch (e) {
      swallow("userPromptSubmit:ensureSessionRow", e);
    }
  }

  // Increment session turn_count at turn START (0.7.12+). Previously this
  // was done in Stop, which is the most fragile lifecycle hook (timeouts,
  // transcript-read failures, occasional drops). UserPromptSubmit is
  // reliable: fires synchronously when the user types, never dropped,
  // no transcript dependency. Token accounting still happens in Stop
  // because token counts aren't known until the assistant has responded.
  // Fire-and-forget so the hook returns promptly.
  if (state.store.isAvailable() && session.surrealSessionId) {
    state.store.bumpSessionTurn(session.surrealSessionId)
      .catch(e => swallow("userPromptSubmit:bumpTurn", e));
  }

  // Claude Code sends the user's text in `prompt`. Earlier code read
  // `payload.user_prompt`, which never existed in the actual hook payload —
  // the handler silently early-returned on every prompt for ~20 days,
  // killing turn ingestion and the entire retrieval pipeline.
  const userPrompt = (payload.prompt as string) ?? (payload.user_prompt as string) ?? "";
  if (!userPrompt) return {};

  session.lastUserText = userPrompt;

  // Ingest user message into graph (async, don't block context assembly)
  ingestTurn(state, session, "user", userPrompt).catch(() => {});

  // 0.7.44: bypass sigil. Prefix with `*` or `/raw` to suppress kongcode's
  // injection for that turn. Turn ingestion still fires (we want history
  // tracked); only the substrate retrieval + assembly is skipped. Useful
  // when the user wants a clean shot at the model without the substrate
  // competing for attention. Strip the sigil from the upstream prompt so
  // Claude doesn't see it as part of the question.
  const bypassMatch = userPrompt.match(/^(\*\s|\/raw\s+)/);
  if (bypassMatch) {
    log.debug(`UserPromptSubmit: bypass sigil detected for session=${sessionId}, skipping injection`);
    return {};
  }

  // Run full context retrieval pipeline
  const contextString = await assembleContextString(state, session, userPrompt);

  // On first turn, check for pending background work from previous sessions
  let pendingWorkMessage = "";
  if (session.userTurnCount <= 1 && state.store.isAvailable()) {
    try {
      const pending = await state.store.queryFirst<{ count: number }>(
        `SELECT count() AS count FROM pending_work WHERE status = "pending" GROUP ALL`,
      );
      const count = pending[0]?.count ?? 0;
      if (count > 0) {
        pendingWorkMessage = `\n\n<kongcode_pending_work>
KongCode has ${count} pending memory operation${count > 1 ? "s" : ""} from previous sessions (extraction, reflection, skills, soul).

IMPORTANT: Spawn a background agent to process these. Use:
- subagent_type: "kongcode:memory-extractor"
- model: opus (highest intelligence for knowledge extraction)
- run_in_background: true
- Prompt: "Process all pending KongCode memory work. Loop: call fetch_pending_work to get the next item, analyze the data according to the instructions provided, then call commit_work_results with your output. Repeat until fetch_pending_work returns empty. Be thorough in your extractions — this is the intelligence layer."

This runs silently in the background. Respond to the user normally.
</kongcode_pending_work>`;
        log.info(`[pending_work] ${count} items queued for subagent processing`);
      }
    } catch (e) {
      swallow("userPromptSubmit:pendingCheck", e);
    }
  }

  // E3: anomaly-only health injection. Runs cheap absolute-threshold
  // detectors and prepends a [kongcode-alert] block ONLY if any flag fires.
  // Cooldowns prevent spam; absent alerts mean substrate is healthy.
  let anomalyBlock = "";
  if (state.store.isAvailable()) {
    try {
      const flags = await detectAnomalies(state.store, state.observabilityCooldown);
      if (flags.length > 0) anomalyBlock = formatAnomalyBlock(flags);
    } catch (e) {
      swallow("userPromptSubmit:anomalies", e);
    }
  }

  const additionalContext = [anomalyBlock, contextString, pendingWorkMessage].filter(Boolean).join("") || undefined;

  log.debug(`UserPromptSubmit: session=${sessionId}, context=${contextString ? "injected" : "none"}, pending=${pendingWorkMessage ? "yes" : "no"}`);

  return makeHookOutput("UserPromptSubmit", wrapKongcodeContext(additionalContext));
}
