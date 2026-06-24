/**
 * Wake-up briefing: constitutive memory initialization.
 *
 * At startup, fetches the latest handoff note, identity chunks, and recent
 * monologue entries, then assembles the raw sections into a formatted
 * briefing. The briefing is injected into the system prompt so the agent
 * "wakes up" knowing who it is and what it was doing.
 *
 * Ported from laqrumbrain — takes SurrealStore as param.
 */
import type { SurrealStore } from "./surreal.js";
/**
 * Assemble a wake-up briefing from constitutive memory sections.
 * Returns null if no prior state exists (first boot) or DB is unavailable.
 */
export declare function synthesizeWakeup(store: SurrealStore, currentSessionId?: string, workspaceDir?: string): Promise<string | null>;
