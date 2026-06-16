/**
 * Live tests for the 2026-06-09 knowledge-write-tool fixes
 * (memory:ety7rj662y98liipw70c — the spec-gem linking incident):
 *
 *  1. link_hierarchy "never reuses" — old 0.7 similarity bar was unreachable;
 *     now: T1 exact-content match → T2 similarity ≥ 0.60 → T3 create with a
 *     near_miss report.
 *  2. supersede collateral decay — a short old_text matching a LONG document
 *     that merely contains it (token-inflated cosine ≥ 0.70) decayed healthy
 *     gems; now: exact-content short-circuit + long-body ratio guard (>4×
 *     old_text length requires ≥ 0.85) + skipped_by_guard reporting.
 *
 * Uses a deterministic FAKE embedder (lookup map → hand-constructed 1024-dim
 * vectors) so pairwise cosines are exact: mix(c) = c·e1 + √(1−c²)·e2 gives
 * cosine(mix, e1) = c precisely. Real DB (kong_test ns), fake vectors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurrealStore } from "../src/engine/surreal.js";
import { handleLinkHierarchy } from "../src/tools/link-hierarchy.js";
import { handleSupersede } from "../src/tools/supersede.js";
import { linkConceptCrossLink } from "../src/engine/commit.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "kong_test";
const TEST_DB = `kwg_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "schema.surql");

const DIM = 1024;
function unit(i: number): number[] { const v = new Array(DIM).fill(0); v[i] = 1; return v; }
/** Vector with EXACT cosine c against unit(base). */
function mix(base: number, other: number, c: number): number[] {
  const v = new Array(DIM).fill(0);
  v[base] = c;
  v[other] = Math.sqrt(1 - c * c);
  return v;
}

/** Deterministic fake embedder: known texts → constructed vectors; anything
 *  else → a far-away default (unit 900). */
const EMBED_MAP = new Map<string, number[]>();
const fakeEmbeddings = {
  isAvailable: () => true,
  embed: async (text: string) => EMBED_MAP.get(text) ?? unit(900),
};

let store: SurrealStore | undefined;
let state: GlobalPluginState;
const session = { sessionId: "kwg-test-session" } as unknown as SessionState;

const callLink = async (parent: string, child: string) => {
  const r = await handleLinkHierarchy(state, session, { parent, child });
  return JSON.parse(r.content[0].text);
};
const callSupersede = async (old_text: string, new_text: string) => {
  const r = await handleSupersede(state, session, { old_text, new_text });
  return JSON.parse(r.content[0].text);
};
async function scalar<T>(sql: string, binds?: Record<string, unknown>): Promise<T | undefined> {
  const r = await store!.queryMulti<unknown>(sql, binds);
  // SurrealDB 3.1.x honors `SELECT VALUE count() ... GROUP ALL` inconsistently:
  // a scanned count unwraps to a bare number, but when a UNIQUE index drives the
  // aggregate it comes back as { count: N }. Normalize so numeric assertions hold
  // regardless of index state (the value is identical; only the wrapper differs).
  if (r !== null && typeof r === "object" && "count" in (r as Record<string, unknown>)) {
    return (r as Record<string, unknown>).count as T;
  }
  return r as T;
}

