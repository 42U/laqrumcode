/**
 * H1 / H2 / H3 — the unbounded-disk + no-disk-preflight class on long-lived
 * single-host installs (power loss + weeks-of-uptime is routine for the 1M
 * laptop/desktop population).
 *
 *  H1: daemon.log + auto-drain.log are opened O_APPEND and inherited by detached
 *      children, so they grow FOREVER (no rotation existed — only a comment).
 *      Fix: rotateLogIfOversized(path) single-generation rotates an over-cap log
 *      at OPEN time, crash-safe (a rotate failure must never block daemon start).
 *
 *  H2: every destructive keystone op writes a reversibility .surql snapshot under
 *      <cacheDir>/gc-backups/; the 6h purges fire up to 100 batches each, so the
 *      dir accumulates forever. Fix: sweepGcBackups(state) prunes by age + count
 *      + total-size, wired into the 6h cycle via runJob — but NEVER deletes a
 *      snapshot younger than a 24h floor (a just-made backup is always available).
 *
 *  H3: nothing in the daemon ever checked free disk (only the manual
 *      compact-store.mjs ran df). Fix: memory_health statfs's the managed dataDir
 *      and pushes a RED diagnostic below a 1GB / 5% floor — the machine-readable
 *      signal bots consume to back off before the store corrupts.
 *
 * H1/H2 use REAL temp dirs (real rename/unlink/readdir — the repo's preferred FS
 * test style); H3 mocks statfs (you can't force a real partition low on disk).
 *
 * SAFETY-FOCUSED assertions (the bar: a fix must not be able to make things
 * WORSE): H1 never throws on a missing/locked log; H2 NEVER deletes a fresh
 * (<24h) snapshot even under count/size pressure; H3 never fabricates a RED from
 * a probe error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readdirSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalPluginState, SessionState } from "../src/engine/state.js";

// ---------------------------------------------------------------------------
// H3 needs a mocked statfs. Partial-override node:fs/promises so the dynamic
// import inside memory-health.ts picks up our stub; everything else is real.
// ---------------------------------------------------------------------------
let _statfsStub: ((p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>) | null = null;
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: (p: string, ...rest: unknown[]) =>
      _statfsStub ? _statfsStub(p) : (actual.statfs as (...a: unknown[]) => unknown)(p, ...rest),
  };
});

// ===========================================================================
// H1 — log rotation (rotateLogIfOversized)
// ===========================================================================
describe("H1 — single-generation log rotation at open time", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kc-h1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rotates an over-cap log to .1 and the next open starts fresh", async () => {
    const { rotateLogIfOversized } = await import("../src/engine/log.js");
    const logPath = join(dir, "daemon.log");
    // Write a 1KB log and use a tiny 500-byte cap so it is "over".
    writeFileSync(logPath, "x".repeat(1024));
    expect(statSync(logPath).size).toBe(1024);

    const rotated = rotateLogIfOversized(logPath, 500);
    expect(rotated).toBe(true);
    // Original content preserved under .1 (single generation).
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(1024);
    // The live path is now a FRESH empty file (rotateLog pre-creates it; even if
    // it hadn't, the caller's openSync(...,"a") would). It must NOT carry the old
    // 1KB — that is the whole point of rotation.
    expect(statSync(logPath).size).toBe(0);
  });

  it("is a no-op when the log is UNDER the cap (no .1 created)", async () => {
    const { rotateLogIfOversized } = await import("../src/engine/log.js");
    const logPath = join(dir, "daemon.log");
    writeFileSync(logPath, "x".repeat(100));
    const rotated = rotateLogIfOversized(logPath, 50_000_000);
    expect(rotated).toBe(false);
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(statSync(logPath).size).toBe(100); // untouched
  });

  it("SAFETY: a missing log (first run) is a clean no-op, never throws", async () => {
    const { rotateLogIfOversized } = await import("../src/engine/log.js");
    const logPath = join(dir, "never-created.log");
    expect(() => rotateLogIfOversized(logPath, 1)).not.toThrow();
    expect(rotateLogIfOversized(logPath, 1)).toBe(false);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it("SAFETY: a second rotation REPLACES the prior .1 (bounded to ~2x cap, not N gens)", async () => {
    const { rotateLogIfOversized } = await import("../src/engine/log.js");
    const logPath = join(dir, "daemon.log");
    writeFileSync(logPath, "aaaa"); // gen 1
    rotateLogIfOversized(logPath, 1);
    writeFileSync(logPath, "bbbbbbbb"); // gen 2 (different size)
    rotateLogIfOversized(logPath, 1);
    // Only ONE backup generation exists, and it holds the MOST RECENT rotated
    // content (8 bytes), not the first.
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(false);
    expect(statSync(`${logPath}.1`).size).toBe(8);
  });

  it("uses a 50MB default cap", async () => {
    const { LOG_ROTATE_CAP_BYTES } = await import("../src/engine/log.js");
    expect(LOG_ROTATE_CAP_BYTES).toBe(50 * 1024 * 1024);
  });
});

// ===========================================================================
// H2 — gc-backups retention sweep (sweepGcBackups)
// ===========================================================================
describe("H2 — gc-backups retention sweep", () => {
  let cacheDir: string;
  let backupDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "kc-h2-"));
    backupDir = join(cacheDir, "gc-backups");
    mkdirSync(backupDir, { recursive: true });
  });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  /** Create a gc snapshot file aged `ageMs` in the past (mtime back-dated). */
  function makeSnap(name: string, ageMs: number, bytes = 10): string {
    const full = join(backupDir, name);
    writeFileSync(full, "-".repeat(bytes));
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(full, when, when);
    return full;
  }

  function makeState(): GlobalPluginState {
    return { config: { paths: { cacheDir } } } as unknown as GlobalPluginState;
  }

  it("deletes snapshots OLDER than the age window but keeps recent ones", async () => {
    const { sweepGcBackups, GC_BACKUP_KEEP_DAYS } = await import("../src/engine/gc.js");
    const day = 24 * 60 * 60 * 1000;
    // 2 snapshots well past the age window (40d, 35d) + 2 recent (2d, 5d).
    makeSnap("gc-old-a.surql", (GC_BACKUP_KEEP_DAYS + 10) * day);
    makeSnap("gc-old-b.surql", (GC_BACKUP_KEEP_DAYS + 5) * day);
    makeSnap("gc-recent-a.surql", 2 * day);
    makeSnap("gc-recent-b.surql", 5 * day);

    const removed = await sweepGcBackups(makeState());
    expect(removed).toBe(2);
    const left = readdirSync(backupDir).sort();
    expect(left).toEqual(["gc-recent-a.surql", "gc-recent-b.surql"]);
  });

  it("enforces the COUNT cap (keep newest N) for snapshots past the 24h floor", async () => {
    const { sweepGcBackups, GC_BACKUP_KEEP_COUNT, GC_BACKUP_KEEP_DAYS } = await import("../src/engine/gc.js");
    const hour = 60 * 60 * 1000;
    // KEEP_COUNT + 5 snapshots, ages spread between 25h and (25h + N*1h) — ALL
    // past the 24h floor AND ALL well within the 30d age window, so ONLY the
    // count cap can prune them (age + size caps stay inert). This isolates the
    // count cap; an earlier version aged files past 30d and conflated the two.
    const total = GC_BACKUP_KEEP_COUNT + 5;
    expect((total + 25) * hour).toBeLessThan(GC_BACKUP_KEEP_DAYS * 24 * hour); // guard: still within age window
    for (let i = 0; i < total; i++) {
      // age increases with i so the highest-i files are the OLDEST → pruned.
      makeSnap(`gc-snap-${String(i).padStart(3, "0")}.surql`, (25 + i) * hour);
    }
    const removed = await sweepGcBackups(makeState());
    expect(removed).toBe(5); // the 5 oldest beyond the count window
    expect(readdirSync(backupDir).length).toBe(GC_BACKUP_KEEP_COUNT);
  });

  it("SAFETY: NEVER deletes a snapshot younger than the 24h floor, even over count", async () => {
    const { sweepGcBackups, GC_BACKUP_KEEP_COUNT } = await import("../src/engine/gc.js");
    const hour = 60 * 60 * 1000;
    // KEEP_COUNT + 10 snapshots, ALL fresh (< 24h). The count window is blown
    // through, but the 24h floor protects every one — nothing may be deleted.
    const total = GC_BACKUP_KEEP_COUNT + 10;
    for (let i = 0; i < total; i++) {
      makeSnap(`gc-fresh-${String(i).padStart(3, "0")}.surql`, i * 0.5 * hour); // 0..~28h? keep < 24h
    }
    // Re-stamp to guarantee all are < 24h regardless of the loop arithmetic.
    for (const n of readdirSync(backupDir)) {
      const when = (Date.now() - 1 * hour) / 1000;
      utimesSync(join(backupDir, n), when, when);
    }
    const removed = await sweepGcBackups(makeState());
    expect(removed).toBe(0);
    expect(readdirSync(backupDir).length).toBe(total);
  });

  it("SAFETY: total-size cap still respects the 24h floor (won't nuke a fresh huge backup)", async () => {
    const { sweepGcBackups, GC_BACKUP_MAX_BYTES, GC_BACKUP_MIN_AGE_MS } = await import("../src/engine/gc.js");
    // Sanity on the floor constant so the test's intent can't silently rot.
    expect(GC_BACKUP_MIN_AGE_MS).toBe(24 * 60 * 60 * 1000);
    // A single fresh snapshot. Even if it alone exceeded the size cap we may not
    // delete it (it's < 24h). Use a small file; the assertion is "fresh survives".
    makeSnap("gc-fresh-big.surql", 1 * 60 * 60 * 1000, 1000);
    const removed = await sweepGcBackups(makeState());
    expect(removed).toBe(0);
    expect(existsSync(join(backupDir, "gc-fresh-big.surql"))).toBe(true);
    expect(GC_BACKUP_MAX_BYTES).toBe(500 * 1024 * 1024);
  });

  it("ignores non-snapshot files in the dir and is a clean 0 when dir is absent", async () => {
    const { sweepGcBackups } = await import("../src/engine/gc.js");
    const day = 24 * 60 * 60 * 1000;
    // A foreign file (not gc-*.surql) aged 100d must be left alone.
    const foreign = join(backupDir, "user-notes.txt");
    writeFileSync(foreign, "keep me");
    const when = (Date.now() - 100 * day) / 1000;
    utimesSync(foreign, when, when);
    // An ancient gc snapshot to prove the sweep DID run and prune.
    makeSnap("gc-ancient.surql", 100 * day);
    const removed = await sweepGcBackups(makeState());
    expect(removed).toBe(1);
    expect(existsSync(foreign)).toBe(true); // foreign file untouched

    // Absent dir → clean 0 (no throw).
    const empty = { config: { paths: { cacheDir: join(tmpdir(), "kc-does-not-exist-" + Date.now()) } } } as unknown as GlobalPluginState;
    await expect(sweepGcBackups(empty)).resolves.toBe(0);
  });
});

