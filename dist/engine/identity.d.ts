import type { SurrealStore } from "./surreal.js";
import type { EmbeddingService } from "./embeddings.js";
/**
 * Version tag for the core identity chunks. Bump when IDENTITY_CHUNKS
 * content changes so existing installs re-seed with the new content.
 * Pre-0.4.0 installs had no identity_version field on their chunks,
 * so the absence-of-field query doubles as the upgrade detector.
 */
export declare const IDENTITY_VERSION = "0.4.1";
export declare function seedIdentity(store: SurrealStore, embeddings: EmbeddingService): Promise<number>;
/**
 * Version tag for user-identity chunks. The compound UNIQUE on identity_chunk
 * is (source, identity_version, chunk_index) — without an explicit version
 * here, all chunks would write identity_version = NONE and any DELETE failure
 * upstream leaves stale NONE-versioned rows occupying chunk_index 0..N-1,
 * causing the CREATEs below to collide on the UNIQUE constraint.
 * Bump when user-identity chunk semantics change so old rows can be migrated.
 */
export declare const USER_IDENTITY_VERSION = "user-v1";
export declare function hasUserIdentity(store: SurrealStore): Promise<boolean>;
export declare function findWakeupFile(cwd: string): string | null;
export declare function readWakeupFile(path: string): string;
export declare function deleteWakeupFile(path: string): void;
export declare function saveUserIdentity(chunks: string[], store: SurrealStore, embeddings: EmbeddingService): Promise<number>;
export declare function buildWakeupPrompt(wakeupContent: string): {
    systemAddition: string;
    firstMessage: string;
};
