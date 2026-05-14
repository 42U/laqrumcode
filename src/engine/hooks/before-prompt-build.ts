/**
 * before_prompt_build hook — orchestrator preflight.
 * Classifies intent, adapts retrieval config, sets thinking level.
 */

import type { GlobalPluginState } from "../state.js";
import { preflight } from "../orchestrator.js";
import { swallow } from "../errors.js";

export function createBeforePromptBuildHandler(state: GlobalPluginState) {
  return async (
    event: { prompt: string; messages: unknown[] },
    ctx: { sessionKey?: string; sessionId?: string },
  ) => {
    const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? "default";
    const session = state.getSession(sessionKey);
    if (!session) return;

    // Reset per-turn counters
    session.resetTurn();

    try {
      const result = await preflight(
        event.prompt,
        session,
        state.embeddings,
        42000,
        state.store,
      );

      // Store config on session for graph-context to read
      session.currentConfig = result.config;

      // Return system prompt addition with thinking level override
      return {
        prependSystemContext: result.config.skipRetrieval
          ? undefined
          : `[Intent: ${result.intent.category} (${(result.intent.confidence * 100).toFixed(0)}%) | Tool budget: ${result.config.toolLimit} | Retrieval: ${result.config.tokenBudget} tokens]`,
        thinkingLevel: result.config.thinkingLevel,
      };
    } catch (e) {
      swallow.warn("hook:beforePromptBuild", e);
      return undefined;
    }
  };
}
