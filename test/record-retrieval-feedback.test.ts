/**
 * Live tests for the record_retrieval_feedback tool handler (GH #16-5, Phase A).
 *
 * Calls the handler against a seeded kong_test DB and verifies the SQL effects:
 *   - helpful/irrelevant/outdated relabel the session's retrieval_outcome row
 *     (llm_relevance/llm_relevant/feedback_source) — the ACAN training sample,
 *   - outdated decays the table-appropriate priority field (memory.importance,
 *     concept.stability),
 *   - pin boosts it,
 *   - validation rejects bad signals / unknown ids,
 *   - feedback on a memory not retrieved this session reports 0 relabels + note.
 *
 * Requires a live SurrealDB; the beforeAll probe races a 10s timeout so CI's
 * no-DB env skips cleanly. ns=kong_test is isolated from production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurrealStore } from "../src/engine/surreal.js";
import { handleRecordRetrievalFeedback } from "../src/tools/record-retrieval-feedback.js";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "kong_test";
const TEST_DB = `rrf_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const SID = `sess_${Math.random().toString(36).slice(2, 8)}`;
const SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "schema.surql");
const EMB = Array(1024).fill(0.01);

let store: SurrealStore | undefined;
let state: GlobalPluginState;
const session = { sessionId: SID } as unknown as SessionState;

async function call(memory_id: string, signal: string, reason?: string) {
  const res = await handleRecordRetrievalFeedback(state, session, { memory_id, signal, reason });
  return JSON.parse(res.content[0].text);
}
async function scalar<T>(sql: string): Promise<T | undefined> {
  // queryMulti returns the last flattened element with NO .filter(Boolean)
  // (unlike queryBatch), so a falsy scalar like 0 / false survives the read.
  return await store!.queryMulti<T>(sql);
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
    console.warn("SurrealDB not available, skipping record-retrieval-feedback tests:", (e as Error).message);
    store = undefined;
    return;
  }
  await store.queryExec(await readFile(SCHEMA, "utf8"));
  await store.queryExec(`CREATE memory:rrf_m1 SET text = $t, category = 'fact', importance = 0.5, embedding = $e`, { t: "a memory that was injected", e: EMB });
  await store.queryExec(`CREATE concept:rrf_c1 SET content = $c, stability = 1.0, embedding = $e`, { c: "an injected concept", e: EMB });
  // Simulate the turn-end retrieval_outcome row (carries query_embedding).
  await store.queryExec(
    `CREATE retrieval_outcome SET session_id = $sid, turn_id = 't1', memory_id = 'memory:rrf_m1', memory_table = 'memory', retrieval_score = 0.8, utilization = 0.3, query_embedding = $e`,
    { sid: SID, e: EMB },
  );
  state = { store } as unknown as GlobalPluginState;
}, 30_000);

afterAll(async () => {
  if (!store) return;
  try { await store.queryExec(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await store.dispose(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>) {
  it(name, async () => { if (!store) return; await fn(); }, 30_000);
}

describe("record_retrieval_feedback (live, kong_test)", () => {
  itDb("helpful relabels the retrieval_outcome row as the explicit ACAN training label", async () => {
    const r = await call("memory:rrf_m1", "helpful", "spot on");
    expect(r.ok).toBe(true);
    expect(r.relabeled_training_samples).toBeGreaterThanOrEqual(1);
    expect(await scalar<number>(`SELECT VALUE llm_relevance FROM retrieval_outcome WHERE memory_id = 'memory:rrf_m1'`)).toBe(1);
    expect(await scalar<boolean>(`SELECT VALUE llm_relevant FROM retrieval_outcome WHERE memory_id = 'memory:rrf_m1'`)).toBe(true);
    expect(await scalar<string>(`SELECT VALUE feedback_source FROM retrieval_outcome WHERE memory_id = 'memory:rrf_m1'`)).toBe("explicit");
  });

  itDb("irrelevant flips the same row to a negative label", async () => {
    const r = await call("memory:rrf_m1", "irrelevant");
    expect(r.ok).toBe(true);
    expect(await scalar<number>(`SELECT VALUE llm_relevance FROM retrieval_outcome WHERE memory_id = 'memory:rrf_m1'`)).toBe(0);
    expect(await scalar<boolean>(`SELECT VALUE llm_relevant FROM retrieval_outcome WHERE memory_id = 'memory:rrf_m1'`)).toBe(false);
  });

  itDb("outdated decays a memory's importance (not stability)", async () => {
    const before = (await scalar<number>(`SELECT VALUE importance FROM memory:rrf_m1`)) ?? 0;
    const r = await call("memory:rrf_m1", "outdated", "superseded by new policy");
    expect(r.ok).toBe(true);
    expect(r.decayed).toContain("importance");
    const after = (await scalar<number>(`SELECT VALUE importance FROM memory:rrf_m1`)) ?? 0;
    expect(after).toBeLessThan(before);
  });

  itDb("pin boosts a memory's importance to 10", async () => {
    const r = await call("memory:rrf_m1", "pin");
    expect(r.ok).toBe(true);
    expect(await scalar<number>(`SELECT VALUE importance FROM memory:rrf_m1`)).toBe(10);
  });

  itDb("pin boosts a concept's stability to 10", async () => {
    const r = await call("concept:rrf_c1", "pin");
    expect(r.ok).toBe(true);
    expect(await scalar<number>(`SELECT VALUE stability FROM concept:rrf_c1`)).toBe(10);
  });

  itDb("rejects an unknown signal and an unknown record", async () => {
    expect((await call("memory:rrf_m1", "bogus")).ok).toBe(false);
    expect((await call("memory:does_not_exist_xyz", "helpful")).ok).toBe(false);
  });

  itDb("reports 0 relabels + a note when the item wasn't retrieved this session", async () => {
    // concept:rrf_c1 has no retrieval_outcome row.
    const r = await call("concept:rrf_c1", "helpful");
    expect(r.ok).toBe(true);
    expect(r.relabeled_training_samples).toBe(0);
    expect(typeof r.note).toBe("string");
  });
});
