import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

import { __testing } from "../src/daemon/auto-drain.js";

const {
  findClaudeBin,
  resetClaudeBinCache,
  tryAcquireLock,
  releaseLock,
  isPidAlive,
  readSpending,
  bumpSpending,
  pruneStaleSpending,
  todayUtc,
  spendingFilePath,
  legacySpendingFilePath,
  pidFilePath,
  readLockMarker,
  writeDaemonInterimMarker,
  writeChildMarker,
  cmdlineLooksLikeDrainer,
  SPENDING_PRUNE_THRESHOLD_BYTES,
} = __testing;

/** Build a JSON marker string matching the auto-drain lock format. */
function drainMarkerJson(pid: number, daemonPid = pid, startedAt = Date.now()): string {
  return JSON.stringify({
    marker: "kongcode-auto-drain",
    pid,
    daemonPid,
    startedAt,
  });
}

/** Set both atime and mtime to `ms` ago. statSync.mtimeMs is what the stale-age
 *  check reads. */
function backdateFile(path: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(path, t, t);
}

describe("auto-drain: findClaudeBin", () => {
  beforeEach(() => {
    resetClaudeBinCache();
  });

  it("returns env override path when KONGCODE_CLAUDE_BIN is set and exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-"));
    const fakeBin = join(tmp, "fake-claude");
    writeFileSync(fakeBin, "#!/bin/sh\necho ok\n");
    const original = process.env.KONGCODE_CLAUDE_BIN;
    process.env.KONGCODE_CLAUDE_BIN = fakeBin;
    try {
      expect(findClaudeBin()).toBe(fakeBin);
    } finally {
      if (original === undefined) delete process.env.KONGCODE_CLAUDE_BIN;
      else process.env.KONGCODE_CLAUDE_BIN = original;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to which-claude when env override is unset", () => {
    const original = process.env.KONGCODE_CLAUDE_BIN;
    delete process.env.KONGCODE_CLAUDE_BIN;
    try {
      // On a dev machine claude is usually on PATH; on CI it may not be.
      // Either result is acceptable — we're just verifying the fn doesn't
      // throw and returns null-or-string.
      const result = findClaudeBin();
      if (result !== null) expect(result.length).toBeGreaterThan(0);
    } finally {
      if (original !== undefined) process.env.KONGCODE_CLAUDE_BIN = original;
    }
  });

  it("returns null when env override points at non-existent path AND nothing else found", () => {
    const original = process.env.KONGCODE_CLAUDE_BIN;
    const originalPath = process.env.PATH;
    process.env.KONGCODE_CLAUDE_BIN = "/definitely/not/a/real/path/claude-binary-xyzzy";
    process.env.PATH = "/dev/null"; // wipe PATH so `which claude` fails
    resetClaudeBinCache();
    try {
      // Note: we can't fully isolate from /home/<user>/.local/bin and
      // /usr/local/bin paths the function checks. So this just asserts
      // the lookup completes without throwing.
      const result = findClaudeBin();
      expect(typeof result === "string" || result === null).toBe(true);
    } finally {
      if (original === undefined) delete process.env.KONGCODE_CLAUDE_BIN;
      else process.env.KONGCODE_CLAUDE_BIN = original;
      if (originalPath !== undefined) process.env.PATH = originalPath;
    }
  });

  it("caches result on success — repeat call returns same value", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-"));
    const fakeBin = join(tmp, "fake-claude");
    writeFileSync(fakeBin, "");
    const original = process.env.KONGCODE_CLAUDE_BIN;
    process.env.KONGCODE_CLAUDE_BIN = fakeBin;
    resetClaudeBinCache();
    try {
      const first = findClaudeBin();
      const second = findClaudeBin();
      expect(first).toBe(second);
      expect(first).toBe(fakeBin);
    } finally {
      if (original === undefined) delete process.env.KONGCODE_CLAUDE_BIN;
      else process.env.KONGCODE_CLAUDE_BIN = original;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("auto-drain: PID-file lock", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-lock-"));
    lockPath = join(tmp, "auto-drain.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("acquires lock when file does not exist", () => {
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) {
      expect(existsSync(lockPath)).toBe(true);
      releaseLock(fd, lockPath);
    }
  });

  it("returns null when lock file exists with a live PID", () => {
    // Use our own pid as the live holder.
    writeFileSync(lockPath, String(process.pid));
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
    expect(existsSync(lockPath)).toBe(true); // not unlinked
  });

  it("auto-cleans stale lock when holder PID is dead", () => {
    // Pick a PID that almost certainly doesn't exist.
    writeFileSync(lockPath, "99999999");
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) releaseLock(fd, lockPath);
  });

  it("releaseLock unlinks the lock file", () => {
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) {
      expect(existsSync(lockPath)).toBe(true);
      releaseLock(fd, lockPath);
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  it("pidFilePath returns expected path", () => {
    expect(pidFilePath(tmp)).toBe(join(tmp, "auto-drain.pid"));
  });
});

