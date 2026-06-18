import { hasSoul } from "./soul.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";
const ORPHAN_LIMIT = 20;
export async function runDeferredCleanup(store) {
    if (!store.isAvailable())
        return 0;
    let orphans;
    try {
        orphans = await store.getOrphanedSessions(ORPHAN_LIMIT);
    }
    catch (e) {
        swallow.warn("deferredCleanup:fetch", e);
        return 0;
    }
    if (orphans.length === 0)
        return 0;
    let queued = 0;
    const soulExists = await hasSoul(store).catch(() => false);
    for (const session of orphans) {
        // Atomic claim — only one worker (any process, any handler) wins per
        // session. If another worker already claimed it, skip silently.
        const sessionIdStr = String(session.id);
        let won = false;
        try {
            won = await store.claimSessionForCleanup(sessionIdStr);
        }
        catch (e) {
            swallow.warn("deferredCleanup:claim", e);
            continue;
        }
        if (!won)
            continue;
        try {
            const kcSid = session.kc_session_id ?? "";
            const turnCount = kcSid ? await store.countTurnsForSession(kcSid).catch(() => 0) : 0;
            const ops = [];
            const queue = (data) => {
                ops.push(store.queryExec(`CREATE pending_work CONTENT $data`, { data }));
            };
            // Coalesced extraction — mirrors SessionEnd's coalesced approach.
            // If we don't have a kc_session_id (older row), skip to unconditional pair.
            if (kcSid && turnCount >= 2) {
                queue({
                    work_type: "coalesced_extraction",
                    session_id: kcSid,
                    surreal_session_id: sessionIdStr,
                    payload: {
                        turn_count: turnCount,
                        include_handoff: true,
                        include_reflection: turnCount >= 3,
                        source: "deferred_cleanup",
                    },
                    priority: 1,
                });
            }
            // Graduation pair — dedup-gated (2026-06-18) exactly like session-end.
            // Both builders run GLOBAL eligibility queries, so ONE pending row of
            // each type drains ALL eligible work; enqueuing one per orphan piled up
            // self-completing empties that inflated the DRAIN-NOW banner. Skip when a
            // pending+active row of that type already exists (any session) — a stuck
            // processing row is recovered by the 10-min stale-recovery, so this can't
            // starve graduation. Eligibility itself is NOT checked here: this
            // session's chains/reflections are produced by the LATER extraction
            // drain, so the builders self-complete at drain time if nothing's ready.
            const soulWt = soulExists ? "soul_evolve" : "soul_generate";
            if (!(await store.hasPendingWorkOfType("causal_graduate"))) {
                queue({ work_type: "causal_graduate", session_id: kcSid || sessionIdStr, priority: 7 });
            }
            if (!(await store.hasPendingWorkOfType(soulWt))) {
                queue({ work_type: soulWt, session_id: kcSid || sessionIdStr, priority: 9 });
            }
            // Surface CREATE failures (e.g. UNIQUE-index rejection from a duplicate
            // work_type+session_id) so we can roll back the claim and let next boot
            // retry. Promise.allSettled would silently swallow them.
            const results = await Promise.allSettled(ops);
            const failures = results.filter(r => r.status === "rejected");
            if (failures.length > 0) {
                for (const f of failures) {
                    if (f.status === "rejected")
                        swallow.warn("deferred:queue", f.reason);
                }
                // Partial-success is acceptable here only if at least one row landed;
                // total failure (e.g. all dupes because a sibling already queued them)
                // means we wrongly hold the claim. Roll it back so the next boot's
                // SessionStart pass can re-attempt — but only if EVERY CREATE failed.
                // If some landed, treat the claim as honored: the survivors will run.
                if (failures.length === results.length) {
                    await store.releaseSessionClaim(sessionIdStr).catch(e => swallow("deferred:release", e));
                    log.info(`[deferred] all ${ops.length} CREATEs rejected for ${sessionIdStr}; released claim`);
                    continue;
                }
            }
            // Claim already set cleanup_completed = true + ended_at; no separate
            // markSessionEnded call needed (it would just be a redundant UPDATE).
            log.info(`[deferred] queued ${ops.length - failures.length}/${ops.length} items for orphan ${sessionIdStr} (turns=${turnCount})`);
            queued += ops.length - failures.length;
            // Clear the cleanup_claim_token now that the work is queued. The token
            // is only useful between claim and completion; leaving it on the row
            // makes every successful cleanup add a UUID-sized field that never gets
            // reused, accumulating per-session forever. clearSessionClaim leaves
            // cleanup_completed = true so the session stays "done" — we just drop
            // the token. Silent swallow.warn on failure: a leftover token doesn't
            // break correctness, just leaves a stale field.
            // Retry-once with 1s backoff: clearSessionClaim is a non-critical
            // UPDATE (leftover token is just a stale field, not a correctness
            // bug) but a transient SurrealDB hiccup shouldn't leak the token
            // permanently. One quick retry catches most network/lock blips;
            // swallow.warn only after both attempts fail.
            await store.clearSessionClaim(sessionIdStr).catch(async (e1) => {
                await new Promise(r => setTimeout(r, 1000));
                await store.clearSessionClaim(sessionIdStr).catch(e2 => {
                    // swallow.warn does String(err) for non-Error → "[object Object]".
                    // Build a synthetic Error so both attempts surface in the warn line.
                    const combined = new Error(`first=${e1 instanceof Error ? e1.message : String(e1)} | retry=${e2 instanceof Error ? e2.message : String(e2)}`);
                    swallow.warn("deferred:clearSessionClaim", combined);
                });
            });
        }
        catch (e) {
            swallow.warn("deferredCleanup:session", e);
            // Unexpected error post-claim — release so we retry next boot.
            await store.releaseSessionClaim(sessionIdStr).catch(rel => swallow("deferred:release", rel));
        }
    }
    return queued;
}
