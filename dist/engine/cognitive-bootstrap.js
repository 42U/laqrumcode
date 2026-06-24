import { swallow } from "./errors.js";
const BOOTSTRAP_SOURCE = "cognitive_bootstrap";
/**
 * Version tag for the cognitive bootstrap content. Bump this when CORE_ENTRIES
 * or IDENTITY_CHUNKS change; seedCognitiveBootstrap uses it to detect stale
 * seeds and re-seed on upgrade.
 */
export const BOOTSTRAP_VERSION = "0.4.1";
// ── Tier 0 Core Memory: imperative reflexes loaded every turn ────────────
const CORE_ENTRIES = [
    {
        text: `MEMORY REFLEX: After completing a task or learning something new: (1) Save the insight to core_memory if it should persist across ALL sessions, or let the daemon extract it if session-scoped. (2) When saving, write the WHAT, WHY, and WHEN-TO-USE in the text — vague entries are useless on recall. (3) Link to existing knowledge by using concept names the graph already contains. Check with recall first. Corrections from the user are the highest-value signal — always save them.`,
        category: "operations",
        priority: 95,
    },
    {
        text: `RECALL BEFORE GUESSING: When uncertain about past decisions, user preferences, project history, or your own capabilities, use the recall tool BEFORE answering. Effective queries: use specific technical terms, file paths, error messages, or concept names — not vague questions. Scope to "memories" for decisions/preferences, "concepts" for technical knowledge, "skills" for procedures, "artifacts" for files. Check what's already in your injected context before calling recall — context is prefetched predictively each turn.`,
        category: "operations",
        priority: 90,
    },
    {
        text: `GRAPH-AWARE SAVING: When you save knowledge, include terms that create graph connectivity. Mention specific file paths (links to artifacts), technical concept names (links to concepts), and session context (links to tasks). Forward traversal: "X caused Y" lets future searches from X find Y. Backward traversal: "Y was caused by X" lets searches from Y find X. Write both directions. Concepts auto-link into hierarchies (narrower/broader) when one name contains another.`,
        category: "operations",
        priority: 85,
    },
    {
        text: `MEMORY TOOLS: recall = search graph (use: uncertain, need history, checking prior work). core_memory = manage always-loaded directives (use: permanent lessons, rules, identity updates; add/update/deactivate; Tier 0 = every turn, Tier 1 = this session). introspect = inspect DB health, counts, retrieval quality, graduation progress (use: status checks, debugging memory, checking maturity stage). Use introspect periodically to understand your memory depth and notice gaps.`,
        category: "tools",
        priority: 80,
    },
    {
        text: `GRAPH SCHEMA REFERENCE: Key table fields — concept: content (the label/name), embedding, stability, confidence, source. memory: text, embedding, category, importance, session_id. artifact: path, type (created/modified/read/discussed), description, embedding. turn: session_id, role, text, tool_name. session: agent_id, started_at, ended_at. reflection: session_id, text, category, severity. skill: name, description, steps, preconditions, postconditions, success_count. monologue: content, session_id. When querying the graph directly, use these exact field names — e.g. concept.content is the concept label, not concept.name or concept.text.`,
        category: "schema",
        priority: 77,
    },
    {
        text: `AUTO-SEAL CONTRACT (0.4.0+): The substrate wires edges for you. You do NOT need to call linkToRelevantConcepts or linkConceptHierarchy manually — every concept/memory/artifact write goes through commitKnowledge(), which auto-fires: concept → narrower/broader hierarchy edges + related_to by embedding similarity; memory → about_concept edges; artifact → artifact_mentions edges; turn → mentions edges. Focus on WHAT to save — the linking is automatic. If a write path you see does NOT go through commitKnowledge (raw store.upsertConcept or store.createMemory calls outside of concept-extract.ts), that is a bug — flag it.`,
        category: "operations",
        priority: 83,
    },
];
// ── Identity Chunks: vector-searchable reference material ────────────────
const IDENTITY_CHUNKS = [
    {
        text: `LaqrumCode's memory daemon runs in the background and extracts 9 knowledge types from your conversations every ~4K tokens or 3 turns: causal chains (cause->effect from debugging), monologue traces (doubts, insights, tradeoffs, realizations — episodic reasoning moments), resolved memories (daemon marks issues done when mentioned as fixed), concepts (technical facts worth remembering), corrections (user correcting you — highest signal), preferences (user workflow/style signals), artifacts (files created/modified/read), decisions (choices with rationale), and skills (multi-step procedures that worked). Extraction is quality-gated — weak confidence extractions are skipped, so the same conversation may yield different extractions depending on signal strength.`,
        importance: 9,
    },
    {
        text: `Effective recall queries use specific terms that match how knowledge was stored. Search by: file paths ("/src/auth/login.ts"), error messages ("ECONNREFUSED"), concept names ("rate limiting"), decision descriptions ("chose PostgreSQL over MongoDB"), or skill names ("deploy to staging"). The recall tool does vector similarity search plus graph neighbor expansion — top results pull in related nodes via 25 edge types. Scope options: "all" (default), "memories" (decisions, corrections, preferences), "concepts" (extracted technical knowledge), "turns" (past conversation), "artifacts" (files), "skills" (learned procedures). Retrieval scoring improves automatically over time as the ACAN (learned scoring model) trains on retrieval outcomes — early sessions use heuristic scoring, later sessions benefit from learned weights.`,
        importance: 9,
    },
    {
        text: `LaqrumCode's memory lifecycle: During a session, the daemon extracts knowledge incrementally. At session end (or mid-session every ~25K tokens): a handoff note is written summarizing progress, skills are extracted from successful tasks, metacognitive reflections are generated (linked to the session via reflects_on edges), and causal chains may graduate to skills. At next session start: the wakeup system synthesizes a first-person briefing from the handoff + identity + monologues + depth signals. Context is also predictively prefetched each turn based on likely follow-up queries — relevant memories may appear in your context without you requesting them.`,
        importance: 8,
    },
    {
        text: `Graph connectivity determines recall quality. ~26 edge types link nodes across the graph. Key edges: mentions (turn->concept), about_concept (memory->concept), artifact_mentions (artifact->concept), caused_by/supports/contradicts (memory<->memory), narrower/broader/related_to (concept<->concept), reflects_on (reflection->session), part_of (turn->session), skill_from_task (skill->task), spawned/spawned_from (session<->subagent). To maximize connectivity: mention specific artifact paths, reference existing concept names, describe cause-effect relationships explicitly, and note task context. Reuse existing concept names — use introspect or recall to discover what names exist.`,
        importance: 8,
    },
    {
        text: `Three persistence mechanisms serve different purposes. Core memory (Tier 0): you control directly via the core_memory tool. Always loaded every turn. Use for: permanent operational rules, learned patterns, identity refinements. Budget-constrained (~10% of context). Core memory (Tier 1): pinned for the current session only. Use for: session-specific context like "working on auth refactor" or "user prefers verbose logging". Identity chunks: self-knowledge seeded at bootstrap, vector-searchable but not always loaded — surfaces in wakeup briefings. Daemon extraction: automatic, runs on conversation content, writes to memory/concept/skill/artifact tables. You don't control extraction directly, but the quality of your conversation affects what gets extracted.`,
        importance: 8,
    },
    {
        text: `Soul graduation: LaqrumCode tracks your maturity across 5 stages — nascent (≤3/7 thresholds), developing (4/7), emerging (5/7), maturing (6/7), ready (7/7). The 7 thresholds are: sessions, reflections, causal chains, concepts, monologues, span days, total memories, and skills (skills:30 added v0.4.x as the 7th gate). Reaching 7/7 is necessary but not sufficient — you must also pass a quality gate (score >= 0.85) based on retrieval utilization, skill success rate, critical reflection rate, and tool failure rate. On graduation, you author a Soul document — a self-assessment grounded in your actual experience, not aspirational claims. Use introspect with action "status" to check your current stage and progress. The Soul document becomes part of your identity once written.`,
        importance: 8,
    },
];
// Per-process mutex: prevents two concurrent SessionStart hooks from both
// passing the version-tag check, both DELETEing identity_chunk rows, and both
// re-inserting — yielding 2N rows. Single in-flight promise; subsequent
// callers await the same result until it resolves.
let _seedBootstrapInFlight = null;
/**
 * Seed cognitive bootstrap knowledge on first run.
 * Idempotent — checks for existing entries before seeding.
 */
