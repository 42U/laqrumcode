/**
 * GH #13 — INTEGRATED owner-guard test for findExistingKongcodeSurreal.
 *
 * The implementer's multi-user-isolation.test.ts unit-tested the /proc helper
 * (findListenerUidViaProc) and pickPort, but NOT the guard's *effect on
 * discovery* — i.e. that findExistingKongcodeSurreal actually SKIPS a port
 * whose live, kongcode-fingerprinted SurrealDB is owned by a foreign UID.
 * This file closes that gap by driving the REAL findExistingKongcodeSurreal
 * against a REAL throwaway SurrealDB (so fetch /health + isKongcodeSurreal both
 * genuinely PASS), while injecting the owner-UID resolver to simulate a foreign
 * vs. own owner without needing a second OS account.
 *
 * THREAT MODEL ASSERTED: a fingerprint-PASS port owned by uid != getuid() must
 * never be returned (no cross-user attach). Plus the owner-undetermined branch
 * must conservatively skip managed-surface ports unless we hold our own live
 * pid file, while still allowing external shared-infra ports (8000/8042).
 *
 * Isolation: a dedicated surrealkv instance in a temp dir on an ephemeral port,
 * seeded in ns=kong / db=memory with one fingerprint table. NEVER touches the
 * production graph (no 8000/8042 writes). Temp dirs + child are cleaned up.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findExistingKongcodeSurreal,
  LEGACY_MANAGED_SURREAL_PORT,
} from "../src/engine/bootstrap.js";

const SURREAL_BIN =
  process.env.KONGCODE_SURREAL_BIN ??
  join(process.env.HOME ?? "/home/zero", ".kongcode/cache/surreal-3.0.5/surreal");

// Ephemeral high port unlikely to collide with the real managed/legacy ports.
const TEST_PORT = 28765;
const USER = "root";
const PASS = "root";

let child: ChildProcess | undefined;
let dataDir: string;
let available = false;
const tmpDirs: string[] = [];

function mkTmp(label: string): string {
  const d = join(tmpdir(), `kc-guard-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  tmpDirs.push(d);
  return d;
}

async function httpAlive(port: number, ms = 800): Promise<boolean> {
  try {
    return await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(ms),
    }).then((r) => r.ok).catch(() => false);
  } catch {
    return false;
  }
}

/** Seed ns=kong / db=memory with a fingerprint table so isKongcodeSurreal
 *  passes. SurrealDB v3 + surrealkv does NOT auto-create the namespace/database
 *  on a bare DEFINE TABLE, and INFO FOR DB against a missing ns/db fails with a
 *  read-only-transaction error — so we must explicitly DEFINE the ns, db, and
 *  one fingerprint table. Returns true only when every statement reports OK
 *  (res.ok alone is insufficient: SurrealDB returns HTTP 200 with per-statement
 *  ERR bodies). */
async function seedFingerprint(port: number): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      "surreal-ns": "kong",
      "surreal-db": "memory",
    },
    body:
      "DEFINE NAMESPACE IF NOT EXISTS kong; " +
      "DEFINE DATABASE IF NOT EXISTS memory; " +
      "DEFINE TABLE IF NOT EXISTS monologue SCHEMALESS;",
    signal: AbortSignal.timeout(3_000),
  }).catch(() => null);
  if (!res || !res.ok) return false;
  try {
    const body = (await res.json()) as Array<{ status?: string }>;
    return Array.isArray(body) && body.every((s) => s.status === "OK");
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!existsSync(SURREAL_BIN)) {
    // eslint-disable-next-line no-console
    console.warn(`surreal binary not found at ${SURREAL_BIN}; skipping guard integration tests`);
    return;
  }
  dataDir = mkTmp("data");
  child = spawn(
    SURREAL_BIN,
    ["start", `surrealkv:${dataDir}`, "--bind", `127.0.0.1:${TEST_PORT}`, "--log", "error"],
    { detached: false, env: { ...process.env, SURREAL_USER: USER, SURREAL_PASS: PASS }, stdio: "ignore" },
  );
  // Wait for readiness (up to ~10s).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await httpAlive(TEST_PORT)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (await httpAlive(TEST_PORT)) {
    available = await seedFingerprint(TEST_PORT);
  }
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn("throwaway SurrealDB did not come up / seed; guard integration tests will skip");
  }
}, 20_000);

