/**
 * Background maintenance — ONCE per process (0.7.118), canonical caller is
 * the daemon boot (daemon/index.ts, post-embeddings-init); the legacy
 * mcp-server.ts and session-start invocations no-op after the first run.
 * On a degraded boot (store down) the guard is NOT latched: a deduped 5-min
 * self-retry plus any later session-start re-attempts until the store is up.
 *
 * Restores the five jobs that used to live in KongBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. KongCode has no such framework call, so these had been silently
 * not running since the port. See GitHub issue history around 2026-04-21 —
 * and the 2026-06-10 recurrence: on the daemon-split architecture the only
 * wired callers were the legacy monolith and the session-start hook, so with
 * hooks degraded NOTHING ran maintenance at all.
 *
 * Each job is internally bounded (count<=200/2000/50 safety floors, LIMIT 50
 * on destructive operations) and idempotent. The ACAN retrain carries its own
 * lockfile from acan.ts preventing concurrent retrains across sibling MCPs.
 * Recurring needs (embedding backfills) are covered by the 6h interval armed
 * in Group 3.
 *
 * Fire-and-forget — the caller should not await this. Errors go to
 * swallow.warn so they're visible without blocking startup.
 */

import type { GlobalPluginState } from "./state.js";
import { checkACANReadiness } from "./acan.js";
import { gcSweepOrphanedEdges, gcHardDelete, sweepGcBackups } from "./gc.js";
import { swallow, RECORD_ID_RE } from "./errors.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

/**
 * One-time forward-migration of ACAN weights.
 *
 * Pre-config-threading default for ACAN weights was ~/.kongbrain/acan_weights.json
 * (from when the code lived in the kongbrain plugin). Now we thread
 * state.config.paths.cacheDir into checkACANReadiness, so weights live under
 * ~/.kongcode/cache/. Existing user installs have 2.7MB of trained weights
 * at the legacy path that would otherwise be orphaned.
 *
 * If the legacy file exists AND the new cacheDir file does NOT, copy the
 * legacy weights forward. Idempotent: subsequent runs see the destination
 * file and skip. NEVER deletes the source — the legacy file stays as a
 * fallback for any code path that hasn't been threaded yet (and as a
 * sanity-recovery point).
 */
function migrateLegacyACANWeights(cacheDir: string): void {
  try {
    const legacyPath = join(homedir(), ".kongbrain", "acan_weights.json");
    const newPath = join(cacheDir, "acan_weights.json");
    if (!existsSync(legacyPath)) return; // nothing to migrate
    if (existsSync(newPath)) return; // already migrated, idempotent skip
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    copyFileSync(legacyPath, newPath);
    log.info(`[maintenance] migrated ACAN weights forward: ${legacyPath} -> ${newPath} (legacy file preserved)`);
  } catch (e) {
    swallow.warn("maintenance:migrateLegacyACAN", e);
  }
}

let bootstrapMaintenanceRan = false;
let maintenanceRetryArmed = false;

/** Test-only: clear the once-per-process guard so suites can invoke
 *  runBootstrapMaintenance repeatedly with fresh fake states. */
export function __resetBootstrapMaintenanceForTests(): void {
  bootstrapMaintenanceRan = false;
  maintenanceRetryArmed = false;
}

/**
 * E1 (observability) — run a maintenance job and ALWAYS record a
 * maintenance_runs row in a finally, so a job that throws is distinguishable
 * from one that never ran or succeeded.
 *
 * Before this, the orchestration jobs in this file (purgeStaleEmbedCache,
 * the backfills, seedSkillsFromJson, the sweep, consolidate, etc.) recorded
 * NOTHING — only the surreal.ts in-class jobs wrote a maintenance_runs row,
 * and they wrote it as the LAST statement in their try block, so any throw
 * recorded nothing at all. memory_health never read the table, so a job that
 * always-throws (the purgeStaleEmbedCache class) was invisible and health
 * stayed green.
 *
 * Contract:
 *   - SUCCESS: writes {job, status:'ok', rows_affected, duration_ms}.
 *     rows_affected = the fn's numeric return (0 if it returns void).
 *   - THROW:   writes {job, status:'error', error: msg.slice(0,300),
 *     duration_ms}, then SWALLOWS the error so the maintenance cycle
 *     continues (matches the fire-and-forget, never-block-startup contract).
 *
 * Store-guarded: if the store is unavailable we cannot record a row, so we run
 * the fn best-effort (it self-guards on store too) and skip the audit write —
 * recording is pointless when the store is down and a degraded boot already
 * leaves the once-guard unlatched for a retry.
 */
export async function runJob(
  state: GlobalPluginState,
  name: string,
  fn: () => Promise<number | void> | number | void,
): Promise<void> {
  const started = Date.now();
  let rowsAffected = 0;
  let status: "ok" | "error" = "ok";
  let error: string | undefined;
  try {
    const r = await fn();
    if (typeof r === "number" && Number.isFinite(r)) rowsAffected = r;
  } catch (e) {
    status = "error";
    error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    // Swallow so the cycle continues — but record it (below) AND log it, so a
    // chronically-failing job is both visible to memory_health and in stderr.
    swallow.warn(`maintenance:job:${name}`, e);
  } finally {
    if (state.store.isAvailable()) {
      try {
        const data: Record<string, unknown> = {
          job: name,
          status,
          rows_affected: rowsAffected,
          duration_ms: Date.now() - started,
        };
        if (error) data.error = error;
        await state.store.queryExec(`CREATE maintenance_runs CONTENT $data`, { data });
      } catch (e) {
        // A failure to RECORD the run must not itself throw out of runJob.
        swallow("maintenance:runJob:record", e);
      }
    }
  }
}

