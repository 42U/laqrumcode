/**
 * Regression test for E12: auto-drain folds itself into E1's maintenance_runs
 * stream so a chronically-failing background extractor becomes visible.
 *
 * Pre-E12, auto-drain.ts only swallow.warn'd its failures (auto-drain.ts
 * startup/periodic/trigger) and wrote no health row, so the ONLY operator
 * signal for a drainer that dies on every spawn was the lagging pending_work>50
 * backlog proxy. E1 added maintenance_runs.status/error + a memory_health
 * diagnostic that reads the newest row per job and pushes RED for status='error'.
 * E12 makes auto-drain write a job='autoDrain' row on each drain attempt so that
 * diagnostic surfaces a wedged drainer immediately.
 *
 * Contract under test:
 *   - a FAILED drain attempt writes a maintenance_runs row job='autoDrain'
 *     status='error';
 *   - a SUCCESSFUL one writes job='autoDrain' status='ok';
 *   - the row uses the SAME `CREATE maintenance_runs CONTENT $data` shape as
 *     maintenance.ts runJob (job/status/rows_affected/duration_ms[/error]);
 *   - the write is store-guarded (no store → no row) and never throws (a write
 *     failure is swallowed), matching runJob's finally — required because the
 *     production call sites are inside detached-child exit/error callbacks where
 *     a throw would be unhandled.
 *
 * No real subprocess is spawned (every other drain test follows this idiom):
 * we drive the exported helper recordDrainRun + the pure outcome→status mapping
 * drainOutcomeToStatus that the child-exit handler uses, against a hand-rolled
 * fake store that records its queryExec calls. CI-safe, no DB.
 */
import { describe, it, expect, vi } from "vitest";
import { __testing } from "../src/daemon/auto-drain.js";

const { recordDrainRun, drainOutcomeToStatus, classifyDrainOutcome } = __testing;

interface CapturedExec {
  sql: string;
  bindings?: Record<string, unknown>;
}

/** Fake store capturing every queryExec(sql, bindings). */
function makeStore(available = true, throwOnExec = false) {
  const execs: CapturedExec[] = [];
  const store = {
    isAvailable: () => available,
    queryExec: vi.fn(async (sql: string, bindings?: Record<string, unknown>) => {
      execs.push({ sql, bindings });
      if (throwOnExec) throw new Error("simulated store write failure");
    }),
  };
  // recordDrainRun only touches state.store.
  const state = { store } as unknown as Parameters<typeof recordDrainRun>[0];
  return { state, store, execs };
}

/** Extract the CONTENT $data object from the single captured maintenance_runs
 *  write, asserting the SQL is exactly the runJob shape. */
function soleDrainRow(execs: CapturedExec[]): Record<string, unknown> {
  const rows = execs.filter((e) => /CREATE maintenance_runs CONTENT \$data/.test(e.sql));
  expect(rows.length).toBe(1);
  const data = rows[0].bindings?.data as Record<string, unknown>;
  expect(data).toBeTruthy();
  return data;
}

