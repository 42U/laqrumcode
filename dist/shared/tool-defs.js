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
export const MCP_TOOLS = [
    {
        name: "recall",
        description: "Search the persistent memory graph for past knowledge, concepts, artifacts, skills, and conversation history.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural language search query" },
                scope: {
                    type: "string",
                    enum: ["all", "memories", "concepts", "turns", "artifacts", "skills"],
                    description: "Narrow search to a specific knowledge type (default: all)",
                },
                limit: {
                    type: "number",
                    description: "Max results to return (1-15, default: 5)",
                    minimum: 1,
                    maximum: 15,
                },
            },
            required: ["query"],
        },
    },
    {
        name: "core_memory",
        description: "Manage always-loaded memory directives. Tier 0 entries appear every turn (identity, rules). Tier 1 entries are session-pinned.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "add", "update", "deactivate"], description: "Operation to perform" },
                tier: { type: "number", enum: [0, 1], description: "Memory tier (0=always, 1=session)" },
                category: { type: "string", enum: ["identity", "rules", "tools", "operations", "general"], description: "Category for the directive" },
                text: { type: "string", description: "Content of the directive (for add/update)" },
                priority: { type: "number", description: "Priority 0-100 (higher = loaded first)" },
                id: { type: "string", description: "Record ID (for update/deactivate)" },
            },
            required: ["action"],
        },
    },
    {
        name: "introspect",
        description: "Inspect the memory database: health status, table counts, record verification, and predefined reports.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["status", "count", "verify", "query", "migrate", "trends", "stats"], description: "Diagnostic action to perform" },
                table: { type: "string", description: "Table name (for count/verify)" },
                filter: { type: "string", enum: ["active", "inactive", "recent_24h", "with_embedding", "unresolved"], description: "Filter preset (for count)" },
                record_id: { type: "string", description: "Record ID (for verify)" },
            },
            required: ["action"],
        },
    },
    {
        name: "fetch_pending_work",
        description: "Claim the next pending background work item for processing. Returns instructions and data for extraction, reflection, skill, or soul work. Call repeatedly until it returns empty.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "commit_work_results",
        description: "Submit processed results for a pending work item. Persists extracted knowledge, reflections, skills, or soul documents to the memory database.",
        inputSchema: {
            type: "object",
            properties: {
                work_id: { type: "string", description: "The work item ID from fetch_pending_work" },
                results: { type: "object", description: "The extraction results — JSON object or plain text depending on work type" },
            },
            required: ["work_id", "results"],
        },
    },
    {
        name: "create_knowledge_gems",
        description: "Direct-write structured knowledge from an external source (PDF, article, doc) into the memory graph. Each gem becomes a concept; a source artifact is created and linked to every gem via 'derived_from'; cross-link edges between gems are created from the 'links' array. Use for foreground extraction tasks where there is no session transcript for the daemon to chew on.",
        inputSchema: {
            type: "object",
            properties: {
                source: { type: "string", description: "Source identifier (e.g. file path, URL, doc title)" },
                source_type: { type: "string", description: "Source type (e.g. 'pdf', 'article', 'book')", default: "document" },
                source_description: { type: "string", description: "One-line description of the source" },
                gems: {
                    type: "array",
                    description: "Array of knowledge gems. Each gem is one concept.",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Short identifier used for cross-link resolution" },
                            content: { type: "string", description: "The actual insight text — this is what gets embedded and stored" },
                            importance: { type: "number", description: "Reserved for future use (concepts do not currently store importance)" },
                        },
                        required: ["name", "content"],
                    },
                },
                links: {
                    type: "array",
                    description: "Cross-link edges between gems. Each link references gems by name.",
                    items: {
                        type: "object",
                        properties: {
                            from: { type: "string", description: "Source gem name" },
                            to: { type: "string", description: "Target gem name" },
                            edge: { type: "string", description: "Relation name: 'broader', 'narrower', or 'related_to'" },
                        },
                        required: ["from", "to", "edge"],
                    },
                },
            },
            required: ["source", "gems"],
        },
    },
    {
        name: "memory_health",
        description: "Substrate self-audit. Returns structured JSON with status (green/yellow/red), connection state, record counts, embedding-gap percentage, pending-work backlog, and diagnostic warnings. Use this to check whether the memory system is healthy before heavy writes or when debugging stale retrievals.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "link_hierarchy",
        description: "Explicitly assert a parent→child concept relationship. Writes broader/narrower edges between the two concepts (creating them via commitKnowledge if they don't exist). Use when you KNOW 'X is a kind of Y' and want to seal the hierarchy rather than hoping embedding-similarity detection finds it.",
        inputSchema: {
            type: "object",
            properties: {
                parent: { type: "string", description: "The broader concept (e.g. 'authentication')" },
                child: { type: "string", description: "The narrower concept (e.g. 'JWT validation')" },
                source: { type: "string", description: "Optional provenance tag" },
            },
            required: ["parent", "child"],
        },
    },
    {
        name: "record_finding",
        description: "Structured save for findings you want to remember permanently. Routes through commitKnowledge so the memory auto-seals about_concept edges. Use when you have a decision, correction, preference, or fact worth preserving across sessions.",
        inputSchema: {
            type: "object",
            properties: {
                finding_type: { type: "string", enum: ["decision", "correction", "preference", "fact"], description: "decision = choice-with-rationale; correction = user corrected a belief; preference = user workflow signal; fact = technical knowledge" },
                text: { type: "string", description: "The finding itself — specific, standalone, useful when recalled in isolation" },
                why: { type: "string", description: "Optional rationale — appended to text as 'Rationale: ...'" },
                importance: { type: "number", description: "1-10. Defaults to type-appropriate: correction=9, decision=7, preference=7, fact=6" },
            },
            required: ["finding_type", "text"],
        },
    },
    {
        name: "cluster_scan",
        description: "Recall with grouped output. Returns results organized into clusters by shared concept neighbors instead of a flat score-sorted list. Use for 'what do I know about X?' queries where structure matters more than rank.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural language query" },
                limit: { type: "number", description: "Max results to cluster (5-15, default 10)", minimum: 5, maximum: 15 },
            },
            required: ["query"],
        },
    },
    {
        name: "what_is_missing",
        description: "Proactive gap detection. Given the current context, seeds concepts via similarity, then surfaces graph-neighbor concepts (broader/narrower/related_to) NOT in the similarity top-N. Answers 'what might I be forgetting?' — the prospective counterpart to recall's reactive shape.",
        inputSchema: {
            type: "object",
            properties: {
                context: { type: "string", description: "Description of the current focus or topic (min 10 chars)" },
                seed_limit: { type: "number", description: "Top-N concept seeds to traverse from (3-10, default 6)", minimum: 3, maximum: 10 },
                gap_limit: { type: "number", description: "Max gaps to return (5-20, default 10)", minimum: 5, maximum: 20 },
            },
            required: ["context"],
        },
    },
    {
        name: "supersede",
        description: "Mark a stale belief as superseded by a new understanding. Writes a correction memory and creates supersedes edges to the concept(s) that matched the old belief, decaying their stability so they lose priority in recall. Use when you KNOW a prior belief is wrong.",
        inputSchema: {
            type: "object",
            properties: {
                old_text: { type: "string", description: "The stale belief — phrase it similarly to how the concept was originally saved for best match" },
                new_text: { type: "string", description: "The corrected understanding" },
                importance: { type: "number", description: "Importance of the correction memory (1-10, default 9)" },
            },
            required: ["old_text", "new_text"],
        },
    },
    {
        name: "record_retrieval_feedback",
        description: "Record explicit feedback on a retrieved memory or concept that was injected into context — the highest-signal training data for retrieval. Use when the user reacts to an injected item ('that's wrong/outdated/not helpful', 'that was useful') or when you judge an injected memory was unhelpful or misleading. Signals: 'helpful'/'irrelevant' relabel the ACAN training sample; 'outdated' relabels + decays the item so it loses retrieval priority (follow with supersede for a fix); 'pin' boosts it so it surfaces when relevant. Pass the full record id of the injected item.",
        inputSchema: {
            type: "object",
            properties: {
                memory_id: { type: "string", description: "Full record id of the injected memory or concept, e.g. 'memory:abc' or 'concept:xyz' (the id shown in the recalled context)." },
                signal: { type: "string", enum: ["helpful", "irrelevant", "outdated", "pin"], description: "helpful = relevant/useful; irrelevant = wrong/not useful; outdated = stale (also decays it; pair with supersede); pin = boost so it surfaces when relevant." },
                reason: { type: "string", description: "Optional short reason, stored as llm_reason on the training sample." },
            },
            required: ["memory_id", "signal"],
        },
    },
    {
        name: "create_skill",
        description: "Create a new skill row in the laqrumcode DB. Skills are DB-resident vector-indexed procedural knowledge invokable via slash command. The full body is stored in the `skill` table and recallable via recall(scope=\"skills\"). Use this instead of authoring a SKILL.md file on disk.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Kebab-case skill name (matches the slash command, e.g. 'laqrumcode-release')" },
                description: { type: "string", description: "One-line summary used for slash-command suggestion and embedding target. Be specific about when to invoke." },
                body: { type: "string", description: "Full markdown body of the skill (procedural instructions, steps, examples). Min 20 chars." },
                preconditions: { type: "string", description: "Optional structured preconditions text." },
                postconditions: { type: "string", description: "Optional structured postconditions text." },
                steps: { type: "array", description: "Optional structured step list (strings or {tool, description, argsPattern} objects)." },
            },
            required: ["name", "description", "body"],
        },
    },
    {
        name: "get_skill_body",
        description: "Fetch the full body markdown of a skill by name. Called from a 5-line SKILL.md stub to load real instructions, or from any agent that needs procedural detail of a known skill. Returns frontmatter (name + description) followed by the body.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Skill name (kebab-case, matches the SKILL.md frontmatter `name` field)" },
            },
            required: ["name"],
        },
    },
    {
        name: "update_skill",
        description: "Revise an EXISTING skill in the laqrumcode DB (counterpart to create_skill, which rejects name collisions). Patches the provided fields on the skill matched by `name` and RE-EMBEDS so recall(scope=\"skills\") reflects the new content — a raw SurrealQL UPDATE would leave the old embedding stale. `name` identifies the skill and is not changed; provide at least one mutable field.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Kebab-case name of the EXISTING skill to update (the slash-command name)." },
                body: { type: "string", description: "New full markdown body (min 20 chars). Replaces the existing body." },
                description: { type: "string", description: "New one-line summary (embedding + slash-command suggestion target)." },
                preconditions: { type: "string", description: "New structured preconditions text." },
                postconditions: { type: "string", description: "New structured postconditions text." },
                steps: { type: "array", description: "New structured step list (strings or {tool, description, argsPattern} objects)." },
            },
            required: ["name"],
        },
    },
];
/** Map MCP tool name (snake_case, what Claude Code sends) to IPC method name
 *  (dotted camelCase, what the daemon expects). The thin client looks up here
 *  in handleToolCall to translate without runtime case conversion. */
export const MCP_TO_IPC_METHOD = {
    recall: "tool.recall",
    core_memory: "tool.coreMemory",
    introspect: "tool.introspect",
    fetch_pending_work: "tool.fetchPendingWork",
    commit_work_results: "tool.commitWorkResults",
    create_knowledge_gems: "tool.createKnowledgeGems",
    memory_health: "tool.memoryHealth",
    link_hierarchy: "tool.linkHierarchy",
    record_finding: "tool.recordFinding",
    cluster_scan: "tool.clusterScan",
    what_is_missing: "tool.whatIsMissing",
    supersede: "tool.supersede",
    record_retrieval_feedback: "tool.recordRetrievalFeedback",
    create_skill: "tool.createSkill",
    get_skill_body: "tool.getSkillBody",
    update_skill: "tool.updateSkill",
};
