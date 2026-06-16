/**
 * PostToolUse hook handler.
 *
 * Records tool outcomes for ACAN training and tracks artifact mutations.
 */

import type { GlobalPluginState } from "../engine/state.js";
import type { HookResponse } from "../http-api.js";
import { swallow } from "../engine/errors.js";
import { commitKnowledge } from "../engine/commit.js";
import { recordToolOutcome } from "../engine/retrieval-quality.js";
import { loadPrivacyConfig, isIgnoredPath } from "../engine/redact.js";

/** Tools whose result text is worth scanning for file paths. recall surfaces
 *  paths from prior turns; Grep/Glob return path lists by definition.
 *  Each match feeds session._observedFilePaths so a follow-up Edit on a
 *  surfaced path clears the edit-gate immediately — without this, the
 *  Tier-0 directive's "recall it" advice was a lie. 0.7.48 fix. */
const PATH_OBSERVING_TOOLS = ["Grep", "Glob"];
function isPathObservingTool(toolName: string): boolean {
  if (PATH_OBSERVING_TOOLS.includes(toolName)) return true;
  // MCP-routed tool names look like `mcp__<plugin>__<name>` — match any
  // recall variant so kongcode's own and any forked recall tool count.
  return toolName.includes("recall");
}

/** Extract path-shaped substrings from tool result text. Two patterns:
 *  (1) anything with a slash and printable non-whitespace tail, (2) bare
 *  filenames ending in a known source/config extension. Bias toward
 *  over-extraction — a false positive is a harmless Set entry, while a
 *  false negative re-locks the gate and forces an avoidable Read call. */
const SLASH_PATH_RE = /[/~][^\s'"`<>{}()\[\],]+/g;
// Path-with-extension matcher: allows slashes, dots, tildes, hyphens in the
// stem so relative paths like `src/engine/state.ts` and `./foo/bar.py` get
// captured as a single entry, not just their bare filename. Bare filenames
// alone wouldn't satisfy the gate (it compares against absolute paths).
const EXT_PATH_RE =
  /[\w./~-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|md|markdown|json|jsonc|yaml|yml|toml|sql|sh|bash|html|css|scss|sass|xml|env|surql|gradle|tf|tfvars)\b/g;

function extractPathsFromText(text: string, into: Set<string>): void {
  for (const m of text.match(SLASH_PATH_RE) ?? []) {
    const cleaned = m.replace(/[.,:;!?]+$/, "");
    if (cleaned.length > 1) into.add(cleaned);
  }
  for (const m of text.match(EXT_PATH_RE) ?? []) {
    into.add(m);
  }
}

export async function handlePostToolUse(
  state: GlobalPluginState,
  payload: Record<string, unknown>,
): Promise<HookResponse> {
  const sessionId = (payload.session_id as string) ?? "default";
  const session = state.getSession(sessionId);
  if (!session) return {};

  const { store, embeddings } = state;
  const toolName = (payload.tool_name as string) ?? "";
  // Claude Code's PostToolUse payload field is `tool_response` (object or
  // string). The previous `tool_result` read was wrong and never matched,
  // so cumulativeTokens was stuck at 0 and recordToolOutcome never fired.
  const toolResponse = payload.tool_response ?? payload.tool_result;
  const toolResultText = typeof toolResponse === "string"
    ? toolResponse
    : toolResponse != null ? JSON.stringify(toolResponse) : undefined;

  if (toolResultText) {
    session.cumulativeTokens += Math.ceil(toolResultText.length / 4);
    // Make recall / Grep / Glob results clear the edit-gate. Without this,
    // the deny message and the active-profile Tier-0 directive both told
    // the agent "recall it to clear the gate" — and the gate ignored it.
    if (isPathObservingTool(toolName)) {
      extractPathsFromText(toolResultText, session._observedFilePaths);
    }
  }

  // Detect failure: top-level `error`, or tool_response object with
  // is_error=true (Anthropic tool_result convention).
  const isError = !!payload.error
    || (typeof toolResponse === "object" && toolResponse !== null
        && (toolResponse as { is_error?: boolean }).is_error === true);
  recordToolOutcome(session.sessionId, !isError);

  // Count tool calls for this turn — consumed by handleStop to feed
  // postflight()'s orchestrator_metrics write. Reset at preflight time.
  session._turnToolCalls += 1;

  // Track file artifacts from Write/Edit tools.
  // Look up args by tool_use_id (matching the PreToolUse write key) so
  // parallel Write calls don't read each other's args.
  if ((toolName === "Write" || toolName === "Edit") && store.isAvailable()) {
    const toolUseId = String(payload.tool_use_id ?? "");
    const toolInput = toolUseId
      ? (session.pendingToolArgs.get(toolUseId) as Record<string, unknown> | undefined)
      : undefined;
    const filePath = toolInput?.file_path as string | undefined;
    // GH #16 privacy: don't even record that an ignore_paths file was touched.
    if (filePath && !isIgnoredPath(filePath, loadPrivacyConfig())) {
      try {
        // Route through commitKnowledge so the file artifact auto-seals
        // artifact_mentions edges to concepts. Previously this write was
        // a bare createArtifact; the artifact landed without any edges
        // to the concept graph, so "what concepts is this file about?"
        // queries returned nothing.
        await commitKnowledge(
          { store, embeddings },
          {
            kind: "artifact",
            path: filePath,
            type: "file",
            description: `${toolName}: ${filePath}`,
          },
        );
      } catch (e) {
        // Upgrade from silent swallow to warn so commitKnowledge failures
        // surface in the log instead of silently dropping artifacts.
        swallow.warn("postToolUse:artifact", e);
      }
    }
    if (toolUseId) session.pendingToolArgs.delete(toolUseId);
  }

  return {};
}
