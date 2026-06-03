/**
 * introspect action="stats" — usage/cost report (GH #16 item 3).
 *
 * Three angles:
 *   1. readSpendingStats — pure parser over an auto-drain ndjson fixture
 *      (+ legacy {date,count} file). Asserts today / 7d / 30d bucketing and
 *      malformed-line tolerance. No DB.
 *   2. dirSizeBytes — recursive directory size walk over a temp tree. No DB.
 *   3. statsAction end-to-end against a live kong_test DB: seed `session`
 *      rows with token counts both inside and outside the 7d window, plus a
 *      spending-ledger fixture, and assert the 7d/30d aggregation + budget
 *      math in the structured `details`.
 *
 * The live-DB block uses the same kong_test harness as
 * test/duplicate-row-fix.test.ts and is skipped when SKIP_INTEGRATION=1 or
 * the local SurrealDB isn't reachable.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealStore } from "../src/engine/surreal.js";
import type { GlobalPluginState } from "../src/engine/state.js";
import {
  readSpendingStats,
  dirSizeBytes,
  statsAction,
  isConnectedDbExternal,
} from "../src/engine/tools/introspect.js";
import { pickPort, LEGACY_MANAGED_SURREAL_PORT } from "../src/engine/bootstrap.js";

// ── 0. isConnectedDbExternal — db_size external detection (0.7.108) ────────
// Regression for the discovered-external gap: the old `!!process.env.SURREAL_URL`
// check reported the managed dataDir size for a DB adopted via discovery (e.g.
// an :8000 Docker container with no SURREAL_URL). External must key on the
// connected port, not just the env.
describe("isConnectedDbExternal (db_size external detection)", () => {
  const origUrl = process.env.SURREAL_URL;
  afterEach(() => {
    if (origUrl === undefined) delete process.env.SURREAL_URL;
    else process.env.SURREAL_URL = origUrl;
  });

  it("treats a discovered non-managed port (e.g. :8000 Docker) as external", () => {
    delete process.env.SURREAL_URL;
    expect(isConnectedDbExternal("ws://127.0.0.1:8000/rpc")).toBe(true);
    expect(isConnectedDbExternal("ws://127.0.0.1:8042/rpc")).toBe(true);
  });

  it("treats OUR managed instance port as not external", () => {
    delete process.env.SURREAL_URL;
    expect(isConnectedDbExternal(`ws://127.0.0.1:${pickPort()}/rpc`)).toBe(false);
    expect(isConnectedDbExternal(`ws://127.0.0.1:${LEGACY_MANAGED_SURREAL_PORT}/rpc`)).toBe(false);
  });

  it("treats SURREAL_URL as external regardless of the connected port", () => {
    process.env.SURREAL_URL = "ws://remote.example:8000/rpc";
    expect(isConnectedDbExternal(`ws://127.0.0.1:${pickPort()}/rpc`)).toBe(true);
  });

  it("assumes managed (false) for an unparseable url", () => {
    delete process.env.SURREAL_URL;
    expect(isConnectedDbExternal("not-a-url")).toBe(false);
  });
});

// ── 1. readSpendingStats — pure parser ────────────────────────────────────

describe("readSpendingStats", () => {
  function seedLedger(lines: object[], legacy?: object): string {
    const dir = mkdtempSync(join(tmpdir(), "kc-spend-"));
    writeFileSync(
      join(dir, "auto-drain-spending.ndjson"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
    if (legacy) writeFileSync(join(dir, "auto-drain-spending.json"), JSON.stringify(legacy), "utf-8");
    return dir;
  }

  it("buckets spawns into today / 7d / 30d windows by ts", () => {
    const now = Date.parse("2026-06-03T12:00:00Z");
    const today = "2026-06-03";
    const dir = seedLedger([
      // 3 today
      { date: today, ts: now - 1_000, pid: 1 },
      { date: today, ts: now - 2_000, pid: 2 },
      { date: today, ts: now - 3_000, pid: 3 },
      // 2 within 7d but not today (3 and 5 days ago)
      { date: "2026-05-31", ts: now - 3 * 86_400_000, pid: 4 },
      { date: "2026-05-29", ts: now - 5 * 86_400_000, pid: 5 },
      // 1 within 30d but not 7d (10 days ago)
      { date: "2026-05-24", ts: now - 10 * 86_400_000, pid: 6 },
      // 1 older than 30d (40 days ago) — excluded from all buckets
      { date: "2026-04-24", ts: now - 40 * 86_400_000, pid: 7 },
    ]);
    const s = readSpendingStats(dir, now);
    rmSync(dir, { recursive: true, force: true });

    expect(s.today_key).toBe(today);
    expect(s.today).toBe(3);
    expect(s.last7d).toBe(5); // 3 today + 2 within-7d
    expect(s.last30d).toBe(6); // 5 + the 10-day-old one; the 40-day one excluded
  });

  it("skips malformed and partial lines", () => {
    const now = Date.parse("2026-06-03T12:00:00Z");
    const today = "2026-06-03";
    const dir = mkdtempSync(join(tmpdir(), "kc-spend-"));
    writeFileSync(
      join(dir, "auto-drain-spending.ndjson"),
      [
        JSON.stringify({ date: today, ts: now - 1000, pid: 1 }),
        "{ not valid json",                       // malformed → skipped
        JSON.stringify({ date: today }),          // missing ts+pid → skipped
        JSON.stringify({ date: today, ts: now - 2000, pid: 2 }),
        "",                                        // blank → skipped
      ].join("\n"),
      "utf-8",
    );
    const s = readSpendingStats(dir, now);
    rmSync(dir, { recursive: true, force: true });
    expect(s.today).toBe(2);
    expect(s.last7d).toBe(2);
  });

  it("adds legacy {date,count} file to today's buckets when same-day", () => {
    const now = Date.parse("2026-06-03T12:00:00Z");
    const today = "2026-06-03";
    const dir = seedLedger(
      [{ date: today, ts: now - 1000, pid: 1 }],
      { date: today, count: 4 },
    );
    const s = readSpendingStats(dir, now);
    rmSync(dir, { recursive: true, force: true });
    expect(s.today).toBe(5);   // 1 ndjson + 4 legacy
    expect(s.last7d).toBe(5);
    expect(s.last30d).toBe(5);
  });

  it("ignores a legacy file whose date != today", () => {
    const now = Date.parse("2026-06-03T12:00:00Z");
    const dir = seedLedger(
      [{ date: "2026-06-03", ts: now - 1000, pid: 1 }],
      { date: "2026-06-01", count: 9 },
    );
    const s = readSpendingStats(dir, now);
    rmSync(dir, { recursive: true, force: true });
    expect(s.today).toBe(1); // legacy 9 ignored (stale date)
  });

  it("returns zeros when the ledger dir/file is absent", () => {
    const s = readSpendingStats(join(tmpdir(), "kc-does-not-exist-" + Math.random()));
    expect(s).toMatchObject({ today: 0, last7d: 0, last30d: 0 });
  });
});

// ── 2. dirSizeBytes — recursive walk ──────────────────────────────────────

describe("dirSizeBytes", () => {
  it("sums file sizes recursively across subdirectories", () => {
    const root = mkdtempSync(join(tmpdir(), "kc-dirsize-"));
    writeFileSync(join(root, "a.txt"), "x".repeat(100));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.txt"), "y".repeat(250));
    mkdirSync(join(root, "sub", "deep"));
    writeFileSync(join(root, "sub", "deep", "c.txt"), "z".repeat(50));
    const total = dirSizeBytes(root);
    rmSync(root, { recursive: true, force: true });
    expect(total).toBe(400); // 100 + 250 + 50
  });

  it("returns null for a non-existent directory", () => {
    expect(dirSizeBytes(join(tmpdir(), "kc-nope-" + Math.random()))).toBeNull();
  });
});

// ── 3. statsAction — live DB aggregation ───────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION === "1";
const TEST_NS = "kong_test";
const TEST_DB = `stats_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let store: SurrealStore;
let tmpCacheDir: string;
let tmpDataDir: string;

beforeAll(async () => {
  if (SKIP) return;
  const url = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const user = process.env.SURREAL_USER ?? "root";
  const pass = process.env.SURREAL_PASS ?? "root";
  store = new SurrealStore({
    url,
    get httpUrl() {
      return url.replace("ws://", "http://").replace("wss://", "https://").replace("/rpc", "");
    },
    user, pass, ns: TEST_NS, db: TEST_DB,
  });
  try {
    await Promise.race([
      store.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SurrealDB connect timeout after 10s")), 10_000),
      ),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping statsAction live tests:", (e as Error).message);
    store = undefined as any;
  }
}, 15_000);

afterAll(async () => {
  if (tmpCacheDir) try { rmSync(tmpCacheDir, { recursive: true, force: true }); } catch { /* ok */ }
  if (tmpDataDir) try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ok */ }
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

