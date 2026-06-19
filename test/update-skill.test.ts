/**
 * update_skill handler unit test (mock store + mock embeddings).
 *
 * Verifies the handler builds the correct UPDATE (patched fields + body_len)
 * and ALWAYS keeps the vector index in sync — re-embedding from
 * `${name}: ${description}\n\n${body}`, or clearing to `embedding = NONE` when
 * the embedding service is down so the maintenance backfill recomputes it
 * (never a stale vector). Mock-based by design: a real-SurrealStore variant
 * was dropped because its connect-timeout beforeAll blocked a CI worker long
 * enough to starve the concurrent mcp-handshake subprocess spawn.
 */

import { describe, it, expect, vi } from "vitest";
import { handleUpdateSkill } from "../src/tools/update-skill.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const sess = { sessionId: "test" } as unknown as SessionState;

type Existing = { id: string; description: string; body: string } | undefined;

function makeState(opts: { existing: Existing; embedAvailable?: boolean }) {
  const updateCalls: { sql: string; params: Record<string, unknown> }[] = [];
  let embedArg: string | null = null;
  const embedAvailable = opts.embedAvailable !== false;

  const store = {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql: string, params: Record<string, unknown>) => {
      if (/^\s*SELECT/i.test(sql)) return opts.existing ? [opts.existing] : [];
      if (/^\s*UPDATE/i.test(sql)) {
        updateCalls.push({ sql, params });
        return [{ id: opts.existing?.id ?? "skill:x" }];
      }
      return [];
    }),
  };
  const embeddings = {
    isAvailable: () => embedAvailable,
    embed: vi.fn(async (t: string) => { embedArg = t; return embedAvailable ? new Array(1024).fill(0.1) : []; }),
  };
  const state = { store, embeddings } as unknown as GlobalPluginState;
  return { state, updateCalls, getEmbedArg: () => embedArg, embedFn: embeddings.embed };
}

function parse(res: { content: Array<{ type: "text"; text: string }> }) {
  return res.content[0].text;
}

const EXISTING = { id: "skill:abc", description: "old description", body: "the old body content" };

describe("update_skill handler", () => {
  it("updates body + body_len and re-embeds from name+description+body", async () => {
    const { state, updateCalls, getEmbedArg } = makeState({ existing: { ...EXISTING } });
    const newBody = "Totally rewritten body, well over twenty characters in length here.";
    const out = JSON.parse(parse(await handleUpdateSkill(state, sess, { name: "my-skill", body: newBody })));

    expect(out.ok).toBe(true);
    expect(out.re_embedded).toBe(true);
    expect(out.fields_updated).toEqual(["body"]);
    expect(out.body_length).toBe(newBody.length);

    // Re-embed target mirrors create_skill / the maintenance backfill exactly.
    expect(getEmbedArg()).toBe(`my-skill: old description\n\n${newBody}`);
    const { sql, params } = updateCalls[0];
    expect(sql).toContain("body = $body");
    expect(sql).toContain("body_len = $body_len");
    expect(sql).toContain("embedding = $vec");
    expect(sql).toContain("updated_at = time::now()");
    expect(params.body).toBe(newBody);
    expect(params.body_len).toBe(newBody.length);
  });

  it("updates description + steps together (no body change)", async () => {
    const { state, updateCalls, getEmbedArg } = makeState({ existing: { ...EXISTING } });
    const out = JSON.parse(parse(await handleUpdateSkill(state, sess, {
      name: "my-skill", description: "new desc", steps: ["a", "b"],
    })));
    expect(out.ok).toBe(true);
    expect(out.fields_updated.sort()).toEqual(["description", "steps"]);
    // embed target uses the NEW description and the UNCHANGED existing body.
    expect(getEmbedArg()).toBe("my-skill: new desc\n\nthe old body content");
    expect(updateCalls[0].sql).toContain("description = $description");
    expect(updateCalls[0].sql).toContain("steps = $steps");
  });

  it("errors on a skill that does not exist (no UPDATE issued)", async () => {
    const { state, updateCalls } = makeState({ existing: undefined });
    const res = parse(await handleUpdateSkill(state, sess, { name: "nope", body: "a body long enough to pass the guard." }));
    expect(res).toMatch(/no skill named/i);
    expect(updateCalls.length).toBe(0);
  });

  it("errors when no mutable field is provided", async () => {
    const { state, updateCalls } = makeState({ existing: { ...EXISTING } });
    const res = parse(await handleUpdateSkill(state, sess, { name: "my-skill" }));
    expect(res).toMatch(/at least one field/i);
    expect(updateCalls.length).toBe(0);
  });

  it("rejects a too-short body", async () => {
    const { state } = makeState({ existing: { ...EXISTING } });
    const res = parse(await handleUpdateSkill(state, sess, { name: "my-skill", body: "too short" }));
    expect(res).toMatch(/at least 20 characters/i);
  });

  it("sets embedding=NONE (not a stale vector) when embeddings unavailable", async () => {
    const { state, updateCalls, embedFn } = makeState({ existing: { ...EXISTING }, embedAvailable: false });
    const out = JSON.parse(parse(await handleUpdateSkill(state, sess, {
      name: "my-skill", body: "a new body written while embeddings are down, long enough.",
    })));
    expect(out.ok).toBe(true);
    expect(out.re_embedded).toBe(false);
    expect(embedFn).not.toHaveBeenCalled();
    expect(updateCalls[0].sql).toContain("embedding = NONE");
    expect(updateCalls[0].sql).not.toContain("embedding = $vec");
  });
});
