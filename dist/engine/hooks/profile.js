/**
 * Hook strictness profiles.
 *
 * Three profiles control which gates fire:
 *   - minimal:  no gates, laqrumcode pre-0.7.47 behavior.
 *   - standard: edit-gate on first Edit/Write/MultiEdit + config-protection
 *               on linter/formatter configs. Default.
 *   - strict:   standard + bash-gate on destructive shell commands.
 *
 * Profile is read once from LAQRUMCODE_HOOK_PROFILE at module load. Per-hook
 * disable is read from LAQRUMCODE_DISABLED_HOOKS (comma-separated ids).
 * Both are env-only — daemon restart required to change them, same as every
 * other env-driven setting.
 */
const VALID_PROFILES = new Set(["minimal", "standard", "strict"]);
let cachedProfile = null;
let cachedDisabled = null;
function readProfile() {
    const raw = (process.env.LAQRUMCODE_HOOK_PROFILE ?? "").trim().toLowerCase();
    if (raw && VALID_PROFILES.has(raw))
        return raw;
    return "standard";
}
function readDisabled() {
    const raw = (process.env.LAQRUMCODE_DISABLED_HOOKS ?? "").trim();
    if (!raw)
        return new Set();
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}
export function getActiveProfile() {
    if (cachedProfile === null)
        cachedProfile = readProfile();
    return cachedProfile;
}
function getDisabledHooks() {
    if (cachedDisabled === null)
        cachedDisabled = readDisabled();
    return cachedDisabled;
}
/**
 * Returns true if a named hook should run under the active profile.
 *
 * @param hookId        stable id for the hook (e.g. "edit-gate", "config-protection")
 * @param requiredFor   profiles that activate this hook. The hook runs if the
 *                      active profile is in this list AND the hook id is not
 *                      explicitly disabled.
 */
export function shouldHookRun(hookId, requiredFor) {
    if (getDisabledHooks().has(hookId))
        return false;
    return requiredFor.includes(getActiveProfile());
}
/**
 * Test-only: clear cached env reads so a new env can take effect.
 * @internal
 */
export function _resetProfileCacheForTests() {
    cachedProfile = null;
    cachedDisabled = null;
}
/**
 * Seed/refresh the Tier-0 core_memory directive that surfaces the active
 * hook profile to the agent every turn. Called from SessionStart after
 * seedCognitiveBootstrap. Idempotent: deletes any prior profile directive
 * (matched by its stable prefix) before inserting the current one, so a
 * profile change picks up on the next session.
 */
export async function seedHookProfileDirective(store, registeredGates) {
    if (!store.isAvailable())
        return;
    const profile = getActiveProfile();
    const disabled = Array.from(getDisabledHooks()).sort();
    let gateStatus;
    if (registeredGates && registeredGates.length > 0) {
        gateStatus = registeredGates.map(g => {
            const active = shouldHookRun(g.id, g.profiles);
            return `${g.id}=${active ? "ON" : "off"}`;
        }).join(", ");
    }
    else {
        gateStatus =
            `edit-gate=${shouldHookRun("edit-gate", ["standard", "strict"]) ? "ON" : "off"}, ` +
                `bash-gate=${shouldHookRun("bash-gate", ["strict"]) ? "ON" : "off"}, ` +
                `config-protection=${shouldHookRun("config-protection", ["standard", "strict"]) ? "ON" : "off"}`;
    }
    const directive = `ACTIVE HOOK PROFILE: ${profile}. ` +
        `Gates: ${gateStatus}` +
        (disabled.length ? ` (disabled: ${disabled.join(",")})` : "") +
        `. ` +
        `Under standard/strict, the FIRST Edit/Write/MultiEdit to a file in this session ` +
        `is BLOCKED until the path appears in turn text — recall it, Read it, or wait for ` +
        `the user to name it. Edits to lint/format configs (.eslintrc, biome.json, ` +
        `prettier.*, ruff.toml, etc.) are blocked unless LAQRUMCODE_ALLOW_CONFIG_EDIT=1. ` +
        `In strict, destructive Bash patterns (rm -rf, git reset --hard, git push --force, ` +
        `DROP TABLE, DELETE FROM without WHERE, TRUNCATE) require user authorization or ` +
        `prior session mention. Override profile with LAQRUMCODE_HOOK_PROFILE=minimal|standard|strict; ` +
        `daemon restart required.`;
    // Stable marker so we can dedupe across daemon restarts.
    const tagged = `${directive}\n[kc_hook_profile_v1]`;
    try {
        // v0.7.93 append-only: was DELETE — now soft-archives prior hook-profile
        // directives. New one inserts fresh; readers filter on active.
        await store.queryExec(`UPDATE core_memory SET
         active = false,
         archived_at = time::now(),
         archive_reason = 'hook_profile_replaced'
       WHERE text CONTAINS '[kc_hook_profile_v1]'
         AND (active = true OR active IS NONE)`);
    }
    catch {
        // best-effort dedup — fall through to create even if archive fails.
    }
    await store.createCoreMemory(tagged, "operations", 88, 0);
}