export async function seedCognitiveBootstrap(store, embeddings) {
    if (!store.isAvailable())
        return { identitySeeded: 0, coreSeeded: 0 };
    if (_seedBootstrapInFlight)
        return _seedBootstrapInFlight;
    _seedBootstrapInFlight = seedCognitiveBootstrapImpl(store, embeddings)
        .finally(() => { _seedBootstrapInFlight = null; });
    return _seedBootstrapInFlight;
}
async function seedCognitiveBootstrapImpl(store, embeddings) {
    let identitySeeded = 0;
    let coreSeeded = 0;
    // ── Core memory Tier 0 (always loaded, no embeddings needed) ───────────
    // One-shot migration (runs every boot, but is a no-op once clean):
    // delete untagged pre-0.4.0 entries matching known fingerprints. Needed
    // because some installs seeded v0.4.0-tagged entries ON TOP OF the
    // untagged pre-0.4.0 ones, leaving 11 rows instead of 6. The version
    // check below can't fix that case because it sees the tag and skips
    // cleanup. This migration runs outside the version check so the cleanup
    // fires regardless. Condition is narrow: text must NOT contain the
    // version tag AND must start with a known pre-0.4.0 fingerprint.
    try {
        // SurQL precedence + string::starts_with arity can be finicky; use
        // explicit parens + CONTAINS so the planner has nothing to misinterpret.
        // The fingerprint prefixes are all unique-enough phrases that a naive
        // CONTAINS match is safe — no user-authored core_memory entry would
        // embed "MEMORY REFLEX" verbatim in its operational text.
        // SELF-TEACHING CYCLE was a transient pre-0.4.0 CORE_ENTRY (dropped
        // before a8a880b landed) that survived on installs bootstrapped in
        // that window; include it so those installs migrate cleanly to 6.
        // v0.7.93 append-only: was DELETE — now soft-deactivates legacy core
        // entries via active=false + archived_at + archive_reason. Readers
        // already filter on active=true (core_memory.active field).
        await store.queryExec(`UPDATE core_memory SET
         active = false,
         archived_at = time::now(),
         archive_reason = 'pre_kc_bootstrap_v_legacy_migration'
       WHERE
         (!(text CONTAINS '[kc_bootstrap_v'))
         AND (active = true OR active IS NONE)
         AND
         (text CONTAINS 'MEMORY REFLEX'
           OR text CONTAINS 'RECALL BEFORE GUESSING'
           OR text CONTAINS 'GRAPH-AWARE SAVING'
           OR text CONTAINS 'MEMORY TOOLS:'
           OR text CONTAINS 'GRAPH SCHEMA REFERENCE'
           OR text CONTAINS 'SELF-TEACHING CYCLE')`);
    }
    catch (e) {
        swallow.warn("bootstrap:migrateLegacyCore", e);
    }
    try {
        // Version-tag check: look for an entry marked with the current
        // BOOTSTRAP_VERSION. If absent, re-seed the core entries (clearing stale
        // ones from prior versions first). This lets 0.4.0's new AUTO-SEAL
        // CONTRACT entry land in grafts that bootstrapped under 0.3.x or earlier.
        const versionRows = await store.queryFirst(`SELECT count() AS cnt FROM core_memory
       WHERE text CONTAINS $tag AND (active = true OR active IS NONE)
       GROUP ALL`, { tag: `[kc_bootstrap_v${BOOTSTRAP_VERSION}]` });
        const currentVersionSeeded = (versionRows[0]?.cnt ?? 0) > 0;
        if (!currentVersionSeeded) {
            // Clear prior bootstrap entries so the index stays tight. Matches
            // (a) any previously version-tagged entries (0.4.0+ style), AND
            // (b) the untagged pre-0.4.0 entries that we can recognize by the
            //     CORE_ENTRIES fingerprint prefixes ("MEMORY REFLEX:",
            //     "RECALL BEFORE GUESSING:", "GRAPH-AWARE SAVING:",
            //     "MEMORY TOOLS:", "GRAPH SCHEMA REFERENCE:"). Without (b),
            //     first-ever 0.4.0 boot left old entries in place, doubling the
            //     core-memory count to 11 instead of migrating to 6.
            try {
                // v0.7.93 append-only: was DELETE — now soft-archives prior bootstrap
                // entries so the new tagged version takes precedence in recall while
                // the old text remains for forensic audit.
                await store.queryExec(`UPDATE core_memory SET
             active = false,
             archived_at = time::now(),
             archive_reason = 'bootstrap_version_replaced'
           WHERE
             (active = true OR active IS NONE)
             AND (
               text CONTAINS '[kc_bootstrap_v' OR
               string::starts_with(text, 'MEMORY REFLEX:') OR
               string::starts_with(text, 'RECALL BEFORE GUESSING:') OR
               string::starts_with(text, 'GRAPH-AWARE SAVING:') OR
               string::starts_with(text, 'MEMORY TOOLS:') OR
               string::starts_with(text, 'GRAPH SCHEMA REFERENCE:') OR
               string::starts_with(text, 'SELF-TEACHING CYCLE:')
             )`);
            }
            catch (e) {
                swallow.warn("bootstrap:clearPrior", e);
            }
            for (const entry of CORE_ENTRIES) {
                try {
                    // Prefix entries with a version tag we can detect on next boot.
                    // Placed at the end so the operational text reads cleanly first.
                    const tagged = `${entry.text}\n[kc_bootstrap_v${BOOTSTRAP_VERSION}]`;
                    await store.createCoreMemory(tagged, entry.category, entry.priority, 0);
                    coreSeeded++;
                }
                catch (e) {
                    swallow.warn("bootstrap:seedCore", e);
                }
            }
        }
    }
    catch (e) {
        swallow.warn("bootstrap:checkCore", e);
    }
    // ── Identity chunks (vector-searchable, requires embeddings) ───────────
    if (!embeddings.isAvailable())
        return { identitySeeded, coreSeeded };
    try {
        // Version-tag identity chunks the same way we do core entries. Without
        // this, existing installs kept pre-0.4.0 identity chunks (referencing
        // "LaqrumBrain", not "LaqrumCode") because the old count-match heuristic
        // saw 6 chunks present and skipped re-seeding even when content changed.
        const vrows = await store.queryFirst(`SELECT count() AS count FROM identity_chunk
         WHERE source = $source AND bootstrap_version = $v
           AND (active = true OR active IS NONE)
         GROUP ALL`, { source: BOOTSTRAP_SOURCE, v: BOOTSTRAP_VERSION });
        const currentVersionSeeded = (vrows[0]?.count ?? 0) > 0;
        if (!currentVersionSeeded) {
            // Clear ALL prior bootstrap identity chunks (any version, including
            // the pre-versioning pre-0.4.0 ones that had no bootstrap_version field).
            // v0.7.93 append-only: was DELETE — now soft-deactivates so old
            // identity content remains for forensic audit while the new version
            // takes effect.
            await store.queryExec(`UPDATE identity_chunk SET
           active = false,
           archived_at = time::now(),
           archive_reason = 'bootstrap_identity_replaced'
         WHERE source = $source AND (active = true OR active IS NONE)`, { source: BOOTSTRAP_SOURCE });
            for (let i = 0; i < IDENTITY_CHUNKS.length; i++) {
                const chunk = IDENTITY_CHUNKS[i];
                try {
                    const vec = await embeddings.embed(chunk.text);
                    await store.queryExec(`CREATE identity_chunk CONTENT $data`, {
                        data: {
                            agent_id: "laqrumcode",
                            source: BOOTSTRAP_SOURCE,
                            bootstrap_version: BOOTSTRAP_VERSION,
                            chunk_index: i,
                            text: chunk.text,
                            embedding: vec,
                            importance: chunk.importance,
                        },
                    });
                    identitySeeded++;
                }
                catch (e) {
                    swallow.warn("bootstrap:seedIdentityChunk", e);
                }
            }
        }
    }
    catch (e) {
        swallow.warn("bootstrap:checkIdentity", e);
    }
    return { identitySeeded, coreSeeded };
}
