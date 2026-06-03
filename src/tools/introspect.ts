/**
 * MCP wrapper for the introspect tool.
 * Bridges the engine's createIntrospectToolDef to MCP CallToolResult format.
 */

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import { createIntrospectToolDef } from "../engine/tools/introspect.js";

export async function handleIntrospect(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const toolDef = createIntrospectToolDef(state, session);
  const result = await toolDef.execute("mcp-introspect", {
    action: String(args.action ?? "status") as "status" | "count" | "verify" | "query" | "migrate" | "trends" | "stats",
    table: args.table as string | undefined,
    filter: args.filter as string | undefined,
    record_id: args.record_id as string | undefined,
  });
  return { content: result.content };
}
