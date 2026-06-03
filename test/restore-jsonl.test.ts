/**
 * Round-trip + merge tests for scripts/backup-jsonl.mjs → scripts/restore-jsonl.mjs.
 *
 * These exercise the real CLI scripts end-to-end as subprocesses (env-driven,
 * exactly how an operator runs them), against a live SurrealDB on localhost:8000:
 *
 *   1. ROUND-TRIP: seed a small graph (concepts + memories + an edge) in one
 *      kong_test db, run backup-jsonl into a temp dir, run restore-jsonl into a
 *      SECOND fresh kong_test db, and assert node/edge counts match, a sample
 *      row's content survives, and a SECOND restore is idempotent (creates 0).
 *   2. MISSING-ENDPOINT: an edge whose endpoint node was never seeded is skipped
 *      (logged), not created — no dangling edges.
 *   3. --merge-by-hash: a row whose content_hash already exists in the target is
 *      skipped even though its id is fresh.
 *   4. manifest: backup writes metadata.json carrying schema_version + table_counts.
 *
 * Requires a live SurrealDB. Skipped when SKIP_INTEGRATION=1 or the connection
 * fails. Each db name is unique per run so concurrent runs never collide.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Surreal, RecordId } from "surrealdb";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const SKIP = process.env.SKIP_INTEGRATION === "1";
const URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER ?? "root";
const PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NS = "kong_test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SCHEMA_PATH = join(REPO, "src", "engine", "schema.surql");
const BACKUP_SCRIPT = join(REPO, "scripts", "backup-jsonl.mjs");
const RESTORE_SCRIPT = join(REPO, "scripts", "restore-jsonl.mjs");

let available = false;
let schemaSql = "";
let tmpRoot = "";

/** Open a client bound to a specific (already-schema'd or to-be-schema'd) db. */
async function open(db: string): Promise<Surreal> {
  const s = new Surreal();
  await s.connect(URL);
  await s.signin({ username: USER, password: PASS });
  await s.use({ namespace: TEST_NS, database: db });
  return s;
}

async function applySchema(db: string): Promise<void> {
  const s = await open(db);
  try {
    await s.query(schemaSql);
  } finally {
    await s.close();
  }
}

async function dropDb(db: string): Promise<void> {
  try {
    const s = await open(db);
    try { await s.query(`REMOVE DATABASE ${db}`); } finally { await s.close(); }
  } catch { /* ok */ }
}

