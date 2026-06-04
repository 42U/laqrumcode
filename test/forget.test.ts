/**
 * Live tests for scripts/forget.mjs (GH #16 item 2 — selective, reversible forget).
 *
 * Verifies: forget soft-deactivates ONLY matching rows (memory→status='archived',
 * concept→superseded_at set, archive_reason='forget:…'); the EXACT retrieval
 * candidate filter (src/engine/surreal.ts) then excludes them; non-matching rows
 * are untouched; dry-run changes nothing; and --undo fully reactivates.
 *
 * Nothing is ever DELETEd (D4 founder rule). Requires a live SurrealDB; the
 * beforeAll probe races a 10s timeout so CI's no-DB env skips cleanly.
 * ns=kong_test, isolated from production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Surreal } from "surrealdb";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "kong_test";
const TEST_DB = `forget_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORGET = join(REPO, "scripts", "forget.mjs");
const EMB = Array(1024).fill(0.01);

let db: Surreal | undefined;

async function open(): Promise<Surreal> {
  const s = new Surreal();
  await s.connect(URL);
  await s.signin({ username: USER, password: PASS });
  await s.use({ namespace: TEST_NS, database: TEST_DB });
  return s;
}
function runForget(args: string[]) {
  return execFileP(process.execPath, [FORGET, ...args], {
    env: { ...process.env, SURREAL_URL: URL, SURREAL_USER: USER, SURREAL_PASS: PASS, SURREAL_NS: TEST_NS, SURREAL_DB: TEST_DB },
    cwd: REPO,
  });
}
async function scalar<T>(sql: string): Promise<T | undefined> {
  const r = await db!.query(sql);
  const flat = (r as unknown[]).flat();
  return flat[flat.length - 1] as T | undefined;
}
/** Ids returned by the production retrieval candidate filter (proves exclusion). */
async function liveMemoryIds(): Promise<string[]> {
  const r = await db!.query(`SELECT VALUE meta::id(id) FROM memory WHERE embedding != NONE AND (status = 'active' OR status IS NONE)`);
  return ((r as unknown[]).flat() as string[]);
}
async function liveConceptIds(): Promise<string[]> {
  const r = await db!.query(`SELECT VALUE meta::id(id) FROM concept WHERE embedding != NONE AND superseded_at IS NONE`);
  return ((r as unknown[]).flat() as string[]);
}

beforeAll(async () => {
  try {
    await Promise.race([
      open().then((s) => { db = s; }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SurrealDB connect timeout after 10s")), 10_000)),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("SurrealDB not available, skipping forget tests:", (e as Error).message);
    db = undefined;
    return;
  }
  await db!.query(`CREATE memory:f_secret SET text = 'rotate the SECRET apikey before friday', embedding = $e, status = 'active', importance = 0.5, created_at = time::now()`, { e: EMB });
  await db!.query(`CREATE memory:f_benign SET text = 'a benign unrelated note', embedding = $e, status = 'active', importance = 0.5, created_at = time::now()`, { e: EMB });
  await db!.query(`CREATE concept:f_secret SET content = 'apikey rotation policy', embedding = $e, stability = 1.0, created_at = time::now()`, { e: EMB });
  await db!.query(`CREATE concept:f_benign SET content = 'unrelated concept', embedding = $e, stability = 1.0, created_at = time::now()`, { e: EMB });
}, 30_000);

afterAll(async () => {
  if (!db) return;
  try { await db.query(`REMOVE DATABASE ${TEST_DB}`); } catch { /* ok */ }
  try { await db.close(); } catch { /* ok */ }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>) {
  it(name, async () => { if (!db) return; await fn(); }, 30_000);
}

describe("forget (live, kong_test) — reversible soft-deactivate", () => {
  itDb("dry-run changes nothing", async () => {
    await runForget(["--query", "apikey"]); // no --commit
    expect(await scalar<string>(`SELECT VALUE status FROM memory:f_secret`)).toBe("active");
    expect(await scalar<unknown>(`SELECT VALUE superseded_at FROM concept:f_secret`)).toBeFalsy();
  });

  itDb("--query --commit soft-forgets ONLY matches; retrieval filter then excludes them", async () => {
    await runForget(["--query", "apikey", "--commit"]);
    // matched rows soft-deactivated with the audit reason
    expect(await scalar<string>(`SELECT VALUE status FROM memory:f_secret`)).toBe("archived");
    expect(await scalar<string>(`SELECT VALUE archive_reason FROM memory:f_secret`)).toBe("forget:query=apikey");
    expect(await scalar<unknown>(`SELECT VALUE superseded_at FROM concept:f_secret`)).toBeTruthy();
    // non-matches untouched
    expect(await scalar<string>(`SELECT VALUE status FROM memory:f_benign`)).toBe("active");
    expect(await scalar<unknown>(`SELECT VALUE superseded_at FROM concept:f_benign`)).toBeFalsy();
    // the production retrieval filter now excludes the forgotten rows, keeps the benign
    const mem = await liveMemoryIds();
    expect(mem).not.toContain("f_secret");
    expect(mem).toContain("f_benign");
    const con = await liveConceptIds();
    expect(con).not.toContain("f_secret");
    expect(con).toContain("f_benign");
  });

  itDb("nothing was DELETEd — the rows still exist (D4)", async () => {
    expect(await scalar<unknown>(`SELECT VALUE id FROM memory:f_secret`)).toBeTruthy();
    expect(await scalar<unknown>(`SELECT VALUE id FROM concept:f_secret`)).toBeTruthy();
  });

  itDb("--undo --commit reactivates the forgotten rows", async () => {
    await runForget(["--undo", "--commit"]);
    expect(await scalar<string>(`SELECT VALUE status FROM memory:f_secret`)).toBe("active");
    expect(await scalar<unknown>(`SELECT VALUE archive_reason FROM memory:f_secret`)).toBeFalsy();
    expect(await scalar<unknown>(`SELECT VALUE superseded_at FROM concept:f_secret`)).toBeFalsy();
    // back in the retrieval candidate set
    expect(await liveMemoryIds()).toContain("f_secret");
    expect(await liveConceptIds()).toContain("f_secret");
  });
});
