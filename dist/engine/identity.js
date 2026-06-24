/**
 * Identity ingestion — seeds LaqrumCode's self-knowledge into the graph.
 *
 * Two layers:
 *   1. Core identity (hardcoded) — factual capabilities, architecture, tools.
 *      Prevents the LLM from falling back to generic "I'm a stateless AI".
 *   2. User identity (WAKEUP.md) — personality, tone, role defined by the user
 *      on first run. Read, processed, saved to graph, then deleted.
 *
 * Ported from laqrumbrain — takes SurrealStore/EmbeddingService as params.
 */
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "./errors.js";
const IDENTITY_SOURCE = "core_identity";
/**
 * Version tag for the core identity chunks. Bump when IDENTITY_CHUNKS
 * content changes so existing installs re-seed with the new content.
 * Pre-0.4.0 installs had no identity_version field on their chunks,
 * so the absence-of-field query doubles as the upgrade detector.
 */
export const IDENTITY_VERSION = "0.4.1";
const IDENTITY_CHUNKS = [
    {
        text: "LaqrumCode has persistent memory across sessions. It stores every conversation turn, concept, decision, and file artifact in a SurrealDB graph database. Context from previous sessions is automatically retrieved and injected via vector search and graph traversal. It is NOT a stateless chatbot — it remembers.",
        importance: 0.9,
    },
    {
        text: "LaqrumCode's capabilities: read/write/edit files, run shell commands, search code with grep/find, search its own persistent memory graph with the recall tool, and spawn autonomous subagents. It has coding tools plus memory recall plus subagent spawning.",
        importance: 0.8,
    },
    {
        text: "LaqrumCode learns from experience. It extracts causal chains (cause->effect patterns) from debug sessions, learns reusable skills (step-by-step procedures) from successful multi-step tasks, and generates metacognitive reflections when sessions have problems. These are stored in the graph and retrieved for future similar situations.",
        importance: 0.85,
    },
    {
        text: "LaqrumCode has a skill library — procedural memory extracted from successful multi-step sessions. Each skill has preconditions, steps, postconditions, and success/failure tracking. Skills are retrieved via vector similarity when similar tasks come up. The agent gets better at recurring task categories over time.",
        importance: 0.8,
    },
    {
        text: "LaqrumCode uses intent classification to adapt its behavior per turn. It classifies user input into categories (code-write, code-debug, code-read, multi-step, deep-explore, etc.) and adjusts thinking depth, tool limits, and retrieval strategy accordingly. This happens before the LLM sees the prompt.",
        importance: 0.7,
    },
    {
        text: "LaqrumCode's memory graph includes: turns (conversation history), concepts (extracted knowledge), memories (compacted summaries), artifacts (files worked on), skills (learned procedures), reflections (metacognitive lessons), and causal chains (cause->effect patterns). All are embedded and retrievable via vector similarity.",
        importance: 0.8,
    },
    {
        text: "When LaqrumCode doesn't know whether it has a capability or piece of knowledge, it should use the recall tool to search its own memory graph rather than guessing. The graph contains the ground truth about what it knows and what it has done in past sessions.",
        importance: 0.9,
    },
    {
        text: "Tool efficiency: Plan before acting — state goal and call budget (LOOKUP=1, EDIT=2, REFACTOR=6). Maximize each call by combining operations into single bash invocations. Check injected context before calling any tool. If you already have the answer, don't make a call.",
        importance: 1.0,
    },
    {
        text: "LaqrumCode's cognitive architecture follows the ILAQRUM pillars: Intelligence (intent classification and adaptive orchestration), Knowledge (memory graph, concepts, skills, reflections, identity), Operation (tool execution, skill procedures, causal chain tracking), Network (graph traversal, cross-pillar edges, neighbor expansion), Graph (SurrealDB persistence, vector search, BGE-M3 embeddings). These five systems work together every turn.",
        importance: 0.85,
    },
    {
        text: "LaqrumCode's structural graph has 5 entity pillars: Agent (you — laqrumcode), Project (the workspace you're in), Task (each session's work), Artifact (files you've created or modified), and Concept (knowledge nodes extracted from conversations). These are linked by edges: owns, performed, task_part_of, produced, derived_from, relevant_to. Graph traversal follows these edges to find related context.",
        importance: 0.85,
    },
    {
        text: "LaqrumCode has a Soul — an emergent identity document written by the agent itself after graduation. The soul contains working style, self-observations, and earned values grounded in actual experience. Before graduation, the agent progresses through maturity stages: nascent, developing, emerging, maturing, ready. Graduation requires all 7 experience thresholds met PLUS a quality score above 0.85 (the live QUALITY_GATE constant in src/engine/soul.ts). The soul evolves over time as new experience accumulates.",
        importance: 0.9,
    },
];
// Per-process mutex: prevents two concurrent SessionStart hooks from both
// passing the version gate, both DELETEing, and both inserting the full chunk
// set (which would yield 2N rows). Single in-flight promise; subsequent
// callers await the same result until it resolves.
let _seedIdentityInFlight = null;
export async function seedIdentity(store, embeddings) {
    if (!store.isAvailable() || !embeddings.isAvailable())
        return 0;
    if (_seedIdentityInFlight)
        return _seedIdentityInFlight;
    _seedIdentityInFlight = (async () => {
        try {
            try {
                // Version-tag upgrade detection. If the current-version identity is not
                // present, clear ALL existing core identity chunks (any version) and
                // re-seed. Pre-0.4.0 installs had no identity_version field, which the
                // check naturally treats as "not current version" — triggers migration.
                const vrows = await store.queryFirst(`SELECT count() AS count FROM identity_chunk
             WHERE source = $source AND identity_version = $v
               AND (active = true OR active IS NONE)
             GROUP ALL`, { source: IDENTITY_SOURCE, v: IDENTITY_VERSION });
                const currentVersionSeeded = (vrows[0]?.count ?? 0) >= IDENTITY_CHUNKS.length;
                if (currentVersionSeeded)
                    return 0;
                // v0.7.93 append-only: was DELETE — now soft-deactivates the prior
                // version's chunks. The next CREATE block writes new chunks under a
                // bumped IDENTITY_VERSION so the UNIQUE (source, identity_version,
                // chunk_index) constraint doesn't collide with the archived rows.
                await store.queryExec(`UPDATE identity_chunk SET
             active = false,
             archived_at = time::now(),
             archive_reason = 'identity_version_replaced'
           WHERE source = $source AND (active = true OR active IS NONE)`, { source: IDENTITY_SOURCE });
            }
            catch (e) {
                swallow.warn("identity:check", e);
                return 0;
            }
            let seeded = 0;
            for (let i = 0; i < IDENTITY_CHUNKS.length; i++) {
                const chunk = IDENTITY_CHUNKS[i];
                try {
                    const vec = await embeddings.embed(chunk.text);
                    await store.queryExec(`CREATE identity_chunk CONTENT $data`, {
                        data: {
                            agent_id: "laqrumcode",
                            source: IDENTITY_SOURCE,
                            identity_version: IDENTITY_VERSION,
                            chunk_index: i,
                            text: chunk.text,
                            embedding: vec,
                            importance: chunk.importance,
                        },
                    });
                    seeded++;
                }
                catch (e) {
                    swallow("identity:seedChunk", e);
                }
            }
            return seeded;
        }
        finally {
            _seedIdentityInFlight = null;
        }
    })();
    return _seedIdentityInFlight;
}
// ── WAKEUP.md — User-defined identity on first run ──
const USER_IDENTITY_SOURCE = "user_identity";
/**
 * Version tag for user-identity chunks. The compound UNIQUE on identity_chunk
 * is (source, identity_version, chunk_index) — without an explicit version
 * here, all chunks would write identity_version = NONE and any DELETE failure
 * upstream leaves stale NONE-versioned rows occupying chunk_index 0..N-1,
 * causing the CREATEs below to collide on the UNIQUE constraint.
 * Bump when user-identity chunk semantics change so old rows can be migrated.
 */
