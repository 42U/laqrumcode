/**
 * Runtime loader for node-llama-cpp.
 *
 * Handles two distinct runtime layouts:
 *
 *   1. Normal Node + node_modules (dev tree, npm-ci'd plugin install): the
 *      bare specifier "node-llama-cpp" resolves via standard module resolution.
 *
 *   2. Node SEA single-executable (0.7.0+ ship target): there's no
 *      node_modules adjacent to the binary. The bootstrap downloads
 *      node-llama-cpp + its platform binding into <cacheDir>/native/, sets
 *      LAQRUMCODE_NODE_LLAMA_CPP_PATH to the absolute path of the main
 *      package's index.js, and we import from that path.
 *
 * Keeping this in one place isolates the layout logic from embeddings.ts so
 * downstream callers don't need to know which runtime they're under.
 *
 * Also provides getSharedLlama() — a single, resource-aware Llama native
 * instance shared by both EmbeddingService and the cross-encoder reranker.
 * Before this, each created its own getLlama() call, doubling thread pools
 * and native binding overhead.
 */
import type { ResourceProfile } from "./resource-tier.js";
type Llama = import("node-llama-cpp").Llama;
export declare function loadNodeLlamaCpp(): Promise<typeof import("node-llama-cpp")>;
export declare function getSharedLlama(profile?: ResourceProfile): Promise<Llama>;
export declare function disposeSharedLlama(): Promise<void>;
export {};