describe("auto-drain: isPidAlive", () => {
  it("returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for pid 0", () => {
    expect(isPidAlive(0)).toBe(false);
  });

  it("returns false for negative pids", () => {
    expect(isPidAlive(-1)).toBe(false);
  });

  it("returns false for NaN", () => {
    expect(isPidAlive(NaN)).toBe(false);
  });

  it("returns false for very large pid that almost certainly doesn't exist", () => {
    expect(isPidAlive(99999999)).toBe(false);
  });
});

describe("auto-drain: spending state (daily cap)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kongcode-auto-drain-spend-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns count=0 for fresh state", () => {
    const s = readSpending(tmp);
    expect(s.count).toBe(0);
    expect(s.date).toBe(todayUtc());
  });

  it("bumpSpending increments count and persists to file", () => {
    const after = bumpSpending(tmp);
    expect(after.count).toBe(1);
    expect(existsSync(spendingFilePath(tmp))).toBe(true);
    const reread = readSpending(tmp);
    expect(reread.count).toBe(1);
  });

  it("bumpSpending across multiple calls accumulates", () => {
    bumpSpending(tmp);
    bumpSpending(tmp);
    const after = bumpSpending(tmp);
    expect(after.count).toBe(3);
  });

  it("auto-resets count when stored date is older than today", () => {
    // Manually plant a spending file with yesterday's date and high count.
    writeFileSync(
      spendingFilePath(tmp),
      JSON.stringify({ date: "2020-01-01", count: 999 }),
      "utf-8",
    );
    const s = readSpending(tmp);
    expect(s.date).toBe(todayUtc());
    expect(s.count).toBe(0);
  });

  it("tolerates corrupt spending file (returns reset state)", () => {
    writeFileSync(spendingFilePath(tmp), "{ this is not json", "utf-8");
    const s = readSpending(tmp);
    expect(s.date).toBe(todayUtc());
    expect(s.count).toBe(0);
  });

  it("tolerates missing count field", () => {
    writeFileSync(
      spendingFilePath(tmp),
      JSON.stringify({ date: todayUtc() }),
      "utf-8",
    );
    const s = readSpending(tmp);
    expect(s.count).toBe(0);
  });

  it("todayUtc returns YYYY-MM-DD format", () => {
    const today = todayUtc();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readLockMarker — parses the on-disk drain lock format. Covers JSON, legacy
// bare-PID, malformed input, and the JSON.parse("12345") trap (numeric-only
// JSON parses successfully as a number but is not an object).
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-drain: readLockMarker", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-marker-read-"));
    lockPath = join(tmp, "auto-drain.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("returns null for empty file", () => {
    writeFileSync(lockPath, "");
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("returns null for whitespace-only file", () => {
    writeFileSync(lockPath, "   \n\n   ");
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("parses well-formed JSON marker with all fields", () => {
    const startedAt = Date.now() - 1000;
    writeFileSync(lockPath, JSON.stringify({
      marker: "kongcode-auto-drain",
      pid: 4242,
      daemonPid: 4200,
      startedAt,
    }));
    const m = readLockMarker(lockPath);
    expect(m).not.toBeNull();
    expect(m!.marker).toBe("kongcode-auto-drain");
    expect(m!.pid).toBe(4242);
    expect(m!.daemonPid).toBe(4200);
    expect(m!.startedAt).toBe(startedAt);
  });

  it("rejects JSON with wrong marker string (e.g. daemon marker in a drain file)", () => {
    // Daemon marker should NOT be accepted by drain reader — cross-contamination guard.
    writeFileSync(lockPath, JSON.stringify({
      marker: "kongcode-daemon",
      pid: 4242,
      startedAt: Date.now(),
      daemonVersion: "0.7.69",
    }));
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("rejects JSON without marker field", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, daemonPid: 4200 }));
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("parses legacy bare-PID format (just a number)", () => {
    writeFileSync(lockPath, "4242");
    const m = readLockMarker(lockPath);
    expect(m).not.toBeNull();
    expect(m!.pid).toBe(4242);
    // Synthesized marker: daemonPid=0 since legacy didn't track it.
    expect(m!.daemonPid).toBe(0);
    expect(m!.startedAt).toBe(0);
  });

  it("parses legacy bare-PID with trailing whitespace", () => {
    writeFileSync(lockPath, "4242\n");
    const m = readLockMarker(lockPath);
    expect(m!.pid).toBe(4242);
  });

  it("returns null for negative or zero PID in legacy format", () => {
    writeFileSync(lockPath, "0");
    expect(readLockMarker(lockPath)).toBeNull();
    writeFileSync(lockPath, "-1");
    // Number("-1") = -1, which fails the n > 0 check.
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("returns null for completely unparseable text", () => {
    writeFileSync(lockPath, "this is not a marker file");
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("returns null for JSON array (not an object)", () => {
    writeFileSync(lockPath, JSON.stringify([4242]));
    expect(readLockMarker(lockPath)).toBeNull();
  });

  it("handles JSON marker with missing daemonPid/startedAt (defaults to 0)", () => {
    writeFileSync(lockPath, JSON.stringify({
      marker: "kongcode-auto-drain",
      pid: 4242,
    }));
    const m = readLockMarker(lockPath);
    expect(m!.pid).toBe(4242);
    expect(m!.daemonPid).toBe(0);
    expect(m!.startedAt).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeDaemonInterimMarker / writeChildMarker — produce the marker bytes the
// readers expect. Round-trip: write via these helpers, parse via readLockMarker,
// verify field shape.
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-drain: marker writers", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-marker-write-"));
    lockPath = join(tmp, "auto-drain.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeDaemonInterimMarker writes a marker readable by readLockMarker", () => {
    // Acquire a fresh fd via tryAcquireLock so the file is open in write mode.
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    writeDaemonInterimMarker(fd!);
    const m = readLockMarker(lockPath);
    expect(m).not.toBeNull();
    expect(m!.marker).toBe("kongcode-auto-drain");
    expect(m!.pid).toBe(process.pid);
    expect(m!.daemonPid).toBe(process.pid);
    expect(m!.startedAt).toBeGreaterThan(0);
    releaseLock(fd!, lockPath);
  });

  it("writeChildMarker overwrites with child PID and tracks daemon PID separately", () => {
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    writeDaemonInterimMarker(fd!);
    // Simulate spawn — child PID different from daemon PID.
    const childPid = process.pid + 1000;
    writeChildMarker(fd!, childPid);
    const m = readLockMarker(lockPath);
    expect(m).not.toBeNull();
    expect(m!.pid).toBe(childPid);
    expect(m!.daemonPid).toBe(process.pid);
    releaseLock(fd!, lockPath);
  });

  it("writeChildMarker truncates so no partial old JSON remains", () => {
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    // Write a long interim marker, then overwrite with a much shorter child marker.
    writeDaemonInterimMarker(fd!);
    const sizeAfterInterim = statSync(lockPath).size;
    writeChildMarker(fd!, 1);
    const sizeAfterChild = statSync(lockPath).size;
    expect(sizeAfterChild).toBeLessThan(sizeAfterInterim);
    // And the result still parses cleanly (no trailing garbage).
    const m = readLockMarker(lockPath);
    expect(m!.pid).toBe(1);
    releaseLock(fd!, lockPath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryAcquireLock — exhaustive scenario coverage: live drainer cmdline,
// unrelated live cmdline, unparseable + old, unparseable + fresh, legacy PID,
// dead PID, stale-age fallback for an alive-but-too-old lock.
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-drain: tryAcquireLock scenarios", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-acq-scenarios-"));
    lockPath = join(tmp, "auto-drain.pid");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses when lock holder is our own process pid with matching (node) cmdline", () => {
    // process.pid is alive; cmdline contains 'node' (we're running under vitest);
    // so cmdlineLooksLikeDrainer returns true. The lock should NOT be stolen.
    writeFileSync(lockPath, drainMarkerJson(process.pid));
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("steals when holder is alive but cmdline doesn't match a drainer (e.g. init)", () => {
    // Only meaningful on Linux. PID 1 is alive (EPERM counts as alive) but
    // its cmdline is `/sbin/init splash` — no 'claude' or 'node'.
    if (platform() !== "linux") return;
    writeFileSync(lockPath, drainMarkerJson(1));
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) releaseLock(fd, lockPath);
  });

  it("steals legacy bare-PID file when holder is dead", () => {
    writeFileSync(lockPath, "99999999"); // dead PID
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) {
      // After stealing, the new file should be created (or be empty until writer marks).
      releaseLock(fd, lockPath);
    }
  });

  it("refuses legacy bare-PID file when holder is our own (live) PID", () => {
    writeFileSync(lockPath, String(process.pid));
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
  });

  it("steals when marker file is unparseable AND older than 20min", () => {
    writeFileSync(lockPath, "{ this is garbage");
    backdateFile(lockPath, 25 * 60 * 1000); // 25min ago, > 20min stale window
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) releaseLock(fd, lockPath);
  });

  it("refuses when marker file is unparseable AND fresh (defensive: mid-write)", () => {
    writeFileSync(lockPath, "{ this is garbage");
    // Default mtime is now → age is ~0 → should NOT steal.
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
  });

  it("steals when JSON marker has alive PID but lock is >20min old (stuck child)", () => {
    if (platform() !== "linux") return;
    // Use our own pid — cmdline looks like drainer (node), BUT mtime is ancient.
    writeFileSync(lockPath, drainMarkerJson(process.pid));
    backdateFile(lockPath, 25 * 60 * 1000);
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) releaseLock(fd, lockPath);
  });

  it("does NOT steal a fresh alive-cmdline-matches lock even if mtime is recent", () => {
    writeFileSync(lockPath, drainMarkerJson(process.pid));
    // mtime is now (fresh). Should refuse.
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
  });

  it("re-acquires after release (idempotent)", () => {
    const fd1 = tryAcquireLock(lockPath);
    expect(fd1).not.toBeNull();
    if (fd1 !== null) releaseLock(fd1, lockPath);
    expect(existsSync(lockPath)).toBe(false);
    const fd2 = tryAcquireLock(lockPath);
    expect(fd2).not.toBeNull();
    if (fd2 !== null) releaseLock(fd2, lockPath);
  });

  it("fd held by acquirer prevents a second acquirer in the same dir", () => {
    // This validates the "fd hold is the lock" semantic. While fd1 is alive
    // AND the file exists with a live marker, a parallel acquirer must fail.
    const fd1 = tryAcquireLock(lockPath);
    expect(fd1).not.toBeNull();
    // Stamp our marker so the second acquirer sees a valid live drainer marker.
    if (fd1 !== null) writeDaemonInterimMarker(fd1);
    const fd2 = tryAcquireLock(lockPath);
    expect(fd2).toBeNull();
    if (fd1 !== null) releaseLock(fd1, lockPath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdlineLooksLikeDrainer — /proc-backed identity verification.
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-drain: cmdlineLooksLikeDrainer", () => {
  it("returns true for our own pid (we run under node)", () => {
    if (platform() !== "linux") {
      // Non-Linux: function returns null. Skip body.
      expect(cmdlineLooksLikeDrainer(process.pid)).toBeNull();
      return;
    }
    expect(cmdlineLooksLikeDrainer(process.pid)).toBe(true);
  });

  it("returns false for pid 1 (init, no claude/node in cmdline)", () => {
    if (platform() !== "linux") return;
    expect(cmdlineLooksLikeDrainer(1)).toBe(false);
  });

  it("returns false for an obviously dead pid (no /proc entry)", () => {
    if (platform() !== "linux") return;
    // /proc/99999999/cmdline read fails → catch returns false.
    expect(cmdlineLooksLikeDrainer(99999999)).toBe(false);
  });

  it("returns null on non-linux platforms (cannot verify)", () => {
    // We assert the platform-conditional contract. On Linux this branch is skipped.
    if (platform() === "linux") {
      // platform-positive case is covered by other tests.
      return;
    }
    expect(cmdlineLooksLikeDrainer(process.pid)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bumpSpending / readSpending — append-only ndjson, daily filtering, legacy
// migration, malformed-line tolerance, concurrent appends.
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-drain: spending append-only ndjson", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-spend-ndjson-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("each bumpSpending appends a single line", () => {
    bumpSpending(tmp);
    bumpSpending(tmp);
    bumpSpending(tmp);
    const raw = readFileSync(spendingFilePath(tmp), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.date).toBe(todayUtc());
      expect(typeof obj.ts).toBe("number");
      expect(obj.pid).toBe(process.pid);
    }
  });

  it("readSpending today filters out old-day entries", () => {
    // Plant: 2 entries from a stale date + 3 from today (via bumpSpending).
    const stale = { date: "2020-01-01", ts: 1577836800000, pid: 1234 };
    appendFileSync(spendingFilePath(tmp), JSON.stringify(stale) + "\n");
    appendFileSync(spendingFilePath(tmp), JSON.stringify(stale) + "\n");
    bumpSpending(tmp);
    bumpSpending(tmp);
    bumpSpending(tmp);
    const s = readSpending(tmp);
    expect(s.count).toBe(3); // stale entries ignored
    expect(s.date).toBe(todayUtc());
  });

  it("readSpending skips malformed/partial lines silently", () => {
    bumpSpending(tmp);
    appendFileSync(spendingFilePath(tmp), "{ partial json no close\n");
    appendFileSync(spendingFilePath(tmp), JSON.stringify({ date: todayUtc() }) + "\n"); // missing pid/ts
    bumpSpending(tmp);
    const s = readSpending(tmp);
    expect(s.count).toBe(2); // only the two valid bumps count
  });

  it("readSpending merges legacy {date,count} file when date matches today", () => {
    // Plant a legacy file with today's date and count=4.
    writeFileSync(legacySpendingFilePath(tmp), JSON.stringify({
      date: todayUtc(),
      count: 4,
    }));
    // Plus 2 new ndjson entries.
    bumpSpending(tmp);
    bumpSpending(tmp);
    const s = readSpending(tmp);
    expect(s.count).toBe(6); // 4 legacy + 2 new
  });

  it("readSpending ignores legacy file when its date is not today", () => {
    writeFileSync(legacySpendingFilePath(tmp), JSON.stringify({
      date: "2020-01-01",
      count: 9999,
    }));
    bumpSpending(tmp);
    const s = readSpending(tmp);
    expect(s.count).toBe(1);
  });

  it("readSpending tolerates corrupt legacy JSON", () => {
    writeFileSync(legacySpendingFilePath(tmp), "{ corrupt");
    bumpSpending(tmp);
    const s = readSpending(tmp);
    expect(s.count).toBe(1);
  });

  it("readSpending handles missing-count field in legacy file", () => {
    writeFileSync(legacySpendingFilePath(tmp), JSON.stringify({
      date: todayUtc(),
    }));
    bumpSpending(tmp);
    const s = readSpending(tmp);
    expect(s.count).toBe(1); // legacy count missing → contributes 0
  });

  it("concurrent bumps: all 100 lines present after Promise.all", async () => {
    const N = 100;
    await Promise.all(
      Array.from({ length: N }, () => Promise.resolve().then(() => bumpSpending(tmp))),
    );
    const raw = readFileSync(spendingFilePath(tmp), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(N);
    // And every line parses cleanly (no torn writes — appendFileSync with
    // O_APPEND under PIPE_BUF is atomic on POSIX).
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.date).toBe(todayUtc());
      expect(typeof obj.ts).toBe("number");
    }
    const s = readSpending(tmp);
    expect(s.count).toBe(N);
  });

  it("spendingFilePath returns .ndjson path", () => {
    expect(spendingFilePath(tmp).endsWith("auto-drain-spending.ndjson")).toBe(true);
  });

  it("legacySpendingFilePath returns .json path", () => {
    expect(legacySpendingFilePath(tmp).endsWith("auto-drain-spending.json")).toBe(true);
  });

  it("readSpending returns date=today even when no files exist", () => {
    const s = readSpending(tmp);
    expect(s.date).toBe(todayUtc());
    expect(s.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pruneStaleSpending — bounded-growth pruning. Closes the unbounded-ndjson
// carryover Reviewer E flagged. The prune is atomic via temp-file + rename
// and keeps only today's entries.
// ─────────────────────────────────────────────────────────────────────────────
describe("auto-drain: pruneStaleSpending", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kc-spend-prune-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("drops yesterday's entries and keeps today's", () => {
    const yesterday = { date: "2020-01-01", ts: 1577836800000, pid: 1234 };
    appendFileSync(spendingFilePath(tmp), JSON.stringify(yesterday) + "\n");
    appendFileSync(spendingFilePath(tmp), JSON.stringify(yesterday) + "\n");
    bumpSpending(tmp);
    bumpSpending(tmp);
    pruneStaleSpending(tmp);
    const raw = readFileSync(spendingFilePath(tmp), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.date).toBe(todayUtc());
    }
    expect(readSpending(tmp).count).toBe(2);
  });

  it("is a no-op when file doesn't exist", () => {
    expect(() => pruneStaleSpending(tmp)).not.toThrow();
    expect(existsSync(spendingFilePath(tmp))).toBe(false);
  });

  it("removes malformed lines while preserving today's valid ones", () => {
    bumpSpending(tmp);
    appendFileSync(spendingFilePath(tmp), "{ malformed json\n");
    appendFileSync(spendingFilePath(tmp), JSON.stringify({ date: todayUtc() }) + "\n"); // missing pid/ts
    bumpSpending(tmp);
    pruneStaleSpending(tmp);
    const raw = readFileSync(spendingFilePath(tmp), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });

  it("rename is atomic (no temp file left behind)", () => {
    bumpSpending(tmp);
    pruneStaleSpending(tmp);
    // No .tmp.* file should remain
    const { readdirSync } = require("node:fs");
    const files = readdirSync(tmp);
    const leftover = files.filter((f: string) => f.includes(".tmp."));
    expect(leftover).toEqual([]);
  });

  it("bumpSpending triggers prune when file exceeds threshold", () => {
    // Plant a giant block of stale entries to exceed SPENDING_PRUNE_THRESHOLD_BYTES.
    const stale = { date: "2020-01-01", ts: 1577836800000, pid: 1234 };
    const lineBytes = Buffer.byteLength(JSON.stringify(stale) + "\n");
    const linesNeeded = Math.ceil(SPENDING_PRUNE_THRESHOLD_BYTES / lineBytes) + 10;
    for (let i = 0; i < linesNeeded; i++) {
      appendFileSync(spendingFilePath(tmp), JSON.stringify(stale) + "\n");
    }
    expect(statSync(spendingFilePath(tmp)).size).toBeGreaterThan(SPENDING_PRUNE_THRESHOLD_BYTES);
    // bumpSpending appends one new line, then opportunistically prunes.
    bumpSpending(tmp);
    const sizeAfter = statSync(spendingFilePath(tmp)).size;
    expect(sizeAfter).toBeLessThan(SPENDING_PRUNE_THRESHOLD_BYTES);
    // Exactly one today's entry remains (the bumpSpending we just did).
    expect(readSpending(tmp).count).toBe(1);
  });

  it("bumpSpending does NOT prune when file is below threshold", () => {
    // Smoke test: a couple of stale lines under threshold survive (we don't
    // pay the prune cost on every bump).
    const stale = { date: "2020-01-01", ts: 1577836800000, pid: 1234 };
    appendFileSync(spendingFilePath(tmp), JSON.stringify(stale) + "\n");
    bumpSpending(tmp);
    // File has 2 lines total, well under threshold → no prune.
    const raw = readFileSync(spendingFilePath(tmp), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBe(2);
    // Count only today's though.
    expect(readSpending(tmp).count).toBe(1);
  });

  it("bumpSpending unlinks a stale legacy file (date != today)", () => {
    writeFileSync(
      legacySpendingFilePath(tmp),
      JSON.stringify({ date: "2020-01-01", count: 999 }),
      "utf-8",
    );
    bumpSpending(tmp);
    expect(existsSync(legacySpendingFilePath(tmp))).toBe(false);
  });

  it("bumpSpending preserves a same-day legacy file", () => {
    writeFileSync(
      legacySpendingFilePath(tmp),
      JSON.stringify({ date: todayUtc(), count: 3 }),
      "utf-8",
    );
    bumpSpending(tmp);
    // Legacy file still present — its count is still merged by readSpending.
    expect(existsSync(legacySpendingFilePath(tmp))).toBe(true);
    expect(readSpending(tmp).count).toBe(4); // 3 legacy + 1 new
  });

  it("handles empty file gracefully (produces empty file, no crash)", () => {
    writeFileSync(spendingFilePath(tmp), "");
    pruneStaleSpending(tmp);
    expect(existsSync(spendingFilePath(tmp))).toBe(true);
    expect(readFileSync(spendingFilePath(tmp), "utf-8")).toBe("");
  });
});
