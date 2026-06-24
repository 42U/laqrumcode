/**
 * Regression: a fresh laqrumcode install must be able to provision its graph.
 *
 * SurrealDB 3.1.x (the 2026-06-12 engine cutover) stopped lazily creating a
 * namespace/database on first write OR DDL. SurrealStore.connect() only SELECTS
 * the ns/db context — so a brand-new install, or a 2nd OS user's fresh
 * UID-offset managed instance (GH #13), hit "The namespace '<ns>' does not
 * exist" inside initialize()→runSchema() and could never bootstrap a graph.
 * Existing/migrated graphs were unaffected (their ns/db already existed), which
 * masked it. Fix: runSchema() now issues idempotent DEFINE NAMESPACE/DATABASE.
 *
 * This test points SurrealStore at a BRAND-NEW (ns, db) that is intentionally
 * NOT pre-provisioned — the exact fresh-install path. It distinguishes "no DB
 * reachable" (legitimate skip, e.g. CI with no SurrealDB) from "DB reachable but
 * provisioning failed" (a hard FAIL — masking that distinction is what let the
 * original bug ship green).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const HTTP = URL.replace(/^ws/, "http").replace(/\/rpc$/, "");
const NS = `kctest_prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const DB = "mem";

let dbReachable = false;
let store: SurrealStore | undefined;

beforeAll(async () => {
  // /version needs no auth. Reachable → the provisioning assertion is binding;
  // unreachable (CI) → the single test self-skips. Never the reverse.
  try {
    const r = await Promise.race([
      fetch(`${HTTP}/version`),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    dbReachable = r.ok || r.status < 500;
  } catch {
    dbReachable = false;
  }
}, 15_000);

afterAll(async () => {
  try { if (store) await store.queryExec(`REMOVE NAMESPACE ${NS}`); } catch { /* best-effort cleanup */ }
  try { if (store) await store.dispose(); } catch { /* ok */ }
}, 15_000);

describe("fresh-install provisioning (3.1.x: DEFINE NS/DB in runSchema)", () => {
  it("initialize() provisions a brand-new namespace+database on the live engine", async () => {
    if (!dbReachable) {
      // eslint-disable-next-line no-console
      console.warn("no SurrealDB reachable — skipping fresh-provision regression");
      return;
    }
    store = new SurrealStore({
      url: URL,
      get httpUrl() { return HTTP; },
      user: USER,
      pass: PASS,
      ns: NS,
      db: DB,
    });
    // Pre-fix this rejected with "The namespace '<NS>' does not exist".
    await expect(store.initialize()).resolves.toBe(true);
    // The provisioned graph must be usable end-to-end, not just defined.
    await store.queryExec(
      `CREATE concept:fresh SET content = 'provisioned', stability = 1.0, confidence = 1.0, access_count = 0`,
    );
    const c = await store.queryBatch<{ c: number }>([`SELECT count() AS c FROM concept GROUP ALL`]);
    expect(c?.[0]?.[0]?.c).toBe(1);
  }, 40_000);
});
