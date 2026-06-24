/**
 * Semantic dedup defense — skills (consolidate Pass 4) + monologue (write pre-check).
 *
 * Companion to dedup-integration.test.ts. Proves the v0.8.x systemic-dedup fix:
 *
 *  Fix 1 — skill semantic dedup lives in consolidateMemories Pass 4 (OFF the
 *  hot path). Different-named-but-similar skills accumulate as siblings on write
 *  (supersedeOldSkills only collapses EXACT names — the v0.7.92 footgun guard),
 *  and the weekly consolidation pass collapses them at cosine >= 0.92 via
 *  soft-archive (active=false + superseded_by). Distinct skills (cosine < 0.92)
 *  and same-name-on-write behavior are preserved.
 *
 *  Fix 2 — monologue dedups by exact (session_id, category, content) on write,
 *  mirroring createMemory, so re-extraction can't duplicate soul-input traces.
 *
 * Deterministic embeddings: cosine(e0, [C, sqrt(1-C^2), 0...]) == C exactly, so
 * we control similarity precisely without a real embedding model.
 *
 * Isolation: fresh namespace per file (kctest_dsem_<ts>_<rand>); dropped on afterAll.
 * Skip with SKIP_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";
import { commitKnowledge } from "../src/engine/commit.js";
import { findRelevantSkills, smoothedSkillUtility, shouldRecordSkillOutcome, SKILL_ENGAGEMENT_MIN } from "../src/engine/skills.js";
import type { EmbeddingService } from "../src/engine/embeddings.js";
import type { MemoryConfig } from "../src/engine/config.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";
process.env.LAQRUMCODE_AUTO_DRAIN = "0";

const TEST_NS = `kctest_dsem_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const TEST_DB = "dedup";
const SURREAL_URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_USER = process.env.SURREAL_USER ?? "root";
const SURREAL_PASS = process.env.SURREAL_PASS ?? "root";

let store: SurrealStore | undefined;
// isAvailable=false so commitSkill's skill_uses_concept auto-seal
// (linkToRelevantConcepts) skips cleanly — we pass precomputedVec, so no real
// embedding is ever needed, and dedup assertions don't depend on concept edges.
const fakeEmbeddings = { isAvailable: () => false } as unknown as EmbeddingService;

function makeConfig(): MemoryConfig {
  return {
    surreal: {
      url: SURREAL_URL,
      get httpUrl() {
        return SURREAL_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", "");
      },
      user: SURREAL_USER, pass: SURREAL_PASS, ns: TEST_NS, db: TEST_DB,
    },
    embedding: { modelPath: "/dev/null", dimension: 1024 } as any,
    thresholds: { midSessionCleanupThreshold: 25_000 } as any,
    paths: { cacheDir: "/tmp", dataDir: "/tmp" } as any,
  } as unknown as MemoryConfig;
}

const DIM = 1024;
/** Unit vector with a single 1.0 on `axis`. */
function unit(axis: number): number[] {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  return v;
}
/** Unit vector at cosine exactly `c` to unit(axis): [c on axis, sqrt(1-c^2) on axis+1]. */
function atCosine(axis: number, c: number): number[] {
  const v = new Array(DIM).fill(0);
  v[axis] = c;
  v[axis + 1] = Math.sqrt(1 - c * c);
  return v;
}
/** Build a vector by setting specific [index, value] pairs (rest zero). */
function sparseVec(pairs: Array<[number, number]>): number[] {
  const v = new Array(DIM).fill(0);
  for (const [i, x] of pairs) v[i] = x;
  return v;
}

async function commitSkill(name: string, description: string, vec: number[]): Promise<void> {
  await commitKnowledge(
    { store: store!, embeddings: fakeEmbeddings },
    // dedupOnCreate:false so this helper can seed intentional near-dups for the
    // retrieval/consolidation tests; the creation-dedup behavior is tested
    // separately by calling commitKnowledge directly (dedup left on).
    { kind: "skill", name, description, steps: [{ tool: "bash", description: "step" }], precomputedVec: vec, dedupOnCreate: false } as any,
  );
}

/** Direct-create a skill row with explicit success/failure counts + embedding. */
async function seedSkillRow(name: string, description: string, vec: number[], sc: number, fc: number): Promise<void> {
  await store!.queryExec(
    `CREATE skill CONTENT { name: $n, description: $d, steps: [], embedding: $e,
       success_count: $sc, failure_count: $fc, active: true, confidence: 1.0 }`,
    { n: name, d: description, e: vec, sc, fc },
  );
}

