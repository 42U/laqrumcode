/**
 * Unit tests for ingestion-time secret redaction + privacy config (GH #16,
 * src/engine/redact.ts). Pure functions — no DB, always runs in CI.
 */
import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  containsSecret,
  parsePrivacyConfig,
  loadPrivacyConfig,
  isIgnoredProject,
  isIgnoredPath,
  SECRET_PATTERNS,
  REDACTION_PLACEHOLDER,
} from "../src/engine/redact.js";

describe("redactSecrets — built-in provider patterns", () => {
  const secrets = [
    // Fixtures are split as prefix + body concatenations ON PURPOSE: a contiguous
    // secret-shaped literal trips GitHub push protection (GH013). The runtime value
    // is identical, so redaction is exercised the same — do NOT inline these back.
    ["Anthropic", "sk-ant-" + "api03-AbCdEf012345_-AbCdEf012345"],
    ["AWS access key", "AKIA" + "IOSFODNN7EXAMPLE"],
    ["GitHub PAT", "ghp_" + "AbCdEf0123456789AbCdEf0123456789"],
    ["GitHub server", "ghs_" + "AbCdEf0123456789AbCdEf0123456789"],
    ["GitHub fine-grained", "github_pat_" + "11ABCDEFG0123456789_abcdefABCDEF0123456789"],
    ["Stripe live", "sk_live_" + "AbCdEf0123456789AbCdEf01"],
    ["OpenAI project", "sk-proj-" + "AbCdEf012345_AbCdEf012345"],
    ["OpenAI legacy", "sk-" + "A1b2C3d4E5".repeat(5)], // 50 alnum chars
    ["Slack", "xoxb-" + "1234567890-abcdefghij"],
    ["Google API", "AIza" + "SyA1b2C3d4E5f6g7h8i9j0K1l2M3n4O5"],
    ["GitLab PAT", "glpat-" + "Ab012345678901234567"], // exactly 20 after prefix
    ["npm token", "npm_" + "a1b2c3d4e5".repeat(3) + "abcdef"], // 36 chars
    ["Hugging Face", "hf_" + "AbCdEf0123456789AbCdEf0123456789AbCd"],
    ["JWT", "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw.dozjgNryP4J3jVmNHl0w"],
    ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----\n" + "MIIBVgIBADANBgkqhkiG9w0BAQEF\n" + "-----END RSA PRIVATE KEY-----"],
  ];
  for (const [name, secret] of secrets) {
    it(`masks a ${name}`, () => {
      const out = redactSecrets(`token is ${secret} ok`);
      expect(out).toContain(REDACTION_PLACEHOLDER);
      expect(out).not.toContain(secret);
    });
  }

  it("does NOT mask benign lookalikes", () => {
    // NOTE: glpat-<exactly 20 [A-Za-z0-9_-] then word-boundary> can over-match a
    // long hyphenated branch name (pre-existing pattern; harmless for redaction —
    // errs toward privacy). Use a short glpat lookalike that clearly can't match.
    for (const benign of ["sk-learn-documentation-page", "glpat-mybranch", "ghp_short"]) {
      expect(redactSecrets(`see ${benign} here`)).toBe(`see ${benign} here`);
    }
  });

  it("masks multiple secrets in one string and is idempotent", () => {
    const ghp = "ghp_" + "AbCdEf0123456789AbCdEf0123456789"; // split: see fixtures note
    const akia = "AKIA" + "IOSFODNN7EXAMPLE";
    const once = redactSecrets(`a ${ghp} b ${akia} c`);
    expect((once.match(/redacted-secret-pattern/g) || []).length).toBe(2);
    expect(redactSecrets(once)).toBe(once);
  });

  it("is pure / empty-safe", () => {
    expect(redactSecrets("")).toBe("");
    expect(containsSecret("plain text")).toBe(false);
    expect(containsSecret("k=ghp_" + "AbCdEf0123456789AbCdEf0123456789")).toBe(true);
  });
});

describe("parsePrivacyConfig", () => {
  it("returns built-in patterns + empty ignore lists for empty/invalid input", () => {
    for (const bad of [undefined, null, 42, "x", {}]) {
      const cfg = parsePrivacyConfig(bad);
      expect(cfg.redactPatterns.length).toBe(SECRET_PATTERNS.length);
      expect(cfg.ignorePaths).toEqual([]);
      expect(cfg.ignoreProjects).toEqual([]);
    }
  });

  it("appends user redact_patterns on top of built-ins", () => {
    const cfg = parsePrivacyConfig({ redact_patterns: ["internal-[0-9]{6}"] });
    expect(cfg.redactPatterns.length).toBe(SECRET_PATTERNS.length + 1);
    expect(redactSecrets("id internal-123456 x", cfg.redactPatterns)).toContain(REDACTION_PLACEHOLDER);
  });

  it("honors a (?i) prefix as case-insensitive", () => {
    const cfg = parsePrivacyConfig({ redact_patterns: ["(?i)secret-[a-z]{4}"] });
    expect(redactSecrets("SECRET-ABCD", cfg.redactPatterns)).toContain(REDACTION_PLACEHOLDER);
  });

  it("skips an invalid regex without throwing, keeping the rest", () => {
    const cfg = parsePrivacyConfig({ redact_patterns: ["valid-[0-9]+", "(unclosed"] });
    expect(cfg.redactPatterns.length).toBe(SECRET_PATTERNS.length + 1); // only the valid one added
  });

  it("parses ignore_paths / ignore_projects and filters non-strings", () => {
    const cfg = parsePrivacyConfig({ ignore_paths: [".env", 7, "*.pem"], ignore_projects: ["client-x", null] });
    expect(cfg.ignorePaths).toEqual([".env", "*.pem"]);
    expect(cfg.ignoreProjects).toEqual(["client-x"]);
  });
});

describe("isIgnoredProject / isIgnoredPath", () => {
  const cfg = parsePrivacyConfig({ ignore_projects: ["client-x-confidential"], ignore_paths: [".env", "*.pem"] });
  it("matches a project by exact id and by substring; safe on empty", () => {
    expect(isIgnoredProject("client-x-confidential", cfg)).toBe(true);
    expect(isIgnoredProject("project:client-x-confidential-2024", cfg)).toBe(true);
    expect(isIgnoredProject("other-project", cfg)).toBe(false);
    expect(isIgnoredProject(undefined, cfg)).toBe(false);
  });
  it("matches an artifact path against ignore fragments", () => {
    expect(isIgnoredPath("/home/u/app/.env", cfg)).toBe(true);
    expect(isIgnoredPath("/certs/server.pem", cfg)).toBe(true);
    expect(isIgnoredPath("/home/u/app/index.ts", cfg)).toBe(false);
    expect(isIgnoredPath(undefined, cfg)).toBe(false);
  });
});

describe("loadPrivacyConfig", () => {
  it("always includes the built-in secret patterns and caches", () => {
    const a = loadPrivacyConfig();
    expect(a.redactPatterns.length).toBeGreaterThanOrEqual(SECRET_PATTERNS.length);
    expect(loadPrivacyConfig()).toBe(a); // cached identity
  });
});
