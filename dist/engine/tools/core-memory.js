/**
 * Core memory management tool — CRUD on always-loaded directives.
 * Ported from kongbrain with SurrealStore injection.
 */
import { Type } from "@sinclair/typebox";
import { stripStructuralTags } from "../sanitize.js";
import { log } from "../log.js";
const TIER0_MAX_PER_SESSION = 5;
const TIER0_MAX_TOTAL = 25;
const tier0WritesPerSession = new Map();
const coreMemorySchema = Type.Object({
    action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("deactivate"),
    ], { description: "Action to perform on core memory." }),
    tier: Type.Optional(Type.Number({ description: "Filter by tier (0=always loaded, 1=session-pinned). Default: list all." })),
    category: Type.Optional(Type.String({ description: "Category (identity/rules/tools/operations/general)." })),
    text: Type.Optional(Type.String({ description: "Text content for add/update actions." })),
    priority: Type.Optional(Type.Number({ description: "Priority for add/update (higher=loaded first). Default: 50." })),
    id: Type.Optional(Type.String({ description: "Record ID for update/deactivate (e.g. core_memory:abc123)." })),
    session_id: Type.Optional(Type.String({ description: "Session ID for Tier 1 entries." })),
});
export function createCoreMemoryToolDef(state, session) {
    return {
        name: "core_memory",
        label: "Core Memory",
        description: "Manage always-loaded core directives (Tier 0) and session-pinned context (Tier 1). Tier 0 entries are present in EVERY turn — use for identity, rules, tool patterns. Tier 1 entries are pinned for the current session.",
        parameters: coreMemorySchema,
        execute: async (_toolCallId, params) => {
            const { store } = state;
            if (!store.isAvailable()) {
                return { content: [{ type: "text", text: "Database unavailable." }], details: null };
            }
            try {
                switch (params.action) {
                    case "list": {
                        const entries = await store.getAllCoreMemory(params.tier);
                        if (entries.length === 0) {
                            return { content: [{ type: "text", text: "No core memory entries found." }], details: null };
                        }
                        const formatted = entries.map((e, i) => {
                            const sid = e.session_id ? ` session:${e.session_id}` : "";
                            return `${i + 1}. [T${e.tier}/${e.category}/p${e.priority}${sid}] ${e.id}\n   ${e.text.slice(0, 120)}`;
                        }).join("\n\n");
                        return {
                            content: [{ type: "text", text: `${entries.length} core memory entries:\n\n${formatted}` }],
                            details: { count: entries.length },
                        };
                    }
                    case "add": {
                        if (!params.text) {
                            return { content: [{ type: "text", text: "Error: 'text' is required for add action." }], details: null };
                        }
                        const tier = params.tier ?? 0;
                        const sanitized = stripStructuralTags(params.text);
                        if (tier === 0) {
                            const sessionWrites = tier0WritesPerSession.get(session.sessionId) ?? 0;
                            if (sessionWrites >= TIER0_MAX_PER_SESSION) {
                                return {
                                    content: [{ type: "text", text: `Tier 0 write limit reached (${TIER0_MAX_PER_SESSION}/session). Use update to modify existing entries or deactivate unused ones first.` }],
                                    details: { error: true, reason: "session_rate_limit" },
                                };
                            }
                            const existing = await store.getAllCoreMemory(0);
                            if (existing.length >= TIER0_MAX_TOTAL) {
                                return {
                                    content: [{ type: "text", text: `Tier 0 capacity reached (${TIER0_MAX_TOTAL} entries). Deactivate unused entries before adding new ones.` }],
                                    details: { error: true, reason: "total_cap" },
                                };
                            }
                            log.warn(`[core-memory] tier-0 write: "${sanitized.slice(0, 120)}..." (session=${session.sessionId})`);
                        }
                        const sid = tier === 1 ? (params.session_id ?? session.sessionId) : undefined;
                        const id = await store.createCoreMemory(sanitized, params.category ?? "general", params.priority ?? 50, tier, sid);
                        if (!id) {
                            return {
                                content: [{ type: "text", text: "FAILED: Core memory entry was not created." }],
                                details: { error: true },
                            };
                        }
                        if (tier === 0) {
                            tier0WritesPerSession.set(session.sessionId, (tier0WritesPerSession.get(session.sessionId) ?? 0) + 1);
                        }
                        // Invalidate cached section so updated content re-injects next turn
                        session.injectedSections.delete(tier === 0 ? "tier0" : "tier1");
                        return {
                            content: [{ type: "text", text: `Created core memory: ${id} (tier ${tier}, ${params.category ?? "general"}, p${params.priority ?? 50})` }],
                            details: { id },
                        };
                    }
                    case "update": {
                        if (!params.id) {
                            return { content: [{ type: "text", text: "Error: 'id' is required for update action." }], details: null };
                        }
                        const fields = {};
                        if (params.text !== undefined) {
                            fields.text = stripStructuralTags(params.text);
                            log.warn(`[core-memory] update ${params.id}: "${String(fields.text).slice(0, 120)}..." (session=${session.sessionId})`);
                        }
                        if (params.category !== undefined)
                            fields.category = params.category;
                        if (params.priority !== undefined)
                            fields.priority = params.priority;
                        if (params.tier !== undefined)
                            fields.tier = params.tier;
                        const updated = await store.updateCoreMemory(params.id, fields);
                        if (!updated) {
                            return {
                                content: [{ type: "text", text: `FAILED: Could not update ${params.id}.` }],
                                details: { error: true },
                            };
                        }
                        // Invalidate both tiers — update may have changed the tier
                        session.injectedSections.delete("tier0");
                        session.injectedSections.delete("tier1");
                        return {
                            content: [{ type: "text", text: `Updated core memory: ${params.id}` }],
                            details: { id: params.id },
                        };
                    }
                    case "deactivate": {
                        if (!params.id) {
                            return { content: [{ type: "text", text: "Error: 'id' is required for deactivate action." }], details: null };
                        }
                        await store.deleteCoreMemory(params.id);
                        // Invalidate both tiers so removal is reflected next turn
                        session.injectedSections.delete("tier0");
                        session.injectedSections.delete("tier1");
                        return {
                            content: [{ type: "text", text: `Deactivated core memory: ${params.id}` }],
                            details: { id: params.id },
                        };
                    }
                }
            }
            catch (err) {
                return { content: [{ type: "text", text: `Core memory operation failed: ${err}` }], details: null };
            }
        },
    };
}
