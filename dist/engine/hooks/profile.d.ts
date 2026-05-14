/**
 * Hook strictness profiles.
 *
 * Three profiles control which gates fire:
 *   - minimal:  no gates, kongcode pre-0.7.47 behavior.
 *   - standard: edit-gate on first Edit/Write/MultiEdit + config-protection
 *               on linter/formatter configs. Default.
 *   - strict:   standard + bash-gate on destructive shell commands.
 *
 * Profile is read once from KONGCODE_HOOK_PROFILE at module load. Per-hook
 * disable is read from KONGCODE_DISABLED_HOOKS (comma-separated ids).
 * Both are env-only — daemon restart required to change them, same as every
 * other env-driven setting.
 */
export type HookProfile = "minimal" | "standard" | "strict";
export declare function getActiveProfile(): HookProfile;
/**
 * Returns true if a named hook should run under the active profile.
 *
 * @param hookId        stable id for the hook (e.g. "edit-gate", "config-protection")
 * @param requiredFor   profiles that activate this hook. The hook runs if the
 *                      active profile is in this list AND the hook id is not
 *                      explicitly disabled.
 */
export declare function shouldHookRun(hookId: string, requiredFor: HookProfile[]): boolean;
/**
 * Test-only: clear cached env reads so a new env can take effect.
 * @internal
 */
export declare function _resetProfileCacheForTests(): void;
/**
 * Seed/refresh the Tier-0 core_memory directive that surfaces the active
 * hook profile to the agent every turn. Called from SessionStart after
 * seedCognitiveBootstrap. Idempotent: deletes any prior profile directive
 * (matched by its stable prefix) before inserting the current one, so a
 * profile change picks up on the next session.
 */
export declare function seedHookProfileDirective(store: {
    isAvailable(): boolean;
    queryExec(sql: string, b?: Record<string, unknown>): Promise<unknown>;
    createCoreMemory(text: string, category: string, priority: number, tier: number): Promise<unknown>;
}, registeredGates?: readonly {
    id: string;
    profiles: readonly string[];
}[]): Promise<void>;
