/**
 * KongCode MCP Server — entry point.
 *
 * Long-lived stdio process that owns:
 * - SurrealDB connection
 * - BGE-M3 embedding model
 * - Session state
 * - MCP tools: recall, core_memory, introspect
 * - Internal Unix socket HTTP API for hook communication
 *
 * Spawned by Claude Code via .mcp.json (stdio transport).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { parsePluginConfig } from "./engine/config.js";
import { bootstrap, resolvePluginDir, shutdownManagedSurreal } from "./engine/bootstrap.js";
import { SurrealStore } from "./engine/surreal.js";
import { EmbeddingService } from "./engine/embeddings.js";
import { GlobalPluginState } from "./engine/state.js";
import { startHttpApi, stopHttpApi, registerHookHandler } from "./http-api.js";
import { handleSessionStart } from "./hook-handlers/session-start.js";
import { handleSessionEnd } from "./hook-handlers/session-end.js";
import { handleUserPromptSubmit } from "./hook-handlers/user-prompt-submit.js";
import { handlePreToolUse } from "./hook-handlers/pre-tool-use.js";
import { handlePostToolUse } from "./hook-handlers/post-tool-use.js";
import { handleStop } from "./hook-handlers/stop.js";
import { handlePreCompact } from "./hook-handlers/pre-compact.js";
import { handlePostCompact } from "./hook-handlers/post-compact.js";
import { handleTaskCreated, handleSubagentStop } from "./hook-handlers/subagent.js";
import { handleRecall } from "./tools/recall.js";
import { handleCoreMemory } from "./tools/core-memory.js";
import { handleIntrospect } from "./tools/introspect.js";
import { handleFetchPendingWork, handleCommitWorkResults, handleCreateKnowledgeGems } from "./tools/pending-work.js";
import { handleMemoryHealth } from "./tools/memory-health.js";
import { handleLinkHierarchy } from "./tools/link-hierarchy.js";
import { handleSupersede } from "./tools/supersede.js";
import { handleRecordFinding } from "./tools/record-finding.js";
import { handleClusterScan } from "./tools/cluster-scan.js";
import { handleWhatIsMissing } from "./tools/what-is-missing.js";
import { handleCreateSkill } from "./tools/create-skill.js";
import { handleGetSkillBody } from "./tools/get-skill-body.js";
import { log } from "./engine/log.js";
import { runBootstrapMaintenance } from "./engine/maintenance.js";
// ── Global state ──────────────────────────────────────────────────────────────
let globalState = null;
let bootstrapPhase = "starting";
let bootstrapStartedAt = Date.now();
let bootstrapError = null;
function setBootstrapPhase(p, err) {
    bootstrapPhase = p;
    if (p === "failed" && err)
        bootstrapError = err;
}
// ── MCP Tool definitions ──────────────────────────────────────────────────────
const TOOLS = [
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
                action: {
                    type: "string",
                    enum: ["list", "add", "update", "deactivate"],
                    description: "Operation to perform",
                },
                tier: { type: "number", enum: [0, 1], description: "Memory tier (0=always, 1=session)" },
                category: {
                    type: "string",
                    enum: ["identity", "rules", "tools", "operations", "general"],
                    description: "Category for the directive",
                },
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
                action: {
                    type: "string",
                    enum: ["status", "count", "verify", "query", "migrate"],
                    description: "Diagnostic action to perform",
                },
                table: { type: "string", description: "Table name (for count/verify)" },
                filter: {
                    type: "string",
                    enum: ["active", "inactive", "recent_24h", "with_embedding", "unresolved"],
                    description: "Filter preset (for count)",
                },
                record_id: { type: "string", description: "Record ID (for verify)" },
            },
            required: ["action"],
        },
    },
    {
        name: "fetch_pending_work",
        description: "Claim the next pending background work item for processing. Returns instructions and data for extraction, reflection, skill, or soul work. Call repeatedly until it returns empty.",
        inputSchema: {
            type: "object",
            properties: {},
        },
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
        inputSchema: {
            type: "object",
            properties: {},
        },
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
                finding_type: {
                    type: "string",
                    enum: ["decision", "correction", "preference", "fact"],
                    description: "decision = choice-with-rationale; correction = user corrected a belief; preference = user workflow signal; fact = technical knowledge",
                },
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
        name: "create_skill",
        description: "Create a new skill row in the kongcode DB. Skills are DB-resident vector-indexed procedural knowledge invokable via slash command. The full body is stored in the `skill` table and recallable via recall(scope=\"skills\"). Use this instead of authoring a SKILL.md file on disk.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Kebab-case skill name (matches the slash command, e.g. 'kongcode-release')" },
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
];
// ── Tool handlers ─────────────────────────────────────────────────────────────
/** Get or create a session for tool calls. Uses KONGCODE_SESSION_ID env var or a default. */
function getSession() {
    const sessionId = process.env.KONGCODE_SESSION_ID ?? "mcp-default";
    return globalState.getOrCreateSession(sessionId, sessionId);
}
async function handleToolCall(name, args) {
    if (!globalState || bootstrapPhase !== "ready") {
        const elapsed = Math.round((Date.now() - bootstrapStartedAt) / 1000);
        let msg;
        if (bootstrapPhase === "failed" && bootstrapError) {
            msg = `KongCode bootstrap failed: ${bootstrapError.message}. Check stderr for details, or set KONGCODE_SKIP_BOOTSTRAP=1 and provide your own SurrealDB via SURREAL_URL.`;
        }
        else if (bootstrapPhase === "starting" || bootstrapPhase === "npm-install") {
            msg = `kongcode is provisioning first-run dependencies (npm install, ~${elapsed}s elapsed). First-run setup typically takes 2-5 minutes total. Try again in 30s.`;
        }
        else if (bootstrapPhase === "downloading-surreal") {
            msg = `kongcode is downloading SurrealDB binary (~80MB, ~${elapsed}s elapsed). Try again in 30s.`;
        }
        else if (bootstrapPhase === "downloading-model") {
            msg = `kongcode is downloading the BGE-M3 embedding model (~420MB, ~${elapsed}s elapsed). Try again in 60s.`;
        }
        else if (bootstrapPhase === "starting-surreal" || bootstrapPhase === "connecting-store") {
            msg = `kongcode is starting its managed SurrealDB child (~${elapsed}s elapsed). Try again in 10s.`;
        }
        else if (bootstrapPhase === "loading-embeddings") {
            msg = `kongcode is loading the embedding model (cold start, ~${elapsed}s elapsed). Try again in 30s.`;
        }
        else {
            msg = `kongcode is still initializing (phase=${bootstrapPhase}, ${elapsed}s elapsed). Try again in 30s.`;
        }
        return { content: [{ type: "text", text: msg }] };
    }
    const session = getSession();
    // Outer try/catch wraps the entire dispatch so handler exceptions surface
    // as tool-result content (which the model can interpret + recover from)
    // instead of bubbling up as raw JSON-RPC errors that confuse the client.
    // Pre-existing bug: any thrown error from a tool handler would otherwise
    // be relayed as a transport-level failure with no usable diagnostic.
    try {
        switch (name) {
            case "recall":
                return await handleRecall(globalState, session, args);
            case "core_memory":
                return await handleCoreMemory(globalState, session, args);
            case "introspect":
                return await handleIntrospect(globalState, session, args);
            case "fetch_pending_work":
                return await handleFetchPendingWork(globalState, session, args);
            case "commit_work_results":
                return await handleCommitWorkResults(globalState, session, args);
            case "create_knowledge_gems":
                return await handleCreateKnowledgeGems(globalState, session, args);
            case "memory_health":
                return await handleMemoryHealth(globalState, session, args);
            case "link_hierarchy":
                return await handleLinkHierarchy(globalState, session, args);
            case "supersede":
                return await handleSupersede(globalState, session, args);
            case "record_finding":
                return await handleRecordFinding(globalState, session, args);
            case "cluster_scan":
                return await handleClusterScan(globalState, session, args);
            case "what_is_missing":
                return await handleWhatIsMissing(globalState, session, args);
            case "create_skill":
                return await handleCreateSkill(globalState, session, args);
            case "get_skill_body":
                return await handleGetSkillBody(globalState, session, args);
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
        }
    }
    catch (err) {
        log.error("toolCall failed", { name, err });
        return {
            content: [{
                    type: "text",
                    text: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
                }],
        };
    }
}
// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function initialize() {
    log.info("Initializing KongCode MCP server...");
    bootstrapStartedAt = Date.now();
    setBootstrapPhase("starting");
    // Parse config from env vars
    const config = parsePluginConfig();
    // First-run bootstrap: provision npm deps, SurrealDB binary + child process,
    // and embedding model. Idempotent — fast path when artifacts already exist.
    // KONGCODE_SKIP_BOOTSTRAP=1 disables; SURREAL_URL override skips the child.
    if (process.env.KONGCODE_SKIP_BOOTSTRAP !== "1") {
        // npm-install is by far the longest first-run step (1-3 min vs <10s for
        // the binary downloads). Tagging the phase as "npm-install" gives the
        // user-facing error message the right hint when they probe mid-bootstrap.
        // Refined per-step phasing requires plumbing a progress callback through
        // bootstrap(); deferred until users complain.
        setBootstrapPhase("npm-install");
        try {
            const result = await bootstrap({
                pluginDir: resolvePluginDir(),
                cacheDir: config.paths.cacheDir,
                dataDir: config.paths.dataDir,
                modelPath: config.embedding.modelPath,
                surrealBinPathOverride: config.paths.surrealBinPath,
                surrealUrlOverride: process.env.SURREAL_URL,
                surrealUser: config.surreal.user,
                surrealPass: config.surreal.pass,
            });
            if (result.surrealServer.managed) {
                // Point the store at the managed child instead of the default ws://localhost:8000.
                config.surreal.url = result.surrealServer.url;
            }
            log.info(`[bootstrap] complete in ${result.totalDurationMs}ms ` +
                `(npm=${result.npmInstall.ran ? "ran" : "skip"}, ` +
                `surreal=${result.surrealBinary.provisioned ? "downloaded" : "cached"}, ` +
                `llama=${result.nodeLlamaCpp.mainPath ? (result.nodeLlamaCpp.provisioned ? "downloaded" : "cached") : "via-npm"}, ` +
                `model=${result.embeddingModel.provisioned ? "downloaded" : "cached"})`);
        }
        catch (err) {
            log.error("[bootstrap] failed — falling back to degraded mode:", err);
            setBootstrapPhase("failed", err instanceof Error ? err : new Error(String(err)));
        }
    }
    else {
        log.info("[bootstrap] skipped (KONGCODE_SKIP_BOOTSTRAP=1)");
    }
    // Create services
    const store = new SurrealStore(config.surreal);
    const embeddings = new EmbeddingService(config.embedding);
    // Build global state
    globalState = new GlobalPluginState(config, store, embeddings);
    globalState.workspaceDir = process.env.KONGCODE_PROJECT_DIR ?? process.cwd();
    // Connect to SurrealDB
    setBootstrapPhase("connecting-store");
    try {
        await store.initialize();
        log.info("SurrealDB connected");
    }
    catch (err) {
        log.error("SurrealDB connection failed — running in degraded mode:", err);
    }
    // Initialize embedding model
    setBootstrapPhase("loading-embeddings");
    try {
        await embeddings.initialize();
        log.info("Embedding model loaded");
    }
    catch (err) {
        log.error("Embedding model failed — running without vector search:", err);
    }
    setBootstrapPhase("ready");
    // Register hook handlers
    registerHookHandler("session-start", handleSessionStart);
    registerHookHandler("session-end", handleSessionEnd);
    registerHookHandler("user-prompt-submit", handleUserPromptSubmit);
    registerHookHandler("pre-tool-use", handlePreToolUse);
    registerHookHandler("post-tool-use", handlePostToolUse);
    registerHookHandler("stop", handleStop);
    registerHookHandler("pre-compact", handlePreCompact);
    registerHookHandler("post-compact", handlePostCompact);
    registerHookHandler("task-created", handleTaskCreated);
    registerHookHandler("subagent-stop", handleSubagentStop);
    // Start internal HTTP API for hook communication.
    // Per-PID socket path so multiple concurrent MCPs don't race on a shared
    // file. hook-proxy.sh enumerates .kongcode-*.sock in $HOME and picks the
    // newest one whose owning PID is still alive. Killing one MCP no longer
    // takes down others' hook routing.
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const socketPath = `${homeDir}/.kongcode-${process.pid}.sock`;
    await startHttpApi(globalState, socketPath, homeDir);
    log.info("KongCode MCP server ready");
    // Fire background maintenance once per MCP process boot. This is the
    // reliable trigger — it fires regardless of whether Claude Code delivers
    // SessionStart (multi-MCP socket races, hook-proxy transport failures,
    // --resume edge cases all previously left this dormant). handleSessionStart
    // also calls it; the ACAN lockfile and per-job safety floors handle the
    // redundancy safely.
    runBootstrapMaintenance(globalState);
}
async function shutdown() {
    log.info("Shutting down KongCode MCP server...");
    await stopHttpApi();
    if (globalState) {
        await globalState.shutdown();
        globalState = null;
    }
    shutdownManagedSurreal();
    log.info("KongCode shutdown complete");
}
// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const server = new Server({ name: "kongcode", version: "0.7.97" }, { capabilities: { tools: {} } });
    // Register tool list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));
    // Register tool call handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        return handleToolCall(name, (args ?? {}));
    });
    // Register signal handlers BEFORE the long init so SIGTERM/SIGINT during
    // startup still triggers graceful shutdown.
    process.on("SIGTERM", async () => {
        await shutdown();
        process.exit(0);
    });
    process.on("SIGINT", async () => {
        await shutdown();
        process.exit(0);
    });
    // Connect transport FIRST so the Claude Code stdio handshake completes
    // immediately. initialize() can take tens of seconds (cold sentence-
    // transformer load), and Claude Code marks the MCP failed if `initialize`
    // JSON-RPC isn't answered within its handshake window. Tool calls that
    // arrive before initialize() finishes hit the null-guard at line 277-279
    // and return a friendly "not initialized" message — the model retries
    // a moment later and gets a working tool. Issue #4.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("KongCode MCP server running on stdio");
    // Now initialize services — slow embedding load no longer blocks handshake.
    await initialize();
}
main().catch((err) => {
    log.error("Fatal error:", err);
    process.exit(1);
});
