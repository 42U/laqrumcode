/**
 * Introspect tool — inspect the memory database.
 * Ported from kongbrain with SurrealStore injection.
 */
import type { GlobalPluginState, SessionState } from "../state.js";
export declare function createIntrospectToolDef(state: GlobalPluginState, session: SessionState): {
    name: string;
    label: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        action: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"status">, import("@sinclair/typebox").TLiteral<"count">, import("@sinclair/typebox").TLiteral<"verify">, import("@sinclair/typebox").TLiteral<"query">, import("@sinclair/typebox").TLiteral<"migrate">, import("@sinclair/typebox").TLiteral<"trends">, import("@sinclair/typebox").TLiteral<"stats">]>;
        table: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        filter: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        record_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    execute: (_toolCallId: string, params: {
        action: "status" | "count" | "verify" | "query" | "migrate" | "trends" | "stats";
        table?: string;
        filter?: string;
        record_id?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            counts: Record<string, number>;
            embCounts: Record<string, number>;
            alive: any;
            totalNodes: number;
            totalEmb: number;
            embeddings: {
                status: "ok" | "down" | "degraded";
                label: string;
            };
        };
    } | {
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
            table: string;
            count: any;
            filter: string | undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            exists: boolean;
            id?: undefined;
            record?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            exists: boolean;
            id: string;
            record: Record<string, unknown>;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: import("../recovery.js").DerivedFromRecoveryResult;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: import("../recovery.js").ProjectIdRecoveryResult;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: import("../workspace-migrate.js").MigrationResult;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: import("../observability.js").TrendReport;
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            window_7d: {
                concepts: number;
                memories: number;
                skills: number;
                sessions: number;
                turns: number;
                tokens_in: number;
                tokens_out: number;
            };
            window_30d: {
                concepts: number;
                memories: number;
                skills: number;
                sessions: number;
                turns: number;
                tokens_in: number;
                tokens_out: number;
            };
            drain: {
                spawns_today: number;
                daily_budget: number;
                spawns_7d: number;
                spawns_30d: number;
                today_key: string;
            };
            graph_counts: {
                concept: number;
                memory: number;
                skill: number;
                turn: number;
                artifact: number;
            };
            db_size: {
                bytes: number | null;
                external: boolean;
                alert_gb: number;
            };
            alerts: {
                code: string;
                severity: "warn" | "critical";
                message: string;
            }[];
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            templates: string[];
            count?: undefined;
        };
    } | {
        content: {
            type: "text";
            text: string;
        }[];
        details: {
            count: any;
            templates?: undefined;
        };
    }>;
};
interface SpendingCounts {
    today: number;
    last7d: number;
    last30d: number;
    /** Today's UTC date key (YYYY-MM-DD) the counts are anchored to. */
    today_key: string;
}
/** Read the auto-drain spending ledger and bucket spawns into today / 7d / 30d.
 *  Tolerant of a missing dir/file (returns all-zero) and of malformed lines
 *  (skipped). Counts only entries with the full {date, ts, pid} shape so a
 *  stray hand-written marker can't inflate the totals — same strictness as
 *  auto-drain.ts:readSpending. The legacy {date,count} file contributes to
 *  today's bucket only (its count has no per-spawn timestamps to bucket by). */
export declare function readSpendingStats(cacheDir: string, now?: number): SpendingCounts;
/** Recursively sum file sizes under `dir`. SurrealKV stores the managed DB as
 *  a directory tree (manifest/, sstables/, vlog/, wal/), so a single statSync
 *  of the dir reports only the inode size, not the data. Walk it. Returns
 *  null if the dir doesn't exist or can't be read. Depth-capped to bound
 *  pathological trees / symlink loops (the surrealkv layout is shallow). */
export declare function dirSizeBytes(dir: string, depth?: number): number | null;
/** True when the connected DB is NOT this install's managed instance — so its
 *  on-disk size isn't ours to measure (report n/a). External covers BOTH a
 *  `SURREAL_URL` override AND a DB that bootstrap discovered + adopted on a
 *  non-managed port (e.g. an :8000 Docker container, where no SURREAL_URL is
 *  set — the case the old `!!process.env.SURREAL_URL` check missed). Keyed on
 *  the connected port vs the managed-surface ports (pickPort + legacy 18765),
 *  matching how findExistingKongcodeSurreal decides managed-vs-external. */
export declare function isConnectedDbExternal(connectedUrl: string): boolean;
export declare function statsAction(state: GlobalPluginState): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    details: {
        window_7d: {
            concepts: number;
            memories: number;
            skills: number;
            sessions: number;
            turns: number;
            tokens_in: number;
            tokens_out: number;
        };
        window_30d: {
            concepts: number;
            memories: number;
            skills: number;
            sessions: number;
            turns: number;
            tokens_in: number;
            tokens_out: number;
        };
        drain: {
            spawns_today: number;
            daily_budget: number;
            spawns_7d: number;
            spawns_30d: number;
            today_key: string;
        };
        graph_counts: {
            concept: number;
            memory: number;
            skill: number;
            turn: number;
            artifact: number;
        };
        db_size: {
            bytes: number | null;
            external: boolean;
            alert_gb: number;
        };
        alerts: {
            code: string;
            severity: "warn" | "critical";
            message: string;
        }[];
    };
}>;
export {};
