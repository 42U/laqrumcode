import { describe, it, expect, vi } from "vitest";
import {
  findBestProjectMatch,
  synthesizePlaceholderTask,
  recoverProjectIdRows,
  recoverDaemonOrphans,
  runFullRecovery,
} from "../src/engine/recovery.js";
import type { SurrealStore } from "../src/engine/surreal.js";

/** Regression for v0.7.40 recovery helpers — extracted from
 *  introspect.ts migrate handlers so the recovery primitives are
 *  reusable from maintenance/auto-run/post-import contexts. Tests pin
 *  the public-facing helper contracts. */

describe("findBestProjectMatch", () => {
  it("returns the highest-similarity project above threshold", () => {
    const a = [1, 0, 0];
    const centroids = new Map<string, number[]>([
      ["project:a", [1, 0, 0]],   // perfect match
      ["project:b", [0, 1, 0]],   // orthogonal
      ["project:c", [0.7, 0.7, 0]], // partial
    ]);
    const result = findBestProjectMatch(a, centroids);
    expect(result?.projectId).toBe("project:a");
    expect(result?.similarity).toBeCloseTo(1.0, 2);
  });

  it("returns null when no project meets threshold", () => {
    const a = [1, 0, 0];
    const centroids = new Map<string, number[]>([
      ["project:far", [0, 1, 0]], // sim=0
    ]);
    expect(findBestProjectMatch(a, centroids, 0.5)).toBeNull();
  });

  it("returns null on empty centroid map", () => {
    expect(findBestProjectMatch([1, 0, 0], new Map(), 0.5)).toBeNull();
  });
});

describe("synthesizePlaceholderTask", () => {
  function setup(opts: { existingId?: string }) {
    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM task WHERE description = $desc")) {
        return opts.existingId ? [{ id: opts.existingId }] : [];
      }
      return [];
    });
    const createTask = vi.fn().mockResolvedValue("task:new123");
    const store = { queryFirst, createTask } as unknown as SurrealStore;
    return { store, queryFirst, createTask };
  }

  it("returns existing placeholder id when one exists for the kc_session_id", async () => {
    const { store, createTask } = setup({ existingId: "task:existing" });
    const id = await synthesizePlaceholderTask(store, "abc-uuid");
    expect(id).toBe("task:existing");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("creates a new placeholder task when none exists", async () => {
    const { store, createTask } = setup({});
    const id = await synthesizePlaceholderTask(store, "abc-uuid");
    expect(id).toBe("task:new123");
    expect(createTask).toHaveBeenCalledWith(
      "[pre-substrate import] session abc-uuid",
    );
  });

  it("returns null on store error (best-effort, doesn't throw)", async () => {
    const queryFirst = vi.fn().mockRejectedValue(new Error("db down"));
    const createTask = vi.fn();
    const store = { queryFirst, createTask } as unknown as SurrealStore;
    const id = await synthesizePlaceholderTask(store, "abc-uuid");
    expect(id).toBeNull();
  });
});

