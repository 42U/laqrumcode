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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
export function setupRuntimeNodePath(cacheDir) {
    const cache = cacheDir ?? join(homedir(), ".laqrumcode", "cache");
    const nativeNodeModules = join(cache, "native", "node_modules");
    if (!existsSync(nativeNodeModules)) {
        return { applied: false, path: null };
    }
    const existing = process.env.NODE_PATH ?? "";
    // Skip if already prepended (idempotent across multiple calls in same process).
    if (existing.split(delimiter).includes(nativeNodeModules)) {
        return { applied: true, path: nativeNodeModules };
    }
    process.env.NODE_PATH = existing
        ? `${nativeNodeModules}${delimiter}${existing}`
        : nativeNodeModules;
    // Tell Node to re-read NODE_PATH. Without this, only newly-spawned child
    // processes pick up the change; the current process's module resolver
    // keeps its cached path list.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require("node:module");
    if (typeof Module._initPaths === "function") {
        Module._initPaths();
    }
    return { applied: true, path: nativeNodeModules };
}
