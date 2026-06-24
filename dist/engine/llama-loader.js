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
import { log } from "./log.js";
let _sharedLlama = null;
let _sharedLlamaInit = null;
export async function loadNodeLlamaCpp() {
    const override = process.env.LAQRUMCODE_NODE_LLAMA_CPP_PATH;
    const target = override || "node-llama-cpp";
    return await import(target);
}
export async function getSharedLlama(profile) {
    if (_sharedLlama)
        return _sharedLlama;
    if (_sharedLlamaInit)
        return _sharedLlamaInit;
    _sharedLlamaInit = (async () => {
        const { getLlama, LlamaLogLevel } = await loadNodeLlamaCpp();
        const llama = await getLlama({
            gpu: profile?.llamaGpu ?? "auto",
            maxThreads: profile?.llamaMaxThreads,
            logLevel: LlamaLogLevel.error,
            logger: (level, message) => {
                if (message.includes("missing newline token"))
                    return;
                if (level === LlamaLogLevel.error)
                    log.error(`[llama] ${message}`);
                else if (level === LlamaLogLevel.warn)
                    log.warn(`[llama] ${message}`);
            },
        });
        _sharedLlama = llama;
        _sharedLlamaInit = null;
        return llama;
    })();
    return _sharedLlamaInit;
}
export async function disposeSharedLlama() {
    if (_sharedLlamaInit) {
        try {
            await _sharedLlamaInit;
        }
        catch { /* ignore */ }
    }
    if (_sharedLlama) {
        try {
            await _sharedLlama.dispose();
        }
        catch { /* ignore */ }
        _sharedLlama = null;
    }
    _sharedLlamaInit = null;
}
