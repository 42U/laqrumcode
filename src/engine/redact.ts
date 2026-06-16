/**
 * Ingestion-time secret redaction + privacy config (GH #16).
 *
 * Distinct from the DISPLAY-time redaction in tools/introspect.ts (which masks
 * what the introspect tool shows an operator): this module strips secrets from
 * text BEFORE it is embedded and stored, so the graph never persists them in the
 * first place — and because downstream extractions (concepts/memories) derive
 * from already-redacted turn text, the redaction propagates without re-running.
 *
 * `SECRET_PATTERNS` is the single source of truth, shared with introspect.ts.
 *
 * Privacy is configured via ~/.kongcode/privacy.json (sibling of surreal-cred.json):
 *   {
 *     "redact_patterns": ["(?i)internal-token-[a-z0-9]{16}"],   // extra regexes (strings)
 *     "ignore_projects": ["client-x-confidential"],             // never store these projects' turns
 *     "ignore_paths":    [".env", "credentials.json", "*.pem"]  // artifact paths to skip
 *   }
 * The file is optional; absent/malformed → built-in secret patterns only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { log } from "./log.js";

export const REDACTION_PLACEHOLDER = "[redacted-secret-pattern]";

// Provider-anchored secret patterns: Anthropic, AWS, GitHub PAT/server-to-server,
// OpenAI (legacy + project/service-account), Slack, Stripe live/test, Google API
// keys, GitLab PATs, npm tokens, Hugging Face, JWTs. Each is anchored to its
// provider's documented prefix. OpenAI `sk-` requires a word boundary + at least
// 40 trailing alphanumerics (no internal hyphens) so benign content like
// `sk-learn-documentation-page` does not match.
export const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /AKIA[0-9A-Z]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk_live_[A-Za-z0-9]{20,}/g,
  /sk_test_[A-Za-z0-9]{20,}/g,
  // OpenAI project / service-account scoped keys (newer prefixed format). Must
  // come BEFORE the plain `\bsk-…` rule so the longer prefix matches first.
  /\bsk-(proj|svcacct)-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{40,}\b/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  // GitLab PATs are exactly 20 chars after `glpat-`; lock to 20 + tail boundary
  // so longer hyphenated identifiers don't trip it.
  /glpat-[A-Za-z0-9_-]{20}\b/g,
  /npm_[A-Za-z0-9]{36}/g,
  /hf_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // PEM private-key blocks (RSA/EC/OPENSSH/PGP/generic). Distinctive headers →
  // near-zero false positives; non-greedy span redacts the whole key body.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];

export interface PrivacyConfig {
  /** Built-in SECRET_PATTERNS plus any compiled user `redact_patterns`. */
  redactPatterns: RegExp[];
  /** Artifact path fragments to skip (matched as substrings). */
  ignorePaths: string[];
  /** Project ids/names whose turns must never be stored. */
  ignoreProjects: string[];
}

let cached: PrivacyConfig | null = null;

export function privacyConfigPath(): string {
  return join(homedir(), ".kongcode", "privacy.json");
}

/** Pure parse of a privacy.json object into a PrivacyConfig (built-ins + user
 *  rules). Never throws: non-objects yield defaults; an invalid individual
 *  pattern is logged and skipped. Extracted from loadPrivacyConfig so it is
 *  unit-testable without filesystem IO. */
export function parsePrivacyConfig(raw: unknown): PrivacyConfig {
  const cfg: PrivacyConfig = { redactPatterns: [...SECRET_PATTERNS], ignorePaths: [], ignoreProjects: [] };
  if (!raw || typeof raw !== "object") return cfg;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.redact_patterns)) {
    for (const p of r.redact_patterns) {
      if (typeof p !== "string" || p.length === 0) continue;
      // JS regex has no inline (?i) flag; honor a leading "(?i)" by stripping it
      // and compiling case-insensitive (matches the #16 config example).
      const ci = p.startsWith("(?i)");
      const body = ci ? p.slice(4) : p;
      try {
        cfg.redactPatterns.push(new RegExp(body, ci ? "gi" : "g"));
      } catch (e) {
        log.warn(`[privacy] ignoring invalid redact_pattern ${JSON.stringify(p)}: ${(e as Error).message}`);
      }
    }
  }
  if (Array.isArray(r.ignore_paths)) {
    cfg.ignorePaths = r.ignore_paths.filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(r.ignore_projects)) {
    cfg.ignoreProjects = r.ignore_projects.filter((x): x is string => typeof x === "string");
  }
  return cfg;
}

/** Load + cache ~/.kongcode/privacy.json. NEVER throws: a missing or malformed
 *  file yields safe built-in defaults (secret patterns only). */
export function loadPrivacyConfig(force = false): PrivacyConfig {
  if (cached && !force) return cached;
  let cfg: PrivacyConfig = { redactPatterns: [...SECRET_PATTERNS], ignorePaths: [], ignoreProjects: [] };
  const path = privacyConfigPath();
  if (existsSync(path)) {
    try {
      cfg = parsePrivacyConfig(JSON.parse(readFileSync(path, "utf-8")));
    } catch (e) {
      log.warn(`[privacy] failed to parse ${path} (${(e as Error).message}) — using built-in secret patterns only`);
    }
  }
  cached = cfg;
  return cfg;
}

/** Strip secret-looking substrings. Pure (does not mutate input). Safe to call
 *  with the shared global regexes: `.replace` resets lastIndex, but we reset
 *  defensively in case a pattern is ever used with `.test` elsewhere. */
export function redactSecrets(text: string, patterns: RegExp[] = SECRET_PATTERNS): string {
  if (!text) return text;
  let out = text;
  for (const pat of patterns) {
    pat.lastIndex = 0;
    out = out.replace(pat, REDACTION_PLACEHOLDER);
  }
  return out;
}

/** Does any string leaf change under redaction? Cheap pre-check for callers
 *  that want to log when a redaction actually fired. */
export function containsSecret(text: string, patterns: RegExp[] = SECRET_PATTERNS): boolean {
  return !!text && redactSecrets(text, patterns) !== text;
}

/** Should this project's content be skipped entirely (never stored)? Matches by
 *  exact id or substring so either the project id or a human name can be listed. */
export function isIgnoredProject(projectId: string | undefined, cfg: PrivacyConfig): boolean {
  if (!projectId) return false;
  return cfg.ignoreProjects.some((p) => p.length > 0 && (projectId === p || projectId.includes(p)));
}

/** Does an artifact path match an ignore_paths fragment? */
export function isIgnoredPath(path: string | undefined, cfg: PrivacyConfig): boolean {
  if (!path) return false;
  return cfg.ignorePaths.some((frag) => frag.length > 0 && path.includes(frag.replace(/^\*+/, "")));
}

/** Test-only: clear the module cache so a freshly-written privacy.json is read. */
export function _resetPrivacyCache(): void {
  cached = null;
}
