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
      // Subagent spawn with no correlation key — we can write the row but
      // SubagentStop will have nothing to match against, and the row will
      // get orphaned. Surface the contract drift instead of silently
      // dropping the spawn capture.
      log.warn(`[pre-tool-use] ${toolName} spawn missing tool_use_id — subagent row will not be created (orphan stop guaranteed at SubagentStop). subagent_type=${subagentType}`);
    } else {
      (async () => {
        try {
          // Dedup: PreToolUse can fire twice for the same tool_use_id on hook
          // timeout retries. Skip if a row already exists for this correlation
          // key. Agent 1 is adding a UNIQUE index on subagent.correlation_key
          // that will reject a duplicate at the DB layer; this avoids even
          // attempting the CREATE.
          const existing = await state.store.queryFirst<{ id: string }>(
            `SELECT id FROM subagent WHERE correlation_key = $cid LIMIT 1`,
            { cid: toolUseId },
          ).catch(() => []);
          if (existing[0]?.id) {
            const existingId = String(existing[0].id);
            session._activeSubagents.set(toolUseId, existingId);
            log.debug(`[subagent] duplicate spawn skipped: corr=${toolUseId.slice(0, 8)} existing=${existingId.slice(-8)}`);
            return;
          }

          let rows: { id: string }[] = [];
          try {
            rows = await state.store.queryFirst<{ id: string }>(
              `CREATE subagent CONTENT $data RETURN id`,
              {
                data: {
                  parent_session_id: session.sessionId,
                  agent_type: subagentType,
                  description,
                  prompt_preview: prompt.slice(0, 500),
                  prompt_length: prompt.length,
                  outcome: "in_progress",
                  correlation_key: toolUseId,
                  // Placeholder run_id = correlation_key. The new schema UNIQUE
                  // on subagent.run_id collides when multiple rows have
                  // run_id=NONE (NULLs are NOT distinct in the index). Stamping
                  // the correlation_key here keeps the constraint happy at
                  // spawn time; SubagentStop will UPDATE run_id with the real
                  // value if one shows up in the stop event, otherwise the
                  // placeholder stays — which is fine, because correlation_key
                  // is already globally unique per spawn.
                  run_id: toolUseId,
                  tool_call_count: 0,
                },
              },
            );
          } catch (createErr) {
            // TOCTOU: between our existence-check SELECT and the CREATE, a
            // sibling PreToolUse can race in and write the same correlation_key.
            // The UNIQUE index then rejects ours, which is exactly the protection
            // the index was designed for. Re-SELECT to grab the sibling's id so
            // we can still stash it for SubagentStop, but stay on log.debug so
            // the warn channel doesn't fill with every successful dedup race.
            if (isUniqueViolation(createErr)) {
              const sibling = await state.store.queryFirst<{ id: string }>(
                `SELECT id FROM subagent WHERE correlation_key = $cid LIMIT 1`,
                { cid: toolUseId },
              ).catch(() => []);
              if (sibling[0]?.id) {
                session._activeSubagents.set(toolUseId, String(sibling[0].id));
                log.debug(`[subagent] spawn rejected by UNIQUE (sibling won race): corr=${toolUseId.slice(0, 8)} sibling=${String(sibling[0].id).slice(-8)}`);
              } else {
                log.debug(`[subagent] spawn rejected by UNIQUE but no sibling row found: corr=${toolUseId.slice(0, 8)}`);
              }
              return;
            }
            throw createErr;
          }
          const subagentId = String(rows[0]?.id ?? "");
          if (subagentId) {
            session._activeSubagents.set(toolUseId, subagentId);
            // spawned_from: subagent → parent session
            // spawned:      parent session → subagent (forward edge — was unwired pre-0.7.70,
            //               which left the spawned table empty graph-wide despite having ~thousands
            //               of subagent rows. Both edges are written so traversal works either way.)
            if (session.surrealSessionId) {
              await state.store.relate(subagentId, "spawned_from", session.surrealSessionId)
                .catch(e => swallow("preToolUse:subagent:spawned_from", e));
              await state.store.relate(session.surrealSessionId, "spawned", subagentId)
                .catch(e => swallow("preToolUse:subagent:spawned", e));
            }
            // derived_from: subagent → task. When the task hasn't been
            // resolved yet (background daemon spawns, gateway-spawned
            // subagents that pre-date session.taskId being set), fall back
            // to the surreal session id. The 0.7.70 schema widened
            // `derived_from` OUT to allow `session` for exactly this case;
            // without the fallback the subagent row gets no derived_from
            // edge at all and provenance is lost.
            if (session.taskId) {
              await state.store.relate(subagentId, "derived_from", session.taskId)
                .catch(e => swallow("preToolUse:subagent:derived_from", e));
            } else if (session.surrealSessionId) {
              await state.store.relate(subagentId, "derived_from", session.surrealSessionId)
                .catch(e => swallow.warn("preToolUse:subagent:derived_from_session_fallback", e));
            }
            log.info(`[subagent] spawned: type=${subagentType} corr=${toolUseId.slice(0, 8)}`);
          }
        } catch (e) {
          swallow.warn("preToolUse:subagent:create", e);
        }
      })();
    }
  }

  return {};
}
