/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */
import { makeHookOutput } from "../http-api.js";
import { log } from "../engine/log.js";
import { swallow } from "../engine/errors.js";
import { runGates } from "../engine/hooks/gate-registry.js";
/** Tools that touch a file via an explicit `file_path` argument. The gate
 *  treats any of these as an "observation" of that path for the rest of
 *  the session, so a Read followed by an Edit in the same response is
 *  not blocked. 0.7.48 fix for the mid-response gating gap. */
const FILE_AWARE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
export async function handlePreToolUse(state, payload) {
    const sessionId = payload.session_id ?? "default";
    const session = state.getSession(sessionId);
    if (!session)
        return {};
    const toolName = payload.tool_name ?? "";
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
        const toolInput = payload.tool_input;
        const filePath = toolInput?.file_path;
        if (filePath)
            session._observedFilePaths.add(filePath);
    }
    // ── Gate evaluation (extensible registry) ─────────────────────────────
    // Built-in gates (config-protection, edit-gate, bash-gate) plus any
    // user-defined gates from ~/.kongcode/gates.json. First deny wins.
    const gateResult = await runGates({
        state,
        session,
        toolName,
        toolInput: payload.tool_input ?? {},
        payload,
    });
    if (gateResult)
        return gateResult;
    // Detect git push — flag for CI reminder at Stop
    if (toolName === "Bash") {
        const toolInput = payload.tool_input;
        const command = toolInput?.command;
        if (command && /git\s+push\b/.test(command)) {
            session._pushDetected = true;
        }
    }
    // Planning gate: soft interrupt if over tool budget
    if (session.toolCallCount > session.toolLimit && !session.softInterrupted) {
        session.softInterrupted = true;
        log.debug(`Tool budget soft interrupt: ${session.toolCallCount}/${session.toolLimit}`);
        return makeHookOutput("PreToolUse", `[KongCode] Remember your tier0 directives are important to the user and make you more helpful. ` +
            `Tool budget reached (${session.toolCallCount}/${session.toolLimit}). ` +
            "Consider summarizing progress before making more tool calls. " +
            "And remember to save knowledge gems along the way.");
    }
    // Redundant recall detection: if user prompt was already retrieved via
    // graphTransformContext, block manual recall with similar query
    if (toolName.includes("recall") && session.lastRetrievalSummary) {
        const toolInput = payload.tool_input;
        const recallQuery = toolInput?.query;
        if (recallQuery && session.lastRetrievalSummary) {
            // Don't block — just inform that context was already retrieved
            return makeHookOutput("PreToolUse", `[KongCode] Remember your tier0 directives are important to the user and make you more helpful. ` +
                `Context was already auto-retrieved this turn (${session.lastRetrievalSummary}). ` +
                "Only call recall if you need something specific not already in the injected context. " +
                "And remember to save knowledge gems along the way.");
        }
    }
    // Track pending tool args for artifact extraction in PostToolUse
    if (toolName === "Write" || toolName === "Edit") {
        const toolInput = payload.tool_input;
        if (toolInput?.file_path) {
            session.pendingToolArgs.set(toolName, toolInput);
        }
    }
    // Subagent spawn capture (R3). Claude Code's Agent / Task tool invocations
    // fire PreToolUse with rich payload: tool_use_id + tool_input.subagent_type
    // + tool_input.prompt + tool_input.description. Write an initial subagent
    // row here; SubagentStop will complete it. Fire-and-forget; errors swallowed.
    if ((toolName === "Agent" || toolName === "Task") && state.store.isAvailable()) {
        const toolInput = payload.tool_input;
        const toolUseId = String(payload.tool_use_id ?? "");
        const subagentType = String(toolInput?.subagent_type ?? "general-purpose");
        const description = String(toolInput?.description ?? "").slice(0, 200);
        const prompt = String(toolInput?.prompt ?? "");
        if (toolUseId) {
            (async () => {
                try {
                    const rows = await state.store.queryFirst(`CREATE subagent CONTENT $data RETURN id`, {
                        data: {
                            parent_session_id: session.sessionId,
                            agent_type: subagentType,
                            description,
                            prompt_preview: prompt.slice(0, 500),
                            prompt_length: prompt.length,
                            outcome: "in_progress",
                            correlation_key: toolUseId,
                            tool_call_count: 0,
                        },
                    });
                    const subagentId = String(rows[0]?.id ?? "");
                    if (subagentId) {
                        session._activeSubagents.set(toolUseId, subagentId);
                        // spawned_from: subagent → parent session
                        if (session.surrealSessionId) {
                            await state.store.relate(subagentId, "spawned_from", session.surrealSessionId)
                                .catch(e => swallow("preToolUse:subagent:spawned_from", e));
                        }
                        // derived_from: subagent → task
                        if (session.taskId) {
                            await state.store.relate(subagentId, "derived_from", session.taskId)
                                .catch(e => swallow("preToolUse:subagent:derived_from", e));
                        }
                        log.info(`[subagent] spawned: type=${subagentType} corr=${toolUseId.slice(0, 8)}`);
                    }
                }
                catch (e) {
                    swallow.warn("preToolUse:subagent:create", e);
                }
            })();
        }
    }
    return {};
}