async function skillRow(name: string): Promise<{ id: string; active: boolean | null; superseded_by: string | null }[]> {
  const rows = await store!.queryFirst<{ id: string; active: boolean | null; superseded_by: string | null }>(
    `SELECT id, active, superseded_by FROM skill WHERE name = $n`, { n: name },
  );
  return rows as any[];
}
async function activeCount(name: string): Promise<number> {
  const rows = await store!.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM skill WHERE name = $n AND (active = true OR active IS NONE) GROUP ALL`, { n: name },
  );
  return Number((rows as any[])[0]?.n ?? 0);
}

beforeAll(async () => {
  if (SKIP) return;
  store = new SurrealStore(makeConfig().surreal);
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SurrealDB connection timed out")), 15_000)),
    ]);
  } catch (e) {
    console.warn("SurrealDB unavailable, skipping dedup-semantic:", (e as Error).message);
    store = undefined;
  }
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE NAMESPACE ${TEST_NS}`); } catch { /* ok */ }
  try { await store.close(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout = 30_000) {
  it(name, async () => {
    if (SKIP || !store?.isAvailable()) return;
    await fn();
  }, timeout);
}

describe("semantic dedup — skills (Pass 4) + monologue (write)", () => {
  // NOTE: consolidateMemories is baseline-true on first call in a fresh namespace
  // but then records a maintenance_run and the cooldown blocks re-runs (memory
  // count 0 <= floor 10). So the whole skill scenario is set up and asserted
  // around a SINGLE consolidate call in this one test.
  itDb("Pass 4 collapses different-named near-dupes but spares distinct skills; no hot-path collapse", async () => {
    // A & B: different names, cosine 0.95 (>= 0.92). Should collapse in Pass 4.
    await commitSkill("diagnose-silent-failure", "process dies without logging", unit(0));
    await commitSkill("diagnose-silent-process-failure", "a process exits with no log output", atCosine(0, 0.95));
    // C & D: different names, cosine 0.70 (< 0.80 Pass-4 threshold). Should NOT collapse.
    await commitSkill("build-dcf-model", "discounted cash flow valuation", unit(10));
    await commitSkill("build-lbo-model", "leveraged buyout valuation", atCosine(10, 0.70));

    // Anti-regression for v0.7.92: different names are NOT collapsed on the WRITE
    // path — all four are active before consolidation runs.
    expect(await activeCount("diagnose-silent-failure")).toBe(1);
    expect(await activeCount("diagnose-silent-process-failure")).toBe(1);
    expect(await activeCount("build-dcf-model")).toBe(1);
    expect(await activeCount("build-lbo-model")).toBe(1);

    // Run consolidation (Pass 4). embedFn is a stub — Pass 4 reads stored vectors.
    const merged = await store!.consolidateMemories(async () => new Array(DIM).fill(0));
    expect(merged).toBeGreaterThanOrEqual(1);

    // A/B collapsed to exactly one active; C/D both spared.
    const ab = (await activeCount("diagnose-silent-failure")) + (await activeCount("diagnose-silent-process-failure"));
    expect(ab).toBe(1);
    expect(await activeCount("build-dcf-model")).toBe(1);
    expect(await activeCount("build-lbo-model")).toBe(1);

    // The collapsed loser is soft-archived with superseded_by pointing at the keeper
    // (NOT at itself — guards the v0.7.92 self-supersession class).
    const all = [...(await skillRow("diagnose-silent-failure")), ...(await skillRow("diagnose-silent-process-failure"))];
    const keeper = all.find(r => r.active === true || r.active === null)!;
    const loser = all.find(r => r.active === false)!;
    expect(keeper).toBeDefined();
    expect(loser).toBeDefined();
    expect(String(loser.superseded_by)).toBe(String(keeper.id));
    expect(String(loser.superseded_by)).not.toBe(String(loser.id));
  });

  itDb("same-name skills still supersede on write (existing behavior preserved)", async () => {
    // Distinct axis so this scenario can't interact with the Pass-4 test's skills.
    await commitSkill("harden-noisy-loop", "first description", unit(40));
    await commitSkill("harden-noisy-loop", "second, revised description", unit(40));
    // supersedeOldSkills (exact name + cosine >= 0.82) collapses on write → 1 active.
    expect(await activeCount("harden-noisy-loop")).toBe(1);
    const rows = await skillRow("harden-noisy-loop");
    expect(rows.length).toBe(2); // append-only: loser retained, soft-archived
    const loser = rows.find(r => r.active === false)!;
    expect(loser).toBeDefined();
    expect(String(loser.superseded_by)).not.toBe(String(loser.id)); // self-exclusion intact
  });

  itDb("monologue dedups by exact (session, category, content) on write", async () => {
    const sid = "msess-1";
    const v = unit(60);
    const id1 = await store!.createMonologue(sid, "insight", "the daemon must arm the drain timer first", v);
    const id2 = await store!.createMonologue(sid, "insight", "the daemon must arm the drain timer first", v);
    expect(id2).toBe(id1); // re-save returns existing id

    const count = await store!.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM monologue WHERE session_id = $s AND category = $c GROUP ALL`,
      { s: sid, c: "insight" },
    );
    expect(Number((count as any[])[0]?.n ?? 0)).toBe(1);

    // Different content, category, or session → distinct rows.
    await store!.createMonologue(sid, "insight", "a totally different reasoning trace", v);
    await store!.createMonologue(sid, "doubt", "the daemon must arm the drain timer first", v);
    await store!.createMonologue("msess-2", "insight", "the daemon must arm the drain timer first", v);
    const total = await store!.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM monologue GROUP ALL`,
    );
    expect(Number((total as any[])[0]?.n ?? 0)).toBe(4); // 1 (deduped) + 3 distinct
  });

  itDb("findRelevantSkills novelty gate: 3 near-dups + 2 distinct -> 1 from the cluster + both distinct", async () => {
    // Axis region 100+ so this pool is orthogonal to every other test's skills.
    // Query at axis 100. A-cluster: 3 near-identical skills (rel ~0.9 to query,
    // mutual cosine ~0.9998). Distinct: beta (rel 0.85), gamma (rel 0.80), each
    // on its own axis so they're dissimilar to the cluster and each other.
    const query = sparseVec([[100, 1]]);
    await commitSkill("mmr-cluster-alpha-1", "alpha one", sparseVec([[100, 0.90], [101, Math.sqrt(1 - 0.90 * 0.90)]]));
    await commitSkill("mmr-cluster-alpha-2", "alpha two", sparseVec([[100, 0.905], [101, Math.sqrt(1 - 0.905 * 0.905)]]));
    await commitSkill("mmr-cluster-alpha-3", "alpha three", sparseVec([[100, 0.895], [101, Math.sqrt(1 - 0.895 * 0.895)]]));
    await commitSkill("mmr-distinct-beta", "beta distinct", sparseVec([[100, 0.55], [102, Math.sqrt(1 - 0.55 * 0.55)]]));
    await commitSkill("mmr-distinct-gamma", "gamma distinct", sparseVec([[100, 0.45], [103, Math.sqrt(1 - 0.45 * 0.45)]]));

    const got = await findRelevantSkills(query, 3, store!);
    const names = got.map(s => s.name);
    expect(got.length).toBe(3);

    // Pure cosine top-3 would be the three alpha near-dups (rel 0.905/0.90/0.895
    // > beta 0.55 > gamma 0.45). The novelty gate (>=0.72 cosine to a selected
    // skill is skipped) drops the 2nd/3rd alpha (~0.9998 mutual) and reaches the
    // distinct beta/gamma (~0.50/0.41 to the cluster): ONE alpha + both distinct.
    const alphaCount = names.filter(n => n.startsWith("mmr-cluster-alpha")).length;
    expect(alphaCount).toBe(1);
    expect(names).toContain("mmr-distinct-beta");
    expect(names).toContain("mmr-distinct-gamma");
  });

  itDb("findRelevantSkills cross-encoder rerank reorders ahead of cosine (step 2)", async () => {
    // Axis region 200+, orthogonal to every other test's skills.
    const query = sparseVec([[200, 1]]);
    await commitSkill("rr-cosine-favored", "ranks highest by embedding", sparseVec([[200, 0.90], [201, Math.sqrt(1 - 0.90 * 0.90)]]));
    await commitSkill("rr-cross-favored", "lower by embedding but the reranker prefers it", sparseVec([[200, 0.60], [202, Math.sqrt(1 - 0.60 * 0.60)]]));

    // Pure cosine (no rerank): the cosine-favored skill wins the single slot.
    const cosineOnly = await findRelevantSkills(query, 1, store!);
    expect(cosineOnly.map(s => s.name)).toEqual(["rr-cosine-favored"]);

    // Stub cross-encoder strongly prefers the cross-favored skill. Blended:
    // 0.6*0.6 + 0.4*1.0 = 0.76 > 0.6*0.9 + 0.4*0 = 0.54 → it overtakes.
    const rerank = async (_a: string, docs: string[]) => docs.map(d => (d.includes("rr-cross-favored") ? 1.0 : 0.0));
    const reranked = await findRelevantSkills(query, 1, store!, { queryText: "anything", rerank });
    expect(reranked.map(s => s.name)).toEqual(["rr-cross-favored"]);

    // Reranker offline (null) → graceful fallback to cosine order.
    const offline = await findRelevantSkills(query, 1, store!, { queryText: "anything", rerank: async () => null });
    expect(offline.map(s => s.name)).toEqual(["rr-cosine-favored"]);
  });

  itDb("proven-utility nudge demotes a high-failure skill at equal relevance (step 3)", async () => {
    // Axis 300+. Both skills at cosine 0.7 to the query but on distinct secondary
    // axes (so MMR doesn't conflate them). util-clean has a strong record,
    // util-failing a poor one — the smoothed-utility term breaks the tie.
    const query = sparseVec([[300, 1]]);
    await seedSkillRow("util-clean", "clean track record", sparseVec([[300, 0.7], [301, Math.sqrt(1 - 0.49)]]), 5, 0);
    await seedSkillRow("util-failing", "failed often", sparseVec([[300, 0.7], [302, Math.sqrt(1 - 0.49)]]), 1, 9);
    const got = await findRelevantSkills(query, 1, store!);
    expect(got.map(s => s.name)).toEqual(["util-clean"]);
  });

  itDb("commitSkill creation-time dedup: a near-identical new skill reuses the canonical (no new row)", async () => {
    // Axis region 400+, orthogonal to every other test's skills.
    const v1 = sparseVec([[400, 1]]);
    const v2 = sparseVec([[400, 0.97], [401, Math.sqrt(1 - 0.97 * 0.97)]]); // cosine 0.97 to v1 (>= 0.85)
    const r1: any = await commitKnowledge({ store: store!, embeddings: fakeEmbeddings },
      { kind: "skill", name: "create-dedup-canonical", description: "the canonical drain procedure", steps: [], precomputedVec: v1 } as any);
    const r2: any = await commitKnowledge({ store: store!, embeddings: fakeEmbeddings },
      { kind: "skill", name: "create-dedup-twin", description: "the same drain procedure, reworded", steps: [], precomputedVec: v2 } as any);
    // Twin is >= 0.85 to the canonical → reused, NOT created.
    expect(String(r2.id)).toBe(String(r1.id));
    const n = await store!.queryFirst<{ c: number }>(
      `SELECT count() AS c FROM skill WHERE (name='create-dedup-canonical' OR name='create-dedup-twin') AND (active=true OR active IS NONE) GROUP ALL`);
    expect(Number((n as any[])[0]?.c ?? 0)).toBe(1);

    // A genuinely-distinct skill (cosine ~0.5 to the canonical) IS created.
    const v3 = sparseVec([[400, 0.5], [402, Math.sqrt(1 - 0.5 * 0.5)]]);
    const r3: any = await commitKnowledge({ store: store!, embeddings: fakeEmbeddings },
      { kind: "skill", name: "create-dedup-distinct", description: "a different procedure entirely", steps: [], precomputedVec: v3 } as any);
    expect(String(r3.id)).not.toBe(String(r1.id));
  });
});

