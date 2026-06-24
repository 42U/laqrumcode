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
 * Configurable via LAQRUMCODE_GATE_TIMEOUT_MS.
 *
 * Override: a user message containing the file path verbatim acts as
 * authorization (the user just told the agent what to do).
 */
import type { GlobalPluginState, SessionState } from "../state.js";
import type { HookResponse } from "../../http-api.js";
/**
 * Run the first-touch check for an Edit/Write/MultiEdit call.
 * Returns a deny HookResponse if the gate should fire, null otherwise.
 */
export declare function checkFileEditGate(state: GlobalPluginState, session: SessionState, filePath: string): Promise<HookResponse | null>;
/**
 * Run the destructive-command check for a Bash call (strict mode only).
 * Matches the command against destructive patterns; if matched, requires
 * either user authorization or prior session mention.
 */
export declare function checkBashGate(state: GlobalPluginState, session: SessionState, command: string): Promise<HookResponse | null>;
