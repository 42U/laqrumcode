/**
 * Shared types for the memory daemon system.
 */
import { type Static } from "@sinclair/typebox";
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
export declare const ExtractionResultSchema: import("@sinclair/typebox").TObject<{
    causal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        triggerText: import("@sinclair/typebox").TString;
        outcomeText: import("@sinclair/typebox").TString;
        chainType: import("@sinclair/typebox").TString;
        success: import("@sinclair/typebox").TBoolean;
        confidence: import("@sinclair/typebox").TNumber;
        description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    monologue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        category: import("@sinclair/typebox").TString;
        content: import("@sinclair/typebox").TString;
    }>>>;
    resolved: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    concepts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        content: import("@sinclair/typebox").TString;
        category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        importance: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        searchTerms: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    }>>>;
    corrections: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        original: import("@sinclair/typebox").TString;
        correction: import("@sinclair/typebox").TString;
        context: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    preferences: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        preference: import("@sinclair/typebox").TString;
        evidence: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    artifacts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        action: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        summary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    decisions: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        decision: import("@sinclair/typebox").TString;
        rationale: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        alternatives_considered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    skills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        steps: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        trigger_context: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    handoff_note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    reflection: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type ExtractionResult = Static<typeof ExtractionResultSchema>;
export interface ValidationResult {
    data: Record<string, unknown>;
    errors: string[];
}
export declare function validateExtraction(raw: unknown): ValidationResult;