export function runBootstrapMaintenance(state: GlobalPluginState): void {
  // 0.7.118 once-per-process guard. session-start invokes this on EVERY
  // session start (no guard existed), which meant full Group 1–3 re-runs per
  // session — and with the 6h backfill interval added this release it would
  // have leaked an interval per session. The daemon boot is now the
  // canonical caller (daemon/index.ts, post-embeddings-init); first
  // invocation wins regardless of origin.
  if (bootstrapMaintenanceRan) return;
  // QA 0.7.118 C1: do NOT burn the single run on a degraded boot (store
  // down). Leave the guard unlatched so a later session-start retries once
  // the store recovers, and arm one deduped self-retry so a hook-less
  // daemon also heals without a restart.
  if (!state.store.isAvailable()) {
    if (!maintenanceRetryArmed) {
      maintenanceRetryArmed = true;
      const retry = setTimeout(() => {
        maintenanceRetryArmed = false;
        runBootstrapMaintenance(state);
      }, 5 * 60_000);
      retry.unref?.();
    }
    return;
  }
  bootstrapMaintenanceRan = true;

  const { store, embeddings, config } = state;
  const deferMs = Number(process.env.KONGCODE_MAINTENANCE_DEFER_MS) || 30_000;

  // One-time forward-migration of ACAN weights from ~/.kongbrain/ to cacheDir.
  // Cheap (one stat + zero or one copy), idempotent, runs early so the deferred
  // checkACANReadiness call below picks up the migrated weights.
  // Guarded against partial test mocks that omit config.paths.
  const cacheDir = config.paths?.cacheDir ?? join(homedir(), ".kongcode", "cache");
  migrateLegacyACANWeights(cacheDir);

  // Group 1: cheap DB queries — safe to run immediately in parallel.
  // The surreal.ts store methods (runMemoryMaintenance, purgeStalePendingWork,
  // purgeOldRetrievalOutcomes, purgeOldTurnScores) each write their OWN
  // maintenance_runs row (status defaults 'ok') and swallow internally, so they
  // are already observable and must NOT be double-wrapped in runJob. The
  // maintenance.ts-local jobs below recorded NOTHING pre-E1 — wrap those in
  // runJob so a chronic failure (the purgeStaleEmbedCache class) becomes visible
  // to memory_health instead of leaving health green.
  Promise.all([
    store.runMemoryMaintenance(),
    store.purgeStalePendingWork(),
    store.purgeOldRetrievalOutcomes(),
    store.purgeOldTurnScores(),
    store.purgeOldMaintenanceRuns(), // E1: bound the new runJob audit trail itself
    runJob(state, "purgeStaleEmbedCache", () => purgeStaleEmbedCache(state)),
    // E6: monologue grows UNBOUNDED (one row per reasoning moment, searched on
    // the hot path). E7: turn_archive grows FOREVER (archiveOldTurns only
    // relocates into it, never trims). Both are bounded count-gated purges
    // routed through the gcHardDelete keystone (both ARE content tables).
    runJob(state, "purgeOldMonologue", () => purgeOldMonologue(state)),
    runJob(state, "purgeOldTurnArchive", () => purgeOldTurnArchive(state)),
  ]).then(async () => {
    // Group 2: moderate cost — after cheap queries complete. The surreal.ts GC
    // methods self-record + swallow (already observable); the maintenance.ts
    // local jobs are wrapped in runJob.
    await store.archiveOldTurns().catch(e => swallow.warn("maintenance:archiveOldTurns", e));
    await store.garbageCollectMemories().catch(e => swallow.warn("maintenance:gcMemories", e));
    await store.garbageCollectConcepts().catch(e => swallow.warn("maintenance:gcConcepts", e));
    // G2: sweep orphaned edges (in/out endpoint hard-deleted) once per cycle.
    // Runs AFTER the node GCs so any edges those just orphaned are caught in the
    // same cycle. (gcSweepOrphanedEdges also writes its OWN audit row internally,
    // but runJob additionally records an 'error' row if the sweep throws.)
    await runJob(state, "sweepOrphanedEdges", () => sweepOrphanedEdges(state));
    // H2: prune the gc-backups snapshot dir (age + count + size caps, 24h floor)
    // so the reversibility snapshots written by every destructive keystone op
    // don't accumulate forever on a long-lived single-host install. Returns the
    // number of files deleted so runJob records it as rows_affected.
    await runJob(state, "sweepGcBackups", () => sweepGcBackups(state));
    await runJob(state, "backfillSessionTurnCounts", () => backfillSessionTurnCounts(state));
    await runJob(state, "seedSkillsFromJson", () => seedSkillsFromJson(state));
    await runJob(state, "backfillSkillEmbeddings", () => backfillSkillEmbeddings(state));
  }).catch(e => swallow.warn("bootstrap:maintenance:group2", e));

  // Group 3: CPU-heavy — deferred so first-turn context assembly is uncontested
  const heavyTimer = setTimeout(async () => {
    // 0.7.118 (QA C1): arm the 6h re-sweep FIRST — before any early-return
    // or throwing step can skip it. The sweep self-guards on store +
    // embeddings availability, so arming unconditionally is safe even if
    // the store dropped between boot and this timer.
    const backfillInterval = setInterval(() => {
      void runJob(state, "runEmbeddingBackfills", () => runEmbeddingBackfills(state));
      // K17-maint: re-arm the embedding_cache prune on the same 6h cadence. Boot
      // Group 1 runs it once; without this re-arm a long-lived daemon (the
      // common local-first case — one host, never restarts for weeks) would let
      // embedding_cache grow unbounded between the boot run and the next restart.
      // purgeStaleEmbedCache self-guards on store availability and now loops to
      // full drain, so arming it unconditionally here is safe.
      void runJob(state, "purgeStaleEmbedCache", () => purgeStaleEmbedCache(state));
      // E6/E7: re-arm the monologue + turn_archive retention on the same 6h
      // cadence — a long-lived daemon that never restarts is exactly the case
      // where these would otherwise grow without bound between boots.
      void runJob(state, "purgeOldMonologue", () => purgeOldMonologue(state));
      void runJob(state, "purgeOldTurnArchive", () => purgeOldTurnArchive(state));
      // G2: re-arm the orphaned-edge sweep on the same 6h cadence so a
      // long-lived daemon keeps the graph clean between restarts. Normally a
      // cheap no-op (see sweepOrphanedEdges' note); self-guarded on store.
      void runJob(state, "sweepOrphanedEdges", () => sweepOrphanedEdges(state));
      // H2: re-arm the gc-backups snapshot prune on the same 6h cadence — a
      // daemon up for weeks is exactly where these snapshots would pile up.
      void runJob(state, "sweepGcBackups", () => sweepGcBackups(state));
    }, 6 * 3_600_000);
    backfillInterval.unref?.();

    if (!store.isAvailable()) return;
    // 0.7.118: backfills BEFORE consolidate. consolidateMemories is an
    // unbounded CPU pass (observed 9+ min on the CPU tier) and the cheap
    // backfill sweep used to sit behind it — unembedded rows stayed invisible
    // to vector search for the whole window. The backfills self-guard with
    // embeddings.isAvailable(), and the 6h interval retries if the embedder
    // isn't up yet at boot+30s on slow machines.
    await runJob(state, "runEmbeddingBackfills", () => runEmbeddingBackfills(state));
    // consolidateMemories self-records a maintenance_runs row on success +
    // swallows internally, so it is already observable; runJob additionally
    // records an 'error' row if it throws.
    await runJob(state, "consolidateMemories", () => store.consolidateMemories((text) => embeddings.embed(text)));
    // (0.7.118: the backfill sweep moved ABOVE consolidateMemories — see the
    // comment there. Historical note kept: Group 2 fires before
    // embeddings.isAvailable() flips true on slow tiers, which is why none
    // of the embed-dependent jobs live in Group 2.)
    await runJob(state, "checkACANReadiness", () => checkACANReadiness(store, config.thresholds.acanTrainingThreshold, cacheDir));
  }, deferMs);
  heavyTimer.unref?.();
}

