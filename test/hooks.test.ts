/**
 * Tests for hook handlers: llm-output.
 *
 * Runs on every LLM response — tracks tokens, accumulates text, parses
 * classifications, captures thinking blocks. (after-tool-call coverage was
 * dropped in v0.7.74 along with its source file; the handler was never
 * registered against the production hook bus.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionState } from "../src/engine/state.js";
import { createLlmOutputHandler } from "../src/engine/hooks/llm-output.js";

// ── Mock helpers ──

function mockStore(available = true) {
  return {
    isAvailable: () => available,
    queryFirst: vi.fn(async () => []),
    queryExec: vi.fn(async () => {}),
    queryBatch: vi.fn(async () => []),
    upsertTurn: vi.fn(async () => "turn:abc123"),
    relate: vi.fn(async () => {}),
    bumpSessionTurn: vi.fn(async () => {}),
    addSessionTokens: vi.fn(async () => {}),
    createArtifact: vi.fn(async () => "artifact:xyz"),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as any;
}

function mockState(session: SessionState, storeOverride?: any) {
  const store = storeOverride ?? mockStore();
  return {
    store,
    embeddings: mockEmbeddings(),
    config: { thresholds: { maxPendingThinking: 10 } },
    getSession: (key: string) => key === session.sessionKey ? session : undefined,
  } as any;
}

function makeCtx(session: SessionState) {
  return { sessionKey: session.sessionKey, sessionId: session.sessionId };
}

// ── llm-output handler ──

describe("createLlmOutputHandler", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("test-session", "test-key");
  });

  it("tracks cumulative token counts from usage data", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["hello world"],
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
    }, makeCtx(session));

    expect(session.cumulativeTokens).toBe(165);
  });

  it("computes delta from cumulative usage (not double-counting)", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    // First call: total 100
    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["first"],
      usage: { input: 60, output: 40, total: 100 },
    }, makeCtx(session));

    expect(session.cumulativeTokens).toBe(100);

    // Second call: total 250 (delta = 150)
    await handler({
      runId: "r2", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["second"],
      usage: { input: 150, output: 100, total: 250 },
    }, makeCtx(session));

    expect(session.cumulativeTokens).toBe(250); // 100 + 150
  });

  it("falls back to text-length estimation when no usage data", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["a".repeat(400)], // 400 chars / 4 = 100 tokens
    }, makeCtx(session));

    expect(session.cumulativeTokens).toBe(100);
  });

  it("tracks text length for planning gate", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["hello", " world"],
    }, makeCtx(session));

    expect(session.turnTextLength).toBe(11); // "hello" + " world"
  });

  it("resets toolCallsSinceLastText when text > 50 chars", async () => {
    session.toolCallsSinceLastText = 5;
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["x".repeat(51)],
    }, makeCtx(session));

    expect(session.toolCallsSinceLastText).toBe(0);
  });

  it("does NOT reset toolCallsSinceLastText for short text", async () => {
    session.toolCallsSinceLastText = 3;
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["ok"],
    }, makeCtx(session));

    expect(session.toolCallsSinceLastText).toBe(3);
  });

  it("parses LOOKUP classification and sets tool limit", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["LOOKUP: I need to check something"],
    }, makeCtx(session));

    expect(session.toolLimit).toBe(3);
  });

  it("parses EDIT classification", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["EDIT: fixing the import"],
    }, makeCtx(session));

    expect(session.toolLimit).toBe(4);
  });

  it("captures thinking blocks into pendingThinking", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["response"],
      lastAssistant: {
        content: [
          { type: "thinking", thinking: "x".repeat(100) },
          { type: "text", text: "response" },
        ],
      },
    }, makeCtx(session));

    expect(session.pendingThinking).toHaveLength(1);
    expect(session.pendingThinking[0]).toHaveLength(100);
  });

  it("skips short thinking blocks (< 50 chars)", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["response"],
      lastAssistant: {
        content: [{ type: "thinking", thinking: "short" }],
      },
    }, makeCtx(session));

    expect(session.pendingThinking).toHaveLength(0);
  });

  it("caps pendingThinking to maxPendingThinking", async () => {
    const state = mockState(session);
    state.config.thresholds.maxPendingThinking = 3;
    const handler = createLlmOutputHandler(state);

    for (let i = 0; i < 5; i++) {
      await handler({
        runId: `r${i}`, sessionId: "s1", provider: "anthropic", model: "claude",
        assistantTexts: ["response"],
        lastAssistant: {
          content: [{ type: "thinking", thinking: `thought ${i} ${"x".repeat(60)}` }],
        },
      }, makeCtx(session));
    }

    expect(session.pendingThinking).toHaveLength(3);
    // Should keep the LAST 3
    expect(session.pendingThinking[0]).toContain("thought 2");
    expect(session.pendingThinking[2]).toContain("thought 4");
  });

  it("tracks lastAssistantText", async () => {
    const handler = createLlmOutputHandler(mockState(session));

    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["line 1", "line 2"],
    }, makeCtx(session));

    expect(session.lastAssistantText).toBe("line 1\nline 2");
  });

  it("batches session stats writes (flushes every 5th call)", async () => {
    const store = mockStore();
    session.surrealSessionId = "session:abc";
    const handler = createLlmOutputHandler(mockState(session, store));

    // First 4 calls — no DB write
    for (let i = 0; i < 4; i++) {
      await handler({
        runId: `r${i}`, sessionId: "s1", provider: "anthropic", model: "claude",
        assistantTexts: ["x"], usage: { input: 10, output: 10, total: 20 * (i + 1) },
      }, makeCtx(session));
    }
    expect(store.bumpSessionTurn).not.toHaveBeenCalled();
    expect(store.addSessionTokens).not.toHaveBeenCalled();

    // 5th call — triggers flush
    await handler({
      runId: "r4", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["x"], usage: { input: 50, output: 50, total: 100 },
    }, makeCtx(session));
    expect(store.bumpSessionTurn).toHaveBeenCalledTimes(1);
    expect(store.addSessionTokens).toHaveBeenCalledTimes(1);
  });

  it("handles missing session gracefully", async () => {
    const handler = createLlmOutputHandler(mockState(session));
    // Wrong session key — should not throw
    await handler({
      runId: "r1", sessionId: "s1", provider: "anthropic", model: "claude",
      assistantTexts: ["hello"],
    }, { sessionKey: "wrong-key" });
  });
});