afterAll(async () => {
  if (child && !child.killed) {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
}, 10_000);

function itLive(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => {
    if (!available) return;
    await fn();
  }, timeout);
}

const OUR_UID = typeof process.getuid === "function" ? process.getuid() : 1000;
const FOREIGN_UID = OUR_UID + 9999; // guaranteed != ours

// Resolver that claims OUR ownership ONLY for the throwaway TEST_PORT and a
// FOREIGN owner for every other probed candidate (8000/8042/18765). This is
// required because the candidate list [8000,8042,managedPort,18765] probes the
// live production DB on 8000 FIRST; without forcing it to skip, 8000 would be
// adopted before TEST_PORT is reached. Foreign-on-8000 makes the guard skip it
// (the desired isolation behavior), letting the probe fall through to TEST_PORT.
const ownOnlyTestPort = (port: number): number => (port === TEST_PORT ? OUR_UID : FOREIGN_UID);
// Resolver: owner UNDETERMINED for TEST_PORT, FOREIGN elsewhere (so 8000/8042
// skip and we reach the undetermined-owner branch on the managed TEST_PORT).
const undeterminedOnTestPort = (port: number): number | null =>
  port === TEST_PORT ? null : FOREIGN_UID;

describe("findExistingKongcodeSurreal owner guard (GH #13 integrated)", () => {
  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(join(d, "surreal.pid"), { force: true }); } catch { /* ok */ }
    }
  });

  // ── SECURITY PROPERTY ──────────────────────────────────────────────────
  // Foreign owner on the managed-surface port → MUST be skipped (not returned),
  // even though the fingerprint PASSES against the live DB.
  itLive("BREACH GUARD: skips a fingerprinted port owned by a FOREIGN uid (managed port)", async () => {
    const cacheDir = mkTmp("cache-foreign-managed");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      TEST_PORT, // treat the test port as THIS user's managed port
      USER,
      PASS,
      () => FOREIGN_UID, // injected resolver: listener owned by someone else
    );
    expect(result).toBeNull();
  }, 15_000);

  // Foreign owner reported for a NON-managed (external-class) candidate must
  // ALSO be skipped — the `ownerUid != ourUid` branch fires regardless of port
  // class. We assert this against the live external port 8000 (read-only): the
  // production kongcode DB there genuinely fingerprints PASS, but a resolver
  // reporting a foreign uid must force a skip rather than adopt it.
  itLive("BREACH GUARD: foreign uid on EXTERNAL port (8000) → skipped (no false adopt)", async () => {
    if (!(await httpAlive(8000))) return; // only if a live DB is on 8000
    const cacheDir = mkTmp("cache-foreign-8000");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      19999, // dead managed port
      USER,
      PASS,
      // Foreign owner on every probed port (8000/8042/18765). None may be adopted.
      () => FOREIGN_UID,
    );
    expect(result).toBeNull();
  }, 15_000);

  // ── REUSE PATH (a): own owner determined → ADOPT ───────────────────────
  itLive("REUSE: adopts the port when the resolver reports OUR uid", async () => {
    const cacheDir = mkTmp("cache-own-uid");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      TEST_PORT,
      USER,
      PASS,
      ownOnlyTestPort, // listener on TEST_PORT owned by us; 8000/8042 foreign→skip
    );
    expect(result).not.toBeNull();
    expect(result?.port).toBe(TEST_PORT);
    expect(result?.url).toBe(`ws://127.0.0.1:${TEST_PORT}/rpc`);
  }, 15_000);

  // ── OWNER-UNDETERMINED on managed surface, NO pid file → SKIP ──────────
  itLive("CONSERVATIVE SKIP: owner undetermined + managed port + no pid file → skip", async () => {
    const cacheDir = mkTmp("cache-unknown-nopid");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      TEST_PORT,
      USER,
      PASS,
      undeterminedOnTestPort, // undetermined on TEST_PORT; foreign elsewhere
    );
    expect(result).toBeNull();
  }, 15_000);

  // ── OWNER-UNDETERMINED on managed surface, WITH our live pid file → ADOPT
  // (single-user "Option A" reuse: we hold the live pid for our managed surreal)
  itLive("REUSE (Option A): owner undetermined + managed port + OUR live pid file → adopt", async () => {
    const cacheDir = mkTmp("cache-unknown-pid");
    // Write a real, LIVE pid file (use our own process pid — guaranteed alive).
    writeFileSync(join(cacheDir, "surreal.pid"), String(process.pid), "utf-8");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      TEST_PORT,
      USER,
      PASS,
      undeterminedOnTestPort, // undetermined on TEST_PORT; foreign elsewhere
    );
    expect(result).not.toBeNull();
    expect(result?.port).toBe(TEST_PORT);
    // pid is tracked from our live pid file for managed-surface ports.
    expect(result?.pid).toBe(process.pid);
  }, 15_000);

  // A STALE pid file (dead pid) must NOT rescue the skip → still skip.
  itLive("CONSERVATIVE SKIP: owner undetermined + managed port + STALE pid file → skip", async () => {
    const cacheDir = mkTmp("cache-unknown-stalepid");
    // PID 2^31-ish: astronomically unlikely to be live.
    writeFileSync(join(cacheDir, "surreal.pid"), "2147480000", "utf-8");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      TEST_PORT,
      USER,
      PASS,
      undeterminedOnTestPort,
    );
    expect(result).toBeNull();
  }, 15_000);

  // ── ADOPT with NULL pid: own owner on managed-surface port but no pid file.
  // Proves the managed-surface adopt path does not fabricate a pid.
  itLive("REUSE: own uid on managed port with NO pid file → adopt, pid null", async () => {
    const cacheDir = mkTmp("cache-own-nopid");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      TEST_PORT,
      USER,
      PASS,
      ownOnlyTestPort,
    );
    expect(result).not.toBeNull();
    expect(result?.port).toBe(TEST_PORT);
    // managed-surface port but no pid file → readLiveOwnSurrealPid → null.
    expect(result?.pid).toBeNull();
  }, 15_000);

  // ── CROSS-PLATFORM (Windows): no getuid → guard skipped → legacy allow ──
  // When process.getuid is absent, ourUid is null, the entire guard block is
  // bypassed, and a fingerprinted port is adopted regardless of resolver.
  itLive("WINDOWS PATH: no getuid → guard skipped → port adopted even with FOREIGN resolver", async () => {
    const cacheDir = mkTmp("cache-windows");
    const orig = process.getuid;
    // @ts-expect-error — simulate non-POSIX (Windows): remove getuid.
    delete process.getuid;
    try {
      const result = await findExistingKongcodeSurreal(
        cacheDir,
        TEST_PORT,
        USER,
        PASS,
        () => FOREIGN_UID, // would skip every port on POSIX; MUST be ignored here
      );
      // getuid absent → ourUid null → guard block entirely bypassed → the first
      // live, fingerprinted candidate is adopted despite the foreign resolver.
      // Candidate order is [8000, 8042, managedPort(TEST_PORT), 18765]; whichever
      // fingerprinted DB responds first is adopted. The load-bearing assertion is
      // that adoption HAPPENED (foreign owner did not block it on the Windows path).
      expect(result).not.toBeNull();
      expect([8000, 8042, TEST_PORT]).toContain(result?.port);
    } finally {
      process.getuid = orig;
    }
  }, 15_000);
});