/** The full unembedded-row sweep, table by table. Boot Group 3 runs it once
 *  (after consolidateMemories proves BGE-M3 is live) and a 6h interval keeps
 *  it running thereafter. Exported for tests. */
export async function runEmbeddingBackfills(state: GlobalPluginState): Promise<void> {
  try {
    await backfillArtifactEmbeddings(state);
    await backfillConceptEmbeddings(state);
    await backfillReflectionEmbeddings(state);
    await backfillMonologueEmbeddings(state);
    await backfillTurnArchiveEmbeddings(state);
    await backfillTurnEmbeddings(state);
    await backfillMemoryEmbeddings(state);
  } catch (e) { swallow.warn("maintenance:backfill-indexed", e); }
}

/** G2 wrapper — best-effort orphaned-edge sweep for the maintenance cycle.
 *  Store-guarded + error-swallowed so it matches its job-list siblings
 *  (fire-and-forget, never throws into the chain).
 *
 *  CADENCE DECISION (run EVERY cycle, not throttled): the sweep scans the 26
 *  relation tables with `in.id IS NONE` and is bounded by the per-install graph
 *  size — kongcode is one daemon + local SurrealDB PER HOST, so a real install's
 *  graph is modest (the dev graph's 182k edges is an outlier from heavy testing).
 *  Crucially it is normally a CHEAP NO-OP going forward: new orphans should be
 *  ~0 because the only sanctioned content delete (gc.ts gcHardDelete keystone)
 *  co-deletes every incident edge in the same op, and the D4 lint blocks ad-hoc
 *  `DELETE <content_table>` everywhere else. The 309 it removed once were
 *  pre-keystone residue. gcSweepOrphanedEdges early-returns
 *  {orphaned:0,removed:0,snapshot:""} the instant it finds zero orphans (no
 *  snapshot write, no DELETE, no after-verify loop), so the steady-state cost is
 *  just the detect SELECTs — fine on a per-install graph at a 6h cadence.
 *  Throttling (e.g. every Nth cycle) would only defer cleanup of any orphan a
 *  future bug introduces, with no real savings on the normal no-op path. */
async function sweepOrphanedEdges(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  try {
    const res = await gcSweepOrphanedEdges(state, { reason: "maintenance-cycle" });
    if (res.removed > 0) {
      log.info(`[maintenance] orphaned-edge sweep: removed ${res.removed} dangling edge(s) across ${Object.keys(res.perTable).length} table(s)`);
    }
  } catch (e) {
    swallow.warn("maintenance:sweepOrphanedEdges", e);
  }
}

/** 0.7.118: live `turn` rows were the one embedded table with NO backfill —
 *  turns written while the embedder was down stayed unembedded forever
 *  (invisible to vector search; only pruning would ever remove them).
 *  Mirrors backfillConceptEmbeddings; target = text, active = not pruned. */
async function backfillTurnEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{ id: string; text: string }>(
      `SELECT id, text FROM turn
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND pruned_at IS NONE
          AND text IS NOT NONE
          AND text != ""
        LIMIT 50`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling turn embeddings: ${rows.length} row(s)`);
    for (const row of rows) {
      if (!row?.id || !row?.text) continue;
      let target = row.text;
      if (target.length > 6000) target = target.slice(0, 6000);
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
      } catch (e) { swallow(`maintenance:backfillTurn:${String(row.id)}`, e); }
    }
  } catch (e) { swallow.warn("maintenance:backfillTurnEmbeddings", e); }
}

/** 0.7.118: plain unembedded `memory` rows had no backfill either —
 *  consolidateMemories embeds only what it consolidates. Active = not
 *  archived. K51: embed `embedding_target ?? text` — when the create path
 *  embedded a shorter form (record-finding.ts strips the [CATEGORY] prefix +
 *  Rationale tail for better short-query match), heal with that same target so
 *  the un-embedded row matches what it would have had if the embedder was up.
 *  embedding_target IS NONE → fall back to text (the common case). */
async function backfillMemoryEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{ id: string; text: string; embedding_target?: string }>(
      `SELECT id, text, embedding_target FROM memory
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND (status IS NONE OR status != "archived")
          AND text IS NOT NONE
          AND text != ""
        LIMIT 50`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling memory embeddings: ${rows.length} row(s)`);
    for (const row of rows) {
      if (!row?.id || !row?.text) continue;
      let target = row.embedding_target ?? row.text;
      if (target.length > 6000) target = target.slice(0, 6000);
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
      } catch (e) { swallow(`maintenance:backfillMemory:${String(row.id)}`, e); }
    }
  } catch (e) { swallow.warn("maintenance:backfillMemoryEmbeddings", e); }
}

