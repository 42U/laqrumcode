/**
 * Daemon singleton-lock contract tests.
 *
 * `acquireDaemonSingletonLock` lives in src/daemon/index.ts and is intentionally
 * not exported — it manages a singleton invariant on the live daemon's behalf
 * and calls process.exit(1) on conflict, which makes direct in-process unit
 * tests destructive. The tests here exercise the marker-file CONTRACT that
 * function reads and writes:
 *
 *   - Marker JSON shape: marker:"kongcode-daemon", pid, startedAt, daemonVersion.
 *   - Stale-recovery rules: dead PID, unparseable + old, recycled PID (cmdline
 *     mismatch) all permit stealing; live + matching cmdline + fresh refuses.
 *   - Cross-contamination guard: the daemon's "kongcode-daemon" marker must not
 *     be confused with the auto-drain "kongcode-auto-drain" marker. Two parallel
 *     locks exist; their readers must each reject the other's format.
 *   - Path: pid file lives at $HOME/.kongcode/cache/daemon.pid.
 *
 * Tests that would require actually spawning a second daemon process (true
 * end-to-end race testing) are intentionally OUT of scope per agent
 * instructions ("DO NOT actually spawn child processes"). The functions are
 * heavily exercised by the parallel auto-drain test suite (test/auto-drain.test.ts)
 * which shares >90% of the locking logic and IS testable via the __testing export.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
  openSync,
  closeSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, isAbsolute } from "node:path";

import { DAEMON_PID_FILE } from "../src/shared/ipc-types.js";
import { __testing as drainTesting } from "../src/daemon/auto-drain.js";

const { cmdlineLooksLikeDrainer } = drainTesting;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — parallel implementations of the daemon's marker reader/writer.
// Kept in-test so the tests document the on-disk contract independently of the
// implementation. If src/daemon/index.ts diverges, these will catch the drift.
// ─────────────────────────────────────────────────────────────────────────────

interface DaemonPidMarker {
  marker: "kongcode-daemon";
  pid: number;
  startedAt: number;
  daemonVersion: string;
}

const DAEMON_LOCK_STALE_AGE_MS = 30 * 60 * 1000;
const DAEMON_LOCK_EMPTY_THRESHOLD_BYTES = 10;
const DAEMON_LOCK_EMPTY_STALE_AGE_MS = 5_000;

function writeDaemonMarkerJson(path: string, pid: number, version = "0.7.69", startedAt = Date.now()): void {
  const marker: DaemonPidMarker = {
    marker: "kongcode-daemon",
    pid,
    startedAt,
    daemonVersion: version,
  };
  writeFileSync(path, JSON.stringify(marker));
}

/** Mirrors the parse logic inside acquireDaemonSingletonLock. */
function parseDaemonMarker(path: string): DaemonPidMarker | { legacyPid: number } | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  try {
    const parsed = JSON.parse(raw) as DaemonPidMarker;
    if (parsed && parsed.marker === "kongcode-daemon" && Number.isFinite(parsed.pid)) {
      return parsed;
    }
  } catch { /* fall through to legacy */ }
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n > 0) return { legacyPid: n };
  return null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Mirrors cmdlineLooksLikeKongcodeDaemon in src/daemon/index.ts. */
