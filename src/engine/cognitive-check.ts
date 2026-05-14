/**
 * Cognitive Check — Periodic reasoning over retrieved context.
 *
 * Fires every few turns to evaluate what was retrieved, produce behavioral
 * directives for the next turn, and grade retrieval quality with LLM-judged
 * relevance scores that feed back into ACAN training.
 *
 * Ported from kongbrain — per-session state via WeakMap, takes SurrealStore param.
 */

import type { SessionState } from "./state.js";
import { clamp01 } from "./math.js";

// --- Types ---

export interface CognitiveDirective {
  type: "repeat" | "continuation" | "contradiction" | "noise" | "insight";
  target: string;
  instruction: string;
  priority: "high" | "medium" | "low";
}

export interface RetrievalGrade {
  id: string;
  relevant: boolean;
  reason: string;
  score: number;
  learned: boolean;
  resolved: boolean;
}

export interface UserPreference {
  observation: string;
  confidence: "high" | "medium";
}

export interface CognitiveCheckResult {
  directives: CognitiveDirective[];
  grades: RetrievalGrade[];
  sessionContinuity: "continuation" | "repeat" | "new_topic" | "tangent";
  preferences: UserPreference[];
}

export interface CognitiveCheckInput {
  sessionId: string;
  userQuery: string;
  responseText: string;
  retrievedNodes: { id: string; text: string; score: number; table: string }[];
  recentTurns: { role: string; text: string }[];
}

// --- Per-session state ---

interface CognitiveState {
  pendingDirectives: CognitiveDirective[];
  sessionContinuity: string;
  checkInFlight: boolean;
  suppressedNodeIds: Set<string>;
}

const sessionState = new WeakMap<SessionState, CognitiveState>();

function getState(session: SessionState): CognitiveState {
  let state = sessionState.get(session);
  if (!state) {
    state = {
      pendingDirectives: [],
      sessionContinuity: "new_topic",
      checkInFlight: false,
      suppressedNodeIds: new Set(),
    };
    sessionState.set(session, state);
  }
  return state;
}

// --- Constants ---

const DIRECTIVE_TYPES = new Set(["repeat", "continuation", "contradiction", "noise", "insight"]);
const PRIORITIES = new Set(["high", "medium", "low"]);
const CONTINUITY_TYPES = new Set(["continuation", "repeat", "new_topic", "tangent"]);
const VALID_RECORD_ID = /^[a-z_]+:[a-zA-Z0-9_]+$/;

// --- Public API ---

/** Returns true on turn 2, then every 5 turns (2, 7, 12, 17...). False if in-flight or retrieval skipped. */
export function shouldRunCheck(turnCount: number, session: SessionState): boolean {
  const state = getState(session);
  if (state.checkInFlight) return false;
  if (turnCount < 2) return false;
  // Skip when retrieval is disabled — no context to evaluate
  if (session.currentConfig?.skipRetrieval) return false;
  return turnCount === 2 || (turnCount - 2) % 5 === 0;
}

export function getPendingDirectives(session: SessionState): CognitiveDirective[] {
  return getState(session).pendingDirectives;
}

export function clearPendingDirectives(session: SessionState): void {
  getState(session).pendingDirectives = [];
}

export function getSessionContinuity(session: SessionState): string {
  return getState(session).sessionContinuity;
}

export function getSuppressedNodeIds(session: SessionState): ReadonlySet<string> {
  return getState(session).suppressedNodeIds;
}

/**
 * Cognitive check is now handled by the subagent-driven pending_work pipeline
 * (commit_work_results tool). The in-line runCognitiveCheck() function was
 * left as an empty no-op shim through the 0.4.x ports; this comment is the
 * gravestone. Pending-work scheduling lives in the daemon/MCP layer — search
 * for `cognitive_check` work_type and `commit_work_results`. The hook in
 * context-engine.ts (afterTurn) was removed because the no-op shim was
 * misleading: it suggested in-line cognitive checks were still firing.
 */

// --- Response parsing ---

export function parseCheckResponse(text: string): CognitiveCheckResult | null {
  // Strip markdown fences if present
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "");
  const jsonMatch = stripped.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  let raw: any;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    try {
      raw = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, "$1"));
    } catch { return null; }
  }

  // Validate directives
  const directives: CognitiveDirective[] = [];
  if (Array.isArray(raw.directives)) {
    for (const d of raw.directives.slice(0, 3)) {
      if (!d.type || !d.target || !d.instruction) continue;
      if (!DIRECTIVE_TYPES.has(d.type)) continue;
      directives.push({
        type: d.type,
        target: String(d.target).slice(0, 100),
        instruction: String(d.instruction).slice(0, 200),
        priority: PRIORITIES.has(d.priority) ? d.priority : "medium",
      });
    }
  }

  // Validate grades
  const grades: RetrievalGrade[] = [];
  if (Array.isArray(raw.grades)) {
    for (const g of raw.grades.slice(0, 30)) {
      if (!g.id || typeof g.relevant !== "boolean") continue;
      if (!VALID_RECORD_ID.test(g.id)) continue;
      grades.push({
        id: String(g.id),
        relevant: Boolean(g.relevant),
        reason: String(g.reason ?? "").slice(0, 150),
        score: clamp01(Number(g.score) || 0),
        learned: g.learned === true,
        resolved: g.resolved === true,
      });
    }
  }

  // Validate preferences
  const preferences: UserPreference[] = [];
  if (Array.isArray(raw.preferences)) {
    for (const p of raw.preferences.slice(0, 2)) {
      if (!p.observation) continue;
      if (p.confidence !== "high" && p.confidence !== "medium") continue;
      preferences.push({
        observation: String(p.observation).slice(0, 200),
        confidence: p.confidence,
      });
    }
  }

  const sessionContinuity = CONTINUITY_TYPES.has(raw.sessionContinuity)
    ? raw.sessionContinuity
    : "new_topic";

  return { directives, grades, sessionContinuity, preferences };
}

// applyRetrievalGrades() was removed when the in-line cognitive-check LLM
// call was retired. Grade application now happens inside the pending_work
// pipeline's commit_work_results handler, which has its own UPDATE-on-
// retrieval_outcome path. Removing this stub eliminated the only consumer
// of CognitiveCheckInput.* — see pending-work.ts for the live equivalent.
