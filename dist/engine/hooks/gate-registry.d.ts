/**
 * Extensible gate registry.
 *
 * Gates are PreToolUse checks that can deny tool calls based on profile,
 * tool type, and context. Three built-in gates ship with kongcode
 * (config-protection, edit-gate, bash-gate). Users add arbitrary gates
 * via ~/.kongcode/gates.json — no code changes required.
 *
 * The registry runs all active gates in priority order (lowest first)
 * on each PreToolUse invocation. First deny wins.
 *
 * Both built-in and config-driven gates are loaded once on first use.
 * Daemon restart required to pick up changes (same as profile env).
 */
import type { GlobalPluginState, SessionState } from "../state.js";
import type { HookResponse } from "../../http-api.js";
import type { HookProfile } from "./profile.js";
export interface GateContext {
    state: GlobalPluginState;
    session: SessionState;
    toolName: string;
    toolInput: Record<string, unknown>;
    payload: Record<string, unknown>;
}
export interface GateDefinition {
    /** Stable id — used with KONGCODE_DISABLED_HOOKS to selectively disable. */
    id: string;
    description?: string;
    /** Which hook profiles activate this gate. */
    profiles: HookProfile[];
    /** Which tools this gate applies to. undefined or empty = all tools. */
    tools?: ReadonlySet<string>;
    /** Lower runs first. Default 50. Built-ins use 10/20/30. */
    priority?: number;
    /** Origin: "builtin" for shipped gates, "config" for ~/.kongcode/gates.json. */
    source?: "builtin" | "config";
    /** Return null to allow, HookResponse to deny. */
    check(ctx: GateContext): Promise<HookResponse | null>;
}
export declare function registerGate(gate: GateDefinition): void;
export declare function unregisterGate(id: string): boolean;
export declare function listGates(): readonly GateDefinition[];
/**
 * Run all active gates for the given tool call context.
 * Returns the first deny response, or null if all gates pass.
 */
export declare function runGates(ctx: GateContext): Promise<HookResponse | null>;
export declare function makeDenyResponse(gateId: string, message: string): HookResponse;
/** Reset to empty. If skipAutoInit is true, ensureInitialized() becomes
 *  a no-op — use this when tests register gates manually and don't want
 *  builtins auto-loaded. */
export declare function _resetRegistryForTests(skipAutoInit?: boolean): void;
