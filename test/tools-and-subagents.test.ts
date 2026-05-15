/**
 * Tests for the 3 LLM-accessible tools (recall, core-memory, introspect).
 *
 * The subagent-lifecycle (OpenClaw gateway) describe blocks were removed in
 * v0.7.74 along with src/engine/hooks/subagent-lifecycle.ts; that file was
 * test-only and targeted a transport (OpenClaw gateway) not shipped from
 * this plugin. Production subagent spawn/stop is handled by
 * src/hook-handlers/pre-tool-use.ts and src/hook-handlers/subagent.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionState } from "../src/engine/state.js";
import { createRecallToolDef } from "../src/engine/tools/recall.js";
import { createCoreMemoryToolDef } from "../src/engine/tools/core-memory.js";

// ── Mock helpers ──

function mockStore() {
  return {
    isAvailable: () => true,
    queryFirst: vi.fn(async () => []),
    queryExec: vi.fn(async () => {}),
    queryBatch: vi.fn(async () => []),
    vectorSearch: vi.fn(async () => [
      { id: "memory:m1", text: "Found a bug in auth", score: 0.85, table: "memory", timestamp: "2026-04-01" },
      { id: "concept:c1", text: "Rate limiting", score: 0.72, table: "concept", timestamp: "2026-03-30" },
    ]),
    graphExpand: vi.fn(async () => [
      { id: "turn:t5", text: "Related discussion", score: 0.6, table: "turn" },
    ]),
    getAllCoreMemory: vi.fn(async () => [
      { id: "core_memory:cm1", text: "Always be concise", tier: 0, category: "rules", priority: 90, session_id: undefined },
    ]),
    createCoreMemory: vi.fn(async () => "core_memory:new1"),
    updateCoreMemory: vi.fn(async () => true),
    deleteCoreMemory: vi.fn(async () => {}),
    relate: vi.fn(async () => {}),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  } as any;
}

function mockState(session: SessionState, storeOverride?: any) {
  const store = storeOverride ?? mockStore();
  return {
    store,
    embeddings: mockEmbeddings(),
    config: { thresholds: {} },
    getSession: (key: string) => key === session.sessionKey ? session : undefined,
    // Real GlobalPluginState.onSessionRemoved returns a disposer. The
    // core-memory tool registers a cleanup callback exactly once per state
    // (via a module-scoped WeakSet), so we just need a callable that returns
    // a disposer function.
    onSessionRemoved: vi.fn((_cb: (sessionId: string) => void) => () => {}),
  } as any;
}

// ── recall tool ──

describe("recall tool", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("test-session", "test-key");
  });

  it("returns search results with scores", async () => {
    const state = mockState(session);
    const tool = createRecallToolDef(state, session);
    const result = await tool.execute("call1", { query: "auth bug" });

    expect(result.content[0].text).toContain("Found");
    expect(result.content[0].text).toContain("auth bug");
    expect(state.store.vectorSearch).toHaveBeenCalled();
    expect(state.embeddings.embed).toHaveBeenCalledWith("auth bug");
  });

  it("returns no-results message when empty", async () => {
    const store = mockStore();
    store.vectorSearch.mockResolvedValue([]);
    store.graphExpand.mockResolvedValue([]);
    const state = mockState(session, store);
    const tool = createRecallToolDef(state, session);

    const result = await tool.execute("call1", { query: "nonexistent" });
    expect(result.content[0].text).toContain("No memories found");
  });

  it("respects limit parameter", async () => {
    const state = mockState(session);
    const tool = createRecallToolDef(state, session);

    await tool.execute("call1", { query: "test", limit: 2 });
    expect(state.store.vectorSearch).toHaveBeenCalledWith(
      expect.any(Array),
      "test-session",
      expect.objectContaining({ turn: 2, concept: 2, memory: 2 }),
    );
  });

  it("caps limit at 15", async () => {
    const state = mockState(session);
    const tool = createRecallToolDef(state, session);

    await tool.execute("call1", { query: "test", limit: 100 });
    expect(state.store.vectorSearch).toHaveBeenCalledWith(
      expect.any(Array),
      "test-session",
      expect.objectContaining({ turn: 15 }),
    );
  });

  it("scopes search to specific type", async () => {
    const state = mockState(session);
    const tool = createRecallToolDef(state, session);

    await tool.execute("call1", { query: "test", scope: "concepts" });
    expect(state.store.vectorSearch).toHaveBeenCalledWith(
      expect.any(Array),
      "test-session",
      expect.objectContaining({ turn: 0, concept: 3, memory: 0, artifact: 0 }),
    );
  });

  it("returns unavailable message when services down", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const state = mockState(session, store);
    const tool = createRecallToolDef(state, session);

    const result = await tool.execute("call1", { query: "test" });
    expect(result.content[0].text).toContain("unavailable");
  });
});

// ── core_memory tool ──

describe("core_memory tool", () => {
  let session: SessionState;

  beforeEach(() => {
    session = new SessionState("test-session", "test-key");
  });

  it("lists core memory entries", async () => {
    const state = mockState(session);
    const tool = createCoreMemoryToolDef(state, session);

    const result = await tool.execute("call1", { action: "list" });
    expect(result.content[0].text).toContain("1 core memory entries");
    expect(result.content[0].text).toContain("Always be concise");
  });

  it("adds a new core memory entry", async () => {
    const state = mockState(session);
    const tool = createCoreMemoryToolDef(state, session);

    const result = await tool.execute("call1", {
      action: "add",
      text: "Always run tests before committing",
      category: "rules",
      priority: 80,
      tier: 0,
    });

    expect(result.content[0].text).toContain("Created core memory");
    expect(state.store.createCoreMemory).toHaveBeenCalledWith(
      "Always run tests before committing", "rules", 80, 0, undefined,
    );
    // Should invalidate cached tier0
    expect(session.injectedSections.has("tier0")).toBe(false);
  });

  it("requires text for add action", async () => {
    const state = mockState(session);
    const tool = createCoreMemoryToolDef(state, session);

    const result = await tool.execute("call1", { action: "add" });
    expect(result.content[0].text).toContain("required");
  });

  it("updates an existing entry", async () => {
    const state = mockState(session);
    const tool = createCoreMemoryToolDef(state, session);

    const result = await tool.execute("call1", {
      action: "update",
      id: "core_memory:cm1",
      text: "Updated text",
      priority: 95,
    });

    expect(result.content[0].text).toContain("Updated core memory");
    expect(state.store.updateCoreMemory).toHaveBeenCalledWith(
      "core_memory:cm1",
      expect.objectContaining({ text: "Updated text", priority: 95 }),
    );
  });

  it("requires id for update/deactivate", async () => {
    const state = mockState(session);
    const tool = createCoreMemoryToolDef(state, session);

    const update = await tool.execute("call1", { action: "update", text: "no id" });
    expect(update.content[0].text).toContain("required");

    const deact = await tool.execute("call2", { action: "deactivate" });
    expect(deact.content[0].text).toContain("required");
  });

  it("deactivates an entry", async () => {
    const state = mockState(session);
    const tool = createCoreMemoryToolDef(state, session);

    const result = await tool.execute("call1", { action: "deactivate", id: "core_memory:cm1" });
    expect(result.content[0].text).toContain("Deactivated");
    expect(state.store.deleteCoreMemory).toHaveBeenCalledWith("core_memory:cm1");
  });

  it("returns unavailable when store is down", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const state = mockState(session, store);
    const tool = createCoreMemoryToolDef(state, session);

    const result = await tool.execute("call1", { action: "list" });
    expect(result.content[0].text).toContain("unavailable");
  });
});
