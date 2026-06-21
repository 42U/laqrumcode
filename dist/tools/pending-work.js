/**
 * MCP tools for subagent-driven background processing.
 *
 * fetch_pending_work — Claims the next pending item and returns
 *   instructions + data for the subagent to process.
 * commit_work_results — Accepts the subagent's extraction output
 *   and persists it to SurrealDB via existing write functions.
 *
 * These tools replace the Anthropic SDK direct calls. The LLM
 * reasoning now happens in the subagent (Opus) itself, not in
 * a separate API call from the MCP server.
 */
import { randomUUID } from "node:crypto";
import { validateExtraction } from "../engine/daemon-types.js";
import { buildCoalescedPrompt, buildTranscript, writeExtractionResults } from "../engine/memory-daemon.js";
import { createSoul, seedSoulAsCoreMemory, reviseSoul, getSoul, checkGraduation, getQualitySignals, recordGraduationEvent } from "../engine/soul.js";
import { swallow, isUniqueViolation } from "../engine/errors.js";
import { clamp01 } from "../engine/math.js";
import { log } from "../engine/log.js";
import { stripStructuralTags } from "../engine/sanitize.js";
import { commitKnowledge, linkConceptCrossLink } from "../engine/commit.js";
import { assertRecordId } from "../engine/surreal.js";
// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Walk the .cause chain so wrapped errors (e.g. createArtifact wrapping a
 * UNIQUE-conflict cause) don't lose their inner message when stringified
 * into the JSON response the subagent reads. `String(e)` collapses to just
 * the top-level message; this walks the chain and joins them.
 *
 * Bounded by both a cycle-detection WeakSet and a fixed depth ceiling — without
 * these, a self-referencing `.cause` (legal in Node since 16; user code can
 * trivially build one) would spin the loop indefinitely and a deeply-nested
 * legitimate chain would still spend CPU producing a multi-megabyte string.
 * Reviewer probe measured 6.4s CPU + RangeError on a circular chain before
 * this guard; bound now caps at 8 cause hops + 4096 chars total.
 */
function serializeError(e) {
    if (!(e instanceof Error))
        return String(e ?? "unknown");
    const seen = new WeakSet();
    seen.add(e);
    let out = e.message;
    let cur = e.cause;
    let depth = 0;
    let truncated = false;
    while (cur instanceof Error && !seen.has(cur) && depth < 8) {
        seen.add(cur);
        out += ` | caused by: ${cur.message}`;
        cur = cur.cause;
        depth++;
    }
    if ((cur instanceof Error && depth >= 8) || (cur && typeof cur === "object" && seen.has(cur))) {
        truncated = true;
    }
    if (truncated)
        out += " | (chain truncated)";
    if (out.length > 4096)
        out = out.slice(0, 4093) + "...";
    return out;
}
// Skill extraction JSON schema (matches skills.ts)
const skillSchema = {
    type: "object",
    properties: {
        name: { type: "string" },
        description: { type: "string" },
        preconditions: { type: "string" },
        steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, description: { type: "string" } } } },
        postconditions: { type: "string" },
    },
    required: ["name", "description", "steps"],
};
// Soul document schema (matches soul.ts)
const soulSchema = {
    type: "object",
    properties: {
        working_style: { type: "array", items: { type: "string" } },
        emotional_dimensions: {
            type: "array",
            items: {
                type: "object",
                properties: { dimension: { type: "string" }, description: { type: "string" } },
                required: ["dimension", "description"],
                additionalProperties: false,
            },
        },
        self_observations: { type: "array", items: { type: "string" } },
        earned_values: {
            type: "array",
            items: {
                type: "object",
                properties: { value: { type: "string" }, grounded_in: { type: "string" } },
                required: ["value", "grounded_in"],
                additionalProperties: false,
            },
        },
    },
    required: ["working_style", "emotional_dimensions", "self_observations", "earned_values"],
};
// ── fetch_pending_work ───────────────────────────────────────────────────────
/**
 * Count pending_work rows that would ACTUALLY yield work if drained — the
 * "actionable" count behind the SessionStart / UserPromptSubmit "DRAIN NOW"
 * banners and the auto-drain spawn decision.
 *
 * The raw `status='pending' AND active` count over-reports: session-end
 * ALWAYS enqueues causal_graduate + soul_evolve/soul_generate regardless of
 * eligibility (session-end.ts), and 4 of 5 builders self-complete to empty
 * when ineligible (see buildWorkPayload below). Counting those raw produced
 * the "DRAIN NOW, N items" banner for a queue that drains to nothing — the
 * recurring empty-drain report (2026-06-18). This runs the SAME global
 * eligibility probes the builders use, so a type is only counted when it
 * would produce a real payload.
 *
 * MUST stay in sync with buildWorkPayload's self-completion conditions.
 * Internal queue-hygiene metrics (observability.ts buildup/aging, the
 * http-api health cache) deliberately keep the RAW count — they measure
 * queue depth / 7-day purge risk, not actionability.
 */
export async function countActionablePendingWork(store) {
    if (!store.isAvailable())
        return 0;
    const rows = await store.queryFirst(`SELECT work_type, count() AS n FROM pending_work
       WHERE status = "pending" AND (active = true OR active IS NONE)
       GROUP BY work_type`);
    if (rows.length === 0)
        return 0;
    // Probe each global-eligibility condition at most once per call.
    let causalEligible = null;
    let soulEvolveEligible = null;
    let soulGenReady = null;
    let total = 0;
    for (const r of rows) {
        const n = r.n ?? 0;
        switch (r.work_type) {
            case "coalesced_extraction":
                // Content-gated at enqueue (userTurnCount >= 2); the blank-transcript
                // guard in buildWorkPayload is a rare edge we accept counting.
                total += n;
                break;
            case "causal_graduate":
                if (causalEligible === null)
                    causalEligible = await hasEligibleCausalChains(store);
                if (causalEligible)
                    total += n;
                break;
            case "soul_generate":
                if (soulGenReady === null)
                    soulGenReady = await checkGraduation(store).then(g => g.ready).catch(() => false);
                if (soulGenReady)
                    total += n;
                break;
            case "soul_evolve":
                if (soulEvolveEligible === null)
                    soulEvolveEligible = await hasNewSoulExperience(store);
                if (soulEvolveEligible)
                    total += n;
                break;
            default:
                // Unknown work types self-complete empty in buildWorkPayload (they
                // never yield knowledge), so they are NOT actionable — counting them
                // would re-create the empty-drain banner this function exists to kill.
                break;
        }
    }
    return total;
}
/** ≥1 ungraduated chain_type with ≥3 high-confidence successful chains.
 *  Mirrors buildWorkPayload case "causal_graduate". */
async function hasEligibleCausalChains(store) {
    try {
        const groups = await store.queryFirst(`SELECT chain_type, count() AS cnt FROM causal_chain
         WHERE success = true AND confidence >= 0.7 AND graduated_at IS NONE
         GROUP BY chain_type`);
        return groups.some(g => (g.cnt ?? 0) >= 3);
    }
    catch {
        return false;
    }
}
/** Soul exists AND there is new experience (reflection/causal_chain/monologue)
 *  since soul.updated_at. Mirrors buildWorkPayload case "soul_evolve". */
