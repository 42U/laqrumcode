import { swallow } from "./errors.js";
import { assertRecordId } from "./surreal.js";
import { linkConceptHierarchy, linkToRelevantConcepts } from "./concept-links.js";
import { supersedeOldSkills } from "./skills.js";
import { stripStructuralTags } from "./sanitize.js";
import { clamp01 } from "./math.js";
/** Local-narrow record-id regex: only accept ids in the `memory:` table. */
const memoryIdRe = /^memory:[a-zA-Z0-9_]+$/;
function sanitizeExtraction(obj) {
    if (obj == null || typeof obj !== "object")
        return;
    if (Array.isArray(obj)) {
        for (const item of obj)
            sanitizeExtraction(item);
        return;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string")
            obj[k] = stripStructuralTags(v);
        else if (typeof v === "object" && v !== null)
            sanitizeExtraction(v);
    }
}
// --- Build the extraction prompt ---
export function buildSystemPrompt(hasThinking, hasRetrievedMemories, prior) {
    const dedup = prior.conceptNames.length > 0 || prior.artifactPaths.length > 0 || prior.skillNames.length > 0
        ? `\n\nALREADY EXTRACTED (do NOT repeat these):
- Concepts: ${prior.conceptNames.length > 0 ? prior.conceptNames.join(", ") : "none yet"}
- Artifacts: ${prior.artifactPaths.length > 0 ? prior.artifactPaths.join(", ") : "none yet"}
- Skills: ${prior.skillNames.length > 0 ? prior.skillNames.join(", ") : "none yet"}`
        : "";
    return `You are a memory extraction daemon. Analyze the conversation transcript and extract structured knowledge.
Return ONLY valid JSON with these fields (all arrays, use [] if none found for a field):
${dedup}

{
  "causal": [
    // Cause->effect chains from debugging, refactoring, fixing, or building.
    // Only when there's a clear trigger and outcome. Max 5.
    {"triggerText": "what caused it (max 200 chars)", "outcomeText": "what happened as a result", "chainType": "debug|refactor|feature|fix", "success": true/false, "confidence": 0.0-1.0, "description": "1-sentence summary"}
  ],
  "monologue": [
    // Internal reasoning moments worth preserving: doubts, tradeoffs, insights, realizations.
    // Infer from the conversation flow — approach changes, surprising discoveries, tradeoff decisions.
    // Skip routine reasoning. Only novel/surprising thoughts. Max 5.
    {"category": "doubt|tradeoff|alternative|insight|realization", "content": "1-2 sentence description"}
  ],
${hasRetrievedMemories ? `  "resolved": [
    // IDs from [RETRIEVED MEMORIES] that have been FULLY addressed/fixed/completed in this conversation.
    // Must be exact IDs like "memory:abc123". Empty [] if none resolved.
    "memory:example_id"
  ],` : '  "resolved": [],'}
  "concepts": [
    // Technical facts, knowledge, decisions, or findings worth remembering.
    // NOT conversation flow — only things that would be useful to recall later.
    // Include BOTH implementation details AND project-level descriptions.
    // Ask: "if someone searched for this work in 3 weeks, what would they type?"
    // Name concepts in the language someone would naturally search for, not just
    // internal jargon. E.g. "migrating trading crons to Docker" not just "apps.yaml schema".
    // searchTerms: phrases a developer would type 3 weeks from now to find this.
    // E.g. for "apps.yaml schema" → ["migrating trading crons to Docker", "Docker compose migration"].
    // Categories: technical, architectural, behavioral, environmental, procedural
    // Max 8 per batch.
    {"name": "short identifier (3-6 words)", "content": "the actual knowledge (1-3 sentences)", "category": "technical|architectural|behavioral|environmental|procedural", "importance": 1-10, "searchTerms": ["2-3 natural language phrases someone would type to find this later"]}
  ],
  "corrections": [
    // Moments where the user corrects the assistant's understanding, approach, or output.
    // These are high-value signals about what NOT to do.
    {"original": "what the assistant said/did wrong", "correction": "what the user said the right answer/approach is", "context": "brief context of when this happened"}
  ],
  "preferences": [
    // User behavioral signals: communication style, workflow preferences, tool preferences.
    // Only extract NOVEL preferences not already obvious. Max 5.
    {"preference": "what the user prefers (1 sentence)", "evidence": "what they said/did that shows this"}
  ],
  "artifacts": [
    // Files that were created, modified, read, or discussed.
    // Extract from tool calls (bash, read, write, edit, grep commands).
    {"path": "/path/to/file", "action": "created|modified|read|discussed", "summary": "what was done to it (1 sentence)"}
  ],
  "decisions": [
    // Explicit choices made during the conversation with reasoning.
    // Architecture decisions, tool choices, approach selections. Max 3.
    {"decision": "what was decided", "rationale": "why", "alternatives_considered": "what else was considered (or 'none discussed')"}
  ],
  "skills": [
    // Reusable multi-step procedures that WORKED. Only extract when a procedure
    // was successfully completed and would be useful to repeat. Max 2.
    {"name": "short name", "steps": ["step 1", "step 2", "..."], "trigger_context": "when to use this skill"}
  ]
}

RULES:
- Return ONLY the JSON object. No markdown, no explanation.
- Every field must be present (use [] for empty).
- Quality over quantity — skip weak/uncertain extractions.
- Concepts should be self-contained — readable without the conversation.
- Corrections are the MOST important signal. Never miss one.
- For artifacts, extract file paths from bash/tool commands in the transcript.
- Always include at least one project-level concept describing WHAT was worked on and WHY — the kind of thing someone would search for weeks later.`;
}
export function buildCoalescedPrompt(hasThinking, hasRetrievedMemories, prior, includeHandoff, includeReflection) {
    let base = buildSystemPrompt(hasThinking, hasRetrievedMemories, prior);
    const extras = [];
    if (includeHandoff) {
        extras.push(`  "handoff_note": "2-3 sentence first-person summary for your future self. What was worked on, what's unfinished, what to remember."`);
    }
    if (includeReflection) {
        extras.push(`  "reflection": "2-4 sentences (max 600 chars) capturing REASONING signal from this session. Valid content: a user correction worth remembering, a hypothesis that turned out wrong, a tradeoff the user resolved a specific way, or a pattern the user wants applied going forward. NEVER critique thoroughness, length, depth, or care taken. Being thorough is a non-negotiable founder rule, not a fault. NEVER write 'should have moved on faster', 'should have just acknowledged', 'overthinking it', 'too detailed', 'rushed it less', or 'acknowledge and move on'; those phrasings are forbidden. NEVER list tool calls, concept IDs, edge counts, save totals, test pass counts, or completion markers; those are operations, not reflections. If no real reasoning signal exists, return the string 'skip'."`);
    }
    extras.push(`  "rules_compliance": 0.0-1.0 — rate how well the assistant followed the injected directives and rules throughout the session. 1.0 = perfect compliance with all rules. 0.5 = mixed, some rules followed some ignored. 0.0 = consistently violated rules. Judge against the ACTIVE RULES block at the top of the transcript if present. Consider: did it cite sources when context was available, follow memory-save directives, avoid prohibited actions, apply user corrections immediately?`);
    if (extras.length > 0) {
        base = base.replace("RULES:", extras.join(",\n") + "\n\nRULES:");
    }
    return base;
}
export function buildTranscript(turns) {
    return turns
        .map(t => {
        const prefix = t.tool_name ? `[tool:${t.tool_name}]` : `[${t.role}]`;
        let line = `${prefix} ${stripStructuralTags((t.text ?? "").slice(0, 1500))}`;
        if (t.tool_result)
            line += `\n  -> ${stripStructuralTags(t.tool_result.slice(0, 500))}`;
        if (t.file_paths && t.file_paths.length > 0)
            line += `\n  files: ${t.file_paths.join(", ")}`;
        return line;
    })
        .join("\n");
}
export async function writeExtractionResults(result, sessionId, store, embeddings, priorState, taskId, projectId, turns) {
    sanitizeExtraction(result);
    const counts = {
        causal: 0, monologue: 0, resolved: 0, concept: 0,
        correction: 0, preference: 0, artifact: 0, decision: 0, skill: 0,
    };
    // ── Phase 1: Upsert concepts first (LLM-extracted) so we have IDs ────
    // These IDs are used to create mentions/about_concept/artifact_mentions
    // edges in Phase 2, replacing the old regex-based extraction.
    const extractedConceptIds = [];
    if (Array.isArray(result.concepts) && result.concepts.length > 0) {
        for (const c of result.concepts.slice(0, 11)) {
            if (!c.name || !c.content)
                continue;
            if (priorState.conceptNames.includes(c.name))
                continue;
            counts.concept++;
            priorState.conceptNames.push(c.name);
            try {
                let emb = null;
                if (embeddings.isAvailable()) {
                    const embeddingText = Array.isArray(c.searchTerms) && c.searchTerms.length > 0
                        ? `${c.content} ${c.searchTerms.join(". ")}`
                        : c.content;
                    try {
                        emb = await embeddings.embed(embeddingText);
                    }
                    catch (e) {
                        swallow("daemon:embedConcept", e);
                    }
                }
                const conceptId = await store.upsertConcept(c.content, emb, `daemon:${sessionId}`, undefined, projectId);
                if (conceptId) {
                    extractedConceptIds.push(conceptId);
                    await linkConceptHierarchy(conceptId, c.name, store, embeddings, "daemon:concept", emb);
                    if (taskId) {
                        await store.relate(conceptId, "derived_from", taskId)
                            .catch(e => swallow("daemon:concept:derived_from", e));
                    }
                    else if (sessionId) {
                        // 0.7.70: when no task is in scope (e.g. coalesced extraction
                        // queued before a task was attached), fall back to the session
                        // for provenance. Better some traceability than none — keeps
                        // concepts out of the "orphan" bucket in introspect. The session
                        // row is always knowable here since we created it upstream.
                        await store.relate(conceptId, "derived_from", sessionId)
                            .catch(e => swallow("daemon:concept:derived_from_session", e));
                    }
                    else {
                        // Both task and session missing — truly orphan, log loudly.
                        swallow.warn("daemon:concept:derived_from_skipped", new Error(`taskId and sessionId both empty when extracting concept "${c.name}" — concept will lack derived_from edge`));
                    }
                    if (projectId) {
                        await store.relate(conceptId, "relevant_to", projectId)
                            .catch(e => swallow("daemon:concept:relevant_to", e));
                    }
                }
            }
            catch (e) {
                swallow.warn("daemon:upsertConcept", e);
            }
        }
    }
    // ── Phase 2: Create mentions edges (turn → concept) via embedding similarity ─
    // Each turn's text is embedded and matched against existing concepts in the
    // graph. This replaces the old batch-local linking that only worked when
    // concepts and turns were extracted in the same batch.
    if (turns && turns.length > 0) {
        const turnIds = turns.filter(t => t.turnId && t.text).slice(0, 15);
        for (const t of turnIds) {
            await linkToRelevantConcepts(t.turnId, "mentions", t.text, store, embeddings, "daemon:mentions", 5, 0.65);
        }
    }
    // ── Phase 3: All other extractions in parallel ───────────────────────
    const writeOps = [];
    // 1. Causal chains
    if (Array.isArray(result.causal) && result.causal.length > 0) {
        const { linkCausalEdges } = await import("./causal.js");
        const validated = result.causal
            .filter((c) => c.triggerText && c.outcomeText && c.chainType && typeof c.success === "boolean")
            .slice(0, 5)
            .map((c) => ({
            triggerText: String(c.triggerText).slice(0, 200),
            outcomeText: String(c.outcomeText).slice(0, 200),
            chainType: (["debug", "refactor", "feature", "fix"].includes(c.chainType) ? c.chainType : "fix"),
            success: Boolean(c.success),
            confidence: clamp01(Number(c.confidence) || 0.5),
            description: String(c.description ?? "").slice(0, 150),
        }));
        if (validated.length > 0) {
            writeOps.push(linkCausalEdges(validated, sessionId, store, embeddings));
            counts.causal += validated.length;
        }
    }
    // 2. Monologue traces
    if (Array.isArray(result.monologue) && result.monologue.length > 0) {
        for (const entry of result.monologue.slice(0, 5)) {
            if (!entry.category || !entry.content)
                continue;
            counts.monologue++;
            writeOps.push((async () => {
                let emb = null;
                if (embeddings.isAvailable()) {
                    try {
                        emb = await embeddings.embed(entry.content);
                    }
                    catch (e) {
                        swallow("daemon:embedMonologue", e);
                    }
                }
                await store.createMonologue(sessionId, entry.category, entry.content, emb);
            })());
        }
    }
    // 3. Resolved memories
    if (Array.isArray(result.resolved) && result.resolved.length > 0) {
        writeOps.push((async () => {
            for (const memId of result.resolved.slice(0, 20)) {
                if (typeof memId !== "string" || !memoryIdRe.test(memId))
                    continue;
                assertRecordId(memId);
                counts.resolved++;
                // Direct interpolation safe: assertRecordId validates format above
                await store.queryExec(`UPDATE ${memId} SET status = 'resolved', resolved_at = time::now(), resolved_by = $sid`, { sid: sessionId }).catch(e => swallow.warn("daemon:resolveMemory", e));
            }
        })());
    }
    // 4. Corrections — high-importance memories, linked to LLM-extracted concepts
    if (Array.isArray(result.corrections) && result.corrections.length > 0) {
        for (const c of result.corrections.slice(0, 5)) {
            if (!c.original || !c.correction)
                continue;
            counts.correction++;
            const text = `[CORRECTION] Original: "${String(c.original).slice(0, 200)}" -> Corrected: "${String(c.correction).slice(0, 200)}" (Context: ${String(c.context ?? "").slice(0, 100)})`;
            writeOps.push((async () => {
                let emb = null;
                if (embeddings.isAvailable()) {
                    try {
                        emb = await embeddings.embed(text);
                    }
                    catch (e) {
                        swallow("daemon:embedCorrection", e);
                    }
                }
                const memId = await store.createMemory(text, emb, 9, "correction", sessionId, projectId);
                if (memId) {
                    await linkToRelevantConcepts(memId, "about_concept", text, store, embeddings, "daemon:correction:about_concept", 5, 0.65, emb);
                }
            })());
        }
    }
    // 5. User preferences
    if (Array.isArray(result.preferences) && result.preferences.length > 0) {
        for (const p of result.preferences.slice(0, 5)) {
            if (!p.preference)
                continue;
            counts.preference++;
            const text = `[USER PREFERENCE] ${String(p.preference).slice(0, 250)} (Evidence: ${String(p.evidence ?? "").slice(0, 150)})`;
            writeOps.push((async () => {
                let emb = null;
                if (embeddings.isAvailable()) {
                    try {
                        emb = await embeddings.embed(text);
                    }
                    catch (e) {
                        swallow("daemon:embedPreference", e);
                    }
                }
                const memId = await store.createMemory(text, emb, 7, "preference", sessionId, projectId);
                if (memId) {
                    await linkToRelevantConcepts(memId, "about_concept", text, store, embeddings, "daemon:preference:about_concept", 5, 0.65, emb);
                }
            })());
        }
    }
    // 6. Artifacts
    if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
        for (const a of result.artifacts.slice(0, 10)) {
            if (!a.path)
                continue;
            if (priorState.artifactPaths.includes(a.path))
                continue;
            counts.artifact++;
            priorState.artifactPaths.push(a.path);
            const desc = `${String(a.action ?? "modified")}: ${String(a.summary ?? "").slice(0, 200)}`;
            writeOps.push((async () => {
                let emb = null;
                if (embeddings.isAvailable()) {
                    try {
                        emb = await embeddings.embed(`${a.path} ${desc}`);
                    }
                    catch (e) {
                        swallow("daemon:embedArtifact", e);
                    }
                }
                const artId = await store.createArtifact(a.path, a.action ?? "modified", desc, emb, projectId);
                if (artId) {
                    await linkToRelevantConcepts(artId, "artifact_mentions", `${a.path} ${desc}`, store, embeddings, "daemon:artifact:artifact_mentions", 5, 0.65, emb);
                    // used_in: artifact → project
                    if (projectId) {
                        await store.relate(artId, "used_in", projectId)
                            .catch(e => swallow("daemon:artifact:used_in", e));
                    }
                }
            })());
        }
    }
    // 7. Decisions
    if (Array.isArray(result.decisions) && result.decisions.length > 0) {
        for (const d of result.decisions.slice(0, 6)) {
            if (!d.decision)
                continue;
            counts.decision++;
            const text = `[DECISION] ${String(d.decision).slice(0, 200)} — Rationale: ${String(d.rationale ?? "").slice(0, 200)} (Alternatives: ${String(d.alternatives_considered ?? "none").slice(0, 100)})`;
            writeOps.push((async () => {
                let emb = null;
                if (embeddings.isAvailable()) {
                    try {
                        emb = await embeddings.embed(text);
                    }
                    catch (e) {
                        swallow("daemon:embedDecision", e);
                    }
                }
                const memId = await store.createMemory(text, emb, 7, "decision", sessionId, projectId);
                if (memId) {
                    await linkToRelevantConcepts(memId, "about_concept", text, store, embeddings, "daemon:decision:about_concept", 5, 0.65, emb);
                }
            })());
        }
    }
    // 8. Skills — get ID back to create skill_from_task + skill_uses_concept edges
    if (Array.isArray(result.skills) && result.skills.length > 0) {
        for (const s of result.skills.slice(0, 3)) {
            if (!s.name || !Array.isArray(s.steps) || s.steps.length === 0)
                continue;
            if (priorState.skillNames.includes(s.name))
                continue;
            counts.skill++;
            priorState.skillNames.push(s.name);
            const content = `${s.name}\nTrigger: ${String(s.trigger_context ?? "").slice(0, 150)}\nSteps:\n${s.steps.map((st, i) => `${i + 1}. ${String(st).slice(0, 200)}`).join("\n")}`;
            writeOps.push((async () => {
                let emb = null;
                if (embeddings.isAvailable()) {
                    try {
                        emb = await embeddings.embed(content);
                    }
                    catch (e) {
                        swallow("daemon:embedSkill", e);
                    }
                }
                try {
                    const rows = await store.queryFirst(`CREATE skill CONTENT $record RETURN id`, {
                        record: {
                            name: String(s.name).slice(0, 100),
                            description: content,
                            content,
                            steps: s.steps.map((st) => String(st).slice(0, 200)),
                            trigger_context: String(s.trigger_context ?? "").slice(0, 200),
                            tags: ["auto-extracted"],
                            session_id: sessionId,
                            ...(projectId ? { project_id: projectId } : {}),
                            ...(emb ? { embedding: emb } : {}),
                        },
                    });
                    const skillId = rows[0]?.id ? String(rows[0].id) : null;
                    if (skillId) {
                        // skill_from_task: skill → task
                        if (taskId) {
                            await store.relate(skillId, "skill_from_task", taskId)
                                .catch(e => swallow.warn("daemon:skill:skill_from_task", e));
                        }
                        // skill_uses_concept: skill → concept
                        await linkToRelevantConcepts(skillId, "skill_uses_concept", content, store, embeddings, "daemon:skill:concepts", 5, 0.65, emb);
                        if (emb?.length) {
                            await supersedeOldSkills(skillId, emb, store)
                                .catch(e => swallow.warn("daemon:skill:supersede", e));
                        }
                    }
                }
                catch (e) {
                    swallow.warn("daemon:createSkill", e);
                }
            })());
        }
    }
    await Promise.allSettled(writeOps);
    return counts;
}
