/**
 * Background maintenance — fired on MCP boot and on every SessionStart.
 *
 * Restores the five jobs that used to live in KongBrain's
 * ContextEngine.bootstrap(), which the OpenClaw framework called on session
 * lifecycle. KongCode has no such framework call, so these had been silently
 * not running since the port. See GitHub issue history around 2026-04-21.
 *
 * Each job is internally bounded (count<=200/2000/50 safety floors, LIMIT 50
 * on destructive operations) and idempotent, so it's safe to run on every
 * MCP boot AND on every SessionStart. The ACAN retrain carries its own
 * lockfile from acan.ts preventing concurrent retrains across sibling MCPs.
 *
 * Fire-and-forget — the caller should not await this. Errors go to
 * swallow.warn so they're visible without blocking startup.
 */
import { checkACANReadiness } from "./acan.js";
import { swallow } from "./errors.js";
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
function migrateLegacyACANWeights(cacheDir) {
    try {
        const legacyPath = join(homedir(), ".kongbrain", "acan_weights.json");
        const newPath = join(cacheDir, "acan_weights.json");
        if (!existsSync(legacyPath))
            return; // nothing to migrate
        if (existsSync(newPath))
            return; // already migrated, idempotent skip
        if (!existsSync(cacheDir))
            mkdirSync(cacheDir, { recursive: true });
        copyFileSync(legacyPath, newPath);
        log.info(`[maintenance] migrated ACAN weights forward: ${legacyPath} -> ${newPath} (legacy file preserved)`);
    }
    catch (e) {
        swallow.warn("maintenance:migrateLegacyACAN", e);
    }
}
export function runBootstrapMaintenance(state) {
    const { store, embeddings, config } = state;
    const deferMs = Number(process.env.KONGCODE_MAINTENANCE_DEFER_MS) || 30_000;
    // One-time forward-migration of ACAN weights from ~/.kongbrain/ to cacheDir.
    // Cheap (one stat + zero or one copy), idempotent, runs early so the deferred
    // checkACANReadiness call below picks up the migrated weights.
    // Guarded against partial test mocks that omit config.paths.
    const cacheDir = config.paths?.cacheDir ?? join(homedir(), ".kongcode", "cache");
    migrateLegacyACANWeights(cacheDir);
    // Group 1: cheap DB queries — safe to run immediately in parallel
    Promise.all([
        store.runMemoryMaintenance(),
        store.purgeStalePendingWork(),
        purgeStaleEmbedCache(state),
    ]).then(async () => {
        // Group 2: moderate cost — after cheap queries complete
        await store.archiveOldTurns().catch(e => swallow.warn("maintenance:archiveOldTurns", e));
        await store.garbageCollectMemories().catch(e => swallow.warn("maintenance:gcMemories", e));
        await store.garbageCollectConcepts().catch(e => swallow.warn("maintenance:gcConcepts", e));
        await backfillSessionTurnCounts(state);
        await seedSkillsFromJson(state);
        await backfillSkillEmbeddings(state);
    }).catch(e => swallow.warn("bootstrap:maintenance:group2", e));
    // Group 3: CPU-heavy — deferred so first-turn context assembly is uncontested
    const heavyTimer = setTimeout(async () => {
        if (!store.isAvailable())
            return;
        try {
            await store.consolidateMemories((text) => embeddings.embed(text));
        }
        catch (e) {
            swallow.warn("maintenance:consolidate", e);
        }
        // Indexed-table backfill lives here in Group 3, not Group 2, because
        // backfillSkillEmbeddings showed no log evidence of ever running across
        // 217KB of daemon log — likely because Group 2 fires before
        // embeddings.isAvailable() flips true and the function short-circuits.
        // consolidateMemories at top of Group 3 proves embeddings are ready,
        // so artifact + concept backfill here is guaranteed to find a live
        // BGE-M3 context.
        try {
            await backfillArtifactEmbeddings(state);
            await backfillConceptEmbeddings(state);
            await backfillReflectionEmbeddings(state);
            await backfillMonologueEmbeddings(state);
            await backfillTurnArchiveEmbeddings(state);
        }
        catch (e) {
            swallow.warn("maintenance:backfill-indexed", e);
        }
        try {
            await checkACANReadiness(store, config.thresholds.acanTrainingThreshold, cacheDir);
        }
        catch (e) {
            swallow.warn("maintenance:acan", e);
        }
    }, deferMs);
    heavyTimer.unref?.();
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
async function backfillSessionTurnCounts(state) {
    if (!state.store.isAvailable())
        return;
    try {
        // turn.session_id stores the Claude Code session id (a UUID string), NOT
        // a SurrealDB record id. So we look up the matching session row via the
        // kc_session_id field, not by interpolating into the UPDATE target.
        // (Earlier 0.7.12 attempt did the wrong thing and tripped SurrealDB's
        // SQL parser on UUIDs that contain hex sequences read as arithmetic.)
        const counts = await state.store.queryFirst(`SELECT session_id, count() AS n FROM turn WHERE session_id IS NOT NONE GROUP BY session_id`);
        if (!counts.length)
            return;
        for (const row of counts) {
            if (!row?.session_id || !row?.n)
                continue;
            try {
                await state.store.queryExec(`UPDATE session SET turn_count = $n
            WHERE kc_session_id = $kc
              AND (turn_count == 0 OR turn_count IS NONE)`, { n: row.n, kc: row.session_id });
            }
            catch (e) {
                swallow.warn("maintenance:backfillTurnCount:update", e);
            }
        }
    }
    catch (e) {
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
async function seedSkillsFromJson(state) {
    if (!state.store.isAvailable())
        return;
    try {
        // Resolve repo root from the running module location. The compiled file
        // lives at dist/engine/maintenance.js inside the plugin dir, so two
        // levels up is the plugin root.
        const here = fileURLToPath(import.meta.url);
        const pluginDir = resolve(here, "..", "..", "..");
        const seedPath = join(pluginDir, ".claude-plugin", "skills-seed.json");
        if (!existsSync(seedPath))
            return;
        const raw = JSON.parse(readFileSync(seedPath, "utf8"));
        if (!Array.isArray(raw?.skills))
            return;
        let inserted = 0;
        let skipped = 0;
        for (const s of raw.skills) {
            if (!s?.name || !s?.description || !s?.body)
                continue;
            try {
                const existing = await state.store.queryFirst(`SELECT id FROM skill WHERE name = $name LIMIT 1`, { name: s.name });
                if (existing.length > 0) {
                    skipped++;
                    continue;
                }
                await state.store.queryExec(`CREATE skill CONTENT {
            name: $name,
            description: $description,
            body: $body,
            steps: $steps,
            preconditions: $preconditions,
            postconditions: $postconditions,
            source: "seed",
            active: true,
            confidence: 1.0
          }`, {
                    name: s.name,
                    description: s.description,
                    body: s.body,
                    steps: s.steps ?? [],
                    preconditions: s.preconditions ?? null,
                    postconditions: s.postconditions ?? null,
                });
                inserted++;
            }
            catch (e) {
                swallow.warn(`maintenance:seedSkill:${s.name}`, e);
            }
        }
        if (inserted > 0) {
            log.info(`[maintenance] skill seed: ${inserted} inserted, ${skipped} already present (${raw.skills.length} total in seed)`);
        }
    }
    catch (e) {
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
async function backfillSkillEmbeddings(state) {
    if (!state.store.isAvailable())
        return;
    if (!state.embeddings.isAvailable())
        return;
    try {
        const rows = await state.store.queryFirst(`SELECT id, name, description, body FROM skill
        WHERE embedding IS NONE AND (active = true OR active IS NONE)
        LIMIT 50`);
        if (!rows.length)
            return;
        log.info(`[maintenance] backfilling skill embeddings: ${rows.length} row(s)`);
        let ok = 0;
        for (const row of rows) {
            if (!row?.id || !row?.name)
                continue;
            const target = `${row.name}: ${row.description ?? ""}${row.body ? "\n\n" + row.body : ""}`;
            try {
                const vec = await state.embeddings.embed(target);
                if (!vec?.length)
                    continue;
                // Update by `name` (safe filter, no `$id` pattern). Migration script
                // guarantees names are unique per skill row by skipping name-collisions
                // on insert, so this matches at most one row.
                await state.store.queryExec(`UPDATE skill SET embedding = $vec WHERE name = $name AND embedding IS NONE`, { name: row.name, vec });
                ok++;
            }
            catch (e) {
                swallow.warn(`maintenance:backfillSkillEmbeddings:${row.name}`, e);
            }
        }
        log.info(`[maintenance] skill embedding backfill: ${ok}/${rows.length} embedded`);
    }
    catch (e) {
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
async function backfillArtifactEmbeddings(state) {
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
        const rows = await state.store.queryFirst(`SELECT id, path, description FROM artifact
        WHERE embedding IS NONE OR array::len(embedding) = 0
        LIMIT 50`);
        total = rows.length;
        log.info(`[maintenance] backfillArtifactEmbeddings: SELECT returned ${total} row(s)`);
        if (!rows.length)
            return;
        for (const row of rows) {
            if (!row?.id || !row?.path)
                continue;
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
                await state.store.queryExec(`UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`, { vec });
                ok++;
            }
            catch (e) {
                log.warn(`[maintenance] backfillArtifactEmbeddings: row ${row.path} FAILED: ${e?.message ?? e}`);
                swallow.warn(`maintenance:backfillArtifactEmbeddings:${row.path}`, e);
            }
        }
        log.info(`[maintenance] backfillArtifactEmbeddings: complete ${ok}/${total} embedded in ${Date.now() - started}ms`);
    }
    catch (e) {
        log.warn(`[maintenance] backfillArtifactEmbeddings: TOP-LEVEL FAIL: ${e?.message ?? e}`);
        swallow.warn("maintenance:backfillArtifactEmbeddings", e);
    }
}
/** Embedding backfill for concept rows where embedding IS NONE OR len=0.
 *
 *  Same shape as backfillArtifactEmbeddings. Embed target matches
 *  commit.ts:456 (just `name`) so backfilled vectors agree with the
 *  hot-path. */
async function backfillConceptEmbeddings(state) {
    if (!state.store.isAvailable())
        return;
    if (!state.embeddings.isAvailable())
        return;
    try {
        const rows = await state.store.queryFirst(
        // Hardening (2026-05-18): explicitly require name to be set. The loop
        // below `continue`s on missing name anyway, but filtering at SELECT
        // makes the contract visible. Rows that legitimately need healing but
        // lack name (e.g. legacy pre-migration writers — see the 2026-05-15
        // iKong session that left 4 such rows; healed via custom script + this
        // session's investigation) must be addressed by setting name first.
        `SELECT id, name FROM concept
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND name IS NOT NONE
          AND name != ""
        LIMIT 50`);
        if (!rows.length)
            return;
        log.info(`[maintenance] backfilling concept embeddings: ${rows.length} row(s)`);
        let ok = 0;
        for (const row of rows) {
            if (!row?.id || !row?.name)
                continue;
            // Concept embed target = name (matches commit.ts:456 hot-path). Names
            // are typically short, but guard with the same 6000-char truncation
            // as artifact for defense-in-depth against pathological gem-derived
            // concept names.
            let target = row.name;
            if (target.length > 6000) {
                log.warn(`[maintenance] backfillConceptEmbeddings: truncating name len=${target.length} → 6000`);
                target = target.slice(0, 6000);
            }
            try {
                const vec = await state.embeddings.embed(target);
                if (!vec?.length)
                    continue;
                // WHERE guard mirrors the SELECT predicate (NONE OR len=0).
                await state.store.queryExec(`UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`, { vec });
                ok++;
            }
            catch (e) {
                swallow.warn(`maintenance:backfillConceptEmbeddings:${row.name}`, e);
            }
        }
        log.info(`[maintenance] concept embedding backfill: ${ok}/${rows.length} embedded`);
    }
    catch (e) {
        swallow.warn("maintenance:backfillConceptEmbeddings", e);
    }
}
/** Embedding backfill for reflection rows where embedding IS NONE OR len=0.
 *
 *  Mirrors backfillArtifactEmbeddings. Reflection hot-path at commit.ts:681
 *  swallows embed failures and persists the row with embedding=null; without
 *  this backfill those rows are permanent recall sediment. Embed target =
 *  `text` field, matching the hot-path. */
async function backfillReflectionEmbeddings(state) {
    if (!state.store.isAvailable())
        return;
    if (!state.embeddings.isAvailable())
        return;
    try {
        const rows = await state.store.queryFirst(`SELECT id, text FROM reflection
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND (active = true OR active IS NONE)
        LIMIT 50`);
        if (!rows.length)
            return;
        log.info(`[maintenance] backfilling reflection embeddings: ${rows.length} row(s)`);
        let ok = 0;
        for (const row of rows) {
            if (!row?.id || !row?.text)
                continue;
            let target = row.text;
            if (target.length > 6000) {
                log.warn(`[maintenance] backfillReflectionEmbeddings: truncating text len=${target.length} → 6000`);
                target = target.slice(0, 6000);
            }
            try {
                const vec = await state.embeddings.embed(target);
                if (!vec?.length)
                    continue;
                await state.store.queryExec(`UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`, { vec });
                ok++;
            }
            catch (e) {
                swallow.warn(`maintenance:backfillReflectionEmbeddings:${String(row.id)}`, e);
            }
        }
        log.info(`[maintenance] reflection embedding backfill: ${ok}/${rows.length} embedded`);
    }
    catch (e) {
        swallow.warn("maintenance:backfillReflectionEmbeddings", e);
    }
}
/** Embedding backfill for monologue rows. Hot-path at memory-daemon.ts:280
 *  swallows embed failures; embed target = `content` field. */
async function backfillMonologueEmbeddings(state) {
    if (!state.store.isAvailable())
        return;
    if (!state.embeddings.isAvailable())
        return;
    try {
        const rows = await state.store.queryFirst(`SELECT id, content FROM monologue
        WHERE embedding IS NONE OR array::len(embedding) = 0
        LIMIT 50`);
        if (!rows.length)
            return;
        log.info(`[maintenance] backfilling monologue embeddings: ${rows.length} row(s)`);
        let ok = 0;
        for (const row of rows) {
            if (!row?.id || !row?.content)
                continue;
            let target = row.content;
            if (target.length > 6000) {
                log.warn(`[maintenance] backfillMonologueEmbeddings: truncating content len=${target.length} → 6000`);
                target = target.slice(0, 6000);
            }
            try {
                const vec = await state.embeddings.embed(target);
                if (!vec?.length)
                    continue;
                await state.store.queryExec(`UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`, { vec });
                ok++;
            }
            catch (e) {
                swallow.warn(`maintenance:backfillMonologueEmbeddings:${String(row.id)}`, e);
            }
        }
        log.info(`[maintenance] monologue embedding backfill: ${ok}/${rows.length} embedded`);
    }
    catch (e) {
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
async function backfillTurnArchiveEmbeddings(state) {
    if (!state.store.isAvailable())
        return;
    if (!state.embeddings.isAvailable())
        return;
    try {
        const rows = await state.store.queryFirst(`SELECT id, text FROM turn_archive
        WHERE (embedding IS NONE OR array::len(embedding) = 0)
          AND text != NONE
        LIMIT 200`);
        if (!rows.length)
            return;
        log.info(`[maintenance] backfilling turn_archive embeddings: ${rows.length} row(s)`);
        let ok = 0;
        for (const row of rows) {
            if (!row?.id || !row?.text)
                continue;
            let target = row.text;
            if (target.length > 6000) {
                log.warn(`[maintenance] backfillTurnArchiveEmbeddings: truncating text len=${target.length} → 6000`);
                target = target.slice(0, 6000);
            }
            try {
                const vec = await state.embeddings.embed(target);
                if (!vec?.length)
                    continue;
                await state.store.queryExec(`UPDATE ${String(row.id)} SET embedding = $vec WHERE embedding IS NONE OR array::len(embedding) = 0`, { vec });
                ok++;
            }
            catch (e) {
                swallow.warn(`maintenance:backfillTurnArchiveEmbeddings:${String(row.id)}`, e);
            }
        }
        log.info(`[maintenance] turn_archive embedding backfill: ${ok}/${rows.length} embedded`);
    }
    catch (e) {
        swallow.warn("maintenance:backfillTurnArchiveEmbeddings", e);
    }
}
async function purgeStaleEmbedCache(state) {
    if (!state.store.isAvailable())
        return;
    try {
        // v0.7.96 tag-don't-delete (core_memory:hoj8fvmbt7d14mskciba): was DELETE
        // on rows >30d, now soft-tag via pruned_at + prune_reason. l2Get filters
        // `pruned_at IS NONE` so stale cache entries are inert but recallable.
        // Schema fields added at schema.surql for embedding_cache.
        await state.store.queryExec(`UPDATE embedding_cache SET
         pruned_at = time::now(),
         prune_reason = "stale_30d"
       WHERE created_at < time::now() - 30d
         AND pruned_at IS NONE
       LIMIT 500`);
    }
    catch (e) {
        swallow.warn("maintenance:purgeEmbedCache", e);
    }
}
