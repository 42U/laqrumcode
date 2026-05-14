/**
 * Shared types for the memory daemon system.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface TurnData {
  role: string;
  text: string;
  turnId?: string;
  tool_name?: string;
  tool_result?: string;
  file_paths?: string[];
}

/** Previously extracted item names for dedup across daemon runs. */
export interface PriorExtractions {
  conceptNames: string[];
  artifactPaths: string[];
  skillNames: string[];
}

// ── TypeBox schemas for extraction output validation ──────────────────────

const CausalSchema = Type.Object({
  triggerText: Type.String(),
  outcomeText: Type.String(),
  chainType: Type.String(),
  success: Type.Boolean(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  description: Type.Optional(Type.String()),
});

const MonologueSchema = Type.Object({
  category: Type.String(),
  content: Type.String(),
});

const ConceptSchema = Type.Object({
  name: Type.String(),
  content: Type.String(),
  category: Type.Optional(Type.String()),
  importance: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  searchTerms: Type.Optional(Type.Array(Type.String())),
});

const CorrectionSchema = Type.Object({
  original: Type.String(),
  correction: Type.String(),
  context: Type.Optional(Type.String()),
});

const PreferenceSchema = Type.Object({
  preference: Type.String(),
  evidence: Type.Optional(Type.String()),
});

const ArtifactSchema = Type.Object({
  path: Type.String(),
  action: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});

const DecisionSchema = Type.Object({
  decision: Type.String(),
  rationale: Type.Optional(Type.String()),
  alternatives_considered: Type.Optional(Type.String()),
});

const SkillSchema = Type.Object({
  name: Type.String(),
  steps: Type.Array(Type.String()),
  trigger_context: Type.Optional(Type.String()),
});

export const ExtractionResultSchema = Type.Object({
  causal: Type.Optional(Type.Array(CausalSchema)),
  monologue: Type.Optional(Type.Array(MonologueSchema)),
  resolved: Type.Optional(Type.Array(Type.String())),
  concepts: Type.Optional(Type.Array(ConceptSchema)),
  corrections: Type.Optional(Type.Array(CorrectionSchema)),
  preferences: Type.Optional(Type.Array(PreferenceSchema)),
  artifacts: Type.Optional(Type.Array(ArtifactSchema)),
  decisions: Type.Optional(Type.Array(DecisionSchema)),
  skills: Type.Optional(Type.Array(SkillSchema)),
  handoff_note: Type.Optional(Type.String()),
  reflection: Type.Optional(Type.String()),
  rules_compliance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export interface ValidationResult {
  data: Record<string, unknown>;
  errors: string[];
}

export function validateExtraction(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { data: {} as Record<string, unknown>, errors: ["Input is not an object"] };
  }
  const converted = Value.Convert(ExtractionResultSchema, raw) as Record<string, unknown>;
  const errors: string[] = [];
  if (!Value.Check(ExtractionResultSchema, converted)) {
    for (const err of Value.Errors(ExtractionResultSchema, converted)) {
      errors.push(`${err.path}: ${err.message}`);
    }
  }
  return { data: converted, errors };
}
