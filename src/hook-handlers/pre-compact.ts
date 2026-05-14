/**
 * PreCompact hook handler.
 *
 * Fires BEFORE Claude Code shrinks the conversation window.
 * Ingests any pending turns into SurrealDB before they're lost.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { ingestTurn } from "../context-assembler.js";
import { swallow } from "../engine/errors.js";
import { log } from "../engine/log.js";

export async function handlePreCompact(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  log.info(`PreCompact: flushing knowledge before compaction for session ${sessionId}`);

  // Ingest any un-ingested turns while we still have the full conversation
  if (session.lastUserText) {
    await ingestTurn(state, session, "user", session.lastUserText).catch(() => {});
  }
  if (session.lastAssistantText) {
    await ingestTurn(state, session, "assistant", session.lastAssistantText).catch(() => {});
  }

  // Flush session stats to DB
  const { store } = state;
  if (store.isAvailable() && session.surrealSessionId) {
    try {
      // 0.7.12+: addSessionTokens (no turn_count bump from this path —
      // that's owned exclusively by UserPromptSubmit now). PreCompact
      // is a flush of any tokens accrued since the last Stop, NOT a
      // turn boundary, so incrementing turn_count here was always wrong.
      await store.addSessionTokens(
        session.surrealSessionId,
        session._pendingInputTokens,
        session._pendingOutputTokens,
      );
      session._pendingInputTokens = 0;
      session._pendingOutputTokens = 0;
      session._statsFlushCounter = 0;
    } catch (e) {
      swallow("preCompact:sessionStats", e);
    }
  }

  // Stash compaction summary for PostCompact to inject after the window
  // shrinks. Extracts structured signals (pending work, key files, tools used,
  // recent errors, last message) so the model doesn't lose mid-task
  // context when Claude Code drops old messages.
  const parts: string[] = [];
  parts.push(`Session: turn ${session.userTurnCount}, ${session.cumulativeTokens} tokens processed`);
  if (session.lastUserText) parts.push(`Last user request: ${session.lastUserText.slice(0, 200)}`);
  if (session.currentConfig) parts.push(`Current intent: ${session.currentConfig.intent ?? "unknown"}`);

  try {
    if (store.isAvailable()) {
      const turns = await store.getSessionTurnsRich(sessionId, 30);
      if (turns.length > 0) {
        const fullText = turns.map(t => t.text).join("\n");

        // Pending work detection (claw-code pattern: compact.rs:235-254)
        const pendingRe = /\b(todo|next|pending|follow up|remaining|unfinished|still need)\b[^.\n]{0,100}/gi;
        const pendingMatches = [...fullText.matchAll(pendingRe)]
          .map(m => m[0].trim().slice(0, 160))
          .slice(0, 5);

        // Key file extraction (claw-code: compact.rs:256-269)
        const filePaths = [...new Set(
          (fullText.match(/[\w\-/.]+\.\w{1,5}/g) ?? [])
            .filter(p => /\.(ts|js|py|rs|go|md|json|yaml|toml|tsx|jsx)$/.test(p)),
        )].slice(0, 10);

        // Tool names used (claw-code: compact.rs:127-137)
        const toolNames = [...new Set(
          turns.filter(t => t.tool_name).map(t => t.tool_name!),
        )];

        // Recent errors — preserve tool failure context across compaction
        const errorRe = /\b(error|failed|exception|crash|panic|TypeError|ReferenceError)\b[^.\n]{0,120}/gi;
        const recentErrors = [...fullText.matchAll(errorRe)]
          .map(m => m[0].trim().slice(0, 160))
          .slice(-3);

        // Current work inference (claw-code: compact.rs:272-279)
        const lastText = turns.filter(t => t.text.length > 10).at(-1)?.text.slice(0, 200) ?? "";

        if (pendingMatches.length > 0) parts.push(`PENDING: ${pendingMatches.join("; ")}`);
        if (filePaths.length > 0) parts.push(`FILES: ${filePaths.join(", ")}`);
        if (toolNames.length > 0) parts.push(`TOOLS USED: ${toolNames.join(", ")}`);
        if (recentErrors.length > 0) parts.push(`RECENT ERRORS: ${recentErrors.join("; ")}`);
        if (lastText) parts.push(`LAST: ${lastText}`);
        parts.push("Resume directly — do not recap what was happening.");
      }
    }
  } catch (e) {
    swallow("preCompact:structuredSignals", e);
  }

  session._compactionSummary = parts.join("\n");

  // Record the compaction in compaction_checkpoint for observability. The
  // writer (store.createCompactionCheckpoint) existed since the port but
  // was only called from ContextEngine.compact() which is dead code —
  // a second regression alongside the signal-extraction gap fixed in
  // 7d8fef5. rangeStart=0 because Claude Code doesn't give us the actual
  // pre-compact turn range; rangeEnd is the current cumulative turn count.
  if (store.isAvailable()) {
    store.createCompactionCheckpoint(sessionId, 0, session.userTurnCount)
      .catch(e => swallow.warn("preCompact:checkpoint", e));
  }

  return {};
}
