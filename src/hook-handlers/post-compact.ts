/**
 * PostCompact hook handler.
 *
 * Fires AFTER Claude Code shrinks the conversation window.
 * The model just lost context, so we re-retrieve relevant knowledge
 * from the graph and inject it via additionalContext. Also clears
 * injectedSections so the next UserPromptSubmit does a full re-inject.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { assembleContextString } from "../context-assembler.js";
import { log } from "../engine/log.js";

export async function handlePostCompact(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  log.info(`PostCompact: re-retrieving context for session ${sessionId}`);

  // Clear injected sections — the model lost them in compaction,
  // so everything needs to be re-injected
  session.injectedSections.clear();

  // Re-retrieve context from the graph using the last user query
  // This rebuilds what the model lost during compaction
  const query = session.lastUserText;
  if (!query) {
    // No query to retrieve against — just inject the compaction summary
    if (session._compactionSummary) {
      const summary = session._compactionSummary;
      session._compactionSummary = undefined;
      return makeHookOutput("PostCompact",
        `[LaqrumCode context recovery after compaction]\n${summary}\n\nGraph memory will provide full context on the next prompt.`,
      );
    }
    return {};
  }

  // Full context retrieval from the graph
  const contextString = await assembleContextString(state, session, query);

  // Include compaction summary if available
  let additionalContext = contextString ?? "";
  if (session._compactionSummary) {
    additionalContext = `[Post-compaction context recovery]\n${session._compactionSummary}\n\n${additionalContext}`;
    session._compactionSummary = undefined;
  }

  return makeHookOutput("PostCompact", additionalContext || undefined);
}