describe("recoverProjectIdRows — return shape contract", () => {
  it("returns the documented shape with all six tables + centroid + globals counters", async () => {
    const queryFirst = vi.fn().mockResolvedValue([]);
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const store = { queryFirst, queryExec } as unknown as SurrealStore;

    const result = await recoverProjectIdRows(store);
    expect(result).toMatchObject({
      tasks: { found: 0, fixed: 0 },
      sessions: { found: 0, fixed: 0 },
      concepts: { found: 0, fixed: 0 },
      memories: { found: 0, fixed: 0 },
      reflections: { found: 0, fixed: 0 },
      skills: { found: 0, fixed: 0 },
      centroidAssigned: 0,
      centroidScanned: 0,
      globalsTagged: 0,
    });
  });

  it("issues UPDATE for each backfillable row and increments fixed counter", async () => {
    // Mock the SELECT-returning-rows path for the FIRST table only (tasks).
    // The remaining selects return [] so we can isolate the assertion.
    let selectCallIndex = 0;
    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      selectCallIndex++;
      // First call is the tasks select — return two rows with project_id set.
      if (selectCallIndex === 1 && sql.includes("FROM task WHERE project_id IS NONE")) {
        return [
          { id: "task:abc123", project_id: "project:foo" },
          { id: "task:xyz789", project_id: "project:bar" },
        ];
      }
      return [];
    });
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const store = { queryFirst, queryExec } as unknown as SurrealStore;

    const result = await recoverProjectIdRows(store);
    expect(result.tasks.found).toBe(2);
    expect(result.tasks.fixed).toBe(2);
    // Both rows should have triggered an UPDATE with their project_id.
    const updates = queryExec.mock.calls.filter(c => String(c[0]).startsWith("UPDATE task:"));
    expect(updates.length).toBe(2);
    expect(updates[0][1]).toMatchObject({ pid: "project:foo" });
    expect(updates[1][1]).toMatchObject({ pid: "project:bar" });
  });

  it("rejects malformed record ids (regex guard) — found but NOT fixed", async () => {
    // Rows whose id doesn't match the RECORD_ID_RE pattern should be counted
    // as 'found' but skipped from UPDATE. This is the injection guard.
    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM task WHERE project_id IS NONE")) {
        return [
          { id: "task:abc123", project_id: "project:safe" },
          { id: "task:bad-id; DROP TABLE task--", project_id: "project:unsafe" },
          { id: "garbage no-colon", project_id: "project:unsafe2" },
          { id: "", project_id: "project:unsafe3" },
        ];
      }
      return [];
    });
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const store = { queryFirst, queryExec } as unknown as SurrealStore;

    const result = await recoverProjectIdRows(store);
    expect(result.tasks.found).toBe(4);
    // Only the well-formed id should have produced an UPDATE.
    const updates = queryExec.mock.calls.filter(c => String(c[0]).startsWith("UPDATE task:"));
    expect(updates.length).toBe(1);
    expect(result.tasks.fixed).toBe(1);
  });

  it("UPDATE failure is swallowed — fixed counter does NOT increment but found does", async () => {
    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM task WHERE project_id IS NONE")) {
        return [
          { id: "task:abc123", project_id: "project:foo" },
          { id: "task:def456", project_id: "project:bar" },
        ];
      }
      return [];
    });
    let exCount = 0;
    const queryExec = vi.fn().mockImplementation(async () => {
      exCount++;
      if (exCount === 1) throw new Error("network blip");
      return undefined;
    });
    const store = { queryFirst, queryExec } as unknown as SurrealStore;

    const result = await recoverProjectIdRows(store);
    expect(result.tasks.found).toBe(2);
    // First UPDATE threw → fixed counter only reflects the second success.
    expect(result.tasks.fixed).toBe(1);
  });

  it("tags scope='global' for rows that have no project_id and no embedding-based match", async () => {
    // Simulate: tasks/sessions/concepts/memories/reflections/skillsViaTask/skillsViaSession all empty (returns []),
    // centroid computation returns nothing (no projects), then the globals-fallback
    // pass finds orphan memory rows and tags them with scope='global'.
    let callIdx = 0;
    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      callIdx++;
      // The globals-tag fallback queries 'FROM type::table($t) WHERE project_id IS NONE AND (scope IS NONE OR scope != 'global')'.
      if (sql.includes("WHERE project_id IS NONE AND (scope IS NONE OR scope != 'global')")) {
        return [{ id: "memory:abc" }, { id: "memory:def" }];
      }
      return [];
    });
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const store = { queryFirst, queryExec } as unknown as SurrealStore;

    const result = await recoverProjectIdRows(store);
    expect(result.globalsTagged).toBeGreaterThanOrEqual(2);
    const globalsUpdates = queryExec.mock.calls.filter(c => String(c[0]).includes("scope = 'global'"));
    expect(globalsUpdates.length).toBeGreaterThanOrEqual(2);
  });
});

describe("recoverDaemonOrphans — return shape contract", () => {
  it("returns the documented shape with gem + daemon + synthesis counters", async () => {
    const queryFirst = vi.fn().mockResolvedValue([]);
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const relate = vi.fn().mockResolvedValue(undefined);
    const createTask = vi.fn().mockResolvedValue("task:placeholder");
    const store = { queryFirst, queryExec, relate, createTask } as unknown as SurrealStore;

    const result = await recoverDaemonOrphans(store);
    expect(result).toMatchObject({
      gemOrphans: 0,
      gemEdgesCreated: 0,
      missingArtifact: 0,
      daemonOrphans: 0,
      daemonEdgesResolved: 0,
      daemonEdgesSynthesized: 0,
      synthesizedPlaceholders: 0,
      missingTask: 0,
      relateFailed: 0,
    });
  });
});

describe("runFullRecovery — orchestrator", () => {
  it("returns combined { projectId, derivedFrom } shape", async () => {
    const queryFirst = vi.fn().mockResolvedValue([]);
    const queryExec = vi.fn().mockResolvedValue(undefined);
    const relate = vi.fn().mockResolvedValue(undefined);
    const createTask = vi.fn().mockResolvedValue("task:placeholder");
    const store = { queryFirst, queryExec, relate, createTask } as unknown as SurrealStore;

    const result = await runFullRecovery(store);
    expect(result.projectId).toBeDefined();
    expect(result.derivedFrom).toBeDefined();
    expect(result.projectId.tasks).toEqual({ found: 0, fixed: 0 });
    expect(result.derivedFrom.gemOrphans).toBe(0);
  });
});