beforeAll(async () => {
  store = new SurrealStore({
    url: URL,
    get httpUrl() { return URL.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: USER, pass: PASS, ns: TEST_NS, db: TEST_DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SurrealDB connect timeout after 10s")), 10_000)),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping knowledge-write-guards tests:", (e as Error).message);
    store = undefined;
    return;
  }
  await store.queryExec(await readFile(SCHEMA, "utf8"));
  state = { store, embeddings: fakeEmbeddings } as unknown as GlobalPluginState;

  // ── link_hierarchy seeds ──
  // T1 target: exact-content (case/trim-insensitive) reuse.
  await store.queryExec(`CREATE concept:kwg_exact SET content = 'Redis Server', embedding = $e, stability = 1.0`, { e: unit(10) });
  // T2 target: prose concept; anchor phrase embeds at cosine 0.65 vs it.
  await store.queryExec(`CREATE concept:kwg_prose SET content = 'kongcode is a graph-backed persistent memory engine for claude code', embedding = $e, stability = 1.0`, { e: unit(20) });
  EMBED_MAP.set("memory engine for claude", mix(20, 21, 0.65)); // 0.65 ≥ 0.60 → reuse
  EMBED_MAP.set("totally unrelated anchor", mix(30, 31, 0.99)); // far from everything seeded
  EMBED_MAP.set("another fresh anchor", unit(40));

  // ── supersede seeds (the incident shape) ──
  // Stub whose content IS the old_text (exact short-circuit target).
  const SLUG = "ikong-test-spec-v1";
  await store.queryExec(`CREATE concept:kwg_stub SET content = $c, embedding = $e, stability = 1.0`, { c: SLUG, e: unit(50) });
  // Healthy LONG doc that contains the slug verbatim — embeds at cosine 0.75
  // vs the slug vector: above 0.70 (old behavior: collateral decay), below
  // 0.85 (new behavior: guard-skipped).
  const longDoc = `The canonical probe sequence is defined by ${SLUG} and spans gather, analyze, validate phases. `.repeat(4);
  await store.queryExec(`CREATE concept:kwg_longdoc SET content = $c, embedding = $e, stability = 1.0`, { c: longDoc, e: mix(50, 51, 0.75) });
  EMBED_MAP.set(SLUG, unit(50));
  // Guard-only scenario (no exact match anywhere): short-ish stale belief at
  // 0.75 (comparable length → decays) + long doc at 0.75 (→ skipped).
  await store.queryExec(`CREATE concept:kwg_belief SET content = 'daemon uses port 18765 by default', embedding = $e, stability = 1.0`, { e: mix(60, 61, 0.75) });
  const longDoc2 = `Operations runbook: the kongcode daemon historically used port 18765 by default before the UID-offset scheme. `.repeat(4);
  await store.queryExec(`CREATE concept:kwg_longdoc2 SET content = $c, embedding = $e, stability = 1.0`, { c: longDoc2, e: mix(60, 62, 0.75) });
  EMBED_MAP.set("daemon default port is 18765", mix(60, 63, 1.0)); // = unit(60) → cosine 0.75 vs both
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>) {
  it(name, async () => { if (!store) return; await fn(); }, 30_000);
}

describe("link_hierarchy reuse (incident fix)", () => {
  itDb("T1: exact content match reuses (case/trim-insensitive) — pre-fix: stub", async () => {
    const r = await callLink("  redis server ", "memory engine for claude");
    expect(r.parent_reused).toBe(true);
    expect(r.parent_id).toBe("concept:kwg_exact");
  });

  itDb("T2: similarity 0.65 ≥ 0.60 reuses the prose concept — pre-fix: 0.7 bar missed it", async () => {
    const r = await callLink("memory engine for claude", "totally unrelated anchor");
    expect(r.parent_reused).toBe(true);
    expect(r.parent_id).toBe("concept:kwg_prose");
  });

  itDb("T3: genuine miss creates AND reports the near-miss with its score", async () => {
    const r = await callLink("another fresh anchor", "totally unrelated anchor");
    expect(r.parent_reused).toBe(false);
    expect(r.parent_id).toBeTruthy();
    // near-miss visibility: present with a numeric score (the old silent
    // reused:false hid this bug for a month)
    if (r.parent_near_miss) expect(typeof r.parent_near_miss.score).toBe("number");
    expect(r.edges_written).toBeGreaterThan(0);
  });
});

describe("gems retry idempotency (cross-link edges)", () => {
  itDb("linkConceptCrossLink called twice creates exactly ONE edge (retry-safe)", async () => {
    await store!.queryExec(`CREATE concept:kwg_idem_a SET content = 'idem a', embedding = $e, stability = 1.0`, { e: unit(70) });
    await store!.queryExec(`CREATE concept:kwg_idem_b SET content = 'idem b', embedding = $e, stability = 1.0`, { e: unit(71) });
    const r1 = await linkConceptCrossLink({ store: store!, embeddings: fakeEmbeddings as never }, "concept:kwg_idem_a", "concept:kwg_idem_b", "related_to");
    const r2 = await linkConceptCrossLink({ store: store!, embeddings: fakeEmbeddings as never }, "concept:kwg_idem_a", "concept:kwg_idem_b", "related_to");
    expect(r1).toBe(1);
    expect(r2).toBe(1); // idempotent success — NOT a failure report
    const count = await scalar<number>(`SELECT VALUE count() FROM related_to WHERE in = concept:kwg_idem_a AND out = concept:kwg_idem_b GROUP ALL`);
    expect(count ?? 0).toBe(1); // pre-fix: 2 (RELATE duplicates per retry)
  });
});

describe("fresh-concept HNSW visibility (bug-4 probe pinned as test)", () => {
  itDb("a just-created concept is immediately findable by vector search", async () => {
    const v = mix(80, 81, 1.0);
    await store!.queryExec(`CREATE concept:kwg_fresh SET content = 'freshly minted concept', embedding = $e, stability = 1.0`, { e: v });
    const hits = await store!.queryFirst<{ id: string; score: number }>(
      `SELECT id, vector::similarity::cosine(embedding, $v) AS score FROM concept WHERE embedding != NONE ORDER BY score DESC LIMIT 3`,
      { v },
    );
    expect(hits.some((h) => String(h.id) === "concept:kwg_fresh" && (h.score ?? 0) > 0.999)).toBe(true);
  });
});

describe("supersede collateral guard (incident fix)", () => {
  itDb("exact-content short-circuit: slug decays ONLY the stub; the 0.75 long-doc survives untouched", async () => {
    const r = await callSupersede("ikong-test-spec-v1", "superseded by v1.1 spec");
    expect(r.superseded_ids).toContain("concept:kwg_stub");
    expect(r.superseded_ids).not.toContain("concept:kwg_longdoc");
    const stubStab = await scalar<number>(`SELECT VALUE stability FROM concept:kwg_stub`);
    const docStab = await scalar<number>(`SELECT VALUE stability FROM concept:kwg_longdoc`);
    expect(stubStab).toBeLessThan(1.0); // decayed
    expect(docStab).toBe(1.0);          // SURVIVED — pre-fix this was the collateral
  });

  itDb("ratio guard: comparable-length belief decays at 0.75; 4x-longer doc at 0.75 is skipped + reported", async () => {
    const r = await callSupersede("daemon default port is 18765", "daemon now uses UID-offset ports");
    expect(r.superseded_ids).toContain("concept:kwg_belief");
    expect(r.superseded_ids).not.toContain("concept:kwg_longdoc2");
    expect(Array.isArray(r.skipped_by_guard)).toBe(true);
    const skip = (r.skipped_by_guard as Array<{ id: string; reason: string }>).find((s) => s.id === "concept:kwg_longdoc2");
    expect(skip).toBeTruthy();
    expect(skip!.reason).toContain("long-body");
    const beliefStab = await scalar<number>(`SELECT VALUE stability FROM concept:kwg_belief`);
    const doc2Stab = await scalar<number>(`SELECT VALUE stability FROM concept:kwg_longdoc2`);
    expect(beliefStab).toBeLessThan(1.0);
    expect(doc2Stab).toBe(1.0);
  });
});
