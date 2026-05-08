/**
 * First-touch edit gates.
 *
 * Blocks the first Edit/Write/MultiEdit to a file in a session until the
 * agent has demonstrably looked at it — defined as: the path appears in
 * any prior turn text, recall result, retrieval injection, or user message.
 * The point is to enforce "RECALL BEFORE GUESSING" at the substrate level
 * instead of leaving it to model self-discipline.
 *
 * Strict mode also gates destructive Bash patterns (rm -rf, git reset
 * --hard, git push --force, DROP TABLE, DELETE FROM without WHERE,
 * TRUNCATE) on first attempt per session, requiring user authorization
 * or prior session mention before allowing.
 *
 * State storage:
 *   - In-memory cache per session (SessionState._editGateChecked) for
 *     hot paths. Wiped on idle timeout.
 *   - Cold-path fallback queries the existing turn table — no new schema.
 *
 * Idle timeout: a session that hasn't gated anything in 30 minutes
 * resets its in-memory cache (the agent's intent has likely shifted).
 * Configurable via KONGCODE_GATE_TIMEOUT_MS.
 *
 * Override: a user message containing the file path verbatim acts as
 * authorization (the user just told the agent what to do).
 */

import type { GlobalPluginState, SessionState } from "../state.js";
import type { HookResponse } from "../../http-api.js";
import { swallow } from "../errors.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function readIdleTimeout(): number {
  const raw = process.env.KONGCODE_GATE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Destructive Bash patterns gated under `strict`. Order matters — most
 *  specific first so error messages are informative. */
const DESTRUCTIVE_BASH_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "rm -rf", re: /(?:^|[\s;&|])(?:\/usr\/bin\/|\/bin\/)?rm\s+(?:-\w+\s+)*(?:--recursive|--force|-\w*r\w*f|-\w*f\w*r)\b/ },
  { name: "rm -rf (separated)", re: /(?:^|[\s;&|])(?:\/usr\/bin\/|\/bin\/)?rm\s+(?:-\w+\s+)*-\w*r\b.*-\w*f\b/ },
  { name: "git reset --hard", re: /\bgit\b.*\breset\b.*--hard\b/ },
  { name: "git push --force", re: /\bgit\s+(?:-\w+\s+)*push\b.*(?:--force\b|--force-with-lease\b|-f\b)/ },
  { name: "git checkout -- (discard)", re: /\bgit\s+checkout\s+--\s+\./ },
  { name: "git clean -f", re: /\bgit\s+clean\b.*-\w*f/ },
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { name: "DELETE FROM (no WHERE)", re: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i },
  { name: "TRUNCATE TABLE", re: /\bTRUNCATE\s+(TABLE\s+)?\w+/i },
];

function maybeWipeIdleCache(session: SessionState): void {
  const now = Date.now();
  const last = session._editGateLastActivity ?? 0;
  if (last > 0 && now - last > readIdleTimeout()) {
    session._editGateChecked.clear();
  }
  session._editGateLastActivity = now;
}

/** Returns true if the file path has been "investigated" this session. */
async function hasInvestigatedFile(
  state: GlobalPluginState,
  session: SessionState,
  filePath: string,
): Promise<boolean> {
  if (session._editGateChecked.has(filePath)) return true;

  // 0.7.48: any prior file-aware tool call (Read/Edit/Write/MultiEdit)
  // this session counts as investigation. Populated by pre-tool-use.ts
  // before the gate runs, so a Read → Edit pair in the same response
  // resolves immediately — without this hot path the gate had to wait
  // for Stop to ingest assistant tool I/O into the turn table, which
  // never happens mid-response.
  if (session._observedFilePaths.has(filePath)) {
    session._editGateChecked.add(filePath);
    return true;
  }

  // The user's most recent message naming the file is an authorization.
  if (session.lastUserText && session.lastUserText.includes(filePath)) {
    session._editGateChecked.add(filePath);
    return true;
  }

  // Cold path: graph query for user turns mentioning this exact path.
  // Restricted to role='user' so the LLM cannot self-authorize by
  // mentioning a path in its own output. Costs one CONTAINS scan;
  // cached on hit.
  if (!state.store.isAvailable() || !session.surrealSessionId) {
    // No store / no session row — fail open. We can't enforce without
    // state, and blocking blindly would be hostile.
    return true;
  }

  try {
    const rows = await state.store.queryFirst<{ id: string }>(
      `SELECT id FROM turn
         WHERE session_id = $sid
           AND role = 'user'
           AND text CONTAINS $path
       LIMIT 1`,
      { sid: session.surrealSessionId, path: filePath },
    );
    if (rows.length > 0) {
      session._editGateChecked.add(filePath);
      return true;
    }
  } catch (e) {
    swallow.warn("editGate:queryTurns", e);
    // Fail open on store error — the gate is an enhancement, not a brick wall.
    return true;
  }

  return false;
}

