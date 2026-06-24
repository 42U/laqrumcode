/**
 * Local type definitions replacing @mariozechner/pi-agent-core and @mariozechner/pi-ai.
 *
 * These are minimal structural types that match the shapes used by LaqrumBrain's
 * graph-context.ts and context-engine.ts. They are NOT full re-implementations
 * of the pi-ai types — only the subset actually consumed by this codebase.
 *
 * IMPORTANT: These match the pi-ai type shapes exactly. The engine code expects
 * these specific role strings and content structures. Do not change them without
 * updating all consumers.
 */
export interface TextContent {
    type: "text";
    text: string;
}
export interface ThinkingContent {
    type: "thinking";
    thinking: string;
}
export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ImageContent {
    type: "image";
    source: {
        type: string;
        media_type: string;
        data: string;
    };
}
export type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;
export interface UserMessage {
    role: "user";
    content: ContentBlock[] | string;
}
export interface AssistantMessage {
    role: "assistant";
    content: ContentBlock[];
    stopReason?: string;
}
export interface ToolResultMessage {
    role: "toolResult";
    content: ContentBlock[];
    tool_use_id?: string;
}
/**
 * Union of all message types that flow through the context pipeline.
 * Replaces `AgentMessage` from @mariozechner/pi-agent-core.
 */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;