async function hasNewSoulExperience(store) {
    try {
        const soul = await getSoul(store);
        if (!soul)
            return false;
        const since = soul.updated_at;
        const [r, c, m] = await Promise.all([
            store.queryFirst(`SELECT count() AS n FROM reflection WHERE created_at > $since GROUP ALL`, { since }).catch(() => []),
            store.queryFirst(`SELECT count() AS n FROM causal_chain WHERE created_at > $since GROUP ALL`, { since }).catch(() => []),
            store.queryFirst(`SELECT count() AS n FROM monologue WHERE timestamp > $since GROUP ALL`, { since }).catch(() => []),
        ]);
        return (r[0]?.n ?? 0) + (c[0]?.n ?? 0) + (m[0]?.n ?? 0) > 0;
    }
    catch {
        return false;
    }
}
export async function handleFetchPendingWork(state, _session, _args) {
    const { store } = state;
    if (!store.isAvailable()) {
        return text("Database unavailable. Cannot fetch pending work.");
    }
    try {
        // Reset stale items stuck in "processing" > 10 min. The compound UNIQUE on
        // (session_id, work_type, status) means we can't blindly UPDATE status to
        // "pending" because that revives a duplicate when a sibling row for the
        // same (session_id, work_type) already exists in ANY status. A revived
        // row would later collide at commit_work_results time when it transitions
        // to "completed" (or "failed") and the sibling terminal row already
        // occupies that triple. Canonical symptom 2026-05-15: fetch_pending_work
        // returning "Database index pw_session_worktype_status_unique already
        // contains [262f8e79-..., soul_evolve, completed]" on every call, blocking
        // the entire claim path. So:
        //   1. find stuck rows
        //   2. for each, check for ANY sibling row (excluding self) → DELETE the
        //      stuck row if any exists; otherwise UPDATE to pending so a sole
        //      stuck row can still recover. Pre-0.7.75 this check only matched
        //      sibling "pending" rows, which left completed/failed-sibling cases
        //      as future collision bombs at commit time.
        try {
            // ORDER BY created_at ASC: without this, the sibling SELECT below
            // picks at random. Under multi-stuck conditions that can DELETE the
            // wrong row. Stable ordering ensures the oldest stuck row is recovered
            // first, matching FIFO intuition.
            const stuck = await store.queryFirst(
            // M2: key the stale window off processing_started_at (when the row was
            // CLAIMED), falling back to created_at for legacy rows — otherwise a
            // long-but-healthy extraction created >10m ago but claimed seconds ago
            // is wrongly reverted while the drainer is still working it (feeds the
            // C1 double-write). Also catch the transient "committing" state so a
            // crash between the commit-CAS and markTerminal can't wedge a row.
            `SELECT id, session_id, work_type FROM pending_work
           WHERE (status = "processing" OR status = "committing")
             AND (processing_started_at ?? created_at) < time::now() - 10m
             AND (active = true OR active IS NONE)
           ORDER BY created_at ASC`);
            for (const row of stuck) {
                try {
                    assertRecordId(String(row.id));
                    // BEGIN/COMMIT around the (sibling-check + DELETE-or-UPDATE) so the
                    // check-and-act is atomic. The sibling SELECT is unfiltered by
                    // status (widened in v0.7.75 from "pending"-only): any other row
                    // for the same (session_id, work_type) triggers DELETE of the
                    // stuck row. AND id != ${row.id} excludes self from the check so
                    // we don't see ourselves as our own sibling.
                    // v0.7.95 append-only: was DELETE of duplicate stuck row — now
                    // soft-archives via active=false + archive_reason. Sibling
                    // still exists, so this row is redundant; UPDATE preserves the
                    // forensic trail without polluting the active queue.
                    await store.queryExec(`BEGIN TRANSACTION;
             LET $siblings = (SELECT id FROM pending_work
               WHERE session_id = $sid AND work_type = $wt AND id != ${row.id}
                 AND (active = true OR active IS NONE) LIMIT 1);
             IF array::len($siblings) > 0 THEN
               UPDATE ${row.id} SET
                 active = false,
                 archived_at = time::now(),
                 completed_at = time::now(),
                 archive_reason = "stale_recovery_sibling_won"
             ELSE
               UPDATE ${row.id} SET status = "pending"
             END;
             COMMIT TRANSACTION;`, { sid: row.session_id, wt: row.work_type });
                }
                catch (e) {
                    swallow.warn("pending-work:stale-recovery-row", e);
                }
            }
        }
        catch (e) {
            swallow.warn("pending-work:stale-recovery", e);
        }
        // 0.7.119 skip-ahead loop: several payload builders SELF-COMPLETE their
        // item when nothing is eligible (causal_graduate with no ungraduated
        // chains, soul_evolve with no new experience, blank-transcript
        // extraction) and return `empty:true`. Handing that to the drain agent
        // burned a full agent round-trip per empty item, and the agent narrating
        // "the work was empty" per item read like a pipeline failure (founder
        // report 2026-06-11). Loop past self-completed items daemon-side; only a
        // REAL payload or the final done-message reaches the agent. Bounded so a
        // pathological queue of empties can't spin forever.
        const MAX_SELF_COMPLETED_SKIPS = 10;
        for (let pass = 0;; pass++) {
            // Claim the highest-priority pending item. SELECT-then-conditional-
            // UPDATE: the WHERE status="pending" on the UPDATE acts as an
            // optimistic lock so concurrent claimers don't double-process.
            const candidates = await store.queryFirst(`SELECT id FROM pending_work
           WHERE status = "pending"
             AND (active = true OR active IS NONE)
           ORDER BY priority ASC, created_at ASC LIMIT 3`);
            if (candidates.length === 0) {
                return text(JSON.stringify({ empty: true, message: "No pending work items. You are done." }));
            }
            let item = null;
            for (const candidate of candidates) {
                const claimedId = String(candidate.id);
                assertRecordId(claimedId);
                // Direct interpolation safe: assertRecordId validates format above.
                // WHERE status="pending" ensures only the first claimer wins the race.
                const items = await store.queryFirst(`UPDATE ${claimedId} SET status = "processing", processing_started_at = time::now() WHERE status = "pending" RETURN AFTER`);
                if (items.length > 0) {
                    item = items[0];
                    break;
                }
            }
            if (!item) {
                return text(JSON.stringify({ empty: true, message: "No pending work items. You are done." }));
            }
            log.info(`[pending_work] Claimed ${item.work_type} (${item.id})`);
            const result = await buildWorkPayload(item, state);
            if (result.empty === true && pass < MAX_SELF_COMPLETED_SKIPS) {
                // Builder already marked the item terminal — move on to real work.
                log.info(`[pending_work] ${item.work_type} (${item.id}) self-completed empty — skipping ahead`);
                continue;
            }
            return text(JSON.stringify(result));
        }
    }
    catch (e) {
        log.error("[pending_work] fetch error:", e);
        return text(JSON.stringify({ error: serializeError(e) }));
    }
}
/**
 * Atomically transition a pending_work row to a terminal status.
 *
 * The compound UNIQUE index pw_session_worktype_status_unique on
 * (session_id, work_type, status) means a naive UPDATE-to-terminal collides
 * when a sibling row already occupies the target triple. Canonical
 * pre-v0.7.75 symptom: fetch_pending_work returns "Database index
 * pw_session_worktype_status_unique already contains
 * [..., soul_evolve, completed]" when an early-exit UPDATE...SET
 * status="completed" runs against a row whose (session, work_type) already
 * has a completed sibling. Resolution: pre-check for a sibling row at
 * (session_id, work_type, target_status) excluding self. If one exists,
 * DELETE this row (the sibling is canonical). Otherwise UPDATE to terminal.
 *
 * Use this for every UPDATE-to-terminal call site (early-exits in
 * buildWorkPayload and the success/failure paths in handleCommitWorkResults).
 * The stale-recovery transaction in handleFetchPendingWork above uses the
 * same pattern for stuck-processing rows.
 *
 * R9: `guardToken` makes the terminal transition ownership-gated. The K15
 * `stillOwned` pre-check in handleCommitWorkResults is a snapshot taken BEFORE
 * a multi-minute commitResults; if the row is reclaimed by another drainer
 * DURING that window (its committing_token changes), an UNGUARDED
 * markTerminal(completed) would still stamp this row completed → the residual
 * C1 double-write. When guardToken is passed, the terminal UPDATE itself
 * carries `WHERE status="committing" AND committing_token=$guard`, so the
 * stamp lands ONLY if we still own the row at write time. Zero matched rows
 * means "reclaimed mid-write" → returns false so the caller discards the
 * outcome rather than reporting a completion it doesn't own. Callers that pass
 * NO guardToken (buildWorkPayload's self-complete early-exits, which act on a
 * row freshly claimed in "processing") keep the original unconditional
 * behavior. Returns true when the row was terminalized or archived by THIS
 * call, false only when a guardToken was supplied and no longer matched.
 */