/** Returns true if the destructive command has been seen / authorized this session. */
async function hasInvestigatedBashCommand(
  state: GlobalPluginState,
  session: SessionState,
  command: string,
  matchedPattern: string,
): Promise<boolean> {
  // Internal cache key prefixed so it can't collide with file paths.
  const cacheKey = `__bash__:${matchedPattern}`;
  if (session._editGateChecked.has(cacheKey)) return true;

  // User message authorization: command must appear verbatim, OR the user
  // explicitly named the destructive verb.
  if (
    session.lastUserText &&
    (session.lastUserText.includes(command.trim()) ||
      session.lastUserText.toLowerCase().includes(matchedPattern.toLowerCase()))
  ) {
    session._editGateChecked.add(cacheKey);
    return true;
  }

  if (!state.store.isAvailable() || !session.surrealSessionId) return true;

  try {
    const rows = await state.store.queryFirst<{ id: string }>(
      `SELECT id FROM turn
         WHERE session_id = $sid
           AND role = 'user'
           AND text CONTAINS $needle
       LIMIT 1`,
      { sid: session.surrealSessionId, needle: matchedPattern },
    );
    if (rows.length > 0) {
      session._editGateChecked.add(cacheKey);
      return true;
    }
  } catch (e) {
    swallow.warn("editGate:queryBash", e);
    return true;
  }
  return false;
}

/** Every gate deny is prefixed with a Tier-0 reminder. Agents read the
 *  whole deny string while figuring out how to unblock, so this is the
 *  highest-attention surface for re-grounding behavior. Keep it short. */
const TIER0_PREFIX =
  "Remember your tier0 directives are important to the user and make you more helpful. " +
  "Make sure you're following the Tier-0 rules (RECALL BEFORE GUESSING, " +
  "MEMORY REFLEX, GRAPH-AWARE SAVING, AUTO-SEAL CONTRACT, ACTIVE HOOK PROFILE). " +
  "And remember to save knowledge gems along the way. ";

function denyResponse(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: TIER0_PREFIX + reason,
    },
  };
}

/**
 * Run the first-touch check for an Edit/Write/MultiEdit call.
 * Returns a deny HookResponse if the gate should fire, null otherwise.
 */
export async function checkFileEditGate(
  state: GlobalPluginState,
  session: SessionState,
  filePath: string,
): Promise<HookResponse | null> {
  if (!filePath) return null;
  maybeWipeIdleCache(session);
  const investigated = await hasInvestigatedFile(state, session, filePath);
  if (investigated) return null;

  return denyResponse(
    `kongcode/edit-gate: first edit to ${filePath} this session. ` +
      `Use the Read tool on this exact path before editing — that registers the ` +
      `path with the gate immediately. (Recall and Grep do NOT clear the gate; ` +
      `only a Read/Edit/Write of this path or the path appearing in the user's ` +
      `message does.) The gate fires once per file per session.`,
  );
}

/**
 * Run the destructive-command check for a Bash call (strict mode only).
 * Matches the command against destructive patterns; if matched, requires
 * either user authorization or prior session mention.
 */
export async function checkBashGate(
  state: GlobalPluginState,
  session: SessionState,
  command: string,
): Promise<HookResponse | null> {
  if (!command) return null;
  maybeWipeIdleCache(session);

  const match = DESTRUCTIVE_BASH_PATTERNS.find((p) => p.re.test(command));
  if (!match) return null;

  const investigated = await hasInvestigatedBashCommand(state, session, command, match.name);
  if (investigated) return null;

  return denyResponse(
    `kongcode/bash-gate: destructive pattern detected: ${match.name}. ` +
      `Either the user must authorize this command, or you must surface context ` +
      `establishing why the destructive operation is correct (recall the target path or ` +
      `the relevant decision). Once acknowledged, retry — the gate fires once per pattern ` +
      `per session.`,
  );
}
