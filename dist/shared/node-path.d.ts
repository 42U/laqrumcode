/**
 * Prepend laqrumcode's runtime-downloaded node_modules dir to NODE_PATH.
 *
 * When laqrumcode-mcp ships as a SEA-bundled binary, its bundled JS contains
 * MCP SDK code that calls require("ajv/...") at runtime. SEA executables
 * have no adjacent node_modules — Node's module resolution would fail with
 * MODULE_NOT_FOUND.
 *
 * Bootstrap (in the daemon) downloads ajv + ajv-formats into
 * <cacheDir>/native/node_modules/ on first run. This helper, called by
 * mcp-client BEFORE any MCP SDK code triggers a runtime require, prepends
 * that directory to NODE_PATH and asks Node to refresh its module search
 * path. After this call, `require("ajv/dist/runtime/equal")` resolves.
 *
 * Idempotent + cheap. No-op when running under standard Node + node_modules
 * (e.g. dev tree, npm-ci'd plugin install) — the dir doesn't exist, we
 * skip. Safe to call always.
 */
export declare function setupRuntimeNodePath(cacheDir?: string): {
    applied: boolean;
    path: string | null;
};