describe("E12: auto-drain writes a maintenance_runs liveness row", () => {
  it("a successful drain attempt records job='autoDrain' status='ok'", async () => {
    const { state, execs } = makeStore();
    await recordDrainRun(state, "ok", { durationMs: 4200, rowsAffected: 7 });
    const data = soleDrainRow(execs);
    expect(data.job).toBe("autoDrain");
    expect(data.status).toBe("ok");
    expect(data.rows_affected).toBe(7);
    expect(data.duration_ms).toBe(4200);
    // No error field on a healthy run (matches runJob: error only set on throw).
    expect("error" in data).toBe(false);
  });

  it("a failed drain attempt records job='autoDrain' status='error' with the message", async () => {
    const { state, execs } = makeStore();
    await recordDrainRun(state, "error", {
      durationMs: 800,
      error: "extractor exited code=1 after 0s with no queue progress (12→12)",
    });
    const data = soleDrainRow(execs);
    expect(data.job).toBe("autoDrain");
    expect(data.status).toBe("error");
    expect(data.error).toBe("extractor exited code=1 after 0s with no queue progress (12→12)");
    expect(data.duration_ms).toBe(800);
    // rows_affected defaults to 0 when not supplied (runJob shape).
    expect(data.rows_affected).toBe(0);
  });

  it("uses exactly the runJob CONTENT shape: job/status/rows_affected/duration_ms keys", async () => {
    const { state, execs } = makeStore();
    await recordDrainRun(state, "ok", { durationMs: 10, rowsAffected: 0 });
    const data = soleDrainRow(execs);
    // The keys runJob writes on a success path (maintenance.ts:121-126). No
    // extra keys that would make autoDrain rows shaped differently from the
    // rest of the maintenance_runs stream memory_health reads.
    expect(Object.keys(data).sort()).toEqual(
      ["duration_ms", "job", "rows_affected", "status"].sort(),
    );
  });

  it("error message is clamped to 300 chars (matches runJob's slice(0,300))", async () => {
    const { state, execs } = makeStore();
    await recordDrainRun(state, "error", { error: "x".repeat(1000) });
    const data = soleDrainRow(execs);
    expect((data.error as string).length).toBe(300);
  });

  it("is store-guarded: no row written when the store is unavailable", async () => {
    const { state, store, execs } = makeStore(/* available */ false);
    await recordDrainRun(state, "error", { error: "boom" });
    expect(store.queryExec).not.toHaveBeenCalled();
    expect(execs.length).toBe(0);
  });

  it("never throws when the store write itself fails (swallowed like runJob)", async () => {
    const { state } = makeStore(/* available */ true, /* throwOnExec */ true);
    // Must resolve, not reject — the production callers are detached-child
    // exit/error handlers where a throw would be unhandled.
    await expect(recordDrainRun(state, "error", { error: "boom" })).resolves.toBeUndefined();
  });
});

describe("E12: drainOutcomeToStatus wires the child-exit classification to a status", () => {
  it("maps a fast-failure (chronic-drainer signal) to 'error'", () => {
    expect(drainOutcomeToStatus("fast-failure")).toBe("error");
  });

  it("maps progress (queue shrank) to 'ok'", () => {
    expect(drainOutcomeToStatus("progress")).toBe("ok");
  });

  it("maps a neutral long run to 'ok' so a slow-but-healthy extractor stays green", () => {
    expect(drainOutcomeToStatus("neutral")).toBe("ok");
  });

  it("end-to-end: an instantly-dying extractor (no queue progress) yields a status='error' row", async () => {
    // This is the wiring the child.on('exit') handler runs: classify the run,
    // then record a row with the mapped status. Simulate the fast-failure case
    // (queueBefore == queueAfter, runtime under the fast-fail window) and assert
    // the row that lands is status='error' — the chronic-drainer signal E1's
    // memory_health turns RED on.
    const { state, execs } = makeStore();
    const runtimeMs = 5_000; // < DRAIN_FAST_FAIL_MS (120_000)
    const queueBefore = 12;
    const queueAfter = 12; // no progress
    const outcome = classifyDrainOutcome(runtimeMs, queueBefore, queueAfter);
    expect(outcome).toBe("fast-failure");
    await recordDrainRun(state, drainOutcomeToStatus(outcome), {
      durationMs: runtimeMs,
      rowsAffected: Math.max(0, queueBefore - queueAfter),
      error: outcome === "fast-failure" ? "no queue progress" : undefined,
    });
    const data = soleDrainRow(execs);
    expect(data.job).toBe("autoDrain");
    expect(data.status).toBe("error");
    expect(data.rows_affected).toBe(0);
  });

  it("end-to-end: a productive extractor (queue shrank) yields a status='ok' row with rows_affected", async () => {
    const { state, execs } = makeStore();
    const runtimeMs = 30_000;
    const queueBefore = 12;
    const queueAfter = 3; // drained 9 items
    const outcome = classifyDrainOutcome(runtimeMs, queueBefore, queueAfter);
    expect(outcome).toBe("progress");
    await recordDrainRun(state, drainOutcomeToStatus(outcome), {
      durationMs: runtimeMs,
      rowsAffected: Math.max(0, queueBefore - queueAfter),
    });
    const data = soleDrainRow(execs);
    expect(data.job).toBe("autoDrain");
    expect(data.status).toBe("ok");
    expect(data.rows_affected).toBe(9);
  });
});
