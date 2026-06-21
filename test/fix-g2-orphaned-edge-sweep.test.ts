/**
 * G2 — gcSweepOrphanedEdges acceptance tests.
 *
 * The orphaned-edge sweep deletes EDGE rows whose `in` OR `out` endpoint record
 * is ABSENT (in.id IS NONE OR out.id IS NONE) — true danglers, NOT soft-tagged
 * (those still exist and are read-filtered by G3). Verified live: 309 removed,
 * partition-clean, independent re-count 0. These guard the function's contract:
 * snapshot-before-delete, after-verify throws if a table's both-live count
 * DROPPED (a live edge wrongly removed), and the dryRun path deletes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcSweepOrphanedEdges } from "../src/engine/gc.js";

/** Scriptable mock: per-table orphan rows + a both-live baseline. A DELETE on a
 *  table clears its orphans (or, if `dropLive` is set for it, also drops its
 *  both-live count to simulate a wrongly-removed live edge → after-verify throws). */
function makeMock(opts: {
  orphans: Record<string, Array<Record<string, unknown>>>;
  live: Record<string, number>;
  dropLiveOnDelete?: string;
  cacheDir: string;
}) {
  const deleted = new Set<string>();
  const execLog: string[] = [];
  const store = {
    async queryFirst<T>(sql: string): Promise<T[]> {
      const orphSel = sql.match(/SELECT \* FROM (\w+) WHERE in\.id IS NONE/);
      if (orphSel) {
        const tb = orphSel[1];
        return (deleted.has(tb) ? [] : (opts.orphans[tb] ?? [])) as unknown as T[];
      }
      const liveCount = sql.match(/SELECT count\(\) AS n FROM (\w+) WHERE in\.id IS NOT NONE/);
      if (liveCount) {
        const tb = liveCount[1];
        const base = opts.live[tb] ?? 0;
        const now = deleted.has(tb) && tb === opts.dropLiveOnDelete ? base - 1 : base;
        return [{ n: now }] as unknown as T[];
      }
      const orphCount = sql.match(/SELECT count\(\) AS n FROM (\w+) WHERE in\.id IS NONE/);
      if (orphCount) {
        const tb = orphCount[1];
        return [{ n: deleted.has(tb) ? 0 : (opts.orphans[tb]?.length ?? 0) }] as unknown as T[];
      }
      return [] as unknown as T[];
    },
    async queryExec(sql: string): Promise<void> {
      execLog.push(sql);
      const del = sql.match(/DELETE (\w+) WHERE in\.id IS NONE/);
      if (del) deleted.add(del[1]);
    },
  };
  const state = { store, config: { paths: { cacheDir: opts.cacheDir } } } as unknown as import("../src/engine/state.js").GlobalPluginState;
  return { state, execLog };
}

describe("G2 gcSweepOrphanedEdges", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "kc-g2-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("snapshots, deletes only orphans, after-verifies, returns exact counts", async () => {
    const mock = makeMock({
      cacheDir: tmp,
      orphans: {
        related_to: [{ id: "related_to:o1", in: "concept:gone", out: "concept:keep" }],
        broader: [{ id: "broader:o2", in: "concept:keep", out: "concept:gone2" }],
      },
      live: { related_to: 100, broader: 50 },
    });
    const res = await gcSweepOrphanedEdges(mock.state, { reason: "test" });
    expect(res.orphaned).toBe(2);
    expect(res.removed).toBe(2);
    expect(res.perTable).toEqual({ related_to: 1, broader: 1 });
    // Snapshot written, with the orphan edges captured.
    const files = readdirSync(join(tmp, "gc-backups"));
    expect(files.length).toBe(1);
    const snap = readFileSync(join(tmp, "gc-backups", files[0]), "utf-8");
    expect(snap).toContain("related_to:o1");
    // A DELETE ran for each orphan table.
    expect(mock.execLog.some(s => /DELETE related_to WHERE in\.id IS NONE/.test(s))).toBe(true);
  });

  it("dryRun snapshots but deletes NOTHING", async () => {
    const mock = makeMock({
      cacheDir: tmp,
      orphans: { related_to: [{ id: "related_to:o1", in: "concept:gone", out: "concept:keep" }] },
      live: { related_to: 100 },
    });
    const res = await gcSweepOrphanedEdges(mock.state, { dryRun: true, reason: "dry" });
    expect(res.orphaned).toBe(1);
    expect(res.removed).toBe(0);
    expect(mock.execLog.some(s => /^DELETE /.test(s))).toBe(false);
    expect(readdirSync(join(tmp, "gc-backups")).length).toBe(1); // snapshot still written
  });

  it("THROWS if a table's both-live count DROPS (a live edge was wrongly removed)", async () => {
    const mock = makeMock({
      cacheDir: tmp,
      orphans: { related_to: [{ id: "related_to:o1", in: "concept:gone", out: "concept:keep" }] },
      live: { related_to: 100 },
      dropLiveOnDelete: "related_to", // simulate the delete also nuking a live edge
    });
    await expect(
      gcSweepOrphanedEdges(mock.state, { reason: "bad" }),
    ).rejects.toThrow(/both-live DROPPED|after-verify FAILED/);
  });

  it("no-ops cleanly when there are zero orphans", async () => {
    const mock = makeMock({ cacheDir: tmp, orphans: {}, live: { related_to: 100 } });
    const res = await gcSweepOrphanedEdges(mock.state, { reason: "clean" });
    expect(res).toMatchObject({ orphaned: 0, removed: 0, snapshot: "" });
  });
});