/** One-shot reconciliation: every session row pre-0.7.12 has turn_count=0
 *  because the increment lived in Stop and Stop's been flaky. The `turn`
 *  table has the truth — every ingested turn carries its session_id.
 *  Reconstruct turn_count from turn rows for any session with turn_count=0
 *  or NONE. Idempotent (only updates rows where turn_count is missing/zero
 *  AND the turn table has matching rows), so running on every daemon
 *  startup is safe. Cheap: a single grouped query plus N small updates,
 *  where N = sessions-needing-backfill (one-time, drops to ~0 going forward
 *  since 0.7.12+ writes turn_count on UserPromptSubmit). */
async function backfillSessionTurnCounts(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  try {
    // turn.session_id stores the Claude Code session id (a UUID string), NOT
    // a SurrealDB record id. So we look up the matching session row via the
    // kc_session_id field, not by interpolating into the UPDATE target.
    // (Earlier 0.7.12 attempt did the wrong thing and tripped SurrealDB's
    // SQL parser on UUIDs that contain hex sequences read as arithmetic.)
    const counts = await state.store.queryFirst<{ session_id: string; n: number }>(
      `SELECT session_id, count() AS n FROM turn WHERE session_id IS NOT NONE GROUP BY session_id`,
    );
    if (!counts.length) return;
    for (const row of counts) {
      if (!row?.session_id || !row?.n) continue;
      try {
        await state.store.queryExec(
          `UPDATE session SET turn_count = $n
            WHERE kc_session_id = $kc
              AND (turn_count == 0 OR turn_count IS NONE)`,
          { n: row.n, kc: row.session_id },
        );
      } catch (e) {
        swallow.warn("maintenance:backfillTurnCount:update", e);
      }
    }
  } catch (e) {
    swallow.warn("maintenance:backfillTurnCount", e);
  }
}

/** Seed the `skill` table from the repo-committed JSON snapshot at
 *  `.claude-plugin/skills-seed.json`. This is how fresh kongcode installs
 *  get the curated skills since the SKILL.md files on disk are 5-line
 *  stubs (v0.7.84 moved the skill bodies into the DB as the founder's
 *  no-md-proliferation directive).
 *
 *  Idempotent: per-row dedup by name. Existing skill rows (from prior
 *  migrations or prior boots) are never overwritten. Newly-inserted rows
 *  are tagged `source: "seed"` so the embedding backfill picks them up on
 *  the same boot. */
// Exported for test/wave2-fixes.test.ts — the W2-22 regression (null →
// option<string> coercion) made every seed CREATE fail silently; the live
// test pins that a fresh install now seeds the full curated set.
export async function seedSkillsFromJson(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  try {
    // Resolve repo root from the running module location. The compiled file
    // lives at dist/engine/maintenance.js inside the plugin dir, so two
    // levels up is the plugin root.
    const here = fileURLToPath(import.meta.url);
    const pluginDir = resolve(here, "..", "..", "..");
    const seedPath = join(pluginDir, ".claude-plugin", "skills-seed.json");
    if (!existsSync(seedPath)) return;

    const raw = JSON.parse(readFileSync(seedPath, "utf8"));
    if (!Array.isArray(raw?.skills)) return;

    let inserted = 0;
    let skipped = 0;
    for (const s of raw.skills) {
      if (!s?.name || !s?.description || !s?.body) continue;
      try {
        const existing = await state.store.queryFirst<{ id: string }>(
          `SELECT id FROM skill WHERE name = $name LIMIT 1`,
          { name: s.name },
        );
        if (existing.length > 0) {
          skipped++;
          continue;
        }
        // W2-22 (2026-06-10): preconditions/postconditions are option<string>
        // — binding JS null fails coercion ("found NULL"). All 15 curated
        // seed skills lack both fields, so EVERY seed CREATE failed (swallowed
        // per-row below): fresh installs seeded 0 of 15 skills. Build the
        // CONTENT object conditionally and omit absent keys.
        const data: Record<string, unknown> = {
          name: s.name,
          description: s.description,
          body: s.body,
          steps: s.steps ?? [],
          source: "seed",
          active: true,
          confidence: 1.0,
        };
        if (s.preconditions != null) data.preconditions = s.preconditions;
        if (s.postconditions != null) data.postconditions = s.postconditions;
        await state.store.queryExec(`CREATE skill CONTENT $data`, { data });
        inserted++;
      } catch (e) {
        swallow.warn(`maintenance:seedSkill:${s.name}`, e);
      }
    }
    if (inserted > 0) {
      log.info(`[maintenance] skill seed: ${inserted} inserted, ${skipped} already present (${raw.skills.length} total in seed)`);
    }
  } catch (e) {
    swallow.warn("maintenance:seedSkillsFromJson", e);
  }
}

/** Embed any skill rows that exist without a vector. Created 2026-05-15
 *  when SKILL.md files were migrated into the DB by scripts/migrate-skills-to-db.mjs;
 *  the direct-write migration left embeddings NULL because the script
 *  doesn't load BGE-M3. This hook closes the gap on the next daemon
 *  start so recall(scope="skills") works without manual intervention.
 *
 *  Idempotent: only acts on rows where embedding IS NONE. LIMIT 50 per run
 *  to keep startup bounded; subsequent boots clear the rest. Embedding
 *  target matches create_skill's: `${name}: ${description}\n\n${body}`. */
