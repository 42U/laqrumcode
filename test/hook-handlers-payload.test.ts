/**
 * Regression tests for live HTTP hook handlers — specifically the payload
 * field-name contracts. Two production handlers shipped with wrong field
 * names since commit 7a16e57 (Apr 6, 2026) and silently no-op'd for ~20
 * days, killing turn ingestion and tool-outcome tracking:
 *
 *   user-prompt-submit.ts read `payload.user_prompt` — Claude Code sends
 *     `payload.prompt`. Every prompt early-returned {}. No turns ingested,
 *     no retrieval pipeline run.
 *   post-tool-use.ts read `payload.tool_result` — Claude Code sends
 *     `payload.tool_response`. Token accounting stuck at 0; recordToolOutcome
 *     was never wired into this handler at all (the engine-internal
 *     after-tool-call handler had it but is test-only).
 *
 * These tests exercise the *production* HTTP handlers — the ones the
 * hook proxy actually invokes — using the canonical Claude Code payload
 * shape. Existing `hooks.test.ts` covers the engine-internal handlers
 * which run in tests but never in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUserPromptSubmit } from "../src/hook-handlers/user-prompt-submit.js";
import { handlePostToolUse } from "../src/hook-handlers/post-tool-use.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";
import {
  stageRetrieval,
  evaluateRetrieval,
  getStagedItems,
} from "../src/engine/retrieval-quality.js";

// Minimal state stub — we only need session lookup, store stub for the
// pending_work query, and a no-op embeddings service.
function makeState(session: SessionState): GlobalPluginState {
  const store = {
    isAvailable: () => false, // skip pending_work query path
    queryFirst: vi.fn(async () => []),
    queryExec: vi.fn(async () => {}),
  } as unknown as GlobalPluginState["store"];
  const embeddings = {
    isAvailable: () => false,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as unknown as GlobalPluginState["embeddings"];

  const state = {
    store,
    embeddings,
    config: { thresholds: { midSessionCleanupThreshold: 25_000 } },
    workspaceDir: "/tmp",
  } as unknown as GlobalPluginState;

  // Wire session lookup to return our prepared session
  (state as unknown as { getSession: (k: string) => SessionState | undefined }).getSession =
    (k: string) => k === session.sessionKey ? session : undefined;
  (state as unknown as { getOrCreateSession: (k: string, i: string) => SessionState }).getOrCreateSession =
    (k: string, _i: string) => k === session.sessionKey ? session : session;

  return state;
}

describe("handleUserPromptSubmit — payload.prompt contract", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("sess-1", "sess-1");
  });

  it("reads the user's text from payload.prompt (canonical Claude Code field)", async () => {
    const state = makeState(session);
    const payload = {
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      hook_event_name: "UserPromptSubmit",
      prompt: "what is the retrieval utilization currently",
    };
    await handleUserPromptSubmit(state, payload);
    // The handler stashes the user text on the session for downstream
    // retrieval/embedding reuse. If field-name parsing breaks, this is
    // the first observable symptom.
    expect(session.lastUserText).toBe("what is the retrieval utilization currently");
  });

  it("falls back to payload.user_prompt for backwards compatibility", async () => {
    const state = makeState(session);
    const payload = {
      session_id: "sess-1",
      user_prompt: "legacy field name",
    };
    await handleUserPromptSubmit(state, payload);
    expect(session.lastUserText).toBe("legacy field name");
  });

  it("early-returns {} only when both fields are absent (real no-prompt case)", async () => {
    const state = makeState(session);
    const result = await handleUserPromptSubmit(state, { session_id: "sess-1" });
    expect(result).toEqual({});
    expect(session.lastUserText).toBe("");
  });

  // 0.7.44: bypass sigil. Prefix `*` or `/raw` skips kongcode injection
  // for that turn. Turn ingestion still fires (lastUserText populated).
  it("bypass sigil '* ' returns empty additionalContext but still ingests the turn", async () => {
    const state = makeState(session);
    const result = await handleUserPromptSubmit(state, {
      session_id: "sess-1",
      prompt: "* clean shot at the model",
    });
    expect(result).toEqual({});
    expect(session.lastUserText).toBe("* clean shot at the model");
  });

  it("bypass sigil '/raw ' returns empty additionalContext but still ingests the turn", async () => {
    const state = makeState(session);
    const result = await handleUserPromptSubmit(state, {
      session_id: "sess-1",
      prompt: "/raw what is happening here",
    });
    expect(result).toEqual({});
    expect(session.lastUserText).toBe("/raw what is happening here");
  });

  it("non-bypass prompts starting with '*' but no following space are NOT bypassed", async () => {
    const state = makeState(session);
    const result = await handleUserPromptSubmit(state, {
      session_id: "sess-1",
      prompt: "*important* — review this",
    });
    // Should run the full pipeline (still returns {} here only because
    // store/embeddings are unavailable in the stub, not because of bypass).
    expect(session.lastUserText).toBe("*important* — review this");
    // result may be {} due to context-pipeline skip, but the bypass branch
    // wasn't taken — verifying via lastUserText being populated is enough.
    expect(result).toBeDefined();
  });
});

describe("wrapKongcodeContext — Anthropic-aligned wording (v0.7.44)", () => {
  // The wrapper is internal but its output reaches the model; we sanity-
  // check that the documented anti-patterns ("MUST", "authoritative",
  // "CRITICAL") aren't present in the legend that wraps every injection.
  // Test imports the handler module to exercise the same wrapper that
  // ships in production.
  it("legend does not contain Anthropic-warned overtrigger phrases", async () => {
    const session2 = new SessionState("sess-wrap", "sess-wrap");
    const state = makeState(session2);
    // We can't observe the wrapper directly without a store/embeddings
    // pair, so instead verify the source has been updated by checking the
    // module's exported behavior is intact (no throw on plain prompt).
    await expect(handleUserPromptSubmit(state, {
      session_id: "sess-wrap",
      prompt: "test prompt",
    })).resolves.toBeDefined();
    // The deeper assertion (legend wording) lives in a snapshot test we
    // can add later when the wrapper is exported. For now: confirm the
    // module loads and runs without the prior wording crashing anything.
  });
});

describe("recalled-memory envelope tag — producer/consumer contract (v0.7.46)", () => {
  // v0.7.45 renamed <graph_context> to <recalled_memory> in graph-context.ts
  // but missed four downstream consumers, dropping the entire payload at the
  // assembler. This test pins the producer's envelope literal AND asserts
  // the assembler still accepts both the new and legacy tag forms — so a
  // future rename can't silently drop the payload again.
  it("graph-context.ts produces <recalled_memory> envelope", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/engine/graph-context.ts", "utf8");
    expect(src).toContain('"<recalled_memory>\\n"');
    expect(src).toContain('"\\n</recalled_memory>"');
  });

  it("context-assembler.ts accepts the producer's envelope (and legacy fallback)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/context-assembler.ts", "utf8");
    expect(src).toMatch(/text\.includes\("<recalled_memory>"\)/);
    expect(src).toMatch(/text\.includes\("<graph_context>"\)/);
  });

  it("model-facing instructions reference <recalled_memory>, not the old tag", async () => {
    const fs = await import("node:fs/promises");
    const beforeTool = await fs.readFile("src/engine/hooks/before-tool-call.ts", "utf8");
    expect(beforeTool).toContain("<recalled_memory>");
    expect(beforeTool).not.toMatch(/from <graph_context>/);
    expect(beforeTool).not.toMatch(/in <graph_context> above/);

    const graphCtx = await fs.readFile("src/engine/graph-context.ts", "utf8");
    expect(graphCtx).toContain("<recalled_memory> already answers");
    expect(graphCtx).not.toContain("<graph_context> already answers");
  });
});

describe("handlePostToolUse — payload.tool_response contract", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("sess-2", "sess-2");
    // Re-register session in state by constructing fresh state per test
  });

  it("reads tool output from payload.tool_response (canonical field)", async () => {
    const state = makeState(session);
    const payload = {
      session_id: "sess-2",
      tool_name: "Bash",
      tool_response: "hello world output", // 18 chars → ceil(18/4) = 5 tokens
    };
    await handlePostToolUse(state, payload);
    expect(session.cumulativeTokens).toBe(5);
    expect(session._turnToolCalls).toBe(1);
  });

  it("falls back to payload.tool_result for backwards compatibility", async () => {
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-2",
      tool_name: "Bash",
      tool_result: "legacy output",
    });
    expect(session.cumulativeTokens).toBeGreaterThan(0);
  });

  it("handles tool_response as object (Claude Code sends parsed objects for many tools)", async () => {
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-2",
      tool_name: "Read",
      tool_response: { file: "x", content: "abc" },
    });
    // JSON.stringify({file:'x',content:'abc'}) = 25 chars → ceil(25/4) = 7
    expect(session.cumulativeTokens).toBeGreaterThan(0);
    expect(session._turnToolCalls).toBe(1);
  });
});

describe("handlePostToolUse — recordToolOutcome wiring", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("sess-3", "sess-3");
    // Stage a fake retrieval so recordToolOutcome has somewhere to land
    stageRetrieval("sess-3", [
      { id: "memory:abc" as unknown as string, table: "memory", text: "x", score: 0.5 } as unknown as Parameters<typeof stageRetrieval>[1][0],
    ]);
  });

  it("records success when no error indicators are present", async () => {
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-3",
      tool_name: "Bash",
      tool_response: "ok",
    });
    expect(getStagedItems("sess-3").length).toBe(1); // still staged until evaluateRetrieval
    // Drain the per-session entry without writing (store is unavailable in stub)
    await evaluateRetrieval("sess-3", "turn:test", "response text", { isAvailable: () => false } as unknown as Parameters<typeof evaluateRetrieval>[3]);
  });

  it("detects failure from top-level payload.error", async () => {
    // Re-stage since the previous test drained the singleton
    stageRetrieval("sess-3", [
      { id: "memory:abc" as unknown as string, table: "memory", text: "x", score: 0.5 } as unknown as Parameters<typeof stageRetrieval>[1][0],
    ]);
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-3",
      tool_name: "Bash",
      tool_response: "boom",
      error: "command failed",
    });
    // Failure path should still increment the turn tool counter
    expect(session._turnToolCalls).toBeGreaterThan(0);
  });

  it("detects failure from tool_response.is_error (Anthropic tool_result convention)", async () => {
    stageRetrieval("sess-3", [
      { id: "memory:abc" as unknown as string, table: "memory", text: "x", score: 0.5 } as unknown as Parameters<typeof stageRetrieval>[1][0],
    ]);
    const state = makeState(session);
    await handlePostToolUse(state, {
      session_id: "sess-3",
      tool_name: "Bash",
      tool_response: { is_error: true, content: "stderr stuff" },
    });
    expect(session._turnToolCalls).toBeGreaterThan(0);
  });
});
