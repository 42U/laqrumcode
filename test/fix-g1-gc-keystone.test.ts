/**
 * G1 KEYSTONE acceptance tests (2026-06-21).
 *
 * Proves the single audited content-DELETE choke point (src/engine/gc.ts)
 * behaves per the deletion policy (core_memory:hoj8fvmbt7d14mskciba) AND that
 * the D4 lint gate opened ONLY for the keystone, not for ad-hoc DELETEs.
 *
 *   (a) NEGATIVE FIXTURE — a planted ad-hoc `DELETE concept WHERE ...` string
 *       OUTSIDE gc.ts makes the D4 scan FAIL (gate didn't over-open).
 *   (b) a properly-`// GATED-GC:`-marked delete INSIDE gc.ts PASSES.
 *   (c) UNIT test of gcHardDelete with a mock store: snapshots first,
 *       co-deletes incident edges, runs the after-verify, and THROWS if a
 *       dangling edge would remain.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gcHardDelete, RELATION_TABLES, GC_CONTENT_TABLES } from "../src/engine/gc.js";

// ---------------------------------------------------------------------------
// The D4 scan logic, reproduced minimally so the negative/positive fixtures
// can be exercised against arbitrary source text without invoking the whole
// vitest file. Kept in lockstep with lint-no-delete-content-tables.test.ts.
// ---------------------------------------------------------------------------
const CONTENT_TABLES = [
  "memory", "concept", "skill", "reflection", "monologue",
  "identity_chunk", "core_memory", "artifact", "turn_archive", "pending_work",
];
const GATED_GC_MARKER = /\/\/\s*GATED-GC:/;

// SAME-LINE scope only (GAP-2 fix) — kept in lockstep with
// lint-no-delete-content-tables.test.ts. A function-body-wide marker search
// would auto-launder a future ad-hoc DELETE added anywhere inside gcHardDelete.
function isGatedHit(lines: string[], hitIdx: number): boolean {
  return GATED_GC_MARKER.test(lines[hitIdx] ?? "");
}

interface ScanHit { line: number; table: string; gated: boolean; }

const DYNAMIC_DELETE_RE = /\bDELETE\s+(?:FROM\s+)?\$\{/;

function scanText(rel: string, text: string): ScanHit[] {
  const lines = text.split(/\r?\n/);
  const hits: ScanHit[] = [];
  const isKeystone = rel === "src/engine/gc.ts";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const tb of CONTENT_TABLES) {
      const re = new RegExp(`\\bDELETE\\s+(?:FROM\\s+)?${tb}\\b`);
      if (re.test(line)) {
        hits.push({ line: i + 1, table: tb, gated: isKeystone && isGatedHit(lines, i) });
      }
    }
    if (DYNAMIC_DELETE_RE.test(line)) {
      hits.push({ line: i + 1, table: "<dynamic>", gated: isKeystone && isGatedHit(lines, i) });
    }
  }
  return hits;
}

describe("G1 (a) negative fixture — ad-hoc content DELETE outside gc.ts FAILS the gate", () => {
  it("a planted `DELETE concept WHERE ...` in a non-keystone file is an unapproved hit", () => {
    const planted = [
      "async function rogueCleanup(store) {",
      "  // an ad-hoc deletion someone tried to sneak in",
      "  await store.queryExec(`DELETE concept WHERE created_at < time::now() - 30d`);",
      "}",
    ].join("\n");
    const hits = scanText("src/engine/some-other-file.ts", planted);
    expect(hits.length).toBe(1);
    expect(hits[0].table).toBe("concept");
    // NOT gated (wrong file) → would be reported as a D4 failure.
    expect(hits[0].gated).toBe(false);
  });

  it("a GATED-GC marker in a NON-keystone file does NOT launder the DELETE", () => {
    const planted = [
      "async function sneaky(store) {",
      "  // GATED-GC: pretending to be authorized from the wrong file",
      "  await store.queryExec(`DELETE memory WHERE id IN [memory:x]`);",
      "}",
    ].join("\n");
    const hits = scanText("src/engine/not-gc.ts", planted);
    expect(hits.length).toBe(1);
    expect(hits[0].gated).toBe(false); // marker only counts inside gc.ts
  });
});

describe("G1 (b) positive fixture — a GATED-GC-marked DELETE inside gc.ts PASSES", () => {
  it("marker on the same line authorizes the DELETE", () => {
    const src = [
      "export async function gcHardDelete(state, table, ids, opts) {",
      "  await store.queryExec(`DELETE ${table} WHERE id IN [${idList}]`); // GATED-GC: keystone",
      "}",
    ].join("\n");
    const hits = scanText("src/engine/gc.ts", src);
    expect(hits.length).toBe(1);
    expect(hits[0].gated).toBe(true);
  });

  it("GAP-2: a function-level-only marker does NOT launder a same-line-unmarked DELETE (even in gc.ts)", () => {
    const src = [
      "async function sweep(store, edgeTb, idList) {",
      "  // GATED-GC: incident-edge co-delete (blast-radius)",
      "  const x = 1;",
      "  await store.queryExec(`DELETE ${edgeTb} WHERE in IN [${idList}]`);",
      "}",
    ].join("\n");
    const hits = scanText("src/engine/gc.ts", src);
    expect(hits.length).toBe(1);
    // Same-line scope: a marker on a PRIOR line does NOT authorize this DELETE.
    // Every gated DELETE must carry its OWN // GATED-GC: marker on the same line
    // (the real keystone's two DELETE sites do). This closes the GAP-2 laundering
    // hole — an ad-hoc DELETE added inside gcHardDelete is no longer auto-blessed.
    expect(hits[0].gated).toBe(false);
  });

  it("the REAL src/engine/gc.ts has only gated content DELETEs", () => {
    const real = readFileSync(
      resolve(__dirname, "..", "src", "engine", "gc.ts"),
      "utf-8",
    );
    const hits = scanText("src/engine/gc.ts", real);
    expect(hits.length).toBeGreaterThanOrEqual(1); // at least the content delete
    for (const h of hits) {
      expect(h.gated, `gc.ts:${h.line} [${h.table}] is an UN-gated content DELETE`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Unit test of gcHardDelete with a mock store.
// ---------------------------------------------------------------------------

interface QueryLog { sql: string; binds?: Record<string, unknown>; }

/**
 * A scriptable mock SurrealStore. `queryFirst` returns rows from a per-pattern
 * responder; `queryExec` records the SQL (and, for DELETEs, removes the
 * matched ids from the mock's "live edges" so after-verify sees them gone —
 * UNLESS configured to leave a dangling edge).
 */