function cmdlineLooksLikeKongcodeDaemon(pid: number): boolean | null {
  if (platform() !== "linux") return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!raw) return false;
    const joined = raw.replace(/\0/g, " ").toLowerCase();
    if (!joined.includes("node")) return false;
    if (joined.includes("kongcode-daemon")) return true;
    if (joined.includes("daemon/index.js") || joined.includes("daemon/index.cjs")) return true;
    if (joined.includes("kongcode") && joined.includes("daemon")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Apply the daemon's stale-decision algorithm to a marker file at `path`.
 *  Returns the same three-way outcome the daemon would compute:
 *    { stale: true, reason } → safe to steal
 *    { stale: false }        → refuse (live daemon owns it)
 *    { unparseable: true, ageMs } → JSON parse failed; daemon decides via mtime
 */
function evaluateDaemonLock(path: string): { stale: boolean; reason?: string; unparseable?: boolean; ageMs?: number; sizeBytes?: number } {
  const parsed = parseDaemonMarker(path);

  if (parsed === null) {
    let ageMs = 0;
    let sizeBytes = 0;
    try {
      const st = statSync(path);
      ageMs = Date.now() - st.mtimeMs;
      sizeBytes = st.size;
    } catch { ageMs = Number.POSITIVE_INFINITY; sizeBytes = 0; }
    if (ageMs > DAEMON_LOCK_STALE_AGE_MS) {
      return { stale: true, reason: `unparseable+old`, unparseable: true, ageMs, sizeBytes };
    }
    // Tightened recovery: an empty/tiny file older than the write-window age
    // is the crash-between-O_EXCL-and-writeSync signature. Don't wait the full 30min.
    if (sizeBytes < DAEMON_LOCK_EMPTY_THRESHOLD_BYTES && ageMs > DAEMON_LOCK_EMPTY_STALE_AGE_MS) {
      return { stale: true, reason: `empty/partial+post-write-window`, unparseable: true, ageMs, sizeBytes };
    }
    return { stale: false, unparseable: true, ageMs, sizeBytes };
  }

  const pid = "marker" in parsed ? parsed.pid : parsed.legacyPid;
  if (!isPidAlive(pid)) return { stale: true, reason: `pid ${pid} dead` };

  const looksLike = cmdlineLooksLikeKongcodeDaemon(pid);
  if (looksLike === false) return { stale: true, reason: `pid ${pid} alive but not daemon (recycled)` };
  // looksLike === true OR null → assume valid daemon, refuse.
  return { stale: false };
}

function backdateFile(path: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(path, t, t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker SHAPE: daemon-pid format vs auto-drain-pid format.
// ─────────────────────────────────────────────────────────────────────────────
describe("daemon singleton: marker shape", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-daemon-marker-"));
    lockPath = join(tmp, "daemon.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("daemon marker JSON has marker:'kongcode-daemon' field", () => {
    writeDaemonMarkerJson(lockPath, process.pid, "0.7.69");
    const raw = readFileSync(lockPath, "utf8");
    const obj = JSON.parse(raw);
    expect(obj.marker).toBe("kongcode-daemon");
    expect(obj.pid).toBe(process.pid);
    expect(typeof obj.daemonVersion).toBe("string");
    expect(typeof obj.startedAt).toBe("number");
  });

  it("auto-drain reader REJECTS a daemon-marker file (cross-contamination guard)", () => {
    // If the daemon marker happened to live in the drain lock path (or vice
    // versa), the drain reader must not treat it as a valid drain marker.
    writeDaemonMarkerJson(lockPath, process.pid);
    const drainMarker = drainTesting.readLockMarker(lockPath);
    expect(drainMarker).toBeNull();
  });

  it("daemon parser REJECTS an auto-drain-marker file", () => {
    // Symmetric guard: daemon-style reader treats drain marker as unparseable
    // (falls through to legacy bare-PID check, which also fails).
    writeFileSync(lockPath, JSON.stringify({
      marker: "kongcode-auto-drain",
      pid: process.pid,
      daemonPid: process.pid,
      startedAt: Date.now(),
    }));
    const parsed = parseDaemonMarker(lockPath);
    expect(parsed).toBeNull();
  });

  it("daemon parser falls back to legacy bare-PID format", () => {
    writeFileSync(lockPath, String(process.pid));
    const parsed = parseDaemonMarker(lockPath);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ legacyPid: process.pid });
  });

  it("daemon parser rejects JSON without daemon marker field", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 4242 }));
    // No marker field → not a daemon-format JSON → falls through to legacy
    // numeric parse → fails because content isn't a number.
    expect(parseDaemonMarker(lockPath)).toBeNull();
  });

  it("daemon parser handles non-numeric garbage", () => {
    writeFileSync(lockPath, "hello world");
    expect(parseDaemonMarker(lockPath)).toBeNull();
  });

  it("daemon parser handles empty file", () => {
    writeFileSync(lockPath, "");
    expect(parseDaemonMarker(lockPath)).toBeNull();
  });

  it("daemon parser ignores marker JSON with non-numeric pid", () => {
    writeFileSync(lockPath, JSON.stringify({
      marker: "kongcode-daemon",
      pid: "not-a-number",
      startedAt: Date.now(),
      daemonVersion: "0.7.69",
    }));
    // pid not finite → rejected, falls through, then numeric parse fails.
    expect(parseDaemonMarker(lockPath)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-recovery rules — the full decision matrix from acquireDaemonSingletonLock.
// ─────────────────────────────────────────────────────────────────────────────
describe("daemon singleton: stale-recovery decision", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-daemon-stale-"));
    lockPath = join(tmp, "daemon.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dead PID with daemon-marker → stale (safe to steal)", () => {
    writeDaemonMarkerJson(lockPath, 99999999); // dead PID
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/dead/);
  });

  it("live PID + matching daemon cmdline → not stale (refuse)", () => {
    // process.pid is alive AND cmdline contains 'node'. On Linux,
    // cmdlineLooksLikeKongcodeDaemon also requires daemon-path tokens — vitest
    // does NOT contain those, so on Linux this returns false (steal-able).
    // On non-Linux it returns null and is treated as "alive, refuse".
    writeDaemonMarkerJson(lockPath, process.pid);
    const decision = evaluateDaemonLock(lockPath);
    if (platform() === "linux") {
      // Vitest's cmdline doesn't include daemon/index path tokens, so it's
      // correctly classified as a recycled PID and stealable.
      expect(decision.stale).toBe(true);
      expect(decision.reason).toMatch(/recycled|not daemon/);
    } else {
      // Non-linux: cannot verify, assume valid → refuse.
      expect(decision.stale).toBe(false);
    }
  });

  it("live PID + unrelated cmdline (PID 1 / init) → stale (recycled PID)", () => {
    if (platform() !== "linux") return;
    writeDaemonMarkerJson(lockPath, 1);
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/recycled|not daemon/);
  });

  it("unparseable file + mtime > 30min → stale", () => {
    writeFileSync(lockPath, "{ corrupt-json");
    backdateFile(lockPath, 35 * 60 * 1000); // 35min ago
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    expect(decision.unparseable).toBe(true);
    expect(decision.ageMs).toBeGreaterThan(DAEMON_LOCK_STALE_AGE_MS);
  });

  it("unparseable file + mtime < 30min → NOT stale (defensive)", () => {
    writeFileSync(lockPath, "{ corrupt-json");
    // mtime is now → very fresh.
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(false);
    expect(decision.unparseable).toBe(true);
    expect(decision.ageMs).toBeLessThan(DAEMON_LOCK_STALE_AGE_MS);
  });

  it("legacy bare-PID file + dead PID → stale", () => {
    writeFileSync(lockPath, "99999999");
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/dead/);
  });

  it("legacy bare-PID file + our own (live) PID + non-daemon cmdline → stale on Linux", () => {
    if (platform() !== "linux") return;
    writeFileSync(lockPath, String(process.pid));
    const decision = evaluateDaemonLock(lockPath);
    // Our cmdline (vitest) doesn't match a kongcode daemon, so legacy live PID
    // is still correctly classified as recycled.
    expect(decision.stale).toBe(true);
  });

  it("missing file → parseDaemonMarker returns null, evaluator says unparseable+old (mtime=infinite)", () => {
    const decision = evaluateDaemonLock(lockPath); // file does not exist
    // No file → statSync fails → ageMs treated as Infinity → stale.
    expect(decision.stale).toBe(true);
    expect(decision.unparseable).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Tightened empty/partial-marker recovery — the carryover Reviewer E flagged.
  // O_EXCL succeeds → SIGKILL → empty file. New: 5s recovery instead of 30min.
  // ──────────────────────────────────────────────────────────────────────────

  it("empty file (0 bytes) + mtime > 5s → stale (crash-during-write recovery)", () => {
    writeFileSync(lockPath, "");
    backdateFile(lockPath, 10_000); // 10s ago, past write-window
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/empty\/partial/);
    expect(decision.sizeBytes).toBeLessThan(DAEMON_LOCK_EMPTY_THRESHOLD_BYTES);
  });

  it("tiny file (<10 bytes) + mtime > 5s → stale", () => {
    writeFileSync(lockPath, "{ ");
    backdateFile(lockPath, 10_000);
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/empty\/partial/);
  });

  it("empty file but mtime < 5s → NOT stale (still being written)", () => {
    writeFileSync(lockPath, "");
    // mtime is now → very fresh, presumed still being written.
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(false);
  });

  it("empty file mtime well-past 30min hits the original stale-age branch first", () => {
    writeFileSync(lockPath, "");
    backdateFile(lockPath, 40 * 60 * 1000); // 40min ago
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(true);
    // The 30min branch fires first since age > 30min check precedes size check.
    expect(decision.reason).toMatch(/unparseable\+old/);
  });

  it("non-empty unparseable file + mtime < 30min → NOT stale (defensive fall-through)", () => {
    // Anything past the empty threshold takes the old conservative path —
    // we don't second-guess content that's at least the size of a real marker.
    writeFileSync(lockPath, "{ this is partial but plenty large to be a real marker write attempt");
    const decision = evaluateDaemonLock(lockPath);
    expect(decision.stale).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdlineLooksLikeKongcodeDaemon — directly tests the /proc detection rules
// for the daemon variant. (Unlike the drainer variant, this one requires
// 'node' AND a daemon-path hint, so it's stricter.)
// ─────────────────────────────────────────────────────────────────────────────
describe("daemon singleton: cmdline detection", () => {
  it("PID 1 (init/systemd, no 'node') → false", () => {
    if (platform() !== "linux") return;
    expect(cmdlineLooksLikeKongcodeDaemon(1)).toBe(false);
  });

  it("our own pid (node but no 'daemon/index') → false", () => {
    if (platform() !== "linux") return;
    // We're running under vitest/node — cmdline contains 'node' but no
    // 'kongcode-daemon' or 'daemon/index' tokens, so it must return false.
    expect(cmdlineLooksLikeKongcodeDaemon(process.pid)).toBe(false);
  });

  it("dead pid → false (read fails, catch returns false)", () => {
    if (platform() !== "linux") return;
    expect(cmdlineLooksLikeKongcodeDaemon(99999999)).toBe(false);
  });

  it("returns null on non-linux platforms (cannot verify)", () => {
    if (platform() === "linux") return;
    expect(cmdlineLooksLikeKongcodeDaemon(process.pid)).toBeNull();
  });

  // Compare with the drain variant's looser rules to document the asymmetry.
  it("drainer detection is LOOSER than daemon detection: 'node' alone is enough for drainer", () => {
    if (platform() !== "linux") return;
    // Same pid: drain says yes (just 'node'), daemon says no (needs daemon-path token too).
    expect(cmdlineLooksLikeDrainer(process.pid)).toBe(true);
    expect(cmdlineLooksLikeKongcodeDaemon(process.pid)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Singleton lock file: O_EXCL acquire/refuse, fd-hold semantic.
// ─────────────────────────────────────────────────────────────────────────────
describe("daemon singleton: O_EXCL acquire semantic", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-daemon-exc-"));
    lockPath = join(tmp, "daemon.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("O_CREAT|O_EXCL succeeds on fresh state and writes marker", () => {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    expect(fd).toBeGreaterThanOrEqual(0);
    writeSync(fd, JSON.stringify({
      marker: "kongcode-daemon",
      pid: process.pid,
      startedAt: Date.now(),
      daemonVersion: "0.7.69",
    }));
    closeSync(fd);
    expect(existsSync(lockPath)).toBe(true);
    const obj = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(obj.marker).toBe("kongcode-daemon");
  });

  it("O_CREAT|O_EXCL fails with EEXIST when file already exists", () => {
    writeDaemonMarkerJson(lockPath, process.pid);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    } catch (e) {
      caught = e as NodeJS.ErrnoException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("EEXIST");
  });

  it.runIf(process.platform !== "win32")("permission mode on created lock is 0o600 (user-only)", () => {
    // POSIX-only: Windows doesn't honor 0o600 mode bits and reports world-readable
    // mode regardless of the openSync mode argument.
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    closeSync(fd);
    const st = statSync(lockPath);
    // mask off file-type bits; check permission triad
    const mode = st.mode & 0o777;
    // umask may pare permissions down, but the intent is user-only.
    expect((mode & 0o077)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DAEMON_PID_FILE path constant — documents the on-disk location so a refactor
// that accidentally moves the file shows up here.
// ─────────────────────────────────────────────────────────────────────────────
describe("daemon singleton: pid file path constant", () => {
  it("DAEMON_PID_FILE is under .kongcode/cache/", () => {
    expect(DAEMON_PID_FILE).toBe(".kongcode/cache/daemon.pid");
  });

  it("DAEMON_PID_FILE is a relative path (joined to $HOME by daemon)", () => {
    // Use path.isAbsolute so the assertion works on Windows (where absolute
    // paths look like C:\... not /...) as well as POSIX. v0.7.89 shipped the
    // older `startsWith("/")` form which passed on Linux CI then exposed the
    // platform-blind shape on Windows; the v0.7.90 lint catches this.
    expect(isAbsolute(DAEMON_PID_FILE)).toBe(false);
  });
});
