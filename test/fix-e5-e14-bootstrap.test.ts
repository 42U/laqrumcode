/**
 * Regression tests for the bootstrap enterprise-readiness lane:
 *
 *   E5 (HIGH) — multi-OS-user Windows port collision in pickPort().
 *     Before the fix, pickPort() returned the FLAT legacy 18765 for EVERY
 *     Windows account (the getuid===null branch). Two users on one Windows host
 *     therefore both tried to bind 18765: the 2nd user's daemon failed to bind,
 *     adopted the 1st user's DB, was rejected by the per-install cred, and
 *     wedged in degraded mode. The fix derives a PER-USER port on Windows too,
 *     offsetting LEGACY_MANAGED_SURREAL_PORT by a stable hash of
 *     os.userInfo().username — the same window/shape resolveTcpPort()
 *     (daemon-spawn.ts) uses for the IPC port — so two accounts land on
 *     different ports and never collide.
 *
 *   E14 — create-then-narrow race on the managed-SurrealDB root credential.
 *     Before the fix, getOrCreateManagedCred() wrote the cred with a plain
 *     writeFileSync (default 0666 & umask) and only THEN chmod-narrowed to 0600
 *     — a window where the secret was world-readable. And the parent (~/.laqrumcode)
 *     was mkdir'd without narrowing to 0700. The fix writes with {mode:0o600}
 *     (created at 0600 atomically) and chmods the parent dir to 0700.
 *
 * Both units live in src/engine/bootstrap.ts and are tested without standing up
 * the full bootstrap (no downloads, no SurrealDB child).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// pickPort() reads os.userInfo() through a module-level named import, and a
// named ESM binding can't be patched from the test after the fact (the binding
// is frozen and node:os's userInfo is non-configurable). So we partial-mock
// node:os at load time: keep every real export (tmpdir etc.) and route only
// userInfo through a controllable stub. `_userInfoStub` is the live knob the
// withUsername() helper turns; vi.mock is hoisted above the imports so this is
// in place before bootstrap.ts pulls userInfo in.
let _userInfoStub: (() => { username: string }) | null = null;
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: (...args: unknown[]) =>
      _userInfoStub ? _userInfoStub() : (actual.userInfo as (...a: unknown[]) => unknown)(...args),
  };
});

import {
  pickPort,
  getOrCreateManagedCred,
  LEGACY_MANAGED_SURREAL_PORT,
  MANAGED_SURREAL_PORT_RANGE,
} from "../src/engine/bootstrap.js";

// ── shared test seams ──────────────────────────────────────────────────────

/** Cross-platform getuid swap. process.getuid is ABSENT on Windows, so a spy
 *  throws there; assign/restore (or delete) the property directly so these
 *  POSIX-semantics tests run on every CI platform. uid===undefined exercises
 *  the Windows / no-getuid branch on a POSIX runner. Mirrors the helper in
 *  multi-user-isolation.test.ts. */
function withGetuid<T>(uid: number | undefined, fn: () => T): T {
  const p = process as { getuid?: () => number };
  const orig = p.getuid;
  if (uid === undefined) delete p.getuid;
  else p.getuid = () => uid;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete p.getuid;
    else p.getuid = orig;
  }
}

/** Drive the mocked os.userInfo().username for the duration of fn. Pass a string
 *  for a normal account name, or a thunk that throws to model userInfo() failing
 *  (e.g. a uid with no /etc/passwd entry). */
function withUsername<T>(username: string | (() => never), fn: () => T): T {
  const prev = _userInfoStub;
  _userInfoStub = () => {
    if (typeof username === "function") return username();
    return { username };
  };
  try {
    return fn();
  } finally {
    _userInfoStub = prev;
  }
}

// ── E5: per-user Windows managed-SurrealDB port ─────────────────────────────