// ── EXTERNAL shared-infra ALLOW, undetermined owner (8000/8042 contract) ──
// Regression guard: the pre-#13 external-DB reuse must still hold. A
// fingerprinted kongcode DB on an EXTERNAL port (8000/8042) with an
// UNDETERMINED owner must still be ADOPTED (it is NOT in managedSurfacePorts,
// so the conservative skip cannot fire). Asserted against the live 8000 DB
// READ-ONLY (findExistingKongcodeSurreal performs only /health + INFO FOR DB).
describe("findExistingKongcodeSurreal external-port allow (GH #13, undetermined owner)", () => {
  itLive("ADOPTS external port 8000 (live, read-only) when owner is undetermined", async () => {
    if (!(await httpAlive(8000))) return; // requires the production-style DB on 8000
    const cacheDir = mkTmp("cache-extallow-8000");
    const result = await findExistingKongcodeSurreal(
      cacheDir,
      19999, // dead managed port → 8000 is the first live, fingerprinted candidate
      USER,
      PASS,
      () => null, // owner cannot be determined; external port must still ALLOW
    );
    expect(result).not.toBeNull();
    expect(result?.port).toBe(8000);
    // External port → not managed-surface → pid stays null (no lifecycle mgmt).
    expect(result?.pid).toBeNull();
  }, 15_000);
});
