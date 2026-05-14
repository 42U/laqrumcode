/**
 * introspect verifyAction — secret redaction regression tests (Round 6).
 *
 * R5 added SECRET_PATTERNS masking to verifyAction's serializer plus a
 * deepRedact pass for nested objects/arrays. R6 pins that behaviour so
 * a future refactor cannot silently regress and leak a token through
 * either the text output or the details.record structure.
 *
 * Two angles covered here:
 *  1. Non-USER_CONTENT string fields (e.g. a custom "note" column) — the
 *     text serializer must apply SECRET_PATTERNS before truncation so a
 *     ghp_/sk-ant token sitting in any string is masked.
 *  2. Tokens buried inside soul.revisions[] array of objects — deepRedact
 *     walks the structure and masks string leaves regardless of depth.
 */

import { describe, it, expect, vi } from "vitest";
import { createIntrospectToolDef } from "../src/engine/tools/introspect.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

function makeState(record: Record<string, unknown>) {
  // verifyAction issues a single `SELECT * FROM <id>` and we hand back the
  // planted row. queryFirst is the only store method involved.
  const queryFirst = vi.fn().mockImplementation(async (_sql: string) => {
    return [record];
  });
  const state: Partial<GlobalPluginState> = {
    store: {
      isAvailable: () => true,
      queryFirst,
      relate: vi.fn(async () => {}),
    } as any,
  };
  const session: Partial<SessionState> = { sessionId: "test-session" };
  return { state, session };
}

// A long enough token to satisfy the SECRET_PATTERNS length requirements
// (most patterns demand at least 20-40 trailing chars after the prefix).
const GHP_TOKEN = "ghp_" + "A".repeat(40);
const SK_ANT_TOKEN = "sk-ant-" + "B".repeat(50);

describe("introspect verify — non-USER_CONTENT field redaction", () => {
  it("masks ghp_ tokens in a non-USER_CONTENT string field (text output)", async () => {
    const { state, session } = makeState({
      // `note` is not in USER_CONTENT_FIELDS — it follows the "other string"
      // serializer path which must still apply SECRET_PATTERNS before the
      // 300-char truncation.
      note: `here is the token ${GHP_TOKEN} please rotate it`,
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", {
      action: "verify",
      record_id: "memory:abc",
    });

    const text = result?.content?.[0]?.text ?? "";
    expect(text).not.toContain(GHP_TOKEN);
    expect(text).toContain("[redacted-secret-pattern]");
  });

  it("masks sk-ant tokens regardless of field name", async () => {
    const { state, session } = makeState({
      operator_hint: `anthropic key ${SK_ANT_TOKEN} pasted by mistake`,
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", {
      action: "verify",
      record_id: "memory:abc",
    });

    const text = result?.content?.[0]?.text ?? "";
    expect(text).not.toContain(SK_ANT_TOKEN);
    expect(text).toContain("[redacted-secret-pattern]");
  });
});

describe("introspect verify — nested object/array redaction", () => {
  it("redacts a token planted deep inside soul.revisions[]", async () => {
    const { state, session } = makeState({
      // Simulates a soul row with a nested revisions array of objects, one
      // of which carries a pasted token in a free-form field. deepRedact
      // must walk the structure and mask the leaf string.
      revisions: [
        { rev: 1, note: "initial draft" },
        { rev: 2, note: `accidentally pasted ${GHP_TOKEN} into the diff` },
        { rev: 3, note: "second pass" },
      ],
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", {
      action: "verify",
      record_id: "soul:42",
    });

    // The structured details.record is what tooling consumes; assert the
    // token does not appear in its JSON serialization regardless of where
    // it sat in the nested structure.
    const serialized = JSON.stringify(result?.details ?? {});
    expect(serialized).not.toContain(GHP_TOKEN);
    expect(serialized).toContain("[redacted-secret-pattern]");
  });

  it("redacts tokens inside a deeply-nested object (audit_log.entries[].details)", async () => {
    const { state, session } = makeState({
      audit_log: {
        entries: [
          { actor: "user", action: "paste", details: { extra: `token=${SK_ANT_TOKEN}` } },
        ],
      },
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", {
      action: "verify",
      record_id: "concept:42",
    });

    const serialized = JSON.stringify(result?.details ?? {});
    expect(serialized).not.toContain(SK_ANT_TOKEN);
    expect(serialized).toContain("[redacted-secret-pattern]");
  });

  it("redacts a token sitting inside an array of strings (plain leaves)", async () => {
    const { state, session } = makeState({
      tags: ["benign-tag", `leaked ${GHP_TOKEN}`, "another-tag"],
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", {
      action: "verify",
      record_id: "memory:abc",
    });

    const serialized = JSON.stringify(result?.details ?? {});
    expect(serialized).not.toContain(GHP_TOKEN);
    expect(serialized).toContain("[redacted-secret-pattern]");
  });
});

describe("introspect verify — VERIFY_SENSITIVE_FIELDS column strip", () => {
  it("replaces cleanup_claim_token with [redacted] placeholder", async () => {
    const { state, session } = makeState({
      name: "ok",
      cleanup_claim_token: "secret-token-value-do-not-leak",
    });
    const tool = createIntrospectToolDef(state as GlobalPluginState, session as SessionState);
    const result = await tool.execute("test", {
      action: "verify",
      record_id: "memory:abc",
    });

    const text = result?.content?.[0]?.text ?? "";
    const serialized = JSON.stringify(result?.details ?? {});
    expect(text).not.toContain("secret-token-value-do-not-leak");
    expect(serialized).not.toContain("secret-token-value-do-not-leak");
    expect(text).toContain("[redacted]");
  });
});
