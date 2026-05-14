/**
 * Categorical block on edits to linter/formatter config files.
 *
 * Steers the agent to fix code instead of weakening tooling. Carve-outs:
 * pyproject.toml, package.json, tsconfig.json are NOT in the denylist — they
 * hold real project metadata that legitimately needs editing, not just
 * lint/format rules.
 *
 * Bypass: KONGCODE_ALLOW_CONFIG_EDIT=1 skips the check for the lifetime
 * of the daemon. Useful when the user is intentionally tuning configs.
 */
export declare function isProtectedConfigFile(filePath: string): boolean;
/**
 * Test-only: clear bypass cache and let a new env take effect.
 * @internal
 */
export declare function _resetConfigProtectionCacheForTests(): void;
/** Exported for tests + the Tier-0 directive text. */
export declare function listProtectedBasenames(): string[];
