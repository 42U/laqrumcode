/**
 * Regression test for fix [K5] (+ [K43] cohort-alignment guard).
 *
 * [K5] ingestTurn embedded the turn text BEFORE calling upsertTurn, inside the
 * same try-block whose catch only logged. So a transient embed failure (model
 * not warm, OOM, an over-window text) threw out to the outer catch BEFORE
 * upsertTurn ran — the conversation turn row was never written and was lost
 * forever. This is a deterministic data-loss bug: it hits 100% of installs on
 * any turn where embed() throws.
 *
 * The fix wraps ONLY the embed call so failure degrades to a null embedding;
 * upsertTurn then stores an un-embedded row and the maintenance turn-backfill
 * (WHERE embedding IS NONE) heals it later.
 *
 * This test would FAIL against the pre-fix code: with a throwing embeddings
 * service, upsertTurn was never invoked, so the assertion that it WAS called
 * (with embedding: null) fails.
 *
 * [K43] also lowered the ingest embed slice from 22,282 → 6,000 chars so the
 * live-ingest cohort embeds the SAME prefix the maintenance backfill uses
 * (surreal.ts documents 6000 as the safe BGE-M3 window target). A static-source
 * assertion guards against a regression back to the over-window limit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Privacy layer → identity pass-through so ingestTurn reaches the embed/store
// path. (Not the subject under test; we only need it not to early-return.)
vi.mock("../src/engine/redact.js", () => ({
  loadPrivacyConfig: () => ({ redactPatterns: [], ignoredProjects: [] }),
  redactSecrets: (text: string) => text,
  isIgnoredProject: () => false,
}));

// upsertAndLinkConcepts is a fire-and-forget (unawaited) call inside ingestTurn;
// stub it so the test doesn't touch the real concept-extraction path.
vi.mock("../src/engine/concept-extract.js", () => ({
  upsertAndLinkConcepts: vi.fn(async () => {}),
}));

// Quiet the log module.
vi.mock("../src/engine/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ingestTurn } from "../src/context-assembler.js";

interface UpsertCall {
  role: string;
  text: string;
  embedding: number[] | null;
}

function makeFakes(opts: { embedThrows: boolean }) {
  const upsertCalls: UpsertCall[] = [];
  const store = {
    isAvailable: () => true,
    upsertTurn: vi.fn(async (rec: UpsertCall) => {
      upsertCalls.push({ role: rec.role, text: rec.text, embedding: rec.embedding });
      return "turn:test123";
    }),
    relate: vi.fn(() => ({ catch: () => {} })),
  };
  const embeddings = {
    isAvailable: () => true,
    embed: vi.fn(async (_t: string) => {
      if (opts.embedThrows) throw new Error("Input is longer than the context size");
      return [0.1, 0.2, 0.3];
    }),
  };
  const state = { store, embeddings } as any;
  const session = {
    sessionId: "sess-1",
    surrealSessionId: "",
    projectId: "proj-1",
    taskId: "task-1",
    lastUserTurnId: "",
    lastAssistantTurnId: "",
    lastUserEmbedding: null,
    userTurnCount: 0,
  } as any;
  return { state, session, store, embeddings, upsertCalls };
}

describe("[K5] ingestTurn: embed failure degrades to null embedding, turn still stored", () => {
  beforeEach(() => vi.clearAllMocks());

  it("still calls upsertTurn (with embedding=null) when embed() throws", async () => {
    const { state, session, store, upsertCalls } = makeFakes({ embedThrows: true });

    await ingestTurn(state, session, "user", "a".repeat(50));

    // The crux: the turn row is written DESPITE the embed throwing.
    expect(store.upsertTurn).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].embedding).toBeNull();
    expect(upsertCalls[0].role).toBe("user");
    // Turn-id wiring proceeded → downstream attribution stays intact.
    expect(session.lastUserTurnId).toBe("turn:test123");
    expect(session.userTurnCount).toBe(1);
  });

  it("stores the real embedding on the happy path (no regression)", async () => {
    const { state, session, store, upsertCalls } = makeFakes({ embedThrows: false });

    await ingestTurn(state, session, "user", "a".repeat(50));

    expect(store.upsertTurn).toHaveBeenCalledTimes(1);
    expect(upsertCalls[0].embedding).toEqual([0.1, 0.2, 0.3]);
    // user embedding is stashed for retrieval reuse
    expect(session.lastUserEmbedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("does not stash a user embedding when embed failed", async () => {
    const { state, session } = makeFakes({ embedThrows: true });
    await ingestTurn(state, session, "user", "a".repeat(50));
    expect(session.lastUserEmbedding).toBeNull();
  });
});

describe("[K43] ingest embed slice aligns with the maintenance backfill cohort", () => {
  it("ingest embed char limit is the safe 6000-char BGE-M3 window target (not the over-window 22282)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "context-assembler.ts"), "utf-8");
    // The live-ingest slice must match the backfill's documented safe target.
    expect(src).toMatch(/INGEST_EMBED_CHAR_LIMIT\s*=\s*6_?000\b/);
    // And must NOT have reverted to the over-window 22,282.
    expect(src).not.toMatch(/INGEST_EMBED_CHAR_LIMIT\s*=\s*22_?282\b/);
  });
});