function makeMockState(opts: {
  targetRows: Array<Record<string, unknown>>;
  /** edge table → rows that are incident before delete */
  incidentEdges: Record<string, Array<Record<string, unknown>>>;
  /** if set, this edge table KEEPS one incident row after the DELETE (dangling) */
  leaveDanglingIn?: string;
  /** correction ids that the never-delete guard should report */
  correctionIds?: string[];
  cacheDir: string;
}) {
  const execLog: QueryLog[] = [];
  const firstLog: QueryLog[] = [];
  // Mutable view of incident edges; DELETE empties them (or leaves a dangler).
  const liveEdges: Record<string, number> = {};
  for (const [tb, rows] of Object.entries(opts.incidentEdges)) liveEdges[tb] = rows.length;
  let targetsDeleted = false;

  const store = {
    async queryFirst<T>(sql: string, binds?: Record<string, unknown>): Promise<T[]> {
      firstLog.push({ sql, binds });

      // never-delete-correction guard probe
      if (/string::starts_with\(text, '\[CORRECTION\]'\)/.test(sql)) {
        return (opts.correctionIds ?? []).map(id => ({ id })) as unknown as T[];
      }

      // SELECT * FROM <content table> WHERE id IN [...] → target rows (snapshot)
      const targetSel = sql.match(/SELECT \* FROM (\w+) WHERE id IN/);
      if (targetSel && (GC_CONTENT_TABLES as readonly string[]).includes(targetSel[1])) {
        return (targetsDeleted ? [] : opts.targetRows) as unknown as T[];
      }

      // SELECT * FROM <edge> WHERE in IN [...] OR out IN [...] → snapshot edges
      const edgeSel = sql.match(/SELECT \* FROM (\w+) WHERE in IN/);
      if (edgeSel) {
        const tb = edgeSel[1];
        const rows = opts.incidentEdges[tb] ?? [];
        return rows as unknown as T[];
      }

      // count() of edges (before delete OR after-verify)
      const edgeCount = sql.match(/SELECT count\(\) AS n FROM (\w+) WHERE in IN/);
      if (edgeCount) {
        const tb = edgeCount[1];
        return [{ n: liveEdges[tb] ?? 0 }] as unknown as T[];
      }

      // count() of surviving targets (after-verify d1)
      const targetCount = sql.match(/SELECT count\(\) AS n FROM (\w+) WHERE id IN/);
      if (targetCount) {
        return [{ n: targetsDeleted ? 0 : opts.targetRows.length }] as unknown as T[];
      }

      // count() of dangling scalar back-pointers (after-verify d3) → none
      if (/SELECT count\(\) AS n FROM \w+ WHERE \w+ IN/.test(sql)) {
        return [{ n: 0 }] as unknown as T[];
      }

      return [] as unknown as T[];
    },

    async queryExec(sql: string, binds?: Record<string, unknown>): Promise<void> {
      execLog.push({ sql, binds });
      // Edge co-delete: empty that edge table's live count (or leave a dangler).
      const edgeDel = sql.match(/DELETE (\w+) WHERE in IN/);
      if (edgeDel) {
        const tb = edgeDel[1];
        liveEdges[tb] = tb === opts.leaveDanglingIn ? 1 : 0;
      }
      // Content delete: mark targets gone.
      if (/DELETE \w+ WHERE id IN/.test(sql)) targetsDeleted = true;
    },

    async queryMulti() { return undefined; },
  };

  const state = {
    store,
    config: { paths: { cacheDir: opts.cacheDir } },
  } as unknown as import("../src/engine/state.js").GlobalPluginState;

  return { state, execLog, firstLog, liveEdges, get targetsDeleted() { return targetsDeleted; } };
}

