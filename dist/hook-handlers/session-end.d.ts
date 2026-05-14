/**
 * SessionEnd hook handler.
 *
 * Queues cognitive work (extraction, reflection, skills, soul) to the
 * pending_work table for processing by a subagent on the next session.
 * No LLM calls — all intelligence runs through Claude subagents.
 *
 * Concurrency: the atomic `claimSessionForCleanup(id)` UPDATE on the
 * session record is the sole arbiter for "who handles this session" —
 * the prior `session.cleanedUp` in-memory guard was defeated by
 * `state.removeSession()` (a follow-up event recreated a fresh
 * SessionState with cleanedUp=false), and never coordinated against
 * deferredCleanup running on a sibling SessionStart.
 */
import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
export declare function handleSessionEnd(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
