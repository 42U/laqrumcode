/**
 * update_skill behavior test.
 *
 * Proves the tool patches an existing skill AND keeps the vector index in sync
 * — the gap that a raw `UPDATE skill SET body=...` left open (stale embedding
 * matching the old body). Uses a real SurrealStore in a throwaway namespace
 * plus a deterministic fake embedding service so a body change produces a
 * measurably different vector.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { GlobalPluginState } from "../src/engine/state.js";
import { handleUpdateSkill } from "../src/tools/update-skill.js";
import type { EmbeddingService } from "../src/engine/embeddings.js";
import type { KongBrainConfig } from "../src/engine/config.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = `kctest_updskill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const TEST_DB = "updskill";
const SURREAL_URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_USER = process.env.SURREAL_USER ?? "root";
const SURREAL_PASS = process.env.SURREAL_PASS ?? "root";

let store: SurrealStore | undefined;
let state: GlobalPluginState | undefined;

// Deterministic embeddings: vector varies by text so a body change yields a
// different vector (lets us assert the row was actually re-embedded).
// 1024-dim to satisfy the skill table's HNSW vector index; content-dependent
// so a body change yields a different vector.
function vecFor(text: string): number[] {
  const v = new Array(1024).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 1024] += text.charCodeAt(i) + i;
  return v;
}
let embedAvailable = true;
const fakeEmbeddings = {
  isAvailable: () => embedAvailable,
  embed: async (text: string) => (embedAvailable ? vecFor(text) : []),
} as unknown as EmbeddingService;

function makeConfig(): KongBrainConfig {
  return {
    surreal: {
      url: SURREAL_URL,
      get httpUrl() { return SURREAL_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
      user: SURREAL_USER, pass: SURREAL_PASS, ns: TEST_NS, db: TEST_DB,
    },
    embedding: { modelPath: "/dev/null", dimension: 1024 } as any,
    thresholds: { midSessionCleanupThreshold: 25_000 } as any,
    paths: { cacheDir: "/tmp", dataDir: "/tmp" } as any,
  } as unknown as KongBrainConfig;
}

beforeAll(async () => {
  if (SKIP) return;
  store = new SurrealStore(makeConfig().surreal);
  try {
    // 8s connect ceiling: a live SurrealDB connects sub-second locally, so this
    // only bounds the SKIP path when SurrealDB is absent (CI). Kept short to
    // minimize the worker-blocking / CPU-contention footprint that the
    // mcp-handshake cold-start test is sensitive to on the loaded CI matrix.
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SurrealDB timed out")), 8_000)),
    ]);
  } catch (e) {
    console.warn("SurrealDB unavailable, skipping update_skill test:", (e as Error).message);
    store = undefined;
    return;
  }
  state = new GlobalPluginState(makeConfig(), store, fakeEmbeddings);
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE NAMESPACE ${TEST_NS}`); } catch { /* ok */ }
  try { await store.close(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout = 30_000) {
  it(name, async () => { if (SKIP || !store?.isAvailable() || !state) return; await fn(); }, timeout);
}

const sess = { sessionId: "test-update-skill" } as any;

async function seedSkill(name: string, body: string, desc = "seed description") {
  await store!.queryExec(
    `CREATE skill CONTENT { name: $name, description: $desc, body: $body, body_len: $len, embedding: $emb, confidence: 1.0, active: true, source: "test" }`,
    { name, desc, body, len: body.length, emb: vecFor(`${name}: ${desc}\n\n${body}`) },
  );
}
async function getSkill(name: string): Promise<any> {
  const r = await store!.queryFirst<any>(
    `SELECT name, description, body, body_len, embedding, updated_at FROM skill WHERE name = $name LIMIT 1`,
    { name },
  );
  return r[0];
}

describe("update_skill", () => {
  itDb("updates body, body_len, and RE-EMBEDS (vector changes)", async () => {
    const name = `upd-body-${Date.now()}`;
    await seedSkill(name, "Original skill body, comfortably over twenty characters.");
    const before = await getSkill(name);
    const origVec = before.embedding;

    const newBody = "Totally rewritten skill body, also well over twenty characters in length.";
    const res = await handleUpdateSkill(state!, sess, { name, body: newBody });
    const out = JSON.parse(res.content[0].text);

    expect(out.ok).toBe(true);
    expect(out.re_embedded).toBe(true);
    expect(out.fields_updated).toEqual(["body"]);

    const after = await getSkill(name);
    expect(after.body).toBe(newBody);
    expect(after.body_len).toBe(newBody.length);
    expect(after.embedding).not.toEqual(origVec); // index kept in sync
    expect(after.updated_at).toBeTruthy();
  });

  itDb("updates description and steps together", async () => {
    const name = `upd-multi-${Date.now()}`;
    await seedSkill(name, "Body that stays the same across this update call here.");
    const res = await handleUpdateSkill(state!, sess, {
      name, description: "new one-line description", steps: ["step a", "step b"],
    });
    const out = JSON.parse(res.content[0].text);
    expect(out.ok).toBe(true);
    expect(out.fields_updated.sort()).toEqual(["description", "steps"]);

    const after = await getSkill(name);
    expect(after.description).toBe("new one-line description");
  });

  itDb("errors on a skill that does not exist (does not create one)", async () => {
    const res = await handleUpdateSkill(state!, sess, {
      name: "definitely-no-such-skill-xyz", body: "a body that is long enough to pass the guard.",
    });
    expect(res.content[0].text).toMatch(/no skill named/i);
    expect(await getSkill("definitely-no-such-skill-xyz")).toBeUndefined();
  });

  itDb("errors when no mutable field is provided", async () => {
    const name = `upd-empty-${Date.now()}`;
    await seedSkill(name, "Body content here, comfortably over twenty characters long.");
    const res = await handleUpdateSkill(state!, sess, { name });
    expect(res.content[0].text).toMatch(/at least one field/i);
  });

  itDb("rejects a too-short body", async () => {
    const name = `upd-short-${Date.now()}`;
    await seedSkill(name, "Body content here, comfortably over twenty characters long.");
    const res = await handleUpdateSkill(state!, sess, { name, body: "too short" });
    expect(res.content[0].text).toMatch(/at least 20 characters/i);
  });

  itDb("sets embedding=NONE when embeddings unavailable (no stale vector; backfill recomputes)", async () => {
    const name = `upd-noembed-${Date.now()}`;
    await seedSkill(name, "Body content here, comfortably over twenty characters long.");
    embedAvailable = false;
    try {
      const res = await handleUpdateSkill(state!, sess, {
        name, body: "A new body written while the embedding service is unavailable here.",
      });
      const out = JSON.parse(res.content[0].text);
      expect(out.ok).toBe(true);
      expect(out.re_embedded).toBe(false);

      const after = await getSkill(name);
      expect(after.body).toContain("A new body written");
      // embedding cleared to NONE so the maintenance backfill recomputes it —
      // never left as the stale pre-update vector.
      expect(after.embedding == null).toBe(true);
    } finally {
      embedAvailable = true;
    }
  });
});