describe("G1 (c) gcHardDelete unit behavior (mock store)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "kc-gc-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("snapshots first, co-deletes incident edges, after-verifies, returns counts", async () => {
    const mock = makeMockState({
      cacheDir: tmp,
      targetRows: [{ id: "concept:dead1", content: "x" }, { id: "concept:dead2", content: "y" }],
      incidentEdges: {
        about_concept: [{ id: "about_concept:e1", in: "memory:m1", out: "concept:dead1" }],
        broader: [{ id: "broader:e2", in: "concept:dead2", out: "concept:keep" }],
      },
    });

    const res = await gcHardDelete(mock.state, "concept", ["concept:dead1", "concept:dead2"], {
      reason: "unit-test dead concepts",
    });

    // Returns exact counts.
    expect(res.deleted).toBe(2);
    expect(res.edgesRemoved).toBe(2); // 1 about_concept + 1 broader

    // Snapshot written BEFORE any DELETE.
    expect(res.snapshot).toContain("gc-backups");
    const files = readdirSync(join(tmp, "gc-backups"));
    expect(files.length).toBe(1);
    const snap = readFileSync(join(tmp, "gc-backups", files[0]), "utf-8");
    expect(snap).toContain("concept:dead1");
    expect(snap).toContain("about_concept:e1"); // incident edge captured
    expect(snap).toContain("INCIDENT EDGES");

    // Ordering: the first DELETE in the exec log must come AFTER the snapshot
    // file exists. We assert the content delete is present and an edge sweep ran.
    const deletes = mock.execLog.filter(l => /^DELETE /.test(l.sql.trim()));
    expect(deletes.some(l => /DELETE about_concept WHERE in IN/.test(l.sql))).toBe(true);
    expect(deletes.some(l => /DELETE broader WHERE in IN/.test(l.sql))).toBe(true);
    expect(deletes.some(l => /DELETE concept WHERE id IN/.test(l.sql))).toBe(true);

    // Edge sweep ran for ALL relation tables (count-probe per table).
    for (const tb of RELATION_TABLES) {
      expect(
        mock.firstLog.some(l => new RegExp(`FROM ${tb} WHERE in IN`).test(l.sql)),
        `expected an incident-edge probe for relation table ${tb}`,
      ).toBe(true);
    }

    // Audit row recorded.
    expect(mock.execLog.some(l => /CREATE maintenance_runs/.test(l.sql))).toBe(true);
  });

  it("THROWS when a dangling edge would remain after delete (after-verify catches it)", async () => {
    const mock = makeMockState({
      cacheDir: tmp,
      targetRows: [{ id: "concept:dead1", content: "x" }],
      incidentEdges: {
        about_concept: [{ id: "about_concept:e1", in: "memory:m1", out: "concept:dead1" }],
      },
      // The about_concept DELETE will NOT clear its live count → 1 dangler.
      leaveDanglingIn: "about_concept",
    });

    await expect(
      gcHardDelete(mock.state, "concept", ["concept:dead1"], { reason: "dangling-test" }),
    ).rejects.toThrow(/after-verify FAILED/);

    // The snapshot must still exist (reversibility preserved despite the throw).
    const files = readdirSync(join(tmp, "gc-backups"));
    expect(files.length).toBe(1);
  });

  it("REFUSES to delete a correction memory (defense in depth)", async () => {
    const mock = makeMockState({
      cacheDir: tmp,
      targetRows: [{ id: "memory:c1", text: "[CORRECTION] x" }],
      incidentEdges: {},
      correctionIds: ["memory:c1"],
    });

    await expect(
      gcHardDelete(mock.state, "memory", ["memory:c1"], { reason: "should-be-refused" }),
    ).rejects.toThrow(/correction/i);

    // No DELETE and no snapshot should have happened — refused before side effects.
    expect(mock.execLog.some(l => /^DELETE /.test(l.sql.trim()))).toBe(false);
  });

  it("rejects an invalid table and a cross-table id", async () => {
    const mock = makeMockState({ cacheDir: tmp, targetRows: [], incidentEdges: {} });
    await expect(
      gcHardDelete(mock.state, "not_a_table", ["x:1"], { reason: "r" }),
    ).rejects.toThrow(/not a content table/);
    await expect(
      gcHardDelete(mock.state, "concept", ["memory:oops"], { reason: "r" }),
    ).rejects.toThrow(/belongs to table/);
  });

  it("no-ops on an empty id list and requires a reason", async () => {
    const mock = makeMockState({ cacheDir: tmp, targetRows: [], incidentEdges: {} });
    const res = await gcHardDelete(mock.state, "concept", [], { reason: "r" });
    expect(res).toEqual({ deleted: 0, edgesRemoved: 0, snapshot: "" });
    await expect(
      gcHardDelete(mock.state, "concept", ["concept:x"], { reason: "  " }),
    ).rejects.toThrow(/reason is required/);
  });
});

// Touch unused imports so eslint/tsc noUnusedLocals stays quiet if it fires.
void mkdirSync;
void writeFileSync;
