/**
 * Tests for commitKnowledge — reflection kind (v0.7.76).
 *
 * Verifies that the new write path:
 *   1. CREATEs a reflection row AND auto-seals the reflects_on edge in one call.
 *   2. Refuses to write when surrealSessionId is missing (architectural anchor
 *      that closes the orphan-reflection bug class).
 *   3. Drops anti-thoroughness reflections (returns no row).
 *   4. Downgrades save-summary / work-completion to importance 3 with no
 *      embedding.
 *   5. Skips writes when cosine similarity > threshold.
 *   6. Honors applyContentFilter: false and dedupCosineThreshold: null
 *      opt-outs (for tests and migrations).
 */

import { describe, it, expect, vi } from "vitest";
import { commitKnowledge } from "../src/engine/commit.js";
import type { GlobalPluginState } from "../src/engine/state.js";

function mockState(opts: {
  embeddingAvailable?: boolean;
  existingDedupScore?: number;
} = {}): GlobalPluginState {
  const { embeddingAvailable = true, existingDedupScore = 0 } = opts;
  let queryFirstCallIdx = 0;
  const store = {
    isAvailable: () => true,
    upsertConcept: vi.fn(async () => "concept:c1"),
    createMemory: vi.fn(async () => "memory:m1"),
    createArtifact: vi.fn(async () => "artifact:a1"),
    relate: vi.fn(async () => {}),
    queryFirst: vi.fn(async (sql: string) => {
      // First queryFirst call inside commitReflection is the dedup SELECT.
      // Second (if reached) is the CREATE.
      queryFirstCallIdx++;
      if (sql.includes("vector::similarity::cosine")) {
        return existingDedupScore > 0 ? [{ score: existingDedupScore }] : [];
      }
      if (sql.includes("CREATE reflection")) {
        return [{ id: "reflection:r1" }];
      }
      return [];
    }),
    clearReflectionCache: vi.fn(() => {}),
  };
  const embeddings = {
    isAvailable: () => embeddingAvailable,
    embed: vi.fn(async () => new Array(1024).fill(0.1)),
  };
  return { store, embeddings } as unknown as GlobalPluginState;
}

describe("commitKnowledge — reflection kind", () => {
  it("happy path: CREATEs row and seals reflects_on edge", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "reflection",
      text: "Pattern: when the user asks 'are you sure?' I re-verify before answering.",
      sessionId: "kc-uuid-1",
      surrealSessionId: "session:s1",
      category: "session_review",
      severity: "minor",
    });
    expect(result.id).toBe("reflection:r1");
    expect(result.edges).toBe(1);
    expect((state.store as any).relate).toHaveBeenCalledWith("reflection:r1", "reflects_on", "session:s1");
    expect((state.store as any).clearReflectionCache).toHaveBeenCalled();
  });

  it("drops anti-thoroughness reflections (no row created)", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "reflection",
      text: "I should have moved on faster instead of going deeper on that point.",
      sessionId: "kc-uuid-1",
      surrealSessionId: "session:s1",
    });
    expect(result.id).toBe("");
    expect(result.edges).toBe(0);
    // No CREATE, no relate.
    const createCalls = (state.store as any).queryFirst.mock.calls
      .filter((c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE reflection"));
    expect(createCalls.length).toBe(0);
    expect((state.store as any).relate).not.toHaveBeenCalled();
  });

  it("downgrades save-summary text to importance 3 with no embedding", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "reflection",
      text: "All saved. Quoted IDs from this turn's tool responses below.",
      sessionId: "kc-uuid-1",
      surrealSessionId: "session:s1",
    });
    expect(result.id).toBe("reflection:r1");
    expect(result.edges).toBe(1);
    // Embedding should be skipped on downgraded rows.
    expect((state.embeddings as any).embed).not.toHaveBeenCalled();
    // The CREATE call should carry importance: 3 in the bound record.
    const createCall = (state.store as any).queryFirst.mock.calls
      .find((c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE reflection"));
    expect(createCall).toBeDefined();
    expect(createCall![1].record.importance).toBe(3.0);
    expect(createCall![1].record.embedding).toBeUndefined();
  });

  it("skips write when cosine dedup score exceeds threshold", async () => {
    const state = mockState({ existingDedupScore: 0.9 });
    const result = await commitKnowledge(state, {
      kind: "reflection",
      text: "Clean reflection text that would otherwise pass the filter.",
      sessionId: "kc-uuid-1",
      surrealSessionId: "session:s1",
    });
    expect(result.id).toBe("");
    expect(result.edges).toBe(0);
    const createCalls = (state.store as any).queryFirst.mock.calls
      .filter((c: any[]) => typeof c[0] === "string" && c[0].includes("CREATE reflection"));
    expect(createCalls.length).toBe(0);
  });

  it("throws when surrealSessionId is missing (defense in depth)", async () => {
    const state = mockState();
    await expect(
      commitKnowledge(state, {
        kind: "reflection",
        text: "Clean reflection text.",
        sessionId: "kc-uuid-1",
        // @ts-expect-error testing runtime guard for JS callers
        surrealSessionId: "",
      }),
    ).rejects.toThrow(/surrealSessionId is required/);
  });

  it("applyContentFilter: false bypasses anti-thoroughness drop", async () => {
    const state = mockState();
    const result = await commitKnowledge(state, {
      kind: "reflection",
      text: "I should have moved on faster (this text would normally be dropped).",
      sessionId: "kc-uuid-1",
      surrealSessionId: "session:s1",
      applyContentFilter: false,
    });
    expect(result.id).toBe("reflection:r1");
    expect(result.edges).toBe(1);
  });

  it("dedupCosineThreshold: null bypasses dedup even with score 0.9", async () => {
    const state = mockState({ existingDedupScore: 0.9 });
    const result = await commitKnowledge(state, {
      kind: "reflection",
      text: "Clean reflection text.",
      sessionId: "kc-uuid-1",
      surrealSessionId: "session:s1",
      dedupCosineThreshold: null,
    });
    expect(result.id).toBe("reflection:r1");
    expect(result.edges).toBe(1);
  });
});
