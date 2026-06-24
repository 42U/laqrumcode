/**
 * Phase 2 (multi-user auth, after GH #13) — per-user credentials for the
 * MANAGED (laqrumcode-auto-spawned) SurrealDB.
 *
 * Two units under test, both in src/engine/bootstrap.ts:
 *
 *   1. getOrCreateManagedCred(cacheDir) — read-or-create the persisted
 *      managed credential at <laqrumcode-home>/surreal-cred.json (sibling of
 *      cacheDir). Asserts: shape (laqrum_<uid> user + base64url pass), 0600
 *      perms best-effort, IDEMPOTENCY (second call returns byte-identical
 *      cred, so a reused detached child and the connecting daemon agree), and
 *      regeneration on a corrupt/legacy file.
 *
 *   2. resolveReusedTargetCred(...) — the security-critical per-target
 *      decision for a REUSED/DISCOVERED SurrealDB. Asserts the full table,
 *      including the load-bearing SAFETY PROPERTY: an EXTERNAL discovered DB
 *      (pid === null, e.g. the dev's :8000 Docker container) MUST get back the
 *      CONFIGURED creds verbatim (auth path unchanged from pre-Phase-2), while
 *      a fresh-cred managed child gets the GENERATED cred and a pre-Phase-2
 *      root:root managed child is gracefully kept on root:root.
 *
 * Isolation: every test uses a throwaway temp dir as cacheDir, so the real
 * ~/.laqrumcode/surreal-cred.json is never touched.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  getOrCreateManagedCred,
  resolveReusedTargetCred,
  type ManagedSurrealCred,
} from "../src/engine/bootstrap.js";

// cacheDir mirrors production's ~/.laqrumcode/cache: the cred file is written to
// its PARENT (<root>/surreal-cred.json). So make a <root>/cache temp dir and
// hand `<root>/cache` to the helper; the cred lands at `<root>/surreal-cred.json`.
const tmpRoots: string[] = [];
function mkCacheDir(label: string): string {
  const root = join(tmpdir(), `kc-cred-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  tmpRoots.push(root);
  return cacheDir;
}
function credPathFor(cacheDir: string): string {
  return join(dirname(cacheDir), "surreal-cred.json");
}

afterEach(() => {
  for (const r of tmpRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpRoots.length = 0;
});

describe("getOrCreateManagedCred — generation + shape", () => {
  it("generates a cred with a non-root user and a strong random pass", () => {
    const cacheDir = mkCacheDir("shape");
    const cred = getOrCreateManagedCred(cacheDir);

    // NOT the dropped root:root default.
    expect(cred.user).not.toBe("root");
    expect(cred.pass).not.toBe("root");

    // user is `laqrum` (no getuid) or `laqrum_<uid>` (POSIX). On the CI POSIX box
    // process.getuid exists, so assert the uid-suffixed form there; accept the
    // bare form on a hypothetical non-POSIX runner.
    if (typeof process.getuid === "function") {
      expect(cred.user).toBe(`laqrum_${process.getuid()}`);
    } else {
      expect(cred.user).toBe("laqrum");
    }

    // pass = randomBytes(24).toString("base64url"): 24 bytes → 32 chars,
    // url-safe alphabet only (no +, /, or = padding).
    expect(cred.pass).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cred.pass.length).toBeGreaterThanOrEqual(30);
  });

  it("writes the cred file to <laqrumcode-home>/surreal-cred.json (sibling of cacheDir)", () => {
    const cacheDir = mkCacheDir("path");
    getOrCreateManagedCred(cacheDir);
    const p = credPathFor(cacheDir);
    expect(existsSync(p)).toBe(true);

    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    expect(typeof parsed.user).toBe("string");
    expect(typeof parsed.pass).toBe("string");
  });

  it("tightens cred-file perms to 0600 (POSIX best-effort)", () => {
    if (typeof process.getuid !== "function") return; // skip on non-POSIX
    const cacheDir = mkCacheDir("perms");
    getOrCreateManagedCred(cacheDir);
    const mode = statSync(credPathFor(cacheDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("getOrCreateManagedCred — idempotency (Option-A reuse correctness)", () => {
  it("returns the SAME cred on a second call (reused child + daemon agree)", () => {
    const cacheDir = mkCacheDir("idem");
    const first = getOrCreateManagedCred(cacheDir);
    const second = getOrCreateManagedCred(cacheDir);
    expect(second).toEqual(first);
  });

  it("does not rewrite/rotate an existing valid cred file", () => {
    const cacheDir = mkCacheDir("norotate");
    const first = getOrCreateManagedCred(cacheDir);
    const onDisk = readFileSync(credPathFor(cacheDir), "utf-8");
    const second = getOrCreateManagedCred(cacheDir);
    // Same in-memory value AND the persisted bytes are unchanged.
    expect(second.pass).toBe(first.pass);
    expect(readFileSync(credPathFor(cacheDir), "utf-8")).toBe(onDisk);
  });

  it("reuses a hand-written valid cred file verbatim", () => {
    const cacheDir = mkCacheDir("preexisting");
    const planted: ManagedSurrealCred = { user: "laqrum_planted", pass: "planted-secret-xyz" };
    writeFileSync(credPathFor(cacheDir), JSON.stringify(planted), "utf-8");
    expect(getOrCreateManagedCred(cacheDir)).toEqual(planted);
  });
});

describe("getOrCreateManagedCred — corrupt/legacy file regeneration", () => {
  it("regenerates when the file is non-JSON garbage", () => {
    const cacheDir = mkCacheDir("garbage");
    writeFileSync(credPathFor(cacheDir), "this is not json", "utf-8");
    const cred = getOrCreateManagedCred(cacheDir);
    expect(cred.user).not.toBe("root");
    expect(cred.pass.length).toBeGreaterThanOrEqual(30);
    // And it overwrote the garbage with valid JSON.
    expect(() => JSON.parse(readFileSync(credPathFor(cacheDir), "utf-8"))).not.toThrow();
  });

  it("regenerates when the JSON is missing user/pass or has empty strings", () => {
    const cacheDir = mkCacheDir("empties");
    writeFileSync(credPathFor(cacheDir), JSON.stringify({ user: "", pass: "" }), "utf-8");
    const cred = getOrCreateManagedCred(cacheDir);
    expect(cred.user).not.toBe("");
    expect(cred.pass).not.toBe("");
  });
});

describe("resolveReusedTargetCred — per-target credential decision", () => {
  const configured: ManagedSurrealCred = { user: "root", pass: "root" };
  const generated: ManagedSurrealCred = { user: "laqrum_4321", pass: "GENERATED-secret" };

  // ── SAFETY PROPERTY: the dev's :8000 external Docker container. ──────────
  // findExistingLaqrumcodeSurreal returns pid === null for an external port, so
  // the daemon MUST connect with exactly the CONFIGURED creds (root:root by
  // default, or SURREAL_USER/SURREAL_PASS). Byte-identical to pre-Phase-2.
  it("EXTERNAL discovered DB (pid===null) → CONFIGURED creds (UNCHANGED auth)", () => {
    const out = resolveReusedTargetCred({
      discoveredPid: null,
      credFileExists: true, // even if a cred file happens to exist locally...
      configured,
      generated,
    });
    expect(out).toEqual(configured); // ...an external target still uses configured creds.
  });

  it("EXTERNAL discovered DB with custom SURREAL_USER/PASS → those exact creds", () => {
    const custom: ManagedSurrealCred = { user: "alice", pass: "s3cr3t" };
    const out = resolveReusedTargetCred({
      discoveredPid: null,
      credFileExists: false,
      configured: custom,
      generated,
    });
    expect(out).toEqual(custom);
  });

  // ── OUR managed child, cred file present → GENERATED cred. ───────────────
  it("OUR managed child (pid!==null) + cred file present → GENERATED cred", () => {
    const out = resolveReusedTargetCred({
      discoveredPid: 12345,
      credFileExists: true,
      configured,
      generated,
    });
    expect(out).toEqual(generated);
  });

  // ── GRACEFUL MIGRATION: pre-Phase-2 root:root managed child, no cred file. ─
  it("OUR managed child (pid!==null) + NO cred file → root:root (graceful migration)", () => {
    const out = resolveReusedTargetCred({
      discoveredPid: 12345,
      credFileExists: false,
      configured: { user: "ignored", pass: "ignored" }, // must NOT leak configured here
      generated,
    });
    expect(out).toEqual({ user: "root", pass: "root" });
  });
});