/** Build a GlobalPluginState-shaped object with the real store + temp paths.
 *  statsAction touches state.store, state.config.paths, and state.config.surreal.url
 *  (the connected url, used to decide managed-vs-external for db_size). A managed
 *  legacy-port url keeps db_size on the temp dataDir; the SURREAL_URL test below
 *  overrides to external. */
function makeState(cacheDir: string, dataDir: string): GlobalPluginState {
  return {
    store,
    config: {
      paths: { cacheDir, dataDir, surrealBinPath: null },
      surreal: { url: `ws://127.0.0.1:${LEGACY_MANAGED_SURREAL_PORT}/rpc` },
    },
  } as unknown as GlobalPluginState;
}

function itDb(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => {
    if (SKIP || !store?.isAvailable()) return;
    await fn();
  }, timeout);
}

describe("statsAction (live DB)", () => {
  itDb("aggregates session tokens/turns inside vs outside the 7d window", async () => {
    // Two sessions inside the 7d window (started 1d and 3d ago) and one
    // outside it (started 20d ago, inside 30d). Use explicit datetime maths
    // so the rows land deterministically relative to time::now().
    await store.queryExec(
      `CREATE session CONTENT { agent_id: "stats-test", started_at: time::now() - 1d, turn_count: 5, total_input_tokens: 1000, total_output_tokens: 400 };
       CREATE session CONTENT { agent_id: "stats-test", started_at: time::now() - 3d, turn_count: 3, total_input_tokens: 500, total_output_tokens: 200 };
       CREATE session CONTENT { agent_id: "stats-test", started_at: time::now() - 20d, turn_count: 7, total_input_tokens: 2000, total_output_tokens: 900 };`,
    );

    tmpCacheDir = mkdtempSync(join(tmpdir(), "kc-stats-cache-"));
    tmpDataDir = mkdtempSync(join(tmpdir(), "kc-stats-data-"));
    // Empty ledger so drain numbers are deterministic (0/budget).
    const state = makeState(tmpCacheDir, tmpDataDir);

    const res = await statsAction(state);
    const d = res.details as any;

    // 7d window: only the 1d + 3d sessions.
    expect(d.window_7d.sessions).toBe(2);
    expect(d.window_7d.turns).toBe(8);          // 5 + 3
    expect(d.window_7d.tokens_in).toBe(1500);   // 1000 + 500
    expect(d.window_7d.tokens_out).toBe(600);   // 400 + 200

    // 30d window: all three.
    expect(d.window_30d.sessions).toBe(3);
    expect(d.window_30d.turns).toBe(15);        // 5 + 3 + 7
    expect(d.window_30d.tokens_in).toBe(3500);  // 1000 + 500 + 2000
    expect(d.window_30d.tokens_out).toBe(1500); // 400 + 200 + 900

    // Text report is redaction-safe and well-formed.
    expect(res.content[0].text).toContain("USAGE & COST REPORT");
  }, 20_000);

  itDb("computes drain budget math + near-cap alert from the ledger", async () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const cacheDir = mkdtempSync(join(tmpdir(), "kc-stats-budget-"));
    const dataDir = mkdtempSync(join(tmpdir(), "kc-stats-budget-data-"));
    // 9 spawns today; default budget is 50 → 18%, below the 80% alert floor.
    // Force the alert by setting a small budget via env.
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) lines.push(JSON.stringify({ date: today, ts: now - i * 1000, pid: 1000 + i }));
    writeFileSync(join(cacheDir, "auto-drain-spending.ndjson"), lines.join("\n") + "\n", "utf-8");

    const prevBudget = process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY;
    process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY = "10"; // 9/10 = 90% → critical-adjacent warn
    try {
      const state = makeState(cacheDir, dataDir);
      const res = await statsAction(state);
      const d = res.details as any;
      expect(d.drain.spawns_today).toBe(9);
      expect(d.drain.daily_budget).toBe(10);
      expect(d.drain.spawns_7d).toBe(9);
      // 9 >= ceil(10*0.8)=8 → alert present.
      const alert = d.alerts.find((a: any) => a.code === "drain.budget_near_cap");
      expect(alert).toBeTruthy();
    } finally {
      if (prevBudget === undefined) delete process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY;
      else process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY = prevBudget;
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  itDb("reports DB size n/a when SURREAL_URL marks an external DB", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "kc-stats-ext-"));
    const dataDir = mkdtempSync(join(tmpdir(), "kc-stats-ext-data-"));
    const prev = process.env.SURREAL_URL;
    process.env.SURREAL_URL = "ws://some-external-host:8000/rpc";
    try {
      const state = makeState(cacheDir, dataDir);
      const res = await statsAction(state);
      const d = res.details as any;
      expect(d.db_size.external).toBe(true);
      expect(d.db_size.bytes).toBeNull();
      expect(res.content[0].text).toContain("n/a (external DB");
    } finally {
      if (prev === undefined) delete process.env.SURREAL_URL;
      else process.env.SURREAL_URL = prev;
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
