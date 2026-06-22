/**
 * C1 + C2 — managed-SurrealDB child supervision (src/engine/bootstrap.ts).
 *
 * C1: before this fix the managed SurrealDB child was spawned detached + unref'd
 * with NO 'exit'/'error' listener anywhere, and bootstrap() runs once — a child
 * that died (power loss recovery, OOM, crash) was a PERMANENT SILENT failure
 * (ensureConnected reconnects the WS but never re-spawns the OS process). The
 * supervisor now respawns a dead child with bounded exponential backoff.
 *
 * C2 (safety-first): if respawns crash-loop (>= SUPERVISOR_MAX_RESTARTS within
 * SUPERVISOR_WINDOW_MS — the store is likely corrupt / unstartable), the
 * supervisor STOPS respawning, enters a loud DEGRADED state, and surfaces it via
 * a maintenance_runs row (job='surrealSupervisor', status='error') so
 * memory_health goes RED. It NEVER auto-deletes / quarantines the data dir.
 *
 * These tests mock node:child_process (the spawn seam) + fs so no real DB or
 * process is touched, and drive the supervisor directly via the exported
 * spawnManagedSurreal(). Fake timers advance the backoff deterministically.
 *
 * SAFETY ASSERTIONS (the bar for this lane):
 *  - intentional shutdown does NOT respawn (no infinite loop on teardown);
 *  - the crash-loop cap STOPS respawns (no fork bomb);
 *  - degraded surfacing writes ONLY a maintenance_runs row — it never issues a
 *    DELETE / REMOVE against the data dir (no auto-destruction of user data).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mock node:child_process so spawn() returns a controllable fake child. ──
// Each spawn() returns a fresh EventEmitter-backed child whose 'exit'/'error'
// the test can emit. We record every spawned child so the test can assert the
// respawn count and drive successive deaths.
//
// vi.mock factories are hoisted above all module-level code, so the shared mock
// state (the spawn fn + the children registry) MUST be created inside
// vi.hoisted() to be initialized before the factory references it.
class FakeChild extends EventEmitter {
  pid: number;
  killed = false;
  unref = vi.fn();
  kill = vi.fn((_sig?: string) => {
    this.killed = true;
    return true;
  });
  constructor(seq: number) {
    super();
    this.pid = 1000 + seq;
  }
}

const { spawnedChildren, spawnMock } = vi.hoisted(() => {
  const children: FakeChild[] = [];
  const mock = vi.fn(() => {
    // FakeChild is referenced lazily inside the fn body (called only at runtime,
    // after the class is defined), so this is safe despite hoisting.
    const child = new FakeChild(children.length);
    children.push(child);
    return child;
  });
  return { spawnedChildren: children, spawnMock: mock };
});

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

// fs / fs/promises: spawnManagedSurreal calls mkdir (fs/promises), chmodSync
// (fs), and writeSurrealPidFile→writeFile (fs/promises). Stub them so nothing
// touches disk. We keep the rest of fs intact for any incidental use.
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, chmodSync: vi.fn() };
});
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) };
});

import {
  spawnManagedSurreal,
  shutdownManagedSurreal,
  registerSurrealSupervisorStore,
  __resetSupervisorForTest,
  __getSupervisorState,
} from "../src/engine/bootstrap.js";

const ARGS = ["/fake/surreal", "/fake/data/dir", 18999, "kong_x", "secret", "/fake/cache"] as const;

beforeEach(() => {
  spawnedChildren.length = 0;
  spawnMock.mockClear();
  __resetSupervisorForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  __resetSupervisorForTest();
  vi.restoreAllMocks();
});

describe("C1 — managed SurrealDB child is supervised + respawned", () => {
  it("respawns the child on an unexpected 'exit' (bounded backoff)", async () => {
    await spawnManagedSurreal(...ARGS);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const first = spawnedChildren[0];

    // Child dies unexpectedly (NOT during shutdown).
    first.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0); // handler runs to its backoff await

    // No respawn yet — it's waiting out the backoff.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Advance past the first backoff (500ms) — respawn fires.
    await vi.advanceTimersByTimeAsync(600);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(__getSupervisorState().degraded).toBe(false);
  });

  it("respawns on a spawn-level 'error' event too", async () => {
    await spawnManagedSurreal(...ARGS);
    spawnedChildren[0].emit("error", new Error("EACCES"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe("C1 safety — intentional shutdown does NOT respawn", () => {
  it("a child 'exit' AFTER shutdownManagedSurreal({force}) is ignored", async () => {
    await spawnManagedSurreal(...ARGS);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Operator teardown: sets the shuttingDown flag + SIGTERMs the child.
    shutdownManagedSurreal({ force: true });
    expect(__getSupervisorState().shuttingDown).toBe(true);

    // The SIGTERM produces an exit — must NOT respawn.
    spawnedChildren[0].emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("the non-force (Option A detach) shutdown also suppresses respawn", async () => {
    await spawnManagedSurreal(...ARGS);
    shutdownManagedSurreal(); // detach, leave child alive, stop owning it
    expect(__getSupervisorState().shuttingDown).toBe(true);
    spawnedChildren[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("a shutdown DURING the backoff window aborts the pending respawn", async () => {
    await spawnManagedSurreal(...ARGS);
    spawnedChildren[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0); // now waiting out the backoff
    // Operator tears down before the backoff elapses.
    shutdownManagedSurreal({ force: true });
    await vi.advanceTimersByTimeAsync(10_000);
    // Respawn must have been aborted post-backoff by the shuttingDown re-check.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("C2 — crash-loop cap stops respawns + surfaces DEGRADED (never destroys data)", () => {
  it(">= 5 rapid exits trips the cap: no further respawn + a surrealSupervisor error row, and NO data-dir DELETE", async () => {
    const queryExec = vi.fn(async () => undefined);
    registerSurrealSupervisorStore({ isAvailable: () => true, queryExec });

    await spawnManagedSurreal(...ARGS); // spawn #1

    // Drive successive deaths. Each respawn yields a new child we then kill,
    // until the window count reaches SUPERVISOR_MAX_RESTARTS (5) and the cap
    // trips — at which point no further spawn happens.
    // Backoffs: 500,1000,2000,4000 then the 5th exit trips the cap (no respawn).
    const backoffs = [500, 1000, 2000, 4000];
    for (let i = 0; i < backoffs.length; i++) {
      const child = spawnedChildren[spawnedChildren.length - 1];
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(backoffs[i] + 50);
    }
    // We have now respawned 4 times (spawn calls = 1 initial + 4 respawns = 5).
    expect(spawnMock).toHaveBeenCalledTimes(5);
    expect(__getSupervisorState().degraded).toBe(false);

    // The 5th unexpected exit reaches the cap (5 within the 60s window) → STOP.
    const last = spawnedChildren[spawnedChildren.length - 1];
    last.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(__getSupervisorState().degraded).toBe(true);
    // No new child spawned after the cap.
    expect(spawnMock).toHaveBeenCalledTimes(5);

    // C2 surfacing: a maintenance_runs error row for job='surrealSupervisor'.
    expect(queryExec).toHaveBeenCalled();
    const supervisorWrite = queryExec.mock.calls.find(
      ([sql, bindings]: [string, any]) =>
        /CREATE\s+maintenance_runs/i.test(sql) && bindings?.data?.job === "surrealSupervisor",
    );
    expect(supervisorWrite).toBeTruthy();
    const data = (supervisorWrite![1] as any).data;
    expect(data.status).toBe("error");
    expect(typeof data.error).toBe("string");
    expect(data.error.length).toBeGreaterThan(0);

    // SAFETY: the supervisor must NEVER auto-destroy the user's graph. Assert no
    // query it issued is a DELETE/REMOVE against the data — surfacing is the ONLY
    // write it is allowed to make.
    for (const [sql] of queryExec.mock.calls as Array<[string, unknown]>) {
      expect(sql).not.toMatch(/\b(DELETE|REMOVE|DROP)\b/i);
    }
  });

  it("a degraded supervisor stays stopped (no respawn) on further exits", async () => {
    registerSurrealSupervisorStore({ isAvailable: () => true, queryExec: vi.fn(async () => undefined) });
    await spawnManagedSurreal(...ARGS);
    const backoffs = [500, 1000, 2000, 4000];
    for (let i = 0; i < backoffs.length; i++) {
      spawnedChildren[spawnedChildren.length - 1].emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(backoffs[i] + 50);
    }
    spawnedChildren[spawnedChildren.length - 1].emit("exit", 1, null); // trips cap
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(__getSupervisorState().degraded).toBe(true);
    const countAtDegrade = spawnMock.mock.calls.length;

    // Any further exit while degraded is a no-op.
    spawnedChildren[spawnedChildren.length - 1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(countAtDegrade);
  });

  it("degraded surfacing does not throw when the store is unavailable (DB down)", async () => {
    // The most likely state when the child is dead: store.isAvailable() === false.
    // Surfacing must skip the row write (best-effort) and never throw.
    const queryExec = vi.fn(async () => undefined);
    registerSurrealSupervisorStore({ isAvailable: () => false, queryExec });
    await spawnManagedSurreal(...ARGS);
    const backoffs = [500, 1000, 2000, 4000];
    for (let i = 0; i < backoffs.length; i++) {
      spawnedChildren[spawnedChildren.length - 1].emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(backoffs[i] + 50);
    }
    spawnedChildren[spawnedChildren.length - 1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(__getSupervisorState().degraded).toBe(true);
    // isAvailable() === false → no write attempted.
    expect(queryExec).not.toHaveBeenCalled();
  });
});

describe("idempotency — duplicate lifecycle events do not double-spawn", () => {
  it("an 'error' immediately followed by 'exit' for the same death respawns once", async () => {
    await spawnManagedSurreal(...ARGS);
    const child = spawnedChildren[0];
    // Some platforms emit BOTH 'error' and 'exit' for one failed process.
    child.emit("error", new Error("boom"));
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    // Exactly one respawn (the 'respawning' guard swallowed the duplicate).
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
