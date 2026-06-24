/**
 * memory_health MCP tool — machine-readable substrate self-audit.
 *
 * Returns a structured JSON report covering connectivity, record counts,
 * embedding coverage gaps, pending-work backlog, and the quality signals
 * used for soul graduation. Bots can consume this to self-diagnose, and
 * the response is compact enough to inject into a hook turn if things go
 * sideways.
 *
 * This is the programmatic counterpart to the skills/laqrumcode-health
 * text-based skill — same data, structured output.
 */
import type { GlobalPluginState, SessionState } from "../engine/state.js";
export declare function handleMemoryHealth(state: GlobalPluginState, _session: SessionState, _args: Record<string, unknown>): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
}>;