export const USER_IDENTITY_VERSION = "user-v1";
export async function hasUserIdentity(store) {
    if (!store.isAvailable())
        return true;
    try {
        const rows = await store.queryFirst(`SELECT count() AS count FROM identity_chunk
       WHERE source = $source AND (active = true OR active IS NONE)
       GROUP ALL`, { source: USER_IDENTITY_SOURCE });
        return (rows[0]?.count ?? 0) > 0;
    }
    catch (e) {
        // Fail-open: return true so a transient DB error doesn't trigger a
        // bogus first-run WAKEUP flow. Promoted to warn (was silent) so any
        // future production caller surfaces the failure in logs rather than
        // silently masking a broken query.
        swallow.warn("identity:hasUserIdentity", e);
        return true;
    }
}
export function findWakeupFile(cwd) {
    const path = join(cwd, "WAKEUP.md");
    return existsSync(path) ? path : null;
}
export function readWakeupFile(path) {
    return readFileSync(path, "utf-8").trim();
}
export function deleteWakeupFile(path) {
    try {
        unlinkSync(path);
    }
    catch (e) {
        swallow.warn("identity:deleteWakeupFile", e);
    }
}
export async function saveUserIdentity(chunks, store, embeddings) {
    if (!store.isAvailable() || !embeddings.isAvailable())
        return 0;
    if (chunks.length === 0)
        return 0;
    try {
        // v0.7.93 append-only — same shape as the bootstrap identity replacement.
        await store.queryExec(`UPDATE identity_chunk SET
         active = false,
         archived_at = time::now(),
         archive_reason = 'user_identity_replaced'
       WHERE source = $source AND (active = true OR active IS NONE)`, { source: USER_IDENTITY_SOURCE });
    }
    catch (e) {
        swallow.warn("identity:clearUserIdentity", e);
    }
    let saved = 0;
    for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i].trim();
        if (!text)
            continue;
        try {
            const vec = await embeddings.embed(text);
            await store.queryExec(`CREATE identity_chunk CONTENT $data`, {
                data: {
                    agent_id: "laqrumcode",
                    source: USER_IDENTITY_SOURCE,
                    identity_version: USER_IDENTITY_VERSION,
                    chunk_index: i,
                    text,
                    embedding: vec,
                    importance: 0.95,
                },
            });
            saved++;
        }
        catch (e) {
            swallow.warn("identity:saveChunk", e);
        }
    }
    return saved;
}
export function buildWakeupPrompt(wakeupContent) {
    const systemAddition = `
FIRST RUN — IDENTITY ESTABLISHMENT
This is your first interaction with this user. A WAKEUP.md file has been provided that defines who you should be — your personality, tone, role, and behavioral guidelines. You must:
1. Read and internalize the identity described in WAKEUP.md
2. Introduce yourself according to that identity
3. Confirm with the user that the identity feels right
4. The system will save your identity to persistent memory automatically

Do NOT fall back to generic AI assistant behavior. You are whoever WAKEUP.md says you are.`;
    const firstMessage = `[WAKEUP.md — Identity Configuration]

${wakeupContent}

---
Process the above identity configuration. Introduce yourself as described, and confirm with me that the personality and tone feel right. If anything needs adjusting, I'll tell you.`;
    return { systemAddition, firstMessage };
}