async function markTerminal(state, workId, sessionId, workType, status, guardToken) {
    assertRecordId(workId);
    // v0.7.95 append-only: was DELETE on terminal-sibling collision — now
    // soft-archives. Sibling already occupies the canonical (session, work,
    // status) triple, so this row is the duplicate; preserve the forensic trail
    // via UPDATE active=false. `archived_status` records the intended terminal
    // status for audit WITHOUT setting `status` (which would collide on the
    // (session,work_type,status) UNIQUE index — the very reason this branch
    // archives instead). (audit C4)
    //
    // R9 ownership gate: when guardToken is supplied the ELSE branch's UPDATE
    // matches only a row still in "committing" carrying THIS token. The
    // returned $changed array (RETURN AFTER) is empty when the gate didn't
    // match — i.e. the row was reclaimed/terminalized by someone else
    // mid-commit — and we report false so the caller discards its outcome.
    // The sibling-archive branch is NOT gated: if a canonical sibling already
    // holds the triple, this row is redundant regardless of who owns it, and
    // archiving it (active=false) can never double-write knowledge.
    try {
        if (!guardToken) {
            // UNGUARDED path (buildWorkPayload self-complete early-exits): unchanged
            // from the original — a fire-and-forget BEGIN/COMMIT via queryExec. These
            // callers act on a row they JUST claimed in "processing", so there is no
            // mid-write reclaim to defend against and no return value to read.
            await state.store.queryExec(`BEGIN TRANSACTION;
         LET $siblings = (SELECT id FROM pending_work
           WHERE session_id = $sid AND work_type = $wt AND status = $st AND id != ${workId}
             AND (active = true OR active IS NONE) LIMIT 1);
         IF array::len($siblings) > 0 THEN
           UPDATE ${workId} SET
             active = false,
             archived_at = time::now(),
             completed_at = time::now(),
             archived_status = $st,
             archive_reason = "terminal_sibling_canonical"
         ELSE
           UPDATE ${workId} SET status = $st, completed_at = time::now()
         END;
         COMMIT TRANSACTION;`, { sid: sessionId, wt: workType, st: status });
            return true;
        }
        // GUARDED path (R9, commit success/failure): the ELSE-branch UPDATE is
        // ownership-gated — it matches only a row STILL in "committing" carrying
        // OUR token. If a reclaim flipped the token mid-commit the UPDATE matches
        // no row and $changed is empty → we report false so the caller discards a
        // completion it no longer owns. The return value is read back via
        // queryMulti's LET + conditional-UPDATE + `RETURN { … }` shape (the proven
        // maintenance.ts purgeStalePendingWork / purgeEmbedCache idiom). No
        // explicit BEGIN/COMMIT: the statements run in one request and the C2
        // UNIQUE-collision race is still caught below by isUniqueViolation — the
        // wrapper transaction never prevented that collision, the catch did.
        const res = await state.store.queryMulti(`LET $siblings = (SELECT id FROM pending_work
         WHERE session_id = $sid AND work_type = $wt AND status = $st AND id != ${workId}
           AND (active = true OR active IS NONE) LIMIT 1);
       LET $archived = (IF array::len($siblings) > 0 THEN
         (UPDATE ${workId} SET
           active = false,
           archived_at = time::now(),
           completed_at = time::now(),
           archived_status = $st,
           archive_reason = "terminal_sibling_canonical" RETURN AFTER)
       ELSE [] END);
       LET $changed = (IF array::len($siblings) > 0 THEN []
         ELSE (UPDATE ${workId} SET status = $st, completed_at = time::now()
           WHERE status = "committing" AND committing_token = $guard RETURN AFTER) END);
       RETURN { changed: array::len($changed), archived: array::len($archived) };`, { sid: sessionId, wt: workType, st: status, guard: guardToken });
        // Gate matched nothing AND nothing was archived → row reclaimed mid-write.
        if ((res?.changed ?? 0) === 0 && (res?.archived ?? 0) === 0) {
            return false;
        }
        return true;
    }
    catch (e) {
        // C2: the LET $siblings check is a snapshot read. Under concurrency two
        // terminal transitions for the same (session, work_type, status) can both
        // see no sibling, both take the ELSE branch, and the second COMMIT violates
        // the UNIQUE index. Pre-fix that threw and left this row stuck in
        // "processing", wedging the claim path. A sibling now demonstrably holds the
        // canonical triple, so archive this row instead of re-throwing.
        if (isUniqueViolation(e)) {
            await state.store.queryExec(`UPDATE ${workId} SET active = false, archived_at = time::now(), completed_at = time::now(), archived_status = $st, archive_reason = "terminal_unique_race_lost"`, { st: status }).catch(err => swallow.warn("markTerminal:raceArchive", err));
            // A sibling holds the canonical triple — this row is archived, not
            // reclaimed-out-from-under-us. The caller's outcome stays committed.
            return true;
        }
        throw e;
    }
}
async function buildWorkPayload(item, state) {
    const { store } = state;
    switch (item.work_type) {
        case "coalesced_extraction": {
            const payload = (item.payload ?? {});
            const turns = await store.getSessionTurnsRich(item.session_id, 50);
            const transcript = buildTranscript(turns);
            // 0.7.119: blank-transcript guard at FETCH time. Enqueue-side gates
            // (userTurnCount >= 2) cover the normal path, but archival races,
            // pruned turns, and legacy items can still yield nothing here — and
            // asking an LLM to extract from a blank transcript is how the
            // 2026-06-10 apology-junk rows were born. Self-complete instead.
            if (turns.length === 0 || transcript.trim().length < 40) {
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return {
                    work_id: item.id,
                    work_type: "coalesced_extraction",
                    empty: true,
                    message: "Transcript empty or too thin to extract. Already marked complete.",
                };
            }
            const prior = { conceptNames: [], artifactPaths: [], skillNames: [] };
            const instructions = buildCoalescedPrompt(false, false, prior, payload.include_handoff ?? true, payload.include_reflection ?? false);
            // Include Tier 0 directives so the LLM can judge rules compliance
            const tier0 = await store.getAllCoreMemory(0).catch(() => []);
            const directivePreamble = tier0.length > 0
                ? `ACTIVE RULES (judge compliance against these):\n${tier0.map(d => `[${d.category}] ${d.text}`).join("\n")}\n\n---\n\n`
                : "";
            const fullTranscript = directivePreamble + transcript.slice(0, 30000 - directivePreamble.length);
            return {
                work_id: item.id,
                work_type: "coalesced_extraction",
                instructions,
                data: { transcript: fullTranscript, turn_count: turns.length },
                output_format: "Return ONLY valid JSON matching the schema in the instructions. All fields are arrays — use [] if empty. handoff_note, reflection are strings. rules_compliance is a number 0.0-1.0.",
            };
        }
        case "causal_graduate": {
            // v0.8.0: `graduated_at IS NONE` is the watermark. Without it, every
            // per-session causal_graduate item fetched the IDENTICAL global chain
            // aggregate and re-synthesized the same skills (the duplicate-skill
            // explosion — memory:2gp8m8j597c46y6z5lpg).
            //
            // K31: CLAIM the chains BEFORE synthesis, not after. The pre-K31 code
            // stamped graduated_at only in the COMMIT handler, AFTER skills were
            // created — so two causal_graduate items draining concurrently both
            // fetched the same ungraduated chains, both ran an agent synthesis, and
            // both created skills before either watermark landed (the watermark was a
            // post-hoc no-op that closed the window only for LATER items). Fix:
            // atomically stamp graduated_at = time::now() on the eligible-type
            // ungraduated chains HERE and RETURN BEFORE to learn which rows THIS item
            // actually won (rows whose graduated_at was NONE at stamp time). A
            // concurrent item's identical per-row UPDATE wins only the rows we didn't
            // flip, so it sees an empty won-set and self-completes. Skills are built
            // ONLY from won chains.
            //
            // Two-step (eligibility GROUP BY, then claim) because the cnt>=3 bar is
            // per chain_type: we first find which types clear it, then claim every
            // ungraduated chain of those types and group the won rows in JS.
            const groups = await store.queryFirst(`SELECT chain_type, count() AS cnt
         FROM causal_chain WHERE success = true AND confidence >= 0.7 AND graduated_at IS NONE
         GROUP BY chain_type`);
            const eligibleTypes = groups.filter(g => g.cnt >= 3).map(g => g.chain_type);
            if (eligibleTypes.length === 0) {
                // No chains to graduate — mark complete immediately
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "causal_graduate", empty: true, message: "No causal chains ready for graduation. Already marked complete." };
            }
            // R8: BOUND the per-fetch claim. Pre-R8 the claim stamped graduated_at on
            // the ENTIRE ungraduated backlog of every eligible type in one shot (no
            // LIMIT) — so a single transient fetch→synth→commit failure stranded the
            // whole backlog (all those chains consumed, never re-tried, since the
            // commit no longer re-stamps and only an explicit un-stamp re-opens them).
            // Capping the claim means one failure can strand at most CLAIM_CAP chains;
            // the remainder stay graduated_at IS NONE and re-trigger on the NEXT
            // causal_graduate fetch. SurrealDB rejects LIMIT on UPDATE ("Unexpected
            // token 'LIMIT'", GH #17), so bound via a SELECT…LIMIT of candidate ids
            // and claim `WHERE … AND id IN $ids` — the per-row `graduated_at IS NONE`
            // guard on the UPDATE keeps the claim atomic and race-safe even though the
            // SELECT and UPDATE are two round-trips (a concurrent item flipping rows
            // between them just shrinks our won-set, which is exactly the K31 design).
            const CLAIM_CAP = 200;
            const candidates = await store.queryFirst(`SELECT id FROM causal_chain
           WHERE success = true AND confidence >= 0.7 AND graduated_at IS NONE
             AND chain_type IN $types
           ORDER BY created_at ASC LIMIT $cap`, { types: eligibleTypes, cap: CLAIM_CAP });
            if (candidates.length === 0) {
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "causal_graduate", empty: true, message: "Causal chains already claimed by a concurrent graduation. Already marked complete." };
            }
            const candidateIds = candidates.map(c => String(c.id)).filter(s => { try {
                assertRecordId(s);
                return true;
            }
            catch {
                return false;
            } });
            if (candidateIds.length === 0) {
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "causal_graduate", empty: true, message: "Causal chains already claimed by a concurrent graduation. Already marked complete." };
            }
            // Atomic claim: per-row `graduated_at IS NONE` guard + SET means a
            // concurrent identical UPDATE can never re-win a row we just stamped.
            // RETURN BEFORE yields the rows as they were pre-stamp (graduated_at NONE),
            // i.e. exactly the set THIS item won (intersection of our candidate ids and
            // the rows still ungraduated at UPDATE time). The candidate ids are
            // interpolated directly into `id IN [${list}]` — a string-array BINDING is
            // treated as literal strings by SurrealDB and silently matches nothing
            // (surreal.ts getSessionRetrievedMemories); they are assertRecordId-clean.
            const won = await store.queryFirst(`UPDATE causal_chain SET graduated_at = time::now()
           WHERE success = true AND confidence >= 0.7 AND graduated_at IS NONE
             AND chain_type IN $types AND id IN [${candidateIds.join(", ")}]
           RETURN BEFORE`, { types: eligibleTypes });
            if (won.length === 0) {
                // A concurrent causal_graduate item claimed these chains first — nothing
                // left for us. Self-complete empty (matches the no-eligible path).
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "causal_graduate", empty: true, message: "Causal chains already claimed by a concurrent graduation. Already marked complete." };
            }
            // R8: persist the won chain ids onto THIS work item (top-level field on
            // the SCHEMALESS pending_work row) so the commit handler — or the catch
            // path in handleCommitWorkResults — can un-stamp them back to
            // graduated_at = NONE if synthesis fails or produces zero skills, the
            // failure-recovery the K31 claim-at-fetch otherwise lacked. A top-level
            // field (not a nested payload.* set) sidesteps the set-on-NONE-object
            // edge case since payload may be NONE here. Best effort: a failed write
            // just means a future failure can't auto-retry these chains (they
            // re-trigger once NEW chains re-cross cnt>=3), so swallow rather than
            // abort the already-successful claim.
            const wonChainIds = won.map(r => String(r.id)).filter(Boolean);
            try {
                assertRecordId(String(item.id));
                await store.queryExec(`UPDATE ${item.id} SET won_chain_ids = $ids`, { ids: wonChainIds });
            }
            catch (e) {
                swallow.warn("pending-work:persist-won-chain-ids", e);
            }
            // Reflect the persisted ids on the in-memory item too, so a same-process
            // failure path (catch in handleCommitWorkResults) can un-stamp even though
            // it never re-reads the row after the claim.
            item.won_chain_ids = wonChainIds;
            // Re-group won rows by chain_type for the synthesis payload.
            const byType = new Map();
            for (const row of won) {
                if (!row?.chain_type)
                    continue;
                const arr = byType.get(row.chain_type) ?? [];
                if (row.description)
                    arr.push(row.description);
                byType.set(row.chain_type, arr);
            }
            const groupsPayload = Array.from(byType.entries()).map(([chain_type, descriptions]) => ({
                chain_type,
                count: descriptions.length,
                descriptions: descriptions.slice(0, 8),
            }));
            return {
                work_id: item.id,
                work_type: "causal_graduate",
                instructions: `Synthesize reusable procedures from these recurring successful patterns. Generic — no specific file paths or variable names. Return one skill JSON per pattern group.`,
                data: { groups: groupsPayload },
                output_format: "Return JSON array of skills: [" + JSON.stringify(skillSchema) + ", ...]. Return [] if no clear patterns.",
            };
        }
        case "soul_generate": {
            const report = await checkGraduation(store);
            if (!report.ready) {
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "soul_generate", empty: true, message: "Not ready for graduation yet. Already marked complete." };
            }
            const [reflections, causalChains, monologues] = await Promise.all([
                store.queryFirst(`SELECT text, category FROM reflection ORDER BY created_at DESC LIMIT 15`).catch(() => []),
                store.queryFirst(`SELECT description, chain_type FROM causal_chain ORDER BY created_at DESC LIMIT 10`).catch(() => []),
                store.queryFirst(`SELECT content FROM monologue ORDER BY timestamp DESC LIMIT 10`).catch(() => []),
            ]);
            const quality = await getQualitySignals(store);
            return {
                work_id: item.id,
                work_type: "soul_generate",
                instructions: `You are KongCode, a graph-backed coding agent with persistent memory. Based on YOUR OWN memory graph data below, write your initial Soul document. Be honest, not aspirational. Only claim what the data supports.`,
                data: {
                    reflections: reflections.map(r => `[${r.category}] ${r.text}`),
                    causal_chains: causalChains.map(c => `[${c.chain_type}] ${c.description}`),
                    monologues: monologues.map(m => m.content),
                    quality: {
                        retrieval_utilization: `${(quality.avgRetrievalUtilization * 100).toFixed(0)}%`,
                        skill_success_rate: `${(quality.skillSuccessRate * 100).toFixed(0)}%`,
                        tool_failure_rate: `${(quality.toolFailureRate * 100).toFixed(0)}%`,
                    },
                },
                output_format: "Return JSON: " + JSON.stringify(soulSchema),
            };
        }
        case "soul_evolve": {
            const soul = await getSoul(store);
            if (!soul) {
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "soul_evolve", empty: true, message: "No soul exists yet. Already marked complete." };
            }
            const [reflections, causalChains, monologues] = await Promise.all([
                store.queryFirst(`SELECT text FROM reflection WHERE created_at > $since ORDER BY created_at DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
                store.queryFirst(`SELECT description FROM causal_chain WHERE created_at > $since ORDER BY created_at DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
                store.queryFirst(`SELECT content FROM monologue WHERE timestamp > $since ORDER BY timestamp DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
            ]);
            if (reflections.length === 0 && causalChains.length === 0 && monologues.length === 0) {
                await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
                return { work_id: item.id, work_type: "soul_evolve", empty: true, message: "No new experience since last soul update. Already marked complete." };
            }
            return {
                work_id: item.id,
                work_type: "soul_evolve",
                instructions: `You are revising your own Soul document based on new experience. Return JSON with ONLY the fields that changed. Omit unchanged fields. If nothing meaningful changed, return {}. Be honest — revise based on evidence, not aspiration.`,
                data: {
                    current_soul: { working_style: soul.working_style, emotional_dimensions: soul.emotional_dimensions, self_observations: soul.self_observations, earned_values: soul.earned_values },
                    new_reflections: reflections.map(r => r.text),
                    new_causal_chains: causalChains.map(c => c.description),
                    new_monologues: monologues.map(m => m.content),
                },
                output_format: "Return JSON with ONLY changed fields from the soul schema. Return {} if nothing changed.",
            };
        }
        default: {
            // Route through markTerminal (not a naive UPDATE-to-completed) so an
            // unknown-type row with a terminal sibling soft-archives instead of
            // colliding on the (session_id, work_type, status) UNIQUE index and
            // wedging the claim path. (audit C6)
            await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
            return { work_id: item.id, work_type: item.work_type, empty: true, message: `Unknown work type: ${item.work_type}` };
        }
    }
}
// ── commit_work_results ──────────────────────────────────────────────────────
export async function handleCommitWorkResults(state, _session, args) {
    const { store, embeddings } = state;
    const workId = String(args.work_id ?? "");
    const results = args.results;
    if (!workId)
        return text("Error: work_id is required");
    if (!store.isAvailable())
        return text("Error: database unavailable");
    assertRecordId(workId);
    // C1: atomically claim the commit. Only one caller can flip
    // processing→committing; if stale-recovery reverted this row and another
    // drainer re-claimed it (or it was already committed), the CAS matches no row
    // and we DISCARD the extraction rather than double-write knowledge / double-
    // apply a (non-idempotent) soul revision. RETURN BEFORE also yields the item.
    //
    // K41: make the CAS idempotent across ONE withRetry re-fire. queryFirst wraps
    // this in withRetry, and a deadline'd write MAY have executed server-side
    // before the response was lost — the naive `WHERE status="processing"` retry
    // would then find the row already "committing" and DISCARD a valid extraction
    // (own CAS succeeded but looked reclaimed). Stamp a caller-generated
    // committing_token and widen the WHERE to also accept a row already in
    // "committing" carrying THIS token. So:
    //   - row in "processing"                         → we win (first attempt)
    //   - row in "committing" with committing_token=ours → we win (our own retry)
    //   - row in "committing" with a DIFFERENT token  → genuinely reclaimed by
    //     another drainer (C1) → no match → discard
    //   - row already completed / reverted+reclaimed  → no match → discard
    // K15: re-stamp processing_started_at = time::now() so the 10-minute
    // stale-recovery window RESTARTS when commit work begins — a long commit must
    // not let stale-recovery revert this row out from under us mid-write.
    const myToken = randomUUID();
    const claimed = await store.queryFirst(`UPDATE ${workId} SET status = "committing", committing_token = $tok, processing_started_at = time::now()
       WHERE status = "processing" OR (status = "committing" AND committing_token = $tok)
       RETURN BEFORE`, { tok: myToken });
    if (claimed.length === 0) {
        // Row is not claimable by us: already committed, reverted by stale-recovery
        // and reclaimed by another drainer (its token differs), or unknown id.
        // Discard to avoid a double-write.
        return text(JSON.stringify({
            success: false,
            skipped: true,
            message: `work item ${workId} is no longer in 'processing' (already committed or reclaimed); extraction discarded to avoid a double-write`,
        }));
    }
    const item = claimed[0];
    try {
        // K15: re-assert ownership immediately before the non-idempotent writes in
        // commitResults (soul revision via reviseSoul, skill creation, handoff/
        // reflection promotion — none of which are safe to apply twice). The CAS
        // above re-stamped processing_started_at so stale-recovery's 10-minute
        // window restarted, but this is the defense-in-depth check: if anything DID
        // flip this row out of "committing" with our token (a reclaim, a manual
        // status change), abort BEFORE writing knowledge rather than double-apply.
        const stillOwned = await store.queryFirst(`SELECT id FROM ${workId} WHERE status = "committing" AND committing_token = $tok`, { tok: myToken });
        if (stillOwned.length === 0) {
            log.warn(`[pending_work] commit ownership lost before write for ${item.work_type} (${workId}) — extraction discarded`);
            return text(JSON.stringify({
                success: false,
                skipped: true,
                message: `work item ${workId} was reclaimed after the commit CAS; extraction discarded to avoid a double-write`,
            }));
        }
        const outcome = await commitResults(item, results, state);
        // R9: gate the terminal stamp on ownership AT WRITE TIME. The stillOwned
        // pre-check above is fail-fast only — it is snapshotted BEFORE the
        // multi-minute commitResults, so a reclaim DURING the embed/synthesis loop
        // would slip past it. Passing myToken makes markTerminal's UPDATE itself
        // `WHERE status="committing" AND committing_token=myToken`; if the row was
        // reclaimed mid-write it matches nothing and returns false. We then DISCARD
        // the outcome instead of reporting a completion we no longer own — the new
        // owner is responsible for terminalizing the row, and reporting success here
        // would re-open the C1 double-completion the K15 fix exists to close.
        const stamped = await markTerminal(state, workId, item.session_id, item.work_type, "completed", myToken);
        if (!stamped) {
            log.warn(`[pending_work] commit ownership lost DURING write for ${item.work_type} (${workId}) — outcome committed but completion not stamped (row reclaimed); reporting skipped`);
            return text(JSON.stringify({
                success: false,
                skipped: true,
                message: `work item ${workId} was reclaimed during commitResults; completion not stamped to avoid a double-complete`,
            }));
        }
        log.info(`[pending_work] Completed ${item.work_type} (${workId})`);
        return text(JSON.stringify({ success: true, work_type: item.work_type, ...outcome }));
    }
    catch (e) {
        // R8: a causal_graduate synthesis that THREW must release the chains it
        // claimed at fetch time — buildWorkPayload stamped graduated_at on the won
        // chains BEFORE the agent ran (the K31 claim-at-fetch), and the commit
        // handler no longer re-stamps, so without this un-stamp those chains are
        // permanently consumed (graduated_at set, never synthesized into a skill).
        // The won chain ids were persisted onto the work item payload at claim time;
        // reset them to NONE so a later causal_graduate item retries them. Best
        // effort: a failed un-stamp just defers retry until new chains re-cross the
        // cnt>=3 bar (same as the no-op-commit path below).
        if (item.work_type === "causal_graduate") {
            await unstampGraduatedChains(item, state)
                .catch(err => swallow.warn("pending-work:unstamp-on-error", err));
        }
        // Mark failed. Uses markTerminal so a sibling failed row for the same
        // (session, work_type) doesn't collide on pw_session_worktype_status_unique;
        // in that case this row is DELETEd instead. If markTerminal itself fails
        // (e.g. DB unreachable), the row stays in "processing" until stale-recovery
        // catches it. Surface the failure to logs so it's not silently lost.
        // R9: gate on ownership too — if the row was reclaimed mid-commit the new
        // owner terminalizes it; a false return is benign here (we are already on
        // the error path) and just means we didn't own the row at write time.
        await markTerminal(state, workId, item.session_id, item.work_type, "failed", myToken)
            .catch(e => swallow.warn("pending-work:mark-failed", e));
        log.error(`[pending_work] Failed ${item.work_type} (${workId}):`, e);
        return text(JSON.stringify({ success: false, error: serializeError(e) }));
    }
}
/**
 * R8 failure-recovery: reset graduated_at = NONE on the causal chains a
 * causal_graduate item CLAIMED at fetch time but failed to synthesize into a
 * skill (synthesis threw, or produced zero skills). buildWorkPayload stamps
 * graduated_at on the won chains BEFORE the agent runs and persists their ids
 * onto the work item (`won_chain_ids` top-level field); this re-opens them so a
 * later graduation item retries them, instead of stranding them permanently
 * consumed.
 *
 * Idempotent: only resets rows still owned by this claim (graduated_at IS NOT
 * NONE among the recorded ids). If the ids are missing (legacy row, or the
 * fetch-side persist write failed), there is nothing to reset and we return 0.
 */
async function unstampGraduatedChains(item, state) {
    const ids = item.won_chain_ids;
    if (!Array.isArray(ids) || ids.length === 0)
        return 0;
    // Canonical id-list pattern (surreal.ts getSessionRetrievedMemories): a
    // string-array BINDING is treated as literal strings and silently matches
    // nothing, so after assertRecordId we interpolate the validated record-id
    // strings directly into `id IN [${list}]` where SurrealDB parses them as
    // Thing literals. Bound the count defensively (CLAIM_CAP is 200; 5000 is a
    // generous ceiling against a corrupted payload).
    const validated = ids
        .map((x) => String(x))
        .filter((s) => { try {
        assertRecordId(s);
        return true;
    }
    catch {
        return false;
    } })
        .slice(0, 5000);
    if (validated.length === 0)
        return 0;
    const idList = validated.join(", ");
    const res = await state.store.queryMulti(`LET $reset = (UPDATE causal_chain SET graduated_at = NONE
       WHERE id IN [${idList}] AND graduated_at IS NOT NONE RETURN BEFORE);
     RETURN { n: array::len($reset) };`);
    const n = Number(res?.n ?? 0);
    if (n > 0)
        log.info(`[pending_work] R8 un-stamped ${n} causal chain(s) after failed/no-op graduation (${item.id})`);
    return n;
}
function computeCurationScore(transcript, turnToolNames = []) {
    const recallInText = /\b(recall|mcp__\w+__recall)\b/gi.test(transcript);
    const saveInText = /\b(record_finding|create_knowledge_gems|supersede|core_memory|mcp__\w+__(record_finding|create_knowledge_gems|supersede|core_memory))\b/gi.test(transcript);
    const citations = /\[#\d+\]/g.test(transcript);
    const toolNameStr = turnToolNames.join(" ").toLowerCase();
    const recallInTools = toolNameStr.includes("recall");
    const saveInTools = /record_finding|create_knowledge_gems|supersede|core_memory/.test(toolNameStr);
    let score = 0;
    if (citations)
        score += 0.4;
    if (recallInText || recallInTools)
        score += 0.3;
    if (saveInText || saveInTools)
        score += 0.3;
    return Math.min(1, score);
}
async function commitHandoffNote(noteText, item, state) {
    const { store, embeddings } = state;
    let noteEmb = null;
    if (embeddings.isAvailable()) {
        try {
            noteEmb = await embeddings.embed(noteText);
        }
        catch { /* ok */ }
    }
    const record = {
        text: noteText,
        category: "handoff",
        importance: 8,
        source: `session:${item.session_id}`,
        session_id: item.session_id,
    };
    if (item.project_id)
        record.project_id = item.project_id;
    if (noteEmb?.length)
        record.embedding = noteEmb;
    const memRows = await store.queryFirst(`CREATE memory CONTENT $record RETURN id`, { record });
    const memId = memRows[0]?.id;
    if (memId && noteText.length >= 30) {
        try {
            await commitKnowledge({ store, embeddings }, {
                kind: "concept",
                name: noteText.slice(0, 200),
                sourceId: memId,
                edgeName: "about_concept",
                source: "handoff:promote",
                precomputedVec: noteEmb,
                projectId: item.project_id,
            });
        }
        catch (e) {
            swallow("handoff:promote", e);
        }
    }
}
// Reflection writer migrated in v0.7.76 to commitKnowledge({ kind: "reflection" }).
// The canonical regex filter set lives in src/engine/reflection-filter.ts; the
// row creation, dedup, edge seal, and cache invalidation live in
// src/engine/commit.ts. This wrapper just adapts the existing PendingWorkItem
// shape to the new CommitKnowledge API.
async function commitReflection(reflText, item, state) {
    // Without a SurrealDB session record id, commitKnowledge would refuse the
    // write (the v0.7.76 architectural anchor closing the orphan-reflection bug
    // class). Skip rather than throw — this matches the prior behavior of
    // pending-work.ts where missing surreal_session_id meant the edge was simply
    // not wired and the row went through.
    if (!item.surreal_session_id)
        return;
    await commitKnowledge(state, {
        kind: "reflection",
        text: reflText,
        sessionId: item.session_id,
        surrealSessionId: item.surreal_session_id,
        category: "session_review",
        severity: "minor",
        projectId: item.project_id,
    });
}
/** 0.7.118: drain agents given a degenerate work item (empty transcript,
 *  turn_count 0) returned apology prose and/or echoed the bare session UUID —
 *  which then got committed as "knowledge" (4 junk rows landed in production
 *  on 2026-06-10, unembedded, failing the db-state invariants). Knowledge
 *  content must never be a bare UUID or an extraction apology. */
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Apology phrasings are free LLM text, not template-bound (QA 0.7.118 D1:
 *  live corpus had "Empty transcript (turn_count=0)… Nothing to extract."
 *  which the original anchored regex missed). Match variants in the HEAD of
 *  the text only — legitimate gems can mention "empty transcript" mid-body
 *  (e.g. knowledge about this very bug). */
const JUNK_HEAD_RE = /empty transcript|nothing to extract|contain(s|ed) an empty|no transcript (data|provided|was)|no session (data|content|transcript)|no data available|nothing to reflect/i;
export function isJunkExtractionText(s) {
    if (typeof s !== "string")
        return false;
    const t = s.trim();
    if (t.length < 8)
        return true;
    if (BARE_UUID_RE.test(t))
        return true;
    return JUNK_HEAD_RE.test(t.slice(0, 60));
}
/** Drop junk entries from an extraction array (returns filtered). Entries may
 *  be bare strings or schema objects — probe content first (concepts commit
 *  `content`; a junk body can hide behind a clean short name), then text,
 *  then name (QA 0.7.118 D2). */
function dropJunkEntries(arr) {
    if (!Array.isArray(arr))
        return [];
    return arr.filter((e) => {
        const o = e;
        const probe = typeof e === "string" ? e : o?.content ?? o?.text ?? o?.name;
        return !isJunkExtractionText(probe);
    });
}
async function commitResults(item, results, state) {
    const { store, embeddings } = state;
    switch (item.work_type) {
        case "coalesced_extraction": {
            if (typeof results === "string") {
                try {
                    results = JSON.parse(results);
                }
                catch {
                    const match = results.match(/\{[\s\S]*\}/);
                    if (!match)
                        throw new Error("Could not parse extraction JSON");
                    // Guard the recovery parse too — the greedy {...} can still capture
                    // invalid JSON (trailing comma, merged blocks). Without this, the
                    // throw lands the whole coalesced extraction in markTerminal(failed)
                    // and discards it with no retry. (audit C1)
                    try {
                        results = JSON.parse(match[0]);
                    }
                    catch {
                        throw new Error("Could not parse extraction JSON");
                    }
                }
            }
            const { data: validated, errors: schemaErrors } = validateExtraction(results);
            if (schemaErrors.length > 0) {
                log.warn(`[pending_work] extraction schema violations (${schemaErrors.length}): ${schemaErrors.slice(0, 5).join("; ")}`);
            }
            const extractionData = schemaErrors.length === 0 ? validated : results;
            // 0.7.118 junk guard: scrub apology/UUID entries from the
            // ExtractionResultSchema arrays the writer actually consumes
            // (daemon-types.ts; QA D2 fixed the original guess-list).
            {
                const ed = extractionData;
                for (const key of ["concepts", "skills", "corrections", "preferences", "decisions", "monologue", "artifacts"]) {
                    if (Array.isArray(ed[key])) {
                        const before = ed[key].length;
                        ed[key] = dropJunkEntries(ed[key]);
                        if (ed[key].length < before) {
                            log.warn(`[pending_work] dropped ${before - ed[key].length} junk ${key} entr(y/ies) (empty-transcript apology / bare UUID) for ${item.session_id}`);
                        }
                    }
                }
            }
            const prior = { conceptNames: [], artifactPaths: [], skillNames: [] };
            const counts = await writeExtractionResults(extractionData, item.session_id, store, embeddings, prior, item.task_id, item.project_id);
            if (item.work_type === "coalesced_extraction") {
                const parsed = extractionData;
                if (typeof parsed.handoff_note === "string" && parsed.handoff_note.length >= 20 && !isJunkExtractionText(parsed.handoff_note)) {
                    await commitHandoffNote(parsed.handoff_note, item, state);
                }
                if (typeof parsed.reflection === "string" && parsed.reflection.length >= 20 && parsed.reflection.toLowerCase().trim() !== "skip" && !isJunkExtractionText(parsed.reflection)) {
                    await commitReflection(parsed.reflection, item, state);
                }
                // Three-bucket scoring: backfill rules_compliance + curation on turn_score rows
                const rulesCompliance = typeof parsed.rules_compliance === "number"
                    ? clamp01(parsed.rules_compliance)
                    : 0.7;
                // Re-fetch transcript for curation analysis (not stored on work item)
                const curationTurns = await store.getSessionTurnsRich(item.session_id, 50).catch(() => []);
                const curationTranscript = buildTranscript(curationTurns);
                const toolNames = curationTurns.map(t => t.tool_name ?? "").filter(Boolean);
                const curation = computeCurationScore(curationTranscript, toolNames);
                // Compute composite in JS (avoids SurrealQL IF/THEN/ELSE risk) and write scalar values
                const sid = item.session_id;
                const turnScoreRows = await store.queryFirst(`SELECT id, context_util FROM turn_score WHERE session_id = $sid`, { sid }).catch(() => []);
                for (const row of turnScoreRows) {
                    const cu = row.context_util != null ? row.context_util : 0;
                    const cuWeight = row.context_util != null ? 0.3 : 0;
                    const composite = (0.6 * rulesCompliance) + (cuWeight * cu) + (0.1 * curation);
                    try {
                        assertRecordId(String(row.id));
                        await store.queryExec(`UPDATE ${row.id} SET rules_compliance = $rc, curation = $cur, composite = $comp`, { rc: rulesCompliance, cur: curation, comp: composite });
                    }
                    catch (e) {
                        swallow("pending-work:turnScoreUpdate", e);
                    }
                }
            }
            return { counts };
        }
        case "causal_graduate": {
            const skills = parseCausalGraduationResult(results);
            let created = 0;
            for (const parsed of skills) {
                await createSkillRecord(parsed, item, state);
                created++;
            }
            // K31: the graduation watermark is now stamped at FETCH time
            // (buildWorkPayload claims the chains atomically BEFORE handing them to
            // the agent), NOT here. The pre-K31 post-creation stamp opened a
            // duplicate-skill window: two items fetched the same ungraduated chains
            // and both reached this point before either watermark landed. Stamping at
            // claim time closes that window; this handler now just persists the
            // synthesized skills.
            //
            // R8 failure-recovery: a no-op synthesis (zero skills created — agent
            // returned [], or every candidate skill was dropped by the parser) must
            // RELEASE the chains it claimed, not strand them. Pre-R8 the comment here
            // said the claim was "consumed by design"; that left a transient empty
            // commit permanently burning the whole claimed backlog (graduated_at set,
            // never synthesized). Un-stamp the won chains back to graduated_at = NONE
            // so a later graduation item retries them. When >=1 skill WAS created we
            // keep the watermark (those chains are genuinely graduated).
            if (created === 0) {
                await unstampGraduatedChains(item, state)
                    .catch(err => swallow.warn("pending-work:unstamp-on-noop", err));
            }
            return { skills_created: created };
        }
        case "soul_generate": {
            const doc = parseSoulResult(results);
            if (!doc)
                throw new Error("Invalid soul document JSON");
            const now = new Date().toISOString();
            const soulDoc = {
                working_style: (doc.working_style ?? []).filter((s) => typeof s === "string").slice(0, 20),
                emotional_dimensions: (doc.emotional_dimensions ?? []).map((d) => ({
                    dimension: String(d.dimension ?? d.name ?? ""),
                    description: String(d.description ?? d.rationale ?? ""),
                    adopted_at: now,
                })).filter((d) => d.dimension).slice(0, 10),
                self_observations: (doc.self_observations ?? []).filter((s) => typeof s === "string").slice(0, 20),
                earned_values: (doc.earned_values ?? []).map((v) => ({
                    value: String(v.value ?? v.name ?? ""),
                    grounded_in: String(v.grounded_in ?? v.evidence ?? v.description ?? ""),
                })).filter((v) => v.value).slice(0, 10),
            };
            const success = await createSoul(soulDoc, store);
            if (!success)
                throw new Error("Failed to create soul record");
            const soul = await getSoul(store);
            if (soul)
                await seedSoulAsCoreMemory(soul, store);
            const report = await checkGraduation(store);
            await recordGraduationEvent(store, report);
            log.info("[GRADUATION] Soul created by subagent!");
            return { graduated: true };
        }
        case "soul_evolve": {
            const changes = parseSoulResult(results);
            if (!changes || Object.keys(changes).length === 0)
                return { skipped: true, reason: "no changes" };
            const now = new Date().toISOString();
            const sanitized = {
                working_style: (changes.working_style ?? []).filter((s) => typeof s === "string"),
                emotional_dimensions: (changes.emotional_dimensions ?? []).map((d) => ({
                    dimension: String(d.dimension ?? d.name ?? ""),
                    description: String(d.description ?? d.rationale ?? ""),
                    adopted_at: now,
                })).filter((d) => d.dimension),
                self_observations: (changes.self_observations ?? []).filter((s) => typeof s === "string"),
                earned_values: (changes.earned_values ?? []).map((v) => ({
                    value: String(v.value ?? v.name ?? ""),
                    grounded_in: String(v.grounded_in ?? v.evidence ?? v.description ?? ""),
                })).filter((v) => v.value),
            };
            let revised = 0;
            for (const section of ["working_style", "emotional_dimensions", "self_observations", "earned_values"]) {
                const vals = sanitized[section];
                if (vals && vals.length > 0) {
                    await reviseSoul(section, vals, "Evolved by subagent based on new experience", store);
                    revised++;
                }
            }
            return { sections_revised: revised };
        }
        default:
            return { skipped: true, reason: `unknown work_type: ${item.work_type}` };
    }
}
const VALID_GEM_EDGES = new Set(["broader", "narrower", "related_to"]);
export async function handleCreateKnowledgeGems(state, session, args) {
    const { store, embeddings } = state;
    if (!store.isAvailable())
        return text("Error: database unavailable");
    const source = String(args.source ?? "").trim();
    const sourceType = String(args.source_type ?? "document").trim();
    const sourceDescription = String(args.source_description ?? "").trim();
    const gems = Array.isArray(args.gems) ? args.gems : [];
    const links = Array.isArray(args.links) ? args.links : [];
    if (!source)
        return text("Error: source is required");
    if (gems.length === 0)
        return text("Error: at least one gem is required");
    try {
        // 1. Create artifact for the source document via commitKnowledge so the
        //    artifact auto-seals artifact_mentions edges to the concept graph.
        const { id: artifactId } = await commitKnowledge({ store, embeddings }, {
            kind: "artifact",
            path: source,
            type: sourceType,
            description: sourceDescription || source,
        });
        // 2. Create each gem as a concept, build name -> id map
        const nameToId = new Map();
        const conceptIds = [];
        let skipped = 0;
        for (const gem of gems) {
            if (!gem?.name || !gem?.content) {
                skipped++;
                continue;
            }
            const cleanContent = stripStructuralTags(gem.content);
            let gemEmb = null;
            if (embeddings.isAvailable()) {
                try {
                    gemEmb = await embeddings.embed(cleanContent);
                }
                catch { /* ok */ }
            }
            const { id: conceptId } = await commitKnowledge(state, {
                kind: "concept",
                name: cleanContent,
                source: `gem:${source}`,
                provenance: {
                    session_id: session.sessionId,
                    source_kind: "gem",
                    skill_name: "create_knowledge_gems",
                },
                precomputedVec: gemEmb,
                // v0.7.78: route the concept→artifact derived_from edge through
                // commitKnowledge's auto-seal instead of hand-wiring after. The
                // edge is what links a gem to the source artifact (PDF / doc / etc.)
                // it was extracted from.
                derivedFromTargetId: artifactId,
            });
            if (!conceptId) {
                skipped++;
                continue;
            }
            nameToId.set(gem.name, conceptId);
            conceptIds.push(conceptId);
        }
        // 3. Create cross-link edges between gems. Surface why each skip happened
        // so the caller can correct the call instead of silently losing edges.
        let edgesCreated = 0;
        const edgeFailures = [];
        for (const link of links) {
            if (!link?.from || !link?.to || !link?.edge) {
                edgeFailures.push({
                    from: link?.from ?? "?",
                    to: link?.to ?? "?",
                    edge: link?.edge ?? "?",
                    reason: "missing from/to/edge field",
                });
                continue;
            }
            if (!VALID_GEM_EDGES.has(link.edge)) {
                edgeFailures.push({
                    from: link.from,
                    to: link.to,
                    edge: link.edge,
                    reason: `edge type not in schema; valid concept→concept edges are: ${Array.from(VALID_GEM_EDGES).join(", ")}`,
                });
                continue;
            }
            const fromId = nameToId.get(link.from);
            const toId = nameToId.get(link.to);
            if (!fromId || !toId) {
                edgeFailures.push({
                    from: link.from,
                    to: link.to,
                    edge: link.edge,
                    reason: !fromId && !toId
                        ? `neither '${link.from}' nor '${link.to}' matches any gem name in this call`
                        : !fromId
                            ? `'${link.from}' does not match any gem name in this call`
                            : `'${link.to}' does not match any gem name in this call`,
                });
                continue;
            }
            // v0.7.81: migrated from hand-wired store.relate to linkConceptCrossLink
            // helper in commit.ts so this writer lives behind the canonical
            // write-path module. VALID_GEM_EDGES has already gated link.edge to
            // broader|narrower|related_to so the helper's internal whitelist is a
            // redundant safety check.
            const added = await linkConceptCrossLink({ store, embeddings }, fromId, toId, link.edge);
            if (added > 0) {
                edgesCreated++;
            }
            else {
                edgeFailures.push({
                    from: link.from,
                    to: link.to,
                    edge: link.edge,
                    reason: "linkConceptCrossLink returned 0 (see daemon log for swallow.warn detail)",
                });
            }
        }
        log.info(`[gems] source=${source} concepts=${conceptIds.length} edges=${edgesCreated} edge_failures=${edgeFailures.length} concepts_skipped=${skipped}`);
        return text(JSON.stringify({
            success: true,
            source,
            artifact_id: artifactId,
            concepts_created: conceptIds.length,
            concepts_skipped: skipped,
            edges_created: edgesCreated,
            edges_skipped: edgeFailures.length,
            edge_failures: edgeFailures,
            concept_ids: conceptIds,
        }));
    }
    catch (e) {
        log.error("[gems] failed:", e);
        return text(JSON.stringify({ success: false, error: serializeError(e) }));
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function text(s) {
    return { content: [{ type: "text", text: s }] };
}
/** 0.7.32: trace why a parser drop happened. Truncates payload preview to
 *  300 chars and tags with the specific reason so a daemon-log scan can
 *  retroactively answer "why did skills_created return 0?". */
function tracedrop(reason, payload) {
    let preview;
    try {
        preview = typeof payload === "string"
            ? payload.slice(0, 300)
            : JSON.stringify(payload).slice(0, 300);
    }
    catch {
        preview = "<unserializable>";
    }
    log.warn(`[graduation-parser] drop reason=${reason} payload=${preview}`);
}
/** 0.7.32: shared name + steps coercion logic, used by both single-skill
 *  and causal-graduate paths. Subagents emit varied shapes — accept any
 *  reasonable name alias and coerce string-array steps to {tool,
 *  description} objects rather than dropping the row entirely. */
function coerceSkill(parsed, traceTag) {
    if (!parsed || typeof parsed !== "object") {
        tracedrop(`${traceTag}:not-an-object`, parsed);
        return null;
    }
    // Name aliases — try name → title → skill_name → id.
    const name = parsed.name ?? parsed.title ?? parsed.skill_name ?? parsed.id;
    if (!name || typeof name !== "string") {
        tracedrop(`${traceTag}:missing-name`, parsed);
        return null;
    }
    if (!Array.isArray(parsed.steps)) {
        tracedrop(`${traceTag}:steps-not-array`, parsed);
        return null;
    }
    if (parsed.steps.length === 0) {
        tracedrop(`${traceTag}:steps-empty`, parsed);
        return null;
    }
    // Coerce string-array steps into {tool, description} objects so we can
    // land the row instead of dropping it. Future maintenance can re-extract
    // the tool tag from description; an unwritten skill is unrecoverable.
    const steps = parsed.steps.map((s) => {
        if (typeof s === "string")
            return { tool: "unknown", description: s };
        if (s && typeof s === "object") {
            return {
                tool: String(s.tool ?? s.name ?? "unknown"),
                description: String(s.description ?? s.text ?? s.desc ?? ""),
            };
        }
        return { tool: "unknown", description: String(s) };
    });
    return {
        name: String(name),
        description: String(parsed.description ?? ""),
        preconditions: parsed.preconditions ? String(parsed.preconditions) : undefined,
        steps,
        postconditions: parsed.postconditions ? String(parsed.postconditions) : undefined,
    };
}
function parseSkillResult(results) {
    let parsed;
    if (typeof results === "string") {
        if (results.trim() === "null" || results.trim() === "None")
            return null;
        try {
            parsed = JSON.parse(results);
        }
        catch {
            const match = results.match(/\{[\s\S]*\}/);
            if (!match) {
                tracedrop("skill:json-parse-failed", results);
                return null;
            }
            try {
                parsed = JSON.parse(match[0]);
            }
            catch {
                tracedrop("skill:json-parse-failed", match[0]);
                return null;
            }
        }
    }
    else {
        parsed = results;
    }
    return coerceSkill(parsed, "skill");
}
function parseCausalGraduationResult(results) {
    // 0.7.32: tolerant unwrap. Subagents may emit a top-level array (canonical),
    // a wrapped object {skills: [...]} or {result: [...]}, or a single skill
    // object instead of a batch. Accept all shapes; only return [] when
    // truly nothing skill-shaped is present, with a trace line each time.
    let arr;
    let parsed = results;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        }
        catch {
            const match = parsed.match(/\[[\s\S]*\]/);
            if (!match) {
                tracedrop("causal_graduate:json-parse-failed", parsed);
                return [];
            }
            try {
                parsed = JSON.parse(match[0]);
            }
            catch {
                tracedrop("causal_graduate:json-parse-failed", match[0]);
                return [];
            }
        }
    }
    if (Array.isArray(parsed)) {
        arr = parsed;
    }
    else if (parsed && typeof parsed === "object") {
        // Try common wrapper keys before falling through.
        const obj = parsed;
        const wrapped = obj.skills ?? obj.result ?? obj.extracted ?? obj.items ?? obj.data;
        if (Array.isArray(wrapped)) {
            arr = wrapped;
        }
        else if (obj.name && Array.isArray(obj.steps)) {
            // Single-skill object (subagent submitted one instead of a batch).
            arr = [obj];
        }
        else {
            tracedrop("causal_graduate:not-an-array", obj);
            return [];
        }
    }
    else {
        tracedrop("causal_graduate:not-an-object", parsed);
        return [];
    }
    return arr.map(item => coerceSkill(item, "causal_graduate")).filter((s) => s !== null);
}
function parseSoulResult(results) {
    if (typeof results === "string") {
        try {
            return JSON.parse(results);
        }
        catch {
            const match = results.match(/\{[\s\S]*\}/);
            if (!match)
                return null;
            try {
                return JSON.parse(match[0]);
            }
            catch {
                return null;
            }
        }
    }
    return (results && typeof results === "object") ? results : null;
}
async function createSkillRecord(parsed, item, state) {
    // v0.7.79: migrated to commitKnowledge({ kind: "skill" }). Behavior change:
    // commitSkill auto-seals skill_uses_concept via linkToRelevantConcepts
    // similarity scan (no conceptIds passed). Pre-v0.7.79 this writer SKIPPED
    // skill_uses_concept entirely — that was the load-bearing gap closed by
    // this iteration.
    const result = await commitKnowledge(state, {
        kind: "skill",
        name: String(parsed.name).slice(0, 100),
        description: String(parsed.description).slice(0, 200),
        preconditions: parsed.preconditions ? String(parsed.preconditions).slice(0, 200) : undefined,
        steps: parsed.steps.slice(0, 8).map(s => ({ tool: String(s.tool ?? "unknown"), description: String(s.description ?? "").slice(0, 200) })),
        postconditions: parsed.postconditions ? String(parsed.postconditions).slice(0, 200) : undefined,
        taskId: item.task_id,
        projectId: item.project_id,
    });
    return { skill_id: result.id, name: parsed.name };
}
// 0.7.32: file-internal parser exposure for the test harness only. Do not
// import from production code — the canonical entry points are
// `commit_work_results` and the work-type case dispatchers above. The
// parsers are tested directly because they're pure helpers and the full
// dispatch path requires a SurrealStore + EmbeddingService.
export const __test__ = {
    parseSkillResult,
    parseCausalGraduationResult,
    parseSoulResult,
};