async function backfillSkillEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{
      id: string;
      name: string;
      description: string;
      body?: string;
    }>(
      `SELECT id, name, description, body FROM skill
        WHERE embedding IS NONE AND (active = true OR active IS NONE)
        LIMIT 50`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling skill embeddings: ${rows.length} row(s)`);
    let ok = 0;
    for (const row of rows) {
      if (!row?.id || !row?.name) continue;
      const target = `${row.name}: ${row.description ?? ""}${row.body ? "\n\n" + row.body : ""}`;
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        // Update by `name` (safe filter, no `$id` pattern). Migration script
        // guarantees names are unique per skill row by skipping name-collisions
        // on insert, so this matches at most one row.
        await state.store.queryExec(
          `UPDATE skill SET embedding = $vec WHERE name = $name AND embedding IS NONE`,
          { name: row.name, vec },
        );
        ok++;
      } catch (e) {
        swallow.warn(`maintenance:backfillSkillEmbeddings:${row.name}`, e);
      }
    }
    log.info(`[maintenance] skill embedding backfill: ${ok}/${rows.length} embedded`);
  } catch (e) {
    swallow.warn("maintenance:backfillSkillEmbeddings", e);
  }
}

/** Embedding backfill for artifact rows where embedding IS NONE OR len=0.
 *
 *  The hot-path `commitArtifact` (src/engine/commit.ts:601) swallows embed
 *  failures via `swallow(...)` and persists the row with embedding=null when
 *  BGE-M3 hiccups. Without a backfill pass, those rows are permanent
 *  sediment — invisible to vector recall forever. consolidateMemories has
 *  Pass 2 backfill for memory only; this is its sibling for artifact.
 *
 *  Idempotent (WHERE embedding IS NONE), LIMIT 50 per boot, embed target
 *  matches commit.ts:601 (`${path} ${description}`) so backfilled vectors
 *  agree with query-time vectors. */
async function backfillArtifactEmbeddings(state: GlobalPluginState): Promise<void> {
  const started = Date.now();
  log.info(`[maintenance] backfillArtifactEmbeddings: entering (store.isAvailable=${state.store.isAvailable()}, embeddings.isAvailable=${state.embeddings.isAvailable()})`);
  if (!state.store.isAvailable()) {
    log.info(`[maintenance] backfillArtifactEmbeddings: SKIP — store not available`);
    return;
  }
  if (!state.embeddings.isAvailable()) {
    log.info(`[maintenance] backfillArtifactEmbeddings: SKIP — embeddings not yet available (after ${Date.now() - started}ms)`);
    return;
  }
  let ok = 0;
  let total = 0;
  try {
    const rows = await state.store.queryFirst<{
      id: string;
      path: string;
      description?: string;
    }>(
      `SELECT id, path, description FROM artifact
        WHERE embedding IS NONE OR array::len(embedding) = 0
        LIMIT 50`,
    );
    total = rows.length;
    log.info(`[maintenance] backfillArtifactEmbeddings: SELECT returned ${total} row(s)`);
    if (!rows.length) return;
    for (const row of rows) {
      if (!row?.id || !row?.path) continue;
      // Match commit.ts:601 hot-path template literal EXACTLY (no .trim(), no
      // `?? ""` fallback). For TypeScript-typed callers, description is
      // required (commit.ts:106) so target is `${path} ${description}`. For
      // legacy rows with description=NONE, hot-path would produce
      // `${path} undefined` via JS template-literal coercion, so backfill
      // matches that quirk to keep query-time vectors aligned with
      // backfilled vectors (see audit 2026-05-16).
      let target = `${row.path} ${row.description}`;
      // BGE-M3 has an 8192-token context window. Long artifact descriptions
      // (gem content, long doc text) throw "Input is longer than the context
      // size" and the per-row catch leaves the row unembedded forever.
      // Mirror the 6000-char truncation from surreal.ts:1941.
      if (target.length > 6000) {
        log.warn(`[maintenance] backfillArtifactEmbeddings: truncating target len=${target.length} → 6000 for ${row.path}`);
        target = target.slice(0, 6000);
      }
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) {
          log.info(`[maintenance] backfillArtifactEmbeddings: empty vec for ${row.path}`);
          continue;
        }
        // WHERE guard mirrors the SELECT predicate so a row with `[]`
        // (empty-array embedding) also gets updated, not just NONE rows.
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
        ok++;
      } catch (e) {
        log.warn(`[maintenance] backfillArtifactEmbeddings: row ${row.path} FAILED: ${(e as Error)?.message ?? e}`);
        swallow.warn(`maintenance:backfillArtifactEmbeddings:${row.path}`, e);
      }
    }
    log.info(`[maintenance] backfillArtifactEmbeddings: complete ${ok}/${total} embedded in ${Date.now() - started}ms`);
  } catch (e) {
    log.warn(`[maintenance] backfillArtifactEmbeddings: TOP-LEVEL FAIL: ${(e as Error)?.message ?? e}`);
    swallow.warn("maintenance:backfillArtifactEmbeddings", e);
  }
}

/** Embedding backfill for concept rows where embedding IS NONE OR len=0.
 *
 *  Same shape as backfillArtifactEmbeddings. Embed target = `content`, the
 *  column the hot-path writer actually populates (surreal.ts upsertConcept
 *  CREATE writes `{ content, ... }`; commitConcept passes the concept text as
 *  that `content` arg). So backfilled vectors agree with the hot-path. */
async function backfillConceptEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{
      id: string;
      content?: string;
      name?: string;
      embedding_target?: string;
    }>(
      // K16 — key off `content`, NOT the dead `name` column. The writer
      // populates `content` (the legacy `name` column was renamed to `content`
      // pre-0.7.x; see schema.surql concept-table recovery migration). The old
      // `name`-gated SELECT matched ~zero rows on content-only concepts, so
      // un-embedded concept rows were never healed — a silent backfill-coverage
      // hole. We now require `content` to be set; the legacy `name` arm is kept
      // as a fallback (OR) so any pre-migration row that still carries only
      // `name` is also selected and healed via the COALESCE embed target below.
      // R12 — also SELECT embedding_target (the daemon's persisted
      // `${content} ${searchTerms}` form). The heal embeds that when present so
      // the healed vector matches the live create-time vector instead of
      // diverging to content-only. NOT in the WHERE: a row without
      // embedding_target must STILL be selectable (backfill-coverage invariant).
      `SELECT id, content, name, embedding_target FROM concept
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND (
            (content IS NOT NONE AND content != "")
            OR (name IS NOT NONE AND name != "")
          )
        LIMIT 50`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling concept embeddings: ${rows.length} row(s)`);
    let ok = 0;
    for (const row of rows) {
      if (!row?.id) continue;
      // Embed target precedence (R12/K16):
      //   1. embedding_target — the daemon's persisted `${content} ${searchTerms}`
      //      form; embedding this reproduces the live create-time vector so the
      //      healed concept does NOT diverge to a content-only vector.
      //   2. content — the hot-path column (the common case; embedding_target is
      //      only persisted when it diverges from content).
      //   3. name — legacy pre-rename fallback.
      const contentOrName = row.content && row.content !== "" ? row.content : (row.name ?? "");
      let target = row.embedding_target && row.embedding_target !== "" ? row.embedding_target : contentOrName;
      if (!target) continue;
      // Content is typically short, but guard with the same 6000-char
      // truncation as artifact for defense-in-depth against pathological
      // gem-derived concept text.
      if (target.length > 6000) {
        log.warn(`[maintenance] backfillConceptEmbeddings: truncating content len=${target.length} → 6000`);
        target = target.slice(0, 6000);
      }
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        // WHERE guard mirrors the SELECT predicate (NONE OR len=0).
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
        ok++;
      } catch (e) {
        swallow.warn(`maintenance:backfillConceptEmbeddings:${String(row.id)}`, e);
      }
    }
    log.info(`[maintenance] concept embedding backfill: ${ok}/${rows.length} embedded`);
  } catch (e) {
    swallow.warn("maintenance:backfillConceptEmbeddings", e);
  }
}

