export declare const REDACTION_PLACEHOLDER = "[redacted-secret-pattern]";
export declare const SECRET_PATTERNS: RegExp[];
export interface PrivacyConfig {
    /** Built-in SECRET_PATTERNS plus any compiled user `redact_patterns`. */
    redactPatterns: RegExp[];
    /** Artifact path fragments to skip (matched as substrings). */
    ignorePaths: string[];
    /** Project ids/names whose turns must never be stored. */
    ignoreProjects: string[];
}
export declare function privacyConfigPath(): string;
/** Pure parse of a privacy.json object into a PrivacyConfig (built-ins + user
 *  rules). Never throws: non-objects yield defaults; an invalid individual
 *  pattern is logged and skipped. Extracted from loadPrivacyConfig so it is
 *  unit-testable without filesystem IO. */
export declare function parsePrivacyConfig(raw: unknown): PrivacyConfig;
/** Load + cache ~/.kongcode/privacy.json. NEVER throws: a missing or malformed
 *  file yields safe built-in defaults (secret patterns only). */
export declare function loadPrivacyConfig(force?: boolean): PrivacyConfig;
/** Strip secret-looking substrings. Pure (does not mutate input). Safe to call
 *  with the shared global regexes: `.replace` resets lastIndex, but we reset
 *  defensively in case a pattern is ever used with `.test` elsewhere. */
export declare function redactSecrets(text: string, patterns?: RegExp[]): string;
/** Does any string leaf change under redaction? Cheap pre-check for callers
 *  that want to log when a redaction actually fired. */
export declare function containsSecret(text: string, patterns?: RegExp[]): boolean;
/** Should this project's content be skipped entirely (never stored)? Matches by
 *  exact id or substring so either the project id or a human name can be listed. */
export declare function isIgnoredProject(projectId: string | undefined, cfg: PrivacyConfig): boolean;
/** Does an artifact path match an ignore_paths fragment? */
export declare function isIgnoredPath(path: string | undefined, cfg: PrivacyConfig): boolean;
/** Test-only: clear the module cache so a freshly-written privacy.json is read. */
export declare function _resetPrivacyCache(): void;