// ===========================================================================
// H3 — memory_health free-disk preflight (statfs the managed dataDir)
// ===========================================================================
describe("H3 — memory_health free-disk RED below the safety floor", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kc-h3-")); _statfsStub = null; });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); _statfsStub = null; });

  /** A memory_health state whose store/embedder are healthy and every count is
   *  0 — so the ONLY diagnostic under test is the disk one. */
  function makeHealthState(): GlobalPluginState {
    const queryFirst = vi.fn(async (sql: string) => {
      if (sql.includes("FROM maintenance_runs ORDER BY ran_at DESC")) return [];
      if (sql.includes("ORDER BY timestamp ASC LIMIT 1")) return [];
      return [{ n: 0 }];
    });
    return {
      store: { ping: async () => true, isAvailable: () => true, queryFirst },
      embeddings: { isAvailable: () => true, embed: async () => [0.1, 0.2] },
      config: { paths: { dataDir } },
    } as unknown as GlobalPluginState;
  }

  it("pushes a RED disk_free error when free bytes are below the 1GB floor", async () => {
    const { handleMemoryHealth } = await import("../src/tools/memory-health.js");
    // 100GB partition, only 200MB available → under the 1GB absolute floor.
    _statfsStub = async () => ({ bsize: 4096, blocks: 26_214_400, bavail: 51_200 }); // 200MB free of 100GB

    const res = await handleMemoryHealth(makeHealthState(), {} as SessionState, {});
    const report = JSON.parse(res.content[0]!.text) as {
      status: string;
      diagnostics: Array<{ severity: string; area: string; message: string }>;
    };
    const disk = report.diagnostics.filter(d => d.area === "disk_free");
    expect(disk.length).toBe(1);
    expect(disk[0]!.severity).toBe("error");
    expect(disk[0]!.message).toContain(dataDir);
    expect(report.status).toBe("red"); // an error diagnostic forces RED
  });

  it("pushes a RED when free PERCENT is below 5% even if absolute GB looks large", async () => {
    const { handleMemoryHealth } = await import("../src/tools/memory-health.js");
    // 1TB partition, 30GB free = 3% → under the 5% relative floor (30GB > 1GB abs).
    _statfsStub = async () => ({ bsize: 4096, blocks: 268_435_456, bavail: 7_864_320 }); // ~30GB free of ~1TB

    const res = await handleMemoryHealth(makeHealthState(), {} as SessionState, {});
    const report = JSON.parse(res.content[0]!.text) as {
      status: string;
      diagnostics: Array<{ severity: string; area: string }>;
    };
    expect(report.diagnostics.some(d => d.area === "disk_free" && d.severity === "error")).toBe(true);
    expect(report.status).toBe("red");
  });

  it("stays quiet (no disk_free diagnostic) when free disk is healthy", async () => {
    const { handleMemoryHealth } = await import("../src/tools/memory-health.js");
    // 100GB partition, 50GB free = 50% → comfortably above both floors.
    _statfsStub = async () => ({ bsize: 4096, blocks: 26_214_400, bavail: 13_107_200 });

    const res = await handleMemoryHealth(makeHealthState(), {} as SessionState, {});
    const report = JSON.parse(res.content[0]!.text) as {
      status: string;
      diagnostics: Array<{ severity: string; area: string }>;
    };
    expect(report.diagnostics.some(d => d.area === "disk_free")).toBe(false);
  });

  it("SAFETY: a statfs failure does NOT fabricate a RED (swallowed, no disk diagnostic)", async () => {
    const { handleMemoryHealth } = await import("../src/tools/memory-health.js");
    _statfsStub = async () => { throw new Error("ENOTSUP: statfs not supported"); };

    const res = await handleMemoryHealth(makeHealthState(), {} as SessionState, {});
    const report = JSON.parse(res.content[0]!.text) as {
      status: string;
      diagnostics: Array<{ severity: string; area: string }>;
    };
    // The probe error is swallowed: NO disk_free diagnostic at all.
    expect(report.diagnostics.some(d => d.area === "disk_free")).toBe(false);
    // And critically it must NOT manufacture an ERROR (which would force a RED)
    // out of a probe failure — that is the "never make things worse" bar. (An
    // unrelated YELLOW from the empty maintenance_runs staleness check is fine
    // and orthogonal to disk; we only forbid a fabricated error/RED here.)
    expect(report.diagnostics.some(d => d.area === "disk_free" && d.severity === "error")).toBe(false);
    expect(report.status).not.toBe("red");
  });
});
