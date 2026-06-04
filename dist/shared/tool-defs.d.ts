/**
 * MCP tool definitions — single source of truth for tool list returned via
 * ListToolsRequestSchema. Imported by both the legacy mcp-server.ts (which
 * runs handlers in-process) and the new mcp-client (which forwards calls
 * to the daemon over IPC).
 *
 * Schema is JSON Schema draft-07 compatible; matches the @modelcontextprotocol
 * SDK's expected shape. Adding a new tool requires three coordinated edits:
 *   1. Append to MCP_TOOLS below.
 *   2. Add the IPC method name to IPC_METHODS in shared/ipc-types.ts.
 *   3. Register a handler in src/daemon/index.ts (and a stub in mcp-server.ts
 *      while the legacy entry point still exists during the migration).
 *
 * Map between MCP tool name (snake_case) and IPC method (dotted camelCase) is
 * the MCP_TO_IPC_METHOD constant. The thin client uses it to translate tool
 * calls into JSON-RPC method names without case-converting at runtime.
 */
import type { IpcMethod } from "./ipc-types.js";
export declare const MCP_TOOLS: readonly [{
    readonly name: "recall";
    readonly description: "Search the persistent memory graph for past knowledge, concepts, artifacts, skills, and conversation history.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Natural language search query";
            };
            readonly scope: {
                readonly type: "string";
                readonly enum: readonly ["all", "memories", "concepts", "turns", "artifacts", "skills"];
                readonly description: "Narrow search to a specific knowledge type (default: all)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max results to return (1-15, default: 5)";
                readonly minimum: 1;
                readonly maximum: 15;
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "core_memory";
    readonly description: "Manage always-loaded memory directives. Tier 0 entries appear every turn (identity, rules). Tier 1 entries are session-pinned.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["list", "add", "update", "deactivate"];
                readonly description: "Operation to perform";
            };
            readonly tier: {
                readonly type: "number";
                readonly enum: readonly [0, 1];
                readonly description: "Memory tier (0=always, 1=session)";
            };
            readonly category: {
                readonly type: "string";
                readonly enum: readonly ["identity", "rules", "tools", "operations", "general"];
                readonly description: "Category for the directive";
            };
            readonly text: {
                readonly type: "string";
                readonly description: "Content of the directive (for add/update)";
            };
            readonly priority: {
                readonly type: "number";
                readonly description: "Priority 0-100 (higher = loaded first)";
            };
            readonly id: {
                readonly type: "string";
                readonly description: "Record ID (for update/deactivate)";
            };
        };
        readonly required: readonly ["action"];
    };
}, {
    readonly name: "introspect";
    readonly description: "Inspect the memory database: health status, table counts, record verification, and predefined reports.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["status", "count", "verify", "query", "migrate", "trends", "stats"];
                readonly description: "Diagnostic action to perform";
            };
            readonly table: {
                readonly type: "string";
                readonly description: "Table name (for count/verify)";
            };
            readonly filter: {
                readonly type: "string";
                readonly enum: readonly ["active", "inactive", "recent_24h", "with_embedding", "unresolved"];
                readonly description: "Filter preset (for count)";
            };
            readonly record_id: {
                readonly type: "string";
                readonly description: "Record ID (for verify)";
            };
        };
        readonly required: readonly ["action"];
    };
}, {
    readonly name: "fetch_pending_work";
    readonly description: "Claim the next pending background work item for processing. Returns instructions and data for extraction, reflection, skill, or soul work. Call repeatedly until it returns empty.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "commit_work_results";
    readonly description: "Submit processed results for a pending work item. Persists extracted knowledge, reflections, skills, or soul documents to the memory database.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly work_id: {
                readonly type: "string";
                readonly description: "The work item ID from fetch_pending_work";
            };
            readonly results: {
                readonly type: "object";
                readonly description: "The extraction results — JSON object or plain text depending on work type";
            };
        };
        readonly required: readonly ["work_id", "results"];
    };
}, {
    readonly name: "create_knowledge_gems";
    readonly description: "Direct-write structured knowledge from an external source (PDF, article, doc) into the memory graph. Each gem becomes a concept; a source artifact is created and linked to every gem via 'derived_from'; cross-link edges between gems are created from the 'links' array. Use for foreground extraction tasks where there is no session transcript for the daemon to chew on.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly source: {
                readonly type: "string";
                readonly description: "Source identifier (e.g. file path, URL, doc title)";
            };
            readonly source_type: {
                readonly type: "string";
                readonly description: "Source type (e.g. 'pdf', 'article', 'book')";
                readonly default: "document";
            };
            readonly source_description: {
                readonly type: "string";
                readonly description: "One-line description of the source";
            };
            readonly gems: {
                readonly type: "array";
                readonly description: "Array of knowledge gems. Each gem is one concept.";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                            readonly description: "Short identifier used for cross-link resolution";
                        };
                        readonly content: {
                            readonly type: "string";
                            readonly description: "The actual insight text — this is what gets embedded and stored";
                        };
                        readonly importance: {
                            readonly type: "number";
                            readonly description: "Reserved for future use (concepts do not currently store importance)";
                        };
                    };
                    readonly required: readonly ["name", "content"];
                };
            };
            readonly links: {
                readonly type: "array";
                readonly description: "Cross-link edges between gems. Each link references gems by name.";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly from: {
                            readonly type: "string";
                            readonly description: "Source gem name";
                        };
                        readonly to: {
                            readonly type: "string";
                            readonly description: "Target gem name";
                        };
                        readonly edge: {
                            readonly type: "string";
                            readonly description: "Relation name: 'broader', 'narrower', or 'related_to'";
                        };
                    };
                    readonly required: readonly ["from", "to", "edge"];
                };
            };
        };
        readonly required: readonly ["source", "gems"];
    };
}, {
    readonly name: "memory_health";
    readonly description: "Substrate self-audit. Returns structured JSON with status (green/yellow/red), connection state, record counts, embedding-gap percentage, pending-work backlog, and diagnostic warnings. Use this to check whether the memory system is healthy before heavy writes or when debugging stale retrievals.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
    };
}, {
    readonly name: "link_hierarchy";
    readonly description: "Explicitly assert a parent→child concept relationship. Writes broader/narrower edges between the two concepts (creating them via commitKnowledge if they don't exist). Use when you KNOW 'X is a kind of Y' and want to seal the hierarchy rather than hoping embedding-similarity detection finds it.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly parent: {
                readonly type: "string";
                readonly description: "The broader concept (e.g. 'authentication')";
            };
            readonly child: {
                readonly type: "string";
                readonly description: "The narrower concept (e.g. 'JWT validation')";
            };
            readonly source: {
                readonly type: "string";
                readonly description: "Optional provenance tag";
            };
        };
        readonly required: readonly ["parent", "child"];
    };
}, {
    readonly name: "record_finding";
    readonly description: "Structured save for findings you want to remember permanently. Routes through commitKnowledge so the memory auto-seals about_concept edges. Use when you have a decision, correction, preference, or fact worth preserving across sessions.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly finding_type: {
                readonly type: "string";
                readonly enum: readonly ["decision", "correction", "preference", "fact"];
                readonly description: "decision = choice-with-rationale; correction = user corrected a belief; preference = user workflow signal; fact = technical knowledge";
            };
            readonly text: {
                readonly type: "string";
                readonly description: "The finding itself — specific, standalone, useful when recalled in isolation";
            };
            readonly why: {
                readonly type: "string";
                readonly description: "Optional rationale — appended to text as 'Rationale: ...'";
            };
            readonly importance: {
                readonly type: "number";
                readonly description: "1-10. Defaults to type-appropriate: correction=9, decision=7, preference=7, fact=6";
            };
        };
        readonly required: readonly ["finding_type", "text"];
    };
}, {
    readonly name: "cluster_scan";
    readonly description: "Recall with grouped output. Returns results organized into clusters by shared concept neighbors instead of a flat score-sorted list. Use for 'what do I know about X?' queries where structure matters more than rank.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Natural language query";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max results to cluster (5-15, default 10)";
                readonly minimum: 5;
                readonly maximum: 15;
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "what_is_missing";
    readonly description: "Proactive gap detection. Given the current context, seeds concepts via similarity, then surfaces graph-neighbor concepts (broader/narrower/related_to) NOT in the similarity top-N. Answers 'what might I be forgetting?' — the prospective counterpart to recall's reactive shape.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly context: {
                readonly type: "string";
                readonly description: "Description of the current focus or topic (min 10 chars)";
            };
            readonly seed_limit: {
                readonly type: "number";
                readonly description: "Top-N concept seeds to traverse from (3-10, default 6)";
                readonly minimum: 3;
                readonly maximum: 10;
            };
            readonly gap_limit: {
                readonly type: "number";
                readonly description: "Max gaps to return (5-20, default 10)";
                readonly minimum: 5;
                readonly maximum: 20;
            };
        };
        readonly required: readonly ["context"];
    };
}, {
    readonly name: "supersede";
    readonly description: "Mark a stale belief as superseded by a new understanding. Writes a correction memory and creates supersedes edges to the concept(s) that matched the old belief, decaying their stability so they lose priority in recall. Use when you KNOW a prior belief is wrong.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly old_text: {
                readonly type: "string";
                readonly description: "The stale belief — phrase it similarly to how the concept was originally saved for best match";
            };
            readonly new_text: {
                readonly type: "string";
                readonly description: "The corrected understanding";
            };
            readonly importance: {
                readonly type: "number";
                readonly description: "Importance of the correction memory (1-10, default 9)";
            };
        };
        readonly required: readonly ["old_text", "new_text"];
    };
}, {
    readonly name: "record_retrieval_feedback";
    readonly description: "Record explicit feedback on a retrieved memory or concept that was injected into context — the highest-signal training data for retrieval. Use when the user reacts to an injected item ('that's wrong/outdated/not helpful', 'that was useful') or when you judge an injected memory was unhelpful or misleading. Signals: 'helpful'/'irrelevant' relabel the ACAN training sample; 'outdated' relabels + decays the item so it loses retrieval priority (follow with supersede for a fix); 'pin' boosts it so it surfaces when relevant. Pass the full record id of the injected item.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly memory_id: {
                readonly type: "string";
                readonly description: "Full record id of the injected memory or concept, e.g. 'memory:abc' or 'concept:xyz' (the id shown in the recalled context).";
            };
            readonly signal: {
                readonly type: "string";
                readonly enum: readonly ["helpful", "irrelevant", "outdated", "pin"];
                readonly description: "helpful = relevant/useful; irrelevant = wrong/not useful; outdated = stale (also decays it; pair with supersede); pin = boost so it surfaces when relevant.";
            };
            readonly reason: {
                readonly type: "string";
                readonly description: "Optional short reason, stored as llm_reason on the training sample.";
            };
        };
        readonly required: readonly ["memory_id", "signal"];
    };
}, {
    readonly name: "create_skill";
    readonly description: "Create a new skill row in the kongcode DB. Skills are DB-resident vector-indexed procedural knowledge invokable via slash command. The full body is stored in the `skill` table and recallable via recall(scope=\"skills\"). Use this instead of authoring a SKILL.md file on disk.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Kebab-case skill name (matches the slash command, e.g. 'kongcode-release')";
            };
            readonly description: {
                readonly type: "string";
                readonly description: "One-line summary used for slash-command suggestion and embedding target. Be specific about when to invoke.";
            };
            readonly body: {
                readonly type: "string";
                readonly description: "Full markdown body of the skill (procedural instructions, steps, examples). Min 20 chars.";
            };
            readonly preconditions: {
                readonly type: "string";
                readonly description: "Optional structured preconditions text.";
            };
            readonly postconditions: {
                readonly type: "string";
                readonly description: "Optional structured postconditions text.";
            };
            readonly steps: {
                readonly type: "array";
                readonly description: "Optional structured step list (strings or {tool, description, argsPattern} objects).";
            };
        };
        readonly required: readonly ["name", "description", "body"];
    };
}, {
    readonly name: "get_skill_body";
    readonly description: "Fetch the full body markdown of a skill by name. Called from a 5-line SKILL.md stub to load real instructions, or from any agent that needs procedural detail of a known skill. Returns frontmatter (name + description) followed by the body.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Skill name (kebab-case, matches the SKILL.md frontmatter `name` field)";
            };
        };
        readonly required: readonly ["name"];
    };
}];
/** Map MCP tool name (snake_case, what Claude Code sends) to IPC method name
 *  (dotted camelCase, what the daemon expects). The thin client looks up here
 *  in handleToolCall to translate without runtime case conversion. */
export declare const MCP_TO_IPC_METHOD: Record<string, IpcMethod>;