describe("E5: pickPort derives a PER-USER managed port on Windows (no more flat 18765)", () => {
  const origPort = process.env.LAQRUMCODE_SURREAL_PORT;
  afterEach(() => {
    if (origPort === undefined) delete process.env.LAQRUMCODE_SURREAL_PORT;
    else process.env.LAQRUMCODE_SURREAL_PORT = origPort;
  });

  it("two DIFFERENT usernames yield DISTINCT ports in the uid===null (Windows) path", () => {
    delete process.env.LAQRUMCODE_SURREAL_PORT;
    const portFor = (name: string) =>
      withGetuid(undefined, () => withUsername(name, () => pickPort()));
    const alice = portFor("alice");
    const bob = portFor("bob");
    const carol = portFor("Administrator");
    expect(alice).not.toBe(bob);
    expect(bob).not.toBe(carol);
    expect(alice).not.toBe(carol);
    // ...and none of them is the old flat default (that WAS the collision bug).
    for (const p of [alice, bob, carol]) {
      expect(p).not.toBe(LEGACY_MANAGED_SURREAL_PORT);
    }
  });

  it("the Windows derivation is DETERMINISTIC (same username → same port)", () => {
    delete process.env.LAQRUMCODE_SURREAL_PORT;
    const a = withGetuid(undefined, () => withUsername("zero", () => pickPort()));
    const b = withGetuid(undefined, () => withUsername("zero", () => pickPort()));
    expect(a).toBe(b);
  });

  it("every Windows-derived port stays inside the managed-SurrealDB window [18765, 28764]", () => {
    delete process.env.LAQRUMCODE_SURREAL_PORT;
    for (const name of ["alice", "bob", "Administrator", "SYSTEM", "zero", "x".repeat(64)]) {
      const p = withGetuid(undefined, () => withUsername(name, () => pickPort()));
      expect(p).toBeGreaterThanOrEqual(LEGACY_MANAGED_SURREAL_PORT);
      expect(p).toBeLessThan(LEGACY_MANAGED_SURREAL_PORT + MANAGED_SURREAL_PORT_RANGE);
      // Disjoint from the daemon IPC window (PORT_OFFSET_BASE=28765) and the UI
      // window — both start ABOVE this ceiling — and below the 32768 ephemeral
      // floor. The window ceiling is 28764.
      expect(p).toBeLessThanOrEqual(28764);
    }
  });

  it("an explicit LAQRUMCODE_SURREAL_PORT override still wins on Windows (operator intent)", () => {
    process.env.LAQRUMCODE_SURREAL_PORT = "29999";
    const p = withGetuid(undefined, () => withUsername("alice", () => pickPort()));
    expect(p).toBe(29999);
  });

  it("degenerate case (no getuid AND no/empty username) falls back to flat 18765", () => {
    delete process.env.LAQRUMCODE_SURREAL_PORT;
    // Empty username → flat default (the only safe choice; isolation then leans
    // on the per-install cred + process-owner guard).
    const empty = withGetuid(undefined, () => withUsername("", () => pickPort()));
    expect(empty).toBe(LEGACY_MANAGED_SURREAL_PORT);
    // userInfo() throwing (e.g. uid with no /etc/passwd entry) → also flat.
    const threw = withGetuid(undefined, () =>
      withUsername(() => { throw new Error("SystemError: uv_os_get_passwd"); }, () => pickPort()),
    );
    expect(threw).toBe(LEGACY_MANAGED_SURREAL_PORT);
  });

  it("the POSIX uid path is unchanged (regression guard for the non-Windows branch)", () => {
    delete process.env.LAQRUMCODE_SURREAL_PORT;
    withGetuid(1234, () => expect(pickPort()).toBe(LEGACY_MANAGED_SURREAL_PORT + 1234));
    withGetuid(412345, () => expect(pickPort()).toBe(LEGACY_MANAGED_SURREAL_PORT + 2345)); // %10000
  });
});

// ── E14: cred file created at 0600, parent dir 0700 ─────────────────────────

const tmpRoots: string[] = [];
function mkCacheDir(label: string): string {
  const root = join(tmpdir(), `kc-e14-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  tmpRoots.push(root);
  return cacheDir;
}
// The cred lands at the PARENT of cacheDir (<root>/surreal-cred.json), mirroring
// production's ~/.laqrumcode/surreal-cred.json sitting beside ~/.laqrumcode/cache.
function credPathFor(cacheDir: string): string {
  return join(dirname(cacheDir), "surreal-cred.json");
}

afterEach(() => {
  for (const r of tmpRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpRoots.length = 0;
});

describe("E14: managed cred is created at 0600 (no create-then-narrow race) and parent is 0700", () => {
  // statSync().mode bits are meaningless on win32 (always reports 0666-ish), so
  // the permission assertions are POSIX-only; the write must still succeed there.
  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("writes the cred file with owner-only 0600 perms", () => {
    const cacheDir = mkCacheDir("perms");
    const cred = getOrCreateManagedCred(cacheDir);
    expect(cred.user).toMatch(/^laqrum/);
    expect(cred.pass.length).toBeGreaterThan(0);
    const p = credPathFor(cacheDir);
    const mode = statSync(p).mode;
    // No group/other bits at all — the property that closes the world-readable
    // window the old create-then-chmod left open.
    expect(mode & 0o077).toBe(0);
    expect(mode & 0o600).toBe(0o600);
  });

  posixOnly("narrows the parent (~/.laqrumcode) directory to 0700", () => {
    const cacheDir = mkCacheDir("parentdir");
    getOrCreateManagedCred(cacheDir);
    const parent = dirname(credPathFor(cacheDir)); // == <root>, the cred's dir
    const mode = statSync(parent).mode;
    expect(mode & 0o077).toBe(0); // no group/other access to the dir holding the secret
  });

  it("the cred-write call site passes mode 0o600 to writeFileSync (static guard)", async () => {
    // Belt-and-suspenders for win32 where the perm bits can't be asserted at
    // runtime: prove the source actually requests 0600 at create time rather
    // than relying solely on the post-hoc chmod.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "..", "src", "engine", "bootstrap.ts"), "utf8");
    // The cred write must include a mode:0o600 option object (created at 0600),
    // and the parent dir must be chmod'd 0700.
    expect(src).toMatch(/writeFileSync\(\s*path,[\s\S]*?mode:\s*0o600/);
    expect(src).toMatch(/chmodSync\(dirname\(path\),\s*0o700\)/);
  });

  it("is idempotent — a second call returns the byte-identical cred (no rewrite churn)", () => {
    const cacheDir = mkCacheDir("idem");
    const first = getOrCreateManagedCred(cacheDir);
    const raw1 = readFileSync(credPathFor(cacheDir), "utf-8");
    const second = getOrCreateManagedCred(cacheDir);
    const raw2 = readFileSync(credPathFor(cacheDir), "utf-8");
    expect(second).toEqual(first);
    expect(raw2).toBe(raw1);
  });
});
