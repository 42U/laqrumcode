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

import type { GlobalPluginState, SessionState } from "../engine/state.js";
import type { PriorExtractions, TurnData } from "../engine/daemon-types.js";
import { validateExtraction } from "../engine/daemon-types.js";
import { buildCoalescedPrompt, buildTranscript, writeExtractionResults } from "../engine/memory-daemon.js";
import { createSoul, seedSoulAsCoreMemory, reviseSoul, getSoul, checkGraduation, getQualitySignals, recordGraduationEvent } from "../engine/soul.js";
import { swallow } from "../engine/errors.js";
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
function serializeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e ?? "unknown");
  const seen = new WeakSet<object>();
  seen.add(e);
  let out = e.message;
  let cur: unknown = (e as { cause?: unknown }).cause;
  let depth = 0;
  let truncated = false;
  while (cur instanceof Error && !seen.has(cur) && depth < 8) {
    seen.add(cur);
    out += ` | caused by: ${cur.message}`;
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  if ((cur instanceof Error && depth >= 8) || (cur && typeof cur === "object" && seen.has(cur as object))) {
    truncated = true;
  }
  if (truncated) out += " | (chain truncated)";
  if (out.length > 4096) out = out.slice(0, 4093) + "...";
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingWorkItem {
  id: string;
  work_type: string;
  session_id: string;
  surreal_session_id?: string;
  task_id?: string;
  project_id?: string;
  payload?: Record<string, unknown>;
  priority: number;
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

export async function handleFetchPendingWork(
  state: GlobalPluginState,
  _session: SessionState,
  _args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
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
      const stuck = await store.queryFirst<{ id: string; session_id: string; work_type: string }>(
        `SELECT id, session_id, work_type FROM pending_work
           WHERE status = "processing" AND created_at < time::now() - 10m
           ORDER BY created_at ASC`,
      );
      for (const row of stuck as { id: string; session_id: string; work_type: string }[]) {
        try {
          assertRecordId(String(row.id));
          // BEGIN/COMMIT around the (sibling-check + DELETE-or-UPDATE) so the
          // check-and-act is atomic. The sibling SELECT is unfiltered by
          // status (widened in v0.7.75 from "pending"-only): any other row
          // for the same (session_id, work_type) triggers DELETE of the
          // stuck row. AND id != ${row.id} excludes self from the check so
          // we don't see ourselves as our own sibling.
          await store.queryExec(
            `BEGIN TRANSACTION;
             LET $siblings = (SELECT id FROM pending_work
               WHERE session_id = $sid AND work_type = $wt AND id != ${row.id} LIMIT 1);
             IF array::len($siblings) > 0 THEN
               DELETE ${row.id}
             ELSE
               UPDATE ${row.id} SET status = "pending"
             END;
             COMMIT TRANSACTION;`,
            { sid: row.session_id, wt: row.work_type },
          );
        } catch (e) { swallow.warn("pending-work:stale-recovery-row", e); }
      }
    } catch (e) { swallow.warn("pending-work:stale-recovery", e); }

    // Claim the highest-priority pending item. SELECT-then-conditional-UPDATE:
    // the WHERE status="pending" on the UPDATE acts as an optimistic lock so
    // concurrent claimers don't double-process the same item.
    const candidates = await store.queryFirst<{ id: string }>(
      `SELECT id FROM pending_work WHERE status = "pending" ORDER BY priority ASC, created_at ASC LIMIT 3`,
    );
    if (candidates.length === 0) {
      return text(JSON.stringify({ empty: true, message: "No pending work items. You are done." }));
    }

    let item: PendingWorkItem | null = null;
    for (const candidate of candidates) {
      const claimedId = String(candidate.id);
      assertRecordId(claimedId);
      // Direct interpolation safe: assertRecordId validates format above.
      // WHERE status="pending" ensures only the first claimer wins the race.
      const items = await store.queryFirst<PendingWorkItem>(
        `UPDATE ${claimedId} SET status = "processing" WHERE status = "pending" RETURN AFTER`,
      );
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
    return text(JSON.stringify(result));
  } catch (e) {
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
 */
async function markTerminal(
  state: GlobalPluginState,
  workId: string,
  sessionId: string,
  workType: string,
  status: "completed" | "failed",
): Promise<void> {
  assertRecordId(workId);
  await state.store.queryExec(
    `BEGIN TRANSACTION;
     LET $siblings = (SELECT id FROM pending_work
       WHERE session_id = $sid AND work_type = $wt AND status = $st AND id != ${workId} LIMIT 1);
     IF array::len($siblings) > 0 THEN
       DELETE ${workId}
     ELSE
       UPDATE ${workId} SET status = $st, completed_at = time::now()
     END;
     COMMIT TRANSACTION;`,
    { sid: sessionId, wt: workType, st: status },
  );
}

async function buildWorkPayload(
  item: PendingWorkItem,
  state: GlobalPluginState,
): Promise<Record<string, unknown>> {
  const { store } = state;

  switch (item.work_type) {
    case "coalesced_extraction": {
      const payload = (item.payload ?? {}) as { turn_count?: number; include_handoff?: boolean; include_reflection?: boolean };
      const turns: TurnData[] = await store.getSessionTurnsRich(item.session_id, 50);
      const transcript = buildTranscript(turns);
      const prior: PriorExtractions = { conceptNames: [], artifactPaths: [], skillNames: [] };
      const instructions = buildCoalescedPrompt(
        false, false, prior,
        payload.include_handoff ?? true,
        payload.include_reflection ?? false,
      );
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
      const groups = await store.queryFirst<{ chain_type: string; cnt: number; descriptions: string[] }>(
        `SELECT chain_type, count() AS cnt, array::group(description) AS descriptions
         FROM causal_chain WHERE success = true AND confidence >= 0.7
         GROUP BY chain_type`,
      );
      const eligible = groups.filter(g => g.cnt >= 3);
      if (eligible.length === 0) {
        // No chains to graduate — mark complete immediately
        await markTerminal(state, item.id, item.session_id, item.work_type, "completed");
        return { work_id: item.id, work_type: "causal_graduate", empty: true, message: "No causal chains ready for graduation. Already marked complete." };
      }
      return {
        work_id: item.id,
        work_type: "causal_graduate",
        instructions: `Synthesize reusable procedures from these recurring successful patterns. Generic — no specific file paths or variable names. Return one skill JSON per pattern group.`,
        data: { groups: eligible.map(g => ({ chain_type: g.chain_type, count: g.cnt, descriptions: g.descriptions.slice(0, 8) })) },
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
        store.queryFirst<{ text: string; category: string }>(`SELECT text, category FROM reflection ORDER BY created_at DESC LIMIT 15`).catch(() => []),
        store.queryFirst<{ description: string; chain_type: string }>(`SELECT description, chain_type FROM causal_chain ORDER BY created_at DESC LIMIT 10`).catch(() => []),
        store.queryFirst<{ content: string }>(`SELECT content FROM monologue ORDER BY timestamp DESC LIMIT 10`).catch(() => []),
      ]);
      const quality = await getQualitySignals(store);
      return {
        work_id: item.id,
        work_type: "soul_generate",
        instructions: `You are KongCode, a graph-backed coding agent with persistent memory. Based on YOUR OWN memory graph data below, write your initial Soul document. Be honest, not aspirational. Only claim what the data supports.`,
        data: {
          reflections: (reflections as any[]).map(r => `[${r.category}] ${r.text}`),
          causal_chains: (causalChains as any[]).map(c => `[${c.chain_type}] ${c.description}`),
          monologues: (monologues as any[]).map(m => m.content),
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
        store.queryFirst<{ text: string }>(`SELECT text FROM reflection WHERE created_at > $since ORDER BY created_at DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
        store.queryFirst<{ description: string }>(`SELECT description FROM causal_chain WHERE created_at > $since ORDER BY created_at DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
        store.queryFirst<{ content: string }>(`SELECT content FROM monologue WHERE timestamp > $since ORDER BY timestamp DESC LIMIT 10`, { since: soul.updated_at }).catch(() => []),
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
          new_reflections: (reflections as any[]).map(r => r.text),
          new_causal_chains: (causalChains as any[]).map(c => c.description),
          new_monologues: (monologues as any[]).map(m => m.content),
        },
        output_format: "Return JSON with ONLY changed fields from the soul schema. Return {} if nothing changed.",
      };
    }

    default: {
      assertRecordId(item.id); await store.queryExec(`UPDATE ${item.id} SET status = "completed", completed_at = time::now()`);
      return { work_id: item.id, work_type: item.work_type, empty: true, message: `Unknown work type: ${item.work_type}` };
    }
  }
}

// ── commit_work_results ──────────────────────────────────────────────────────

export async function handleCommitWorkResults(
  state: GlobalPluginState,
  _session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { store, embeddings } = state;
  const workId = String(args.work_id ?? "");
  const results = args.results as Record<string, unknown> | string | undefined;

  if (!workId) return text("Error: work_id is required");
  if (!store.isAvailable()) return text("Error: database unavailable");

  // Look up the work item to know what type it is
  assertRecordId(workId);
  const items = await store.queryFirst<PendingWorkItem>(
    `SELECT * FROM ${workId}`,
  );
  if (items.length === 0) return text(`Error: work item not found: ${workId}`);

  const item = items[0];

  try {
    const outcome = await commitResults(item, results, state);
    // Mark completed. Uses markTerminal so a sibling completed row for the
    // same (session, work_type) doesn't collide on pw_session_worktype_status_unique;
    // in that case this row is DELETEd instead.
    await markTerminal(state, workId, item.session_id, item.work_type, "completed");
    log.info(`[pending_work] Completed ${item.work_type} (${workId})`);
    return text(JSON.stringify({ success: true, work_type: item.work_type, ...outcome }));
  } catch (e) {
    // Mark failed. Uses markTerminal so a sibling failed row for the same
    // (session, work_type) doesn't collide on pw_session_worktype_status_unique;
    // in that case this row is DELETEd instead. If markTerminal itself fails
    // (e.g. DB unreachable), the row stays in "processing" until stale-recovery
    // catches it. Surface the failure to logs so it's not silently lost.
    await markTerminal(state, workId, item.session_id, item.work_type, "failed")
      .catch(e => swallow.warn("pending-work:mark-failed", e));
    log.error(`[pending_work] Failed ${item.work_type} (${workId}):`, e);
    return text(JSON.stringify({ success: false, error: serializeError(e) }));
  }
}

function computeCurationScore(transcript: string, turnToolNames: string[] = []): number {
  const recallInText = /\b(recall|mcp__\w+__recall)\b/gi.test(transcript);
  const saveInText = /\b(record_finding|create_knowledge_gems|supersede|core_memory|mcp__\w+__(record_finding|create_knowledge_gems|supersede|core_memory))\b/gi.test(transcript);
  const citations = /\[#\d+\]/g.test(transcript);

  const toolNameStr = turnToolNames.join(" ").toLowerCase();
  const recallInTools = toolNameStr.includes("recall");
  const saveInTools = /record_finding|create_knowledge_gems|supersede|core_memory/.test(toolNameStr);

  let score = 0;
  if (citations) score += 0.4;
  if (recallInText || recallInTools) score += 0.3;
  if (saveInText || saveInTools) score += 0.3;
  return Math.min(1, score);
}

async function commitHandoffNote(
  noteText: string,
  item: PendingWorkItem,
  state: GlobalPluginState,
): Promise<void> {
  const { store, embeddings } = state;
  let noteEmb: number[] | null = null;
  if (embeddings.isAvailable()) {
    try { noteEmb = await embeddings.embed(noteText); } catch { /* ok */ }
  }
  const record: Record<string, unknown> = {
    text: noteText,
    category: "handoff",
    importance: 8,
    source: `session:${item.session_id}`,
    session_id: item.session_id,
  };
  if (item.project_id) record.project_id = item.project_id;
  if (noteEmb?.length) record.embedding = noteEmb;
  const memRows = await store.queryFirst<{ id: string }>(`CREATE memory CONTENT $record RETURN id`, { record });
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
    } catch (e) { swallow("handoff:promote", e); }
  }
}

// Reflection writer migrated in v0.7.76 to commitKnowledge({ kind: "reflection" }).
// The canonical regex filter set lives in src/engine/reflection-filter.ts; the
// row creation, dedup, edge seal, and cache invalidation live in
// src/engine/commit.ts. This wrapper just adapts the existing PendingWorkItem
// shape to the new CommitKnowledge API.

async function commitReflection(
  reflText: string,
  item: PendingWorkItem,
  state: GlobalPluginState,
): Promise<void> {
  // Without a SurrealDB session record id, commitKnowledge would refuse the
  // write (the v0.7.76 architectural anchor closing the orphan-reflection bug
  // class). Skip rather than throw — this matches the prior behavior of
  // pending-work.ts where missing surreal_session_id meant the edge was simply
  // not wired and the row went through.
  if (!item.surreal_session_id) return;
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

async function commitResults(
  item: PendingWorkItem,
  results: Record<string, unknown> | string | undefined,
  state: GlobalPluginState,
): Promise<Record<string, unknown>> {
  const { store, embeddings } = state;

  switch (item.work_type) {
    case "coalesced_extraction": {
      if (typeof results === "string") {
        try { results = JSON.parse(results); } catch {
          const match = (results as string).match(/\{[\s\S]*\}/);
          if (match) results = JSON.parse(match[0]);
          else throw new Error("Could not parse extraction JSON");
        }
      }
      const { data: validated, errors: schemaErrors } = validateExtraction(results);
      if (schemaErrors.length > 0) {
        log.warn(`[pending_work] extraction schema violations (${schemaErrors.length}): ${schemaErrors.slice(0, 5).join("; ")}`);
      }
      const extractionData = schemaErrors.length === 0 ? validated : (results as Record<string, any>);
      const prior: PriorExtractions = { conceptNames: [], artifactPaths: [], skillNames: [] };
      const counts = await writeExtractionResults(
        extractionData as Record<string, any>,
        item.session_id,
        store,
        embeddings,
        prior,
        item.task_id,
        item.project_id,
      );
      if (item.work_type === "coalesced_extraction") {
        const parsed = extractionData as Record<string, any>;
        if (typeof parsed.handoff_note === "string" && parsed.handoff_note.length >= 20) {
          await commitHandoffNote(parsed.handoff_note, item, state);
        }
        if (typeof parsed.reflection === "string" && parsed.reflection.length >= 20 && parsed.reflection.toLowerCase().trim() !== "skip") {
          await commitReflection(parsed.reflection, item, state);
        }

        // Three-bucket scoring: backfill rules_compliance + curation on turn_score rows
        const rulesCompliance = typeof parsed.rules_compliance === "number"
          ? clamp01(parsed.rules_compliance)
          : 0.7;

        // Re-fetch transcript for curation analysis (not stored on work item)
        const curationTurns: TurnData[] = await store.getSessionTurnsRich(item.session_id, 50).catch(() => [] as TurnData[]);
        const curationTranscript = buildTranscript(curationTurns);
        const toolNames = curationTurns.map(t => t.tool_name ?? "").filter(Boolean);
        const curation = computeCurationScore(curationTranscript, toolNames);

        // Compute composite in JS (avoids SurrealQL IF/THEN/ELSE risk) and write scalar values
        const sid = item.session_id;
        const turnScoreRows = await store.queryFirst<{ id: string; context_util: number | null }>(
          `SELECT id, context_util FROM turn_score WHERE session_id = $sid`,
          { sid },
        ).catch(() => []);

        for (const row of turnScoreRows as { id: string; context_util: number | null }[]) {
          const cu = row.context_util != null ? row.context_util : 0;
          const cuWeight = row.context_util != null ? 0.3 : 0;
          const composite = (0.6 * rulesCompliance) + (cuWeight * cu) + (0.1 * curation);
          try {
            assertRecordId(String(row.id));
            await store.queryExec(
              `UPDATE ${row.id} SET rules_compliance = $rc, curation = $cur, composite = $comp`,
              { rc: rulesCompliance, cur: curation, comp: composite },
            );
          } catch (e) { swallow("pending-work:turnScoreUpdate", e); }
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
      return { skills_created: created };
    }

    case "soul_generate": {
      const doc = parseSoulResult(results);
      if (!doc) throw new Error("Invalid soul document JSON");
      const now = new Date().toISOString();
      const soulDoc = {
        working_style: (doc.working_style ?? []).filter((s: unknown) => typeof s === "string").slice(0, 20),
        emotional_dimensions: (doc.emotional_dimensions ?? []).map((d: any) => ({
          dimension: String(d.dimension ?? d.name ?? ""),
          description: String(d.description ?? d.rationale ?? ""),
          adopted_at: now,
        })).filter((d: any) => d.dimension).slice(0, 10),
        self_observations: (doc.self_observations ?? []).filter((s: unknown) => typeof s === "string").slice(0, 20),
        earned_values: (doc.earned_values ?? []).map((v: any) => ({
          value: String(v.value ?? v.name ?? ""),
          grounded_in: String(v.grounded_in ?? v.evidence ?? v.description ?? ""),
        })).filter((v: any) => v.value).slice(0, 10),
      };
      const success = await createSoul(soulDoc, store);
      if (!success) throw new Error("Failed to create soul record");
      const soul = await getSoul(store);
      if (soul) await seedSoulAsCoreMemory(soul, store);
      const report = await checkGraduation(store);
      await recordGraduationEvent(store, report);
      log.info("[GRADUATION] Soul created by subagent!");
      return { graduated: true };
    }

    case "soul_evolve": {
      const changes = parseSoulResult(results);
      if (!changes || Object.keys(changes).length === 0) return { skipped: true, reason: "no changes" };
      const now = new Date().toISOString();
      const sanitized: Record<string, unknown[]> = {
        working_style: (changes.working_style ?? []).filter((s: unknown) => typeof s === "string"),
        emotional_dimensions: (changes.emotional_dimensions ?? []).map((d: any) => ({
          dimension: String(d.dimension ?? d.name ?? ""),
          description: String(d.description ?? d.rationale ?? ""),
          adopted_at: now,
        })).filter((d: any) => d.dimension),
        self_observations: (changes.self_observations ?? []).filter((s: unknown) => typeof s === "string"),
        earned_values: (changes.earned_values ?? []).map((v: any) => ({
          value: String(v.value ?? v.name ?? ""),
          grounded_in: String(v.grounded_in ?? v.evidence ?? v.description ?? ""),
        })).filter((v: any) => v.value),
      };
      let revised = 0;
      for (const section of ["working_style", "emotional_dimensions", "self_observations", "earned_values"] as const) {
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

// ── create_knowledge_gems ────────────────────────────────────────────────────
// Direct-write path for structured knowledge extracted from external sources
// (PDFs, articles, docs). Bypasses the pending_work queue because there is no
// session transcript — the source is a document and the "extraction" happens
// in a foreground conversation.
//
// Each gem becomes a `concept` record. An `artifact` record is created for
// the source, and every gem gets a `derived_from` edge to the source artifact.
// `links` create named edges between gems (by gem name — resolved to record
// id via the concept id map built during gem creation).

interface GemInput {
  name: string;        // short identifier, used for link resolution
  content: string;     // the actual insight text (embedded + stored on concept)
  importance?: number; // 1-10, defaults to 7
}

interface GemLink {
  from: string;   // gem name
  to: string;     // gem name
  // Relation name. Must be one of the schema-defined concept→concept edges:
  //   "broader"   — from is a broader concept than to (parent of)
  //   "narrower"  — from is narrower than to (child of)
  //   "related_to" — from and to are related but not hierarchical
  // Other edge names are silently dropped because there's no schema table
  // for them. If you need a new relation type, define it in schema.surql.
  edge: "broader" | "narrower" | "related_to";
}

const VALID_GEM_EDGES = new Set<string>(["broader", "narrower", "related_to"]);

export async function handleCreateKnowledgeGems(
  state: GlobalPluginState,
  session: SessionState,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { store, embeddings } = state;

  if (!store.isAvailable()) return text("Error: database unavailable");

  const source = String(args.source ?? "").trim();
  const sourceType = String(args.source_type ?? "document").trim();
  const sourceDescription = String(args.source_description ?? "").trim();
  const gems = Array.isArray(args.gems) ? (args.gems as GemInput[]) : [];
  const links = Array.isArray(args.links) ? (args.links as GemLink[]) : [];

  if (!source) return text("Error: source is required");
  if (gems.length === 0) return text("Error: at least one gem is required");

  try {
    // 1. Create artifact for the source document via commitKnowledge so the
    //    artifact auto-seals artifact_mentions edges to the concept graph.
    const { id: artifactId } = await commitKnowledge(
      { store, embeddings },
      {
        kind: "artifact",
        path: source,
        type: sourceType,
        description: sourceDescription || source,
      },
    );

    // 2. Create each gem as a concept, build name -> id map
    const nameToId = new Map<string, string>();
    const conceptIds: string[] = [];
    let skipped = 0;

    for (const gem of gems) {
      if (!gem?.name || !gem?.content) {
        skipped++;
        continue;
      }
      const cleanContent = stripStructuralTags(gem.content);
      let gemEmb: number[] | null = null;
      if (embeddings.isAvailable()) {
        try { gemEmb = await embeddings.embed(cleanContent); } catch { /* ok */ }
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
    const edgeFailures: Array<{ from: string; to: string; edge: string; reason: string }> = [];
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
      const added = await linkConceptCrossLink({ store, embeddings }, fromId, toId, link.edge as "broader" | "narrower" | "related_to");
      if (added > 0) {
        edgesCreated++;
      } else {
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
  } catch (e) {
    log.error("[gems] failed:", e);
    return text(JSON.stringify({ success: false, error: serializeError(e) }));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function text(s: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: s }] };
}

interface ExtractedSkill {
  name: string;
  description: string;
  preconditions?: string;
  steps: { tool: string; description: string }[];
  postconditions?: string;
}

/** 0.7.32: trace why a parser drop happened. Truncates payload preview to
 *  300 chars and tags with the specific reason so a daemon-log scan can
 *  retroactively answer "why did skills_created return 0?". */
function tracedrop(reason: string, payload: unknown): void {
  let preview: string;
  try {
    preview = typeof payload === "string"
      ? payload.slice(0, 300)
      : JSON.stringify(payload).slice(0, 300);
  } catch {
    preview = "<unserializable>";
  }
  log.warn(`[graduation-parser] drop reason=${reason} payload=${preview}`);
}

/** 0.7.32: shared name + steps coercion logic, used by both single-skill
 *  and causal-graduate paths. Subagents emit varied shapes — accept any
 *  reasonable name alias and coerce string-array steps to {tool,
 *  description} objects rather than dropping the row entirely. */
function coerceSkill(parsed: any, traceTag: string): ExtractedSkill | null {
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
  const steps = parsed.steps.map((s: any) => {
    if (typeof s === "string") return { tool: "unknown", description: s };
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

function parseSkillResult(results: unknown): ExtractedSkill | null {
  let parsed: any;
  if (typeof results === "string") {
    if (results.trim() === "null" || results.trim() === "None") return null;
    try { parsed = JSON.parse(results); } catch {
      const match = results.match(/\{[\s\S]*\}/);
      if (!match) {
        tracedrop("skill:json-parse-failed", results);
        return null;
      }
      try { parsed = JSON.parse(match[0]); } catch {
        tracedrop("skill:json-parse-failed", match[0]);
        return null;
      }
    }
  } else {
    parsed = results;
  }
  return coerceSkill(parsed, "skill");
}

function parseCausalGraduationResult(results: unknown): ExtractedSkill[] {
  // 0.7.32: tolerant unwrap. Subagents may emit a top-level array (canonical),
  // a wrapped object {skills: [...]} or {result: [...]}, or a single skill
  // object instead of a batch. Accept all shapes; only return [] when
  // truly nothing skill-shaped is present, with a trace line each time.
  let arr: unknown[];
  let parsed: unknown = results;

  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch {
      const match = (parsed as string).match(/\[[\s\S]*\]/);
      if (!match) {
        tracedrop("causal_graduate:json-parse-failed", parsed);
        return [];
      }
      try { parsed = JSON.parse(match[0]); } catch {
        tracedrop("causal_graduate:json-parse-failed", match[0]);
        return [];
      }
    }
  }

  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    // Try common wrapper keys before falling through.
    const obj = parsed as Record<string, unknown>;
    const wrapped = obj.skills ?? obj.result ?? obj.extracted ?? obj.items ?? obj.data;
    if (Array.isArray(wrapped)) {
      arr = wrapped;
    } else if (obj.name && Array.isArray(obj.steps)) {
      // Single-skill object (subagent submitted one instead of a batch).
      arr = [obj];
    } else {
      tracedrop("causal_graduate:not-an-array", obj);
      return [];
    }
  } else {
    tracedrop("causal_graduate:not-an-object", parsed);
    return [];
  }

  return arr.map(item => coerceSkill(item, "causal_graduate")).filter((s): s is ExtractedSkill => s !== null);
}

function parseSoulResult(results: unknown): Record<string, any> | null {
  if (typeof results === "string") {
    try { return JSON.parse(results); } catch {
      const match = results.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { return JSON.parse(match[0]); } catch { return null; }
    }
  }
  return (results && typeof results === "object") ? results as Record<string, any> : null;
}

async function createSkillRecord(
  parsed: ExtractedSkill,
  item: PendingWorkItem,
  state: GlobalPluginState,
): Promise<Record<string, unknown>> {
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
