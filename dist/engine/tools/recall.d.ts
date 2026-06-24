/**
 * Recall tool — search the persistent memory graph.
 * Ported from laqrumbrain with SurrealStore/EmbeddingService injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
export declare function createRecallToolDef(state: GlobalPluginState, session: SessionState): {
    name: string;
    label: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        query: import("@sinclair/typebox").TString;
        scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"all">, import("@sinclair/typebox").TLiteral<"memories">, import("@sinclair/typebox").TLiteral<"concepts">, import("@sinclair/typebox").TLiteral<"turns">, import("@sinclair/typebox").TLiteral<"artifacts">, import("@sinclair/typebox").TLiteral<"skills">]>>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    }>;
    execute: (_toolCallId: string, params: {
        query: string;
        scope?: string;
        limit?: number;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        details: null;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: number;
            ids: string[];
            neighbor_count?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: number;
            ids: string[];
            neighbor_count: number;
        };
    }>;
};
