/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */

import type { GlobalPluginState } from "../engine/state.js";
import { makeHookOutput, type HookResponse } from "../http-api.js";
import { log } from "../engine/log.js";
import { swallow, isUniqueViolation } from "../engine/errors.js";
import { runGates } from "../engine/hooks/gate-registry.js";
import { commitKnowledge } from "../engine/commit.js";

/** Tools that touch a file via an explicit `file_path` argument. The gate
 *  treats any of these as an "observation" of that path for the rest of
 *  the session, so a Read followed by an Edit in the same response is
 *  not blocked. 0.7.48 fix for the mid-response gating gap. */
const FILE_AWARE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "MultiEdit"]);

export async function handlePreToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const toolName = (payload.tool_name as string) ?? "";
  session.toolCallCount++;
  session.toolCallsSinceLastText++;

  // ── Observation pass (must run before any gate) ───────────────────────
  // Record every file path the agent has touched via a file-aware tool so
  // the edit-gate can resolve "I just Read this" immediately, without
  // waiting for Stop to ingest tool I/O into turn.text. Pre-0.7.48 the
  // gate only saw turn rows (which lag the assistant by a full response)
  // so a Read → Edit pair in the same response was always blocked — even
  // when the Read had succeeded.
  if (FILE_AWARE_TOOLS.has(toolName)) {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (filePath) session._observedFilePaths.add(filePath);
  }

  // ── Gate evaluation (extensible registry) ─────────────────────────────
  // Built-in gates (config-protection, edit-gate, bash-gate) plus any
  // user-defined gates from ~/.kongcode/gates.json. First deny wins.
  const gateResult = await runGates({
    state,
    session,
    toolName,
    toolInput: (payload.tool_input as Record<string, unknown>) ?? {},
    payload,
  });
  if (gateResult) return gateResult;

  // Detect git push — flag for CI reminder at Stop
  if (toolName === "Bash") {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const command = toolInput?.command as string | undefined;
    if (command && /git\s+push\b/.test(command)) {
      session._pushDetected = true;
    }
  }

  // Planning gate: soft interrupt if over tool budget
  if (session.toolCallCount > session.toolLimit && !session.softInterrupted) {
    session.softInterrupted = true;
    log.debug(`Tool budget soft interrupt: ${session.toolCallCount}/${session.toolLimit}`);
    return makeHookOutput("PreToolUse",
      `[KongCode] Remember your tier0 directives are important to the user and make you more helpful. ` +
        `Tool budget reached (${session.toolCallCount}/${session.toolLimit}). ` +
        "Consider summarizing progress before making more tool calls. " +
        "And remember to save knowledge gems along the way.",
    );
  }

  // Redundant recall detection: if user prompt was already retrieved via
  // graphTransformContext, block manual recall with similar query
  if (toolName.includes("recall") && session.lastRetrievalSummary) {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const recallQuery = toolInput?.query as string | undefined;

    if (recallQuery && session.lastRetrievalSummary) {
      // Don't block — just inform that context was already retrieved
      return makeHookOutput("PreToolUse",
        `[KongCode] Remember your tier0 directives are important to the user and make you more helpful. ` +
          `Context was already auto-retrieved this turn (${session.lastRetrievalSummary}). ` +
          "Only call recall if you need something specific not already in the injected context. " +
          "And remember to save knowledge gems along the way.",
      );
    }
  }

  // Track pending tool args for artifact extraction in PostToolUse.
  // Keyed by tool_use_id (NOT toolName) so two parallel Write calls don't
  // overwrite each other's args. PostToolUse reads back by tool_use_id.
  if (toolName === "Write" || toolName === "Edit") {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const toolUseId = String(payload.tool_use_id ?? "");
    if (toolInput?.file_path && toolUseId) {
      session.pendingToolArgs.set(toolUseId, toolInput);
    } else if (toolInput?.file_path && !toolUseId) {
      // Silent skip would hide a Claude Code contract change (e.g. payload
      // shape rename). PostToolUse would then read pendingToolArgs and miss
      // the artifact entirely, so commitKnowledge never fires for this
      // Write/Edit and the artifact->concept edges never get sealed. Surface
      // it instead so a future contract drift is detectable.
      log.warn(`[pre-tool-use] ${toolName} missing tool_use_id — artifact tracking skipped for ${String(toolInput.file_path).slice(0, 120)}`);
    }
  }

  // Subagent spawn capture (R3). Claude Code's Agent / Task tool invocations
  // fire PreToolUse with rich payload: tool_use_id + tool_input.subagent_type
  // + tool_input.prompt + tool_input.description. Write an initial subagent
  // row here; SubagentStop will complete it. Fire-and-forget; errors swallowed.
  if ((toolName === "Agent" || toolName === "Task") && state.store.isAvailable()) {
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    const toolUseId = String(payload.tool_use_id ?? "");
    const subagentType = String(toolInput?.subagent_type ?? "general-purpose");
    const description = String(toolInput?.description ?? "").slice(0, 200);
    const prompt = String(toolInput?.prompt ?? "");

    if (!toolUseId) {
      // No correlation key → can't dedup, can't anchor SubagentStop. Skip.
      log.warn(`[pre-tool-use] ${toolName} spawn missing tool_use_id — subagent row will not be created. subagent_type=${subagentType}`);
    } else if (!session.surrealSessionId) {
      // v0.7.77: without surrealSessionId, commitKnowledge would refuse to
      // seal the spawned/spawned_from/derived_from edges. Writing the row
      // alone would just create the orphan rows the auto-sealing campaign
      // exists to prevent. Skip.
      log.warn(`[pre-tool-use] ${toolName} spawn missing surrealSessionId — subagent row not created (orphan-prevention). corr=${toolUseId.slice(0, 8)}`);
    } else {
      // v0.7.77: route the entire spawn through commitKnowledge so the
      // subagent row + three edges (spawned, spawned_from, derived_from)
      // are auto-sealed together. UNIQUE-violation recovery on
      // (correlation_key, run_id) is internal to commitSubagent — caller
      // just trusts the returned id whether it's a new row or a sibling
      // recovered from the TOCTOU race. Fire-and-forget per existing pattern.
      (async () => {
        try {
          const result = await commitKnowledge(state, {
            kind: "subagent",
            parent_session_id: session.sessionId,
            surrealSessionId: session.surrealSessionId!,
            correlation_key: toolUseId,
            // Placeholder run_id = correlation_key; schema UNIQUE on run_id
            // collides when multiple rows share NONE. SubagentStop UPDATEs
            // run_id later if a real value shows up; otherwise the placeholder
            // stays — fine because correlation_key is already globally unique
            // per spawn.
            run_id: toolUseId,
            agent_type: subagentType,
            description,
            prompt_preview: prompt.slice(0, 500),
            prompt_length: prompt.length,
            outcome: "in_progress",
            tool_call_count: 0,
            taskId: session.taskId,
          });
          if (result.id) {
            session._activeSubagents.set(toolUseId, result.id);
            log.info(`[subagent] spawned: type=${subagentType} corr=${toolUseId.slice(0, 8)} edges=${result.edges}`);
          }
        } catch (e) {
          swallow.warn("preToolUse:subagent:create", e);
        }
      })();
    }
  }

  return {};
}