/** Embedding backfill for reflection rows where embedding IS NONE OR len=0.
 *
 *  Mirrors backfillArtifactEmbeddings. Reflection hot-path at commit.ts:681
 *  swallows embed failures and persists the row with embedding=null; without
 *  this backfill those rows are permanent recall sediment. Embed target =
 *  `text` field, matching the hot-path. */
async function backfillReflectionEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{
      id: string;
      text: string;
    }>(
      `SELECT id, text FROM reflection
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND (active = true OR active IS NONE)
        LIMIT 50`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling reflection embeddings: ${rows.length} row(s)`);
    let ok = 0;
    for (const row of rows) {
      if (!row?.id || !row?.text) continue;
      let target = row.text;
      if (target.length > 6000) {
        log.warn(`[maintenance] backfillReflectionEmbeddings: truncating text len=${target.length} → 6000`);
        target = target.slice(0, 6000);
      }
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
        ok++;
      } catch (e) {
        swallow.warn(`maintenance:backfillReflectionEmbeddings:${String(row.id)}`, e);
      }
    }
    log.info(`[maintenance] reflection embedding backfill: ${ok}/${rows.length} embedded`);
  } catch (e) {
    swallow.warn("maintenance:backfillReflectionEmbeddings", e);
  }
}

/** Embedding backfill for monologue rows. Hot-path at memory-daemon.ts:280
 *  swallows embed failures; embed target = `content` field. */
async function backfillMonologueEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{
      id: string;
      content: string;
    }>(
      `SELECT id, content FROM monologue
        WHERE embedding IS NONE OR array::len(embedding) = 0
        LIMIT 50`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling monologue embeddings: ${rows.length} row(s)`);
    let ok = 0;
    for (const row of rows) {
      if (!row?.id || !row?.content) continue;
      let target = row.content;
      if (target.length > 6000) {
        log.warn(`[maintenance] backfillMonologueEmbeddings: truncating content len=${target.length} → 6000`);
        target = target.slice(0, 6000);
      }
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
        ok++;
      } catch (e) {
        swallow.warn(`maintenance:backfillMonologueEmbeddings:${String(row.id)}`, e);
      }
    }
    log.info(`[maintenance] monologue embedding backfill: ${ok}/${rows.length} embedded`);
  } catch (e) {
    swallow.warn("maintenance:backfillMonologueEmbeddings", e);
  }
}

/** Embedding backfill for turn_archive rows. This heals the 1126 archived
 *  turns (16.3%) discovered in v0.7.93 as silently un-recallable: the
 *  vectorSearch at surreal.ts:435 filters `embedding != NONE`, so archived
 *  rows without an embedding never surface. archiveOldTurns copies the row
 *  verbatim into turn_archive; if the source turn had embedding=NONE (from
 *  a swallowed embed failure during ingestion), the archive inherits it.
 *  LIMIT 200 per boot — higher than other tables because there are 1126
 *  stuck rows to heal on first run; subsequent boots find 0 and exit fast.
 *  Embed target = `text` field, matching the live `turn` table's embed
 *  target so query-time vectors are aligned. */
