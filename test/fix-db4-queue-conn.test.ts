/**
 * DB4-queue-conn lane — regression guards for the queue/connection hardening
 * batch: K15, K41, K31, K21, K32, K17-maint.
 *
 * Local-first frame: laqrumcode is one long-lived daemon per host owning a local
 * SurrealDB serving a few co-located Claude Code sessions. These six findings
 * are all about that shape — a commit CAS that double-writes knowledge under a
 * withRetry re-fire (K41) or a stale-recovery revert (K15), concurrent
 * causal_graduate items that synthesize duplicate skills (K31), a fire-and-
 * forget running-average UPSERT that loses updates under concurrent writebacks
 * (K21), a first DB connect with no timeout that hangs the daemon in
 * connecting-store forever (K32), and an embedding_cache prune that ran once at
 * boot capped at one 500-row batch so it grew unbounded on a daemon that stays
 * up for weeks (K17-maint).
 *
 * utilityMean (K21) is exercised as pure logic — it is the read-time mean that
 * replaces the racy materialized average. The rest are asserted statically
 * against the actual source: each fix is a deterministic source-level fact, and
 * an integration test would SKIP without a live SurrealDB on localhost (false
 * green). The drift these findings represent is exactly "the guard silently
 * isn't there", which a source assertion catches every run, and the static
 * shape is robust to the concurrent multi-lane edits in this batch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { utilityMean } from "../src/engine/surreal.js";

const surrealSrc = readFileSync(new URL("../src/engine/surreal.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../src/engine/schema.surql", import.meta.url), "utf8");
const pendingWorkSrc = readFileSync(new URL("../src/tools/pending-work.ts", import.meta.url), "utf8");
const maintenanceSrc = readFileSync(new URL("../src/engine/maintenance.ts", import.meta.url), "utf8");

// ── K21: read-time utility mean (pure logic) ──────────────────────────────────
describe("K21 — utilityMean computes mean from commutative accumulators", () => {
  it("computes util_sum / retrieval_count when both present", () => {
    // 3 retrievals summing to 1.8 → mean 0.6. Order-independent accumulation.
    expect(utilityMean({ util_sum: 1.8, retrieval_count: 3 })).toBeCloseTo(0.6, 10);
  });

  it("falls back to legacy materialized avg_utilization when util_sum is absent", () => {
    // Pre-K21 rows carry a materialized average and util_sum IS NONE.
    expect(utilityMean({ avg_utilization: 0.42 })).toBeCloseTo(0.42, 10);
    expect(utilityMean({ util_sum: null, retrieval_count: 5, avg_utilization: 0.7 })).toBeCloseTo(0.7, 10);
  });

  it("prefers the accumulator-derived mean over a stale materialized value", () => {
    // If both exist, the accumulators are the source of truth.
    expect(utilityMean({ util_sum: 2, retrieval_count: 4, avg_utilization: 0.99 })).toBeCloseTo(0.5, 10);
  });

  it("does not divide by zero — count 0 falls back, then null", () => {
    expect(utilityMean({ util_sum: 0, retrieval_count: 0, avg_utilization: 0.3 })).toBeCloseTo(0.3, 10);
    expect(utilityMean({ util_sum: 0, retrieval_count: 0 })).toBeNull();
    expect(utilityMean({})).toBeNull();
  });
});

describe("K21 — writer is race-free (deterministic id + commutative accumulators)", () => {
  it("updateUtilityCache no longer does the non-atomic read-compute-write average", () => {
    const fn = sliceFn(surrealSrc, "async updateUtilityCache(");
    // The racy form read avg_utilization back into its own recompute. Gone.
    expect(fn).not.toMatch(/avg_utilization\s*\*\s*\(retrieval_count/);
    // Commutative accumulators instead.
    expect(fn).toMatch(/util_sum\s*\+=\s*\$util/);
    expect(fn).toMatch(/retrieval_count\s*\+=\s*1/);
    // Deterministic record id (no random-ULID create-on-miss → no UNIQUE race).
    expect(fn).toMatch(/UPSERT memory_utility_cache:⟨\$\{key\}⟩/);
  });

  it("schema declares util_sum and relaxes avg_utilization to option", () => {
    expect(schemaSrc).toMatch(/DEFINE FIELD IF NOT EXISTS util_sum ON memory_utility_cache TYPE option<float>/);
    expect(schemaSrc).toMatch(/DEFINE FIELD OVERWRITE avg_utilization ON memory_utility_cache TYPE option<float>/);
  });

  it("the maintenance importance-floor join computes the mean inline (not raw avg_utilization)", () => {
    // The correlated subquery must derive util_sum/retrieval_count, falling back
    // to avg_utilization — not read a now-unwritten materialized average.
    expect(surrealSrc).toMatch(/IF util_sum != NONE AND retrieval_count > 0 THEN util_sum \/ retrieval_count ELSE \(avg_utilization \?\? 0\)/);
  });
});

// ── K41 + K15: idempotent commit CAS + ownership re-assertion ──────────────────
describe("K41 — commit CAS is idempotent across one withRetry re-fire", () => {
  const fn = sliceFn(pendingWorkSrc, "export async function handleCommitWorkResults(");

  it("stamps a caller-generated committing_token on the CAS", () => {
    expect(fn).toMatch(/const myToken = randomUUID\(\)/);
    expect(fn).toMatch(/committing_token = \$tok/);
  });

  it("WHERE accepts a row already in 'committing' carrying THIS token (own-retry win)", () => {
    // The own-CAS-succeeded-but-response-lost case must NOT be discarded.
    expect(fn).toMatch(/status = "processing" OR \(status = "committing" AND committing_token = \$tok\)/);
  });

  it("schema declares committing_token as option<string>", () => {
    expect(schemaSrc).toMatch(/DEFINE FIELD IF NOT EXISTS committing_token ON pending_work TYPE option<string>/);
  });

  it("randomUUID is imported into pending-work.ts", () => {
    expect(pendingWorkSrc).toMatch(/import \{ randomUUID \} from "node:crypto"/);
  });
});

describe("K15 — stale-recovery cannot revert an in-flight committing row", () => {
  const fn = sliceFn(pendingWorkSrc, "export async function handleCommitWorkResults(");

  it("the commit CAS re-stamps processing_started_at to restart the stale window", () => {
    expect(fn).toMatch(/processing_started_at = time::now\(\)/);
  });

  it("ownership is re-asserted before the non-idempotent commitResults writes", () => {
    // A SELECT ... WHERE status="committing" AND committing_token=ours must
    // gate the write, and an empty result must short-circuit (discard) rather
    // than fall through to commitResults.
    const reassertIdx = fn.indexOf('WHERE status = "committing" AND committing_token = $tok');
    const commitIdx = fn.indexOf("await commitResults(");
    expect(reassertIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(reassertIdx).toBeLessThan(commitIdx); // re-assert happens FIRST
    expect(fn).toMatch(/ownership lost before write/i);
  });

  it("schema declares processing_started_at and stale-recovery catches 'committing'", () => {
    expect(schemaSrc).toMatch(/DEFINE FIELD IF NOT EXISTS processing_started_at ON pending_work TYPE option<datetime>/);
    // The stale-recovery SELECT must include the committing state and key off
    // processing_started_at (falling back to created_at).
    expect(pendingWorkSrc).toMatch(/status = "processing" OR status = "committing"/);
    expect(pendingWorkSrc).toMatch(/\(processing_started_at \?\? created_at\) < time::now\(\) - 10m/);
  });
});

// ── K31: claim causal chains BEFORE synthesis ─────────────────────────────────
describe("K31 — causal_graduate claims chains before synthesis (no duplicate skills)", () => {
  it("fetch handler atomically stamps graduated_at and RETURNs the won chains", () => {
    // The claim must be an UPDATE ... SET graduated_at ... WHERE graduated_at IS
    // NONE ... RETURN BEFORE inside the fetch (buildWorkPayload), so a concurrent
    // item wins only the rows this one did not flip.
    expect(pendingWorkSrc).toMatch(/UPDATE causal_chain SET graduated_at = time::now\(\)[\s\S]*?graduated_at IS NONE[\s\S]*?RETURN BEFORE/);
  });

  it("an empty won-set self-completes (concurrent item already claimed)", () => {
    expect(pendingWorkSrc).toMatch(/already claimed by a concurrent graduation/i);
  });

  it("commit handler no longer re-stamps the watermark after skill creation", () => {
    const commitResults = sliceFn(pendingWorkSrc, "async function commitResults(");
    // The old post-creation stamp (guarded on created>0) must be gone from the
    // commit path — claiming now happens at fetch time.
    expect(commitResults).not.toMatch(/advance the graduation watermark/);
    expect(commitResults).not.toMatch(/if \(created > 0\)[\s\S]*?UPDATE causal_chain SET graduated_at/);
  });
});

// ── K32: first connect is deadlined ───────────────────────────────────────────
describe("K32 — initial db.connect() has a timeout (shared with reconnect)", () => {
  it("a shared connectWithTimeout helper exists and is deadlined", () => {
    expect(surrealSrc).toMatch(/private async connectWithTimeout\(\)/);
    const helper = sliceFn(surrealSrc, "private async connectWithTimeout()");
    expect(helper).toMatch(/raceWithDeadline\(/);
    expect(helper).toMatch(/CONNECT_TIMEOUT_MS/);
  });

  it("initialize() uses the deadlined connect, not a bare db.connect await", () => {
    const init = sliceFn(surrealSrc, "async initialize()");
    expect(init).toMatch(/await this\.connectWithTimeout\(\)/);
    // The old bare connect inside initialize is gone.
    expect(init).not.toMatch(/await this\.db\.connect\(/);
  });

  it("ensureConnected() routes through the same helper", () => {
    const ensure = sliceFn(surrealSrc, "private async ensureConnected()");
    expect(ensure).toMatch(/await this\.connectWithTimeout\(\)/);
  });
});

// ── K17-maint: embedding_cache prune drains + re-arms ──────────────────────────
describe("K17-maint — embedding_cache prune loops to drain and is periodically re-armed", () => {
  const fn = sliceFn(maintenanceSrc, "async function purgeStaleEmbedCache(");

  it("loops in batches until the backlog is drained (not a single 500-row pass)", () => {
    expect(fn).toMatch(/for \(let i = 0; i < MAX_BATCHES/);
    expect(fn).toMatch(/SELECT id FROM embedding_cache/);   // JS-collect a bounded batch
    expect(fn).toMatch(/if \(ids\.length < BATCH\) break/); // drains across batches
  });

  it("is armed on the 6h interval alongside runEmbeddingBackfills", () => {
    // Inside the same setInterval body that runs the embedding backfills.
    const interval = maintenanceSrc.slice(
      maintenanceSrc.indexOf("const backfillInterval = setInterval("),
      maintenanceSrc.indexOf("backfillInterval.unref?.()"),
    );
    // E1 wraps both in runJob(state, "...", () => fn(state)) for observability,
    // so match the inner invocation rather than the old bare `void fn(state)`.
    expect(interval).toMatch(/runEmbeddingBackfills\(state\)/);
    expect(interval).toMatch(/purgeStaleEmbedCache\(state\)/);
  });

  it("Phase 1 soft-tags only; Phase 2 (G10B) hard-deletes already-pruned rows", () => {
    // G10B split purgeStaleEmbedCache into two phases. Scope the no-DELETE
    // guard to Phase 1 (soft-tag) and positively assert Phase 2's bounded,
    // pruned_at-rechecked hard delete (embedding_cache is telemetry → DELETE-OK).
    const marker = fn.indexOf("Phase 2 (G10B)");
    expect(marker).toBeGreaterThan(0);
    const phase1 = fn.slice(0, marker);
    const phase2 = fn.slice(marker);
    expect(phase1).toMatch(/pruned_at = time::now\(\)/);
    expect(phase1).toMatch(/prune_reason = "stale_30d"/);
    expect(phase1).not.toMatch(/DELETE embedding_cache/); // Phase 1 soft-tags via UPDATE, never deletes
    expect(phase2).toMatch(/DELETE embedding_cache WHERE id IN \[/);
    expect(phase2).toMatch(/pruned_at IS NOT NONE/);
  });
});

/** Slice the source from a declaration anchor to the next top-level `\n}\n`
 *  (the function's closing brace at column 0) so a regex assertion is scoped to
 *  one function, not the whole file. A 6000-char hard cap backstops the rare
 *  case where no such boundary is found. Coarse but sufficient for "is this
 *  token present in THIS function". */
function sliceFn(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error(`anchor not found: ${anchor}`);
  const rest = src.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest.slice(0, 6000) : rest.slice(0, end + 2);
}
