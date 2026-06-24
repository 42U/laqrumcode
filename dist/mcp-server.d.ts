/**
 * LaqrumCode MCP Server — entry point.
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
export {};