async function backfillTurnArchiveEmbeddings(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  if (!state.embeddings.isAvailable()) return;
  try {
    const rows = await state.store.queryFirst<{
      id: string;
      text: string;
    }>(
      `SELECT id, text FROM turn_archive
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND text != NONE
        LIMIT 200`,
    );
    if (!rows.length) return;
    log.info(`[maintenance] backfilling turn_archive embeddings: ${rows.length} row(s)`);
    let ok = 0;
    for (const row of rows) {
      if (!row?.id || !row?.text) continue;
      let target = row.text;
      if (target.length > 6000) {
        log.warn(`[maintenance] backfillTurnArchiveEmbeddings: truncating text len=${target.length} → 6000`);
        target = target.slice(0, 6000);
      }
      try {
        const vec = await state.embeddings.embed(target);
        if (!vec?.length) continue;
        await state.store.queryExec(
          `UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`,
          { vec },
        );
        ok++;
      } catch (e) {
        swallow.warn(`maintenance:backfillTurnArchiveEmbeddings:${String(row.id)}`, e);
      }
    }
    log.info(`[maintenance] turn_archive embedding backfill: ${ok}/${rows.length} embedded`);
  } catch (e) {
    swallow.warn("maintenance:backfillTurnArchiveEmbeddings", e);
  }
}

/** embedding_cache retention. embedding_cache is TELEMETRY (not a content
 *  table), so hard-delete IS allowed — but per the tag-don't-delete directive
 *  the writer at embeddings.ts l2Get filters `pruned_at IS NONE`, so we soft-tag
 *  here instead and let lane D's l2Put reset the tag if a hash is re-cached.
 *
 *  K17-maint: drains to a TARGET retention rather than tagging one 500-row batch
 *  per boot. Pre-fix this ran once at boot and capped at a single 500-row batch,
 *  so on a host that accrued >500 stale rows between restarts the cache grew
 *  without bound (and a long-lived daemon that never restarts never re-ran it at
 *  all). Now: (1) loop batches until no stale rows remain (bounded by
 *  MAX_BATCHES so a clock skew / mis-set pruned_at can't spin forever), and
 *  (2) the caller arms it on the same 6h interval as runEmbeddingBackfills so a
 *  daemon that stays up for weeks keeps draining.
 *
 *  G10B (2026-06-21): the soft-tag phase above only EVER sets pruned_at — under
 *  the old never-delete rule pruned rows accumulated forever (16.3k of 29.7k on
 *  the dev graph). embedding_cache is TELEMETRY, NOT a content table (D4 lists
 *  it as "DELETE OK"; gc.ts GC_CONTENT_TABLES does not include it), so it needs
 *  no keystone/GATED-GC marker — a plain `DELETE embedding_cache WHERE ...` is
 *  lint-legal. A pruned row is truly dead: l2Get (embeddings.ts:120) filters
 *  `pruned_at IS NONE` so it is never read, and l2Put's UPSERT recomputes the
 *  embedding on a cache miss (embeddings.ts:145 SETs embedding=$vec), so a
 *  re-cached hash gains nothing from a resurrected row over a fresh insert —
 *  hard-deleting a pruned row loses nothing. So after soft-tagging we HARD-DELETE
 *  already-pruned rows in the SAME bounded loop shape (LET+FOR+LIMIT+MAX_BATCHES)
 *  so a huge backlog can't spin forever. Idempotent + store-guarded like the
 *  soft-tag phase. */
async function purgeStaleEmbedCache(state: GlobalPluginState): Promise<void> {
  if (!state.store.isAvailable()) return;
  // Per-batch cap kept at 500 (each batch is one bounded transaction); the loop
  // is what lets it fully drain. MAX_BATCHES * BATCH = 100k rows/run ceiling —
  // far above any realistic single-host stale backlog, and the loop exits early
  // the moment a batch tags < BATCH rows (the common steady-state path).
  const BATCH = 500;
  const MAX_BATCHES = 200;
  // Extract + validate the record-id list from a `SELECT id` result. ids are
  // DB-sourced (embedding_cache:<alnum>), all RECORD_ID_RE-valid, so interpolating
  // them as a Thing list (`IN [id, ...]`) is injection-safe AND the only binding
  // form this engine treats as record refs (a string-array $bind silently no-ops).
  const idsOf = (rows: Array<{ id: unknown }>) =>
    rows.map((r) => String(r.id)).filter((id) => RECORD_ID_RE.test(id));
  try {
    // 2026-06-21: the prior LET+FOR(write)+LIMIT form sent via queryMulti
    // parse-errored ("Unexpected token LIMIT, expected Eof") — a write statement
    // inside FOR combined with a LIMIT-in-LET subquery is rejected by this
    // SurrealDB, and since Phase 1 was the FIRST statement its error skipped
    // Phase 2 too (the swallow.warn ate both). So the maintenance prune silently
    // never ran via this path. Rewritten to the proven keystone idiom:
    // JS-collect a bounded id batch via a plain SELECT, then UPDATE/DELETE
    // ... WHERE id IN [<validated Things>].
    //
    // Phase 1 — soft-tag >30d rows (sets pruned_at; l2Get then stops reading them).
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = await state.store.queryFirst<{ id: unknown }>(
        `SELECT id FROM embedding_cache
           WHERE created_at < time::now() - 30d AND pruned_at IS NONE
           LIMIT ${BATCH}`,
      );
      const ids = idsOf(rows);
      if (ids.length === 0) break;
      await state.store.queryExec(
        `UPDATE embedding_cache SET pruned_at = time::now(), prune_reason = "stale_30d"
           WHERE id IN [${ids.join(", ")}]`,
      );
      if (ids.length < BATCH) break; // last (partial) batch — backlog drained
    }

    // Phase 2 (G10B) — hard-delete already-pruned rows. embedding_cache is
    // TELEMETRY (NOT a content table; D4 lists it DELETE-OK, gc.ts excludes it),
    // so a WHERE-bounded `DELETE embedding_cache WHERE id IN [...]` is lint-legal
    // and needs no keystone/GATED-GC marker. A pruned row is truly dead (l2Get
    // filters pruned_at IS NONE; l2Put recomputes on miss), so deleting loses
    // nothing. Bounded per batch; loop drains the backlog across runs.
    let removed = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = await state.store.queryFirst<{ id: unknown }>(
        `SELECT id FROM embedding_cache WHERE pruned_at IS NOT NONE LIMIT ${BATCH}`,
      );
      const ids = idsOf(rows);
      if (ids.length === 0) break;
      await state.store.queryExec(`DELETE embedding_cache WHERE id IN [${ids.join(", ")}]`);
      removed += ids.length;
      if (ids.length < BATCH) break; // last (partial) batch — pruned backlog drained
    }
    if (removed > 0) {
      log.info(`[maintenance] purgeStaleEmbedCache: hard-deleted ${removed} pruned embedding_cache row(s)`);
    }
  } catch (e) {
    swallow.warn("maintenance:purgeEmbedCache", e);
  }
}