/** Count rows in a table within a given db. */
async function countRows(db: string, table: string): Promise<number> {
  const s = await open(db);
  try {
    const r = await s.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM ${table} GROUP ALL`);
    return Array.isArray(r[0]) && r[0][0] ? Number(r[0][0].c) : 0;
  } finally {
    await s.close();
  }
}

function runScript(script: string, args: string[], extraEnv: Record<string, string>) {
  return execFileP(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      SURREAL_URL: URL,
      SURREAL_USER: USER,
      SURREAL_PASS: PASS,
      SURREAL_NS: TEST_NS,
      ...extraEnv,
    },
    cwd: REPO,
  });
}

beforeAll(async () => {
  if (SKIP) return;
  schemaSql = await readFile(SCHEMA_PATH, "utf8");
  try {
    const probe = await open("connectivity_probe");
    await probe.query("RETURN 'ok'");
    await probe.close();
    available = true;
  } catch (e) {
    console.warn("SurrealDB not available, skipping restore-jsonl tests:", (e as Error).message);
    available = false;
    return;
  }
  tmpRoot = await mkdtemp(join(tmpdir(), "kc-restore-test-"));
}, 30_000);

afterAll(async () => {
  if (tmpRoot) { try { await rm(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ } }
}, 15_000);

function itDb(name: string, fn: () => Promise<void>, timeout = 60_000) {
  it(name, async () => {
    if (SKIP || !available) return;
    await fn();
  }, timeout);
}

describe("restore-jsonl round-trip", () => {
  itDb("seeds a graph, backs it up, restores into a fresh db with matching counts + content + idempotency", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const srcDb = `rt_src_${suffix}`;
    const dstDb = `rt_dst_${suffix}`;
    const backupDir = join(tmpRoot, `bk_${suffix}`);

    await applySchema(srcDb);
    await applySchema(dstDb);

    // ── Seed the source graph: 2 concepts, 2 memories, 1 concept→concept edge,
    //    1 memory→memory edge. Use explicit ids so we can assert content survives.
    const src = await open(srcDb);
    try {
      await src.query(
        `CREATE concept:rt_c1 CONTENT { content: $c1, stability: 1, confidence: 1, access_count: 0, content_hash: "hash_c1" };
         CREATE concept:rt_c2 CONTENT { content: $c2, stability: 1, confidence: 1, access_count: 0, content_hash: "hash_c2" };
         CREATE memory:rt_m1 CONTENT { text: $m1, importance: 0.7, category: "general" };
         CREATE memory:rt_m2 CONTENT { text: $m2, importance: 0.3, category: "general" };
         RELATE concept:rt_c1->related_to->concept:rt_c2;
         RELATE memory:rt_m1->supports->memory:rt_m2;`,
        {
          c1: "round-trip concept one — UNIQUE_MARKER_C1",
          c2: "round-trip concept two",
          m1: "round-trip memory one",
          m2: "round-trip memory two",
        },
      );
    } finally {
      await src.close();
    }

    // ── Backup the source db to a temp dir.
    const bk = await runScript(BACKUP_SCRIPT, [], { SURREAL_DB: srcDb, KONGCODE_BACKUP_DIR: backupDir });
    expect(bk.stdout).toMatch(/Wrote \d+ total rows/);

    // metadata.json carries the manifest fields restore reads.
    const meta = JSON.parse(await readFile(join(backupDir, "metadata.json"), "utf8"));
    expect(typeof meta.schema_version).toBe("string");
    expect(meta.schema_version.length).toBeGreaterThan(0);
    expect(meta.table_counts).toBeTruthy();
    expect(meta.table_counts.concept).toBe(2);
    expect(meta.table_counts.memory).toBe(2);
    expect(meta.table_counts.related_to).toBe(1);
    expect(meta.table_counts.supports).toBe(1);

    // ── Restore into the fresh dst db (default skip-if-exists).
    const r1 = await runScript(RESTORE_SCRIPT, [backupDir], { SURREAL_DB: dstDb });
    expect(r1.stdout).toMatch(/Restore complete/);

    // Node + edge counts must match the source.
    expect(await countRows(dstDb, "concept")).toBe(2);
    expect(await countRows(dstDb, "memory")).toBe(2);
    expect(await countRows(dstDb, "related_to")).toBe(1);
    expect(await countRows(dstDb, "supports")).toBe(1);

    // Sample content survives, including the exact id + a datetime field
    // (created_at must have re-coerced to a real datetime, not a bare string).
    const dst = await open(dstDb);
    try {
      const cr = await dst.query<[Array<{ id: unknown; content: string; created_at: unknown }>]>(
        `SELECT id, content, created_at FROM concept:rt_c1`,
      );
      const row = cr[0][0];
      expect(String(row.id)).toBe("concept:rt_c1");
      expect(row.content).toBe("round-trip concept one — UNIQUE_MARKER_C1");
      // created_at came back as a DateTime object, not the ISO string we wrote.
      expect(typeof row.created_at).not.toBe("string");

      // The edge actually links the two restored concept rows.
      const er = await dst.query<[Array<{ in: unknown; out: unknown }>]>(
        `SELECT in, out FROM related_to`,
      );
      expect(String(er[0][0].in)).toBe("concept:rt_c1");
      expect(String(er[0][0].out)).toBe("concept:rt_c2");
    } finally {
      await dst.close();
    }

    // ── Idempotency: a SECOND restore must create nothing and skip everything.
    const r2 = await runScript(RESTORE_SCRIPT, [backupDir], { SURREAL_DB: dstDb });
    expect(r2.stdout).toMatch(/Restore complete: 0 created/);

    // Counts unchanged after the second restore.
    expect(await countRows(dstDb, "concept")).toBe(2);
    expect(await countRows(dstDb, "memory")).toBe(2);
    expect(await countRows(dstDb, "related_to")).toBe(1);
    expect(await countRows(dstDb, "supports")).toBe(1);

    await dropDb(srcDb);
    await dropDb(dstDb);
  });

  itDb("skips an edge whose endpoint node is absent (no dangling edges)", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const srcDb = `me_src_${suffix}`;
    const dstDb = `me_dst_${suffix}`;
    const backupDir = join(tmpRoot, `me_${suffix}`);

    await applySchema(srcDb);
    await applySchema(dstDb);

    const src = await open(srcDb);
    try {
      await src.query(
        `CREATE concept:me_a CONTENT { content: "a", stability:1, confidence:1, access_count:0 };
         CREATE concept:me_b CONTENT { content: "b", stability:1, confidence:1, access_count:0 };
         RELATE concept:me_a->related_to->concept:me_b;`,
      );
    } finally {
      await src.close();
    }

    await runScript(BACKUP_SCRIPT, [], { SURREAL_DB: srcDb, KONGCODE_BACKUP_DIR: backupDir });

    // Pre-seed ONLY one endpoint (me_a) in the destination, then restore JUST the
    // edge file. The other endpoint (me_b) is absent → the edge must be skipped.
    const dst = await open(dstDb);
    try {
      await dst.query(`CREATE concept:me_a CONTENT { content: "a", stability:1, confidence:1, access_count:0 }`);
    } finally {
      await dst.close();
    }

    // Restore the whole backup dir EXCEPT we delete the node files so only the
    // edge is attempted. Simplest: point restore at a dir containing only the
    // related_to.jsonl. Copy that one file into a fresh dir.
    const edgeOnly = join(tmpRoot, `me_edgeonly_${suffix}`);
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(edgeOnly, { recursive: true });
    await copyFile(join(backupDir, "related_to.jsonl"), join(edgeOnly, "related_to.jsonl"));
    await copyFile(join(backupDir, "metadata.json"), join(edgeOnly, "metadata.json"));

    const r = await runScript(RESTORE_SCRIPT, [edgeOnly], { SURREAL_DB: dstDb });
    // The edge was skipped as missing-endpoint, created 0.
    expect(r.stdout).toMatch(/missing-endpoint/);
    expect(await countRows(dstDb, "related_to")).toBe(0);

    await dropDb(srcDb);
    await dropDb(dstDb);
  });
});

describe("restore-jsonl --merge-by-hash", () => {
  itDb("skips a node whose content_hash already exists in the target (fresh id notwithstanding)", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const srcDb = `mh_src_${suffix}`;
    const dstDb = `mh_dst_${suffix}`;
    const backupDir = join(tmpRoot, `mh_${suffix}`);

    await applySchema(srcDb);
    await applySchema(dstDb);

    // Source has one artifact with content_hash "DUP_HASH" at id artifact:mh_src1.
    const src = await open(srcDb);
    try {
      await src.query(
        `CREATE artifact:mh_src1 CONTENT { path: "/src/path.ts", type: "file", content_hash: "DUP_HASH" }`,
      );
    } finally {
      await src.close();
    }
    await runScript(BACKUP_SCRIPT, [], { SURREAL_DB: srcDb, KONGCODE_BACKUP_DIR: backupDir });

    // Destination ALREADY has a DIFFERENT artifact id but the SAME content_hash.
    const dst = await open(dstDb);
    try {
      await dst.query(
        `CREATE artifact:mh_dst_existing CONTENT { path: "/dst/other.ts", type: "file", content_hash: "DUP_HASH" }`,
      );
    } finally {
      await dst.close();
    }

    // --merge-by-hash: the source row (fresh id artifact:mh_src1) must be SKIPPED
    // because its content_hash already exists in the target.
    const r = await runScript(RESTORE_SCRIPT, [backupDir, "--merge-by-hash"], { SURREAL_DB: dstDb });
    expect(r.stdout).toMatch(/Strategy: merge-by-hash/);

    // Only the pre-existing artifact remains; the duplicate-hash row was not created.
    expect(await countRows(dstDb, "artifact")).toBe(1);
    const dst2 = await open(dstDb);
    try {
      const got = await dst2.query<[Array<{ id: unknown }>]>(`SELECT id FROM artifact WHERE id = artifact:mh_src1`);
      expect((got[0] ?? []).length).toBe(0); // the dup-hash source row was skipped
    } finally {
      await dst2.close();
    }

    // Sanity: WITHOUT --merge-by-hash (default skip-if-exists by id), the fresh
    // id WOULD be created since no row with that id exists yet.
    const r2 = await runScript(RESTORE_SCRIPT, [backupDir], { SURREAL_DB: dstDb });
    expect(r2.stdout).toMatch(/Restore complete: 1 created/);
    expect(await countRows(dstDb, "artifact")).toBe(2);

    await dropDb(srcDb);
    await dropDb(dstDb);
  });
});

describe("restore-jsonl --dry-run", () => {
  itDb("writes nothing — including an edge whose endpoints already exist in the target", async () => {
    // Regression: --dry-run previously RELATE'd edges for real when both endpoint
    // nodes were already present (restoreEdgeTable got no flags), violating the
    // "no writes" contract on a dry-run merge into a populated graph.
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const srcDb = `dr_src_${suffix}`;
    const dstDb = `dr_dst_${suffix}`;
    const backupDir = join(tmpRoot, `dr_${suffix}`);

    await applySchema(srcDb);
    await applySchema(dstDb);

    const src = await open(srcDb);
    try {
      await src.query(
        `CREATE concept:dr_a CONTENT { content: "dry-run a", stability:1, confidence:1, access_count:0 };
         CREATE concept:dr_b CONTENT { content: "dry-run b", stability:1, confidence:1, access_count:0 };
         RELATE concept:dr_a->related_to->concept:dr_b;`,
      );
    } finally {
      await src.close();
    }
    await runScript(BACKUP_SCRIPT, [], { SURREAL_DB: srcDb, KONGCODE_BACKUP_DIR: backupDir });

    // The destination ALREADY holds both endpoint nodes (the bug condition) but
    // not the edge.
    const dst = await open(dstDb);
    try {
      await dst.query(
        `CREATE concept:dr_a CONTENT { content: "dry-run a", stability:1, confidence:1, access_count:0 };
         CREATE concept:dr_b CONTENT { content: "dry-run b", stability:1, confidence:1, access_count:0 };`,
      );
    } finally {
      await dst.close();
    }

    // --dry-run must write NOTHING — including the edge (endpoints present).
    const dr = await runScript(RESTORE_SCRIPT, [backupDir, "--dry-run"], { SURREAL_DB: dstDb });
    expect(dr.stdout).toMatch(/dry-run/);
    expect(await countRows(dstDb, "related_to")).toBe(0); // pre-fix: would be 1
    expect(await countRows(dstDb, "concept")).toBe(2);    // pre-seeded, skip-if-exists

    // A REAL restore now creates the edge — proving the dry-run suppressed a
    // write it correctly predicted.
    await runScript(RESTORE_SCRIPT, [backupDir], { SURREAL_DB: dstDb });
    expect(await countRows(dstDb, "related_to")).toBe(1);

    await dropDb(srcDb);
    await dropDb(dstDb);
  });
});
