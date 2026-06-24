/**
 * R8 — causal_graduate claim is BOUNDED and has failure-recovery.
 *
 * K31 (commit 26ea0b0) moved the graduation watermark to FETCH time:
 * buildWorkPayload stamps `graduated_at = time::now()` on the ungraduated
 * high-confidence chains and the commit handler no longer re-stamps. Two
 * regressions that introduced:
 *
 *   1. The claim had NO LIMIT — it stamped the ENTIRE ungraduated backlog of
 *      every eligible type in one shot. A single transient fetch→synth→commit
 *      failure then stranded the whole backlog permanently (chains consumed,
 *      never re-tried).
 *   2. There was NO un-stamp path. A failed or no-op (zero-skill) commit left
 *      the claimed chains stamped forever.
 *
 * Fix:
 *   - Bound the per-fetch claim (SELECT … LIMIT $cap, then claim WHERE id IN …
 *     — SurrealDB rejects LIMIT on UPDATE). One failure strands at most CAP
 *     chains; the rest re-trigger on the next fetch.
 *   - Persist the won chain ids on the work item (`won_chain_ids`); on a failed
 *     OR no-op commit, reset them to graduated_at = NONE so a later item retries.
 *
 * The mock-store behavioral test for the no-op-commit un-stamp FAILS against the
 * pre-fix commitResults, which returned `{ skills_created: 0 }` with no
 * un-stamp. Source-wiring tests pin the bounded claim + recovery shape. A live
 * itDb test exercises the real fetch→persist→unstamp round-trip end to end.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleCommitWorkResults, handleFetchPendingWork } from "../src/tools/pending-work.js";
import { SurrealStore } from "../src/engine/surreal.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const sess = {} as unknown as SessionState;
const SRC = readFileSync(join(__dirname, "..", "src", "tools", "pending-work.ts"), "utf-8");

// ── Behavioral: no-op commit un-stamps the claimed chains ─────────────────────
describe("R8 — a no-op (zero-skill) causal_graduate commit un-stamps its chains", () => {
  const WON = ["causal_chain:r8a", "causal_chain:r8b", "causal_chain:r8c"];

  function makeState() {
    let unstampSql = "";
    let markTerminalCalls = 0;
    const queryFirst = vi.fn(async (sql: string) => {
      if (sql.includes('status = "committing"') && sql.includes("RETURN BEFORE")) {
        // CAS — claim won, return the row WITH the persisted won_chain_ids.
        return [{ id: "pending_work:r8w", work_type: "causal_graduate", session_id: "sess-r8", won_chain_ids: WON }];
      }
      if (sql.includes('committing_token')) return [{ id: "pending_work:r8w" }]; // stillOwned
      return [];
    });
    const queryMulti = vi.fn(async (sql: string) => {
      if (sql.includes("graduated_at = NONE")) { unstampSql = sql; return { n: WON.length }; }
      // markTerminal
      markTerminalCalls++;
      return { changed: 1, archived: 0 };
    });
    const state = {
      store: { isAvailable: () => true, queryFirst, queryMulti, queryExec: vi.fn(async () => undefined) },
      embeddings: { isAvailable: () => false },
    } as unknown as GlobalPluginState;
    return { state, getUnstampSql: () => unstampSql, queryMulti, getMarkTerminalCalls: () => markTerminalCalls };
  }

  it("resets graduated_at = NONE on exactly the claimed chain ids when synthesis yields []", async () => {
    const { state, getUnstampSql } = makeState();
    // results = [] → parseCausalGraduationResult → 0 skills → created === 0.
    const res = await handleCommitWorkResults(state, sess, { work_id: "pending_work:r8w", results: "[]" });
    const out = JSON.parse(res.content[0].text);
    expect(out.success).toBe(true);
    expect(out.skills_created).toBe(0);

    const sql = getUnstampSql();
    expect(sql).toContain("UPDATE causal_chain SET graduated_at = NONE");
    expect(sql).toContain("graduated_at IS NOT NONE"); // idempotent: only re-open still-claimed rows
    for (const id of WON) expect(sql).toContain(id); // ids interpolated, not bound
  });

  it("does NOT un-stamp when at least one skill was created (chains genuinely graduated)", async () => {
    const { state, getUnstampSql } = makeState();
    const skill = { name: "s1", description: "d", steps: [{ tool: "Bash", description: "x" }] };
    await handleCommitWorkResults(state, sess, { work_id: "pending_work:r8w", results: JSON.stringify([skill]) });
    expect(getUnstampSql()).toBe(""); // un-stamp never fired
  });
});

// ── Source wiring (survives a refactor) ───────────────────────────────────────
describe("R8 — bounded claim + failure-recovery wiring", () => {
  it("the per-fetch claim is bounded (SELECT … LIMIT before the UPDATE claim)", () => {
    // SurrealDB rejects LIMIT on UPDATE; the bound is a candidate SELECT … LIMIT.
    expect(SRC).toMatch(/SELECT id FROM causal_chain[\s\S]*?graduated_at IS NONE[\s\S]*?LIMIT \$cap/);
    expect(SRC).toMatch(/const CLAIM_CAP = \d+/);
    // The claim UPDATE narrows to the candidate ids.
    expect(SRC).toMatch(/UPDATE causal_chain SET graduated_at = time::now\(\)[\s\S]*?id IN \[\$\{candidateIds\.join/);
  });

  it("the K31 claim shape (RETURN BEFORE on graduated_at IS NONE) is preserved", () => {
    expect(SRC).toMatch(/UPDATE causal_chain SET graduated_at = time::now\(\)[\s\S]*?graduated_at IS NONE[\s\S]*?RETURN BEFORE/);
  });

  it("won chain ids are persisted on the work item for recovery", () => {
    expect(SRC).toMatch(/won_chain_ids = \$ids/);
    expect(SRC).toMatch(/item\.won_chain_ids = wonChainIds/);
  });

  it("a thrown synthesis (commit catch) and a zero-skill commit both un-stamp", () => {
    // Catch path: causal_graduate failure resets the claimed chains.
    expect(SRC).toMatch(/if \(item\.work_type === "causal_graduate"\)[\s\S]*?unstampGraduatedChains/);
    // No-op path: created === 0 resets them.
    expect(SRC).toMatch(/if \(created === 0\)[\s\S]*?unstampGraduatedChains/);
    // The un-stamp helper exists and only re-opens still-claimed rows.
    expect(SRC).toMatch(/async function unstampGraduatedChains/);
  });
});

// ── Live round-trip (itDb-gated; skips with no DB) ────────────────────────────
const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "laqrum_test";
const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const DB = `r8_${STAMP}`;
const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "schema.surql");

let store: SurrealStore | undefined;

beforeAll(async () => {
  store = new SurrealStore({
    url: URL,
    get httpUrl() { return URL.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", ""); },
    user: USER, pass: PASS, ns: TEST_NS, db: DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 10_000)),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping R8 live tests:", (e as Error).message);
    store = undefined;
    return;
  }
  await store.queryExec(await readFile(SCHEMA, "utf8"));
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 20_000);

function itDb(name: string, fn: () => Promise<void>, t = 30_000) {
  it(name, async () => { if (!store) return; await fn(); }, t);
}

describe("R8 — live fetch claim bounds + persists, no-op commit re-opens", () => {
  itDb("a bounded fetch claim stamps graduated_at, persists won_chain_ids, and a no-op commit resets them", async () => {
    const s = store!;
    // Seed 5 high-confidence, ungraduated 'debug' chains (>= the cnt>=3 bar).
    // causal_chain requires session_id / trigger_memory / outcome_memory (all
    // non-optional strings in schema.surql) — populate them or the CREATE
    // coercion fails.
    for (let i = 0; i < 5; i++) {
      await s.queryExec(
        `CREATE causal_chain SET session_id = "r8sess", trigger_memory = $t, outcome_memory = $o,
           chain_type = "debug", success = true, confidence = 0.9, description = $d, graduated_at = NONE`,
        { t: `trigger ${i}`, o: `outcome ${i}`, d: `chain ${i}` },
      );
    }
    // Enqueue a causal_graduate work item.
    await s.queryExec(`CREATE pending_work:r8live SET work_type = "causal_graduate", session_id = "r8sess", status = "pending", priority = 7`);

    const state = {
      store: s,
      embeddings: { isAvailable: () => false, embed: async () => [] },
    } as unknown as GlobalPluginState;

    // Fetch → claims the chains (graduated_at stamped) and returns a payload.
    const fetched = await handleFetchPendingWork(state, sess, {});
    const payload = JSON.parse(fetched.content[0].text);
    expect(payload.work_type).toBe("causal_graduate");
    expect(payload.empty).not.toBe(true);

    // All 5 should now be claimed (stamped) since 5 < CLAIM_CAP.
    const stamped = await s.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM causal_chain WHERE graduated_at IS NOT NONE GROUP ALL`,
    );
    expect(stamped[0]?.n ?? 0).toBe(5);

    // won_chain_ids must be persisted on the work row for recovery.
    const rows = await s.queryFirst<{ won_chain_ids?: unknown[] }>(`SELECT won_chain_ids FROM pending_work:r8live`);
    expect(Array.isArray(rows[0]?.won_chain_ids)).toBe(true);
    expect((rows[0]!.won_chain_ids as unknown[]).length).toBe(5);

    // Commit a NO-OP synthesis (empty array) → chains must be re-opened.
    const committed = await handleCommitWorkResults(state, sess, { work_id: "pending_work:r8live", results: "[]" });
    const cout = JSON.parse(committed.content[0].text);
    expect(cout.skills_created).toBe(0);

    const reopened = await s.queryFirst<{ n: number }>(
      `SELECT count() AS n FROM causal_chain WHERE graduated_at IS NONE GROUP ALL`,
    );
    // All 5 back to NONE — re-claimable by a future graduation item.
    expect(reopened[0]?.n ?? 0).toBe(5);
  });
});