/**
 * Generic oldest-first content-table retention through the gcHardDelete
 * keystone. Shared by E6 (monologue) and E7 (turn_archive) — both ARE content
 * tables (gc.ts GC_CONTENT_TABLES + the D4 lint), so their hard-delete MUST
 * flow through the keystone (snapshot + blast-radius edge co-delete +
 * after-verify), NOT a plain DELETE.
 *
 * Bounded the same way as purgeOldTurnScores: only act when count is
 * meaningfully over `retain` (avoid churn right at the bound), then delete the
 * OLDEST rows (ORDER BY <tsField> ASC) in capped batches, looping until the
 * table is back under `retain` or MAX_BATCHES is hit (termination guard). The
 * per-batch SELECT uses the table's timestamp index.
 *
 * Returns the number of rows deleted (so runJob records it as rows_affected).
 * Store-guarded; per-batch errors propagate to the caller (runJob records an
 * 'error' row) — but gcHardDelete is transactional per batch, so a throw can
 * only lose the CURRENT batch, never corrupt prior ones.
 */
async function purgeOldContentTable(
  state: GlobalPluginState,
  table: "monologue" | "turn_archive",
  tsField: string,
  retain: number,
  reason: string,
): Promise<number> {
  if (!state.store.isAvailable()) return 0;
  // Per-batch cap is modest because gcHardDelete does heavy per-row work
  // (snapshot + a 26-relation-table incident-edge sweep + after-verify), so a
  // huge single batch would be a long transaction. The loop is what drains a
  // backlog. BATCH * MAX_BATCHES = 100k rows/run ceiling — above any realistic
  // single-host backlog accrued between 6h cycles, and the loop exits the moment
  // the table is back under `retain`.
  const BATCH = 1_000;
  const MAX_BATCHES = 100;
  // Only act when meaningfully over target (mirror purgeOldTurnScores' +5k
  // slack) so we don't churn the keystone for a handful of rows every cycle.
  const SLACK = 5_000;
  const idsOf = (rows: Array<{ id: unknown }>) =>
    rows.map((r) => String(r.id)).filter((id) => RECORD_ID_RE.test(id));
  let removed = 0;
  const countRows = await state.store.queryFirst<{ n: number }>(
    `SELECT count() AS n FROM ${table} GROUP ALL`,
  );
  let count = countRows[0]?.n ?? 0;
  if (count <= retain + SLACK) return 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    // How many rows over target remain; cap the batch at BATCH.
    const overage = count - retain;
    if (overage <= 0) break;
    const take = Math.min(overage, BATCH);
    // Oldest-first. ORDER BY <tsField> ASC is served by the table's timestamp
    // index (monologue_timestamp_idx / turn_archive_timestamp_idx).
    const rows = await state.store.queryFirst<{ id: unknown }>(
      `SELECT id FROM ${table} ORDER BY ${tsField} ASC LIMIT ${take}`,
    );
    const ids = idsOf(rows);
    if (ids.length === 0) break;
    // E6/E7 KEYSTONE ROUTE: monologue + turn_archive are content tables, so the
    // hard delete goes through gcHardDelete (snapshot + edge co-delete +
    // after-verify), never a plain DELETE.
    const res = await gcHardDelete(state, table, ids, { reason });
    removed += res.deleted;
    count -= res.deleted;
    if (res.deleted < take) break; // fewer deleted than asked — drained / racing
  }
  if (removed > 0) {
    log.info(`[maintenance] ${reason}: hard-deleted ${removed} old ${table} row(s) via keystone (retain ~${retain})`);
  }
  return removed;
}

/**
 * E6 — monologue retention. The createMonologue hot path writes one row per
 * reasoning moment (memory-daemon.ts) and the table is searched on the hot path
 * via the monologue_vec_idx HNSW index, so left unbounded it grows forever and
 * inflates both the store and every vector search. monologue IS a content table
 * (gc.ts GC_CONTENT_TABLES:64), so this routes through the gcHardDelete
 * keystone. Keep the most-recent ~30k rows (monologue feeds soul generation;
 * 30k is generous for a single-host install's reasoning history).
 */
async function purgeOldMonologue(state: GlobalPluginState): Promise<number> {
  return purgeOldContentTable(state, "monologue", "timestamp", 30_000, "monologue retention (E6)");
}

/**
 * E7 — turn_archive retention. archiveOldTurns only RELOCATES rows here (INSERT
 * INTO turn_archive + tag the source turn), so this cold-storage table grew
 * FOREVER. turn_archive IS a content table (gc.ts GC_CONTENT_TABLES:68), so the
 * trim routes through the gcHardDelete keystone. Keep the newest ~100k rows
 * (turn_archive is the largest vector table; 100k is a generous archival depth
 * for a single host — older archived turns are rarely the recall winner and the
 * live `turn` table still holds the recent corpus). Rows are copied verbatim
 * from `turn`, which carries `timestamp`, so we order by that.
 */
async function purgeOldTurnArchive(state: GlobalPluginState): Promise<number> {
  return purgeOldContentTable(state, "turn_archive", "timestamp", 100_000, "turn_archive retention (E7)");
}