describe("step 3 helpers (pure)", () => {
  it("smoothedSkillUtility: neutral prior, rewards success, penalizes failure", () => {
    expect(smoothedSkillUtility(0, 0)).toBeCloseTo(0.5, 5);   // unobserved → neutral (no cold-start penalty)
    expect(smoothedSkillUtility(1, 0)).toBeCloseTo(2 / 3, 5); // schema default — barely above neutral
    expect(smoothedSkillUtility(9, 0)).toBeGreaterThan(0.85); // proven
    expect(smoothedSkillUtility(1, 9)).toBeLessThan(0.2);     // mostly failing
    // Monotonic: more failures at equal success ⇒ lower utility.
    expect(smoothedSkillUtility(3, 1)).toBeGreaterThan(smoothedSkillUtility(3, 5));
  });

  it("shouldRecordSkillOutcome: only credits engaged skills with a real tool outcome", () => {
    // no tool outcome → no signal (kills the old `?? true` blanket-success bias)
    expect(shouldRecordSkillOutcome(0.9, null)).toBeNull();
    // reranker offline (engagement null) → no signal
    expect(shouldRecordSkillOutcome(null, true)).toBeNull();
    // engaged below the bar → no signal
    expect(shouldRecordSkillOutcome(SKILL_ENGAGEMENT_MIN - 0.01, true)).toBeNull();
    // engaged + tools succeeded → success
    expect(shouldRecordSkillOutcome(SKILL_ENGAGEMENT_MIN, true)).toEqual({ success: true });
    // engaged + tools failed → failure (failures now actually recorded)
    expect(shouldRecordSkillOutcome(0.95, false)).toEqual({ success: false });
  });
});
