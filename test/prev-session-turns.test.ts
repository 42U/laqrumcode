/**
 * Live test for getPreviousSessionTurns (2026-06-09 double-defect fix,
 * src/engine/surreal.ts:1432): (a) the kc-session UUID was cast with
 * type::record() → threw on every call → silently returned []; (b) the
 * previous session's Thing was bound as a STRING into part_of.out → matched
 * zero rows. Pre-fix this function NEVER returned turns through the
 * kc-UUID caller path (all three production callers).
 *
 * Requires a live SurrealDB; the beforeAll probe races a 10s timeout so CI's
 * no-DB env skips cleanly. ns=laqrum_test, isolated from production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurrealStore } from "../src/engine/surreal.js";

const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "laqrum_test";
const TEST_DB = `pst_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "schema.surql");

const KC_PREV = "11111111-aaaa-4bbb-8ccc-000000000001";
const KC_CUR = "22222222-aaaa-4bbb-8ccc-000000000002";

let store: SurrealStore | undefined;

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
    console.warn("SurrealDB not available, skipping prev-session-turns tests:", (e as Error).message);
    store = undefined;
    return;
  }
  await store.queryExec(await readFile(SCHEMA, "utf8"));
  // Previous session (older) with two turns attached via part_of.
  await store.queryExec(`CREATE session:pst_prev SET agent_id = 'a', kc_session_id = $kc, started_at = time::now() - 2h`, { kc: KC_PREV });
  await store.queryExec(`CREATE session:pst_cur SET agent_id = 'a', kc_session_id = $kc, started_at = time::now()`, { kc: KC_CUR });
  await store.queryExec(`CREATE turn:pst_t1 SET role = 'user', text = 'hello from the previous session', session_id = $kc, timestamp = time::now() - 2h`, { kc: KC_PREV });
  await store.queryExec(`CREATE turn:pst_t2 SET role = 'assistant', text = 'reply in the previous session', session_id = $kc, timestamp = time::now() - 119m`, { kc: KC_PREV });
  await store.queryExec(`RELATE turn:pst_t1->part_of->session:pst_prev`);
  await store.queryExec(`RELATE turn:pst_t2->part_of->session:pst_prev`);
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>) {
  it(name, async () => { if (!store) return; await fn(); }, 30_000);
}

describe("getPreviousSessionTurns (live, laqrum_test)", () => {
  itDb("returns the previous session's turns when called with the current kc-UUID (pre-fix: [])", async () => {
    const turns = await store!.getPreviousSessionTurns(KC_CUR, 10);
    expect(turns.length).toBe(2);
    // reversed → chronological order
    expect(turns[0].text).toBe("hello from the previous session");
    expect(turns[1].text).toBe("reply in the previous session");
    expect(turns[0].role).toBe("user");
  });

  itDb("kc-UUID exclusion picks the OTHER session — and a turn-less previous session yields []", async () => {
    // Calling with the prev session's kc id makes the (newer) current session
    // the "previous" one; it has no part_of turns → [].
    const turns = await store!.getPreviousSessionTurns(KC_PREV, 10);
    expect(turns).toEqual([]);
  });
});
