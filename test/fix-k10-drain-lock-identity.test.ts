/**
 * Regression tests for the auto-drain lock identity fixes (K10) in
 * src/daemon/auto-drain.ts.
 *
 *   K10b — releaseOnce must gate the unlink on the FULL lock identity
 *          (daemonPid AND child pid AND startedAt), not just daemonPid. A
 *          sibling drain from the SAME daemon writes a marker with the same
 *          daemonPid; the old loose check would unlink the sibling's LIVE lock
 *          when this (superseded) child exits, freeing the lock out from under
 *          a running drainer → two concurrent drainers.
 *
 *   K10a — writeChildMarker must surface the startedAt it stamps so the caller
 *          can record its full identity for that release-time check.
 *
 * The release closure is internal, but its decision is a pure comparison of
 * the recorded (daemonPid,pid,startedAt) against the on-disk marker. These
 * tests exercise that comparison through the __testing round-trip the way the
 * closure does (writeChildMarker -> readLockMarker), and would FAIL against the
 * old code where writeChildMarker returned void (no startedAt to compare) and a
 * daemonPid-only match treated a sibling's marker as "ours".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing } from "../src/daemon/auto-drain.js";

const { writeChildMarker, readLockMarker } = __testing;

/** Replicates releaseOnce's K10b ownership predicate exactly. */
function isOurs(
  lockPath: string,
  ourDaemonPid: number,
  ourChildPid: number,
  ourStartedAt: number,
): boolean {
  const marker = readLockMarker(lockPath);
  return (
    marker !== null &&
    marker.daemonPid === ourDaemonPid &&
    marker.pid === ourChildPid &&
    marker.startedAt === ourStartedAt
  );
}

describe("K10: drain lock full-identity release check", () => {
  let tmp: string;
  let lockPath: string;
  let fd: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kongcode-k10-"));
    lockPath = join(tmp, "auto-drain.pid");
    fd = openSync(lockPath, "w");
  });
  afterEach(() => {
    try { closeSync(fd); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeChildMarker returns the startedAt it stamped (round-trips via readLockMarker)", () => {
    const startedAt = writeChildMarker(fd, 4242);
    expect(typeof startedAt).toBe("number");
    const marker = readLockMarker(lockPath);
    expect(marker).not.toBeNull();
    expect(marker!.pid).toBe(4242);
    expect(marker!.daemonPid).toBe(process.pid);
    expect(marker!.startedAt).toBe(startedAt);
  });

  it("recognizes OUR own child marker as ours", () => {
    const startedAt = writeChildMarker(fd, 4242);
    expect(isOurs(lockPath, process.pid, 4242, startedAt)).toBe(true);
  });

  it("does NOT treat a sibling drain's marker (same daemon, different child) as ours", () => {
    // Our child claimed the lock...
    const ourStartedAt = writeChildMarker(fd, 4242);
    // ...then a SIBLING drain from the same daemon stole + rewrote it (same
    // daemonPid, different child pid + a later startedAt).
    const siblingFd = openSync(lockPath, "w");
    writeChildMarker(siblingFd, 9999);
    closeSync(siblingFd);

    // The old daemonPid-only check would say "ours" (same daemonPid) and
    // unlink the sibling's LIVE lock. The full-identity check must say no.
    expect(isOurs(lockPath, process.pid, 4242, ourStartedAt)).toBe(false);
  });

  it("does NOT treat a same-child-pid-but-different-startedAt marker as ours", () => {
    // Same child PID can recur (PID reuse) on a later drain; startedAt
    // disambiguates. Our recorded startedAt must not match the newer marker.
    const ourStartedAt = writeChildMarker(fd, 4242);
    // Force a distinct timestamp for the rewrite.
    const before = Date.now();
    while (Date.now() === before) { /* spin to next ms */ }
    const sibFd = openSync(lockPath, "w");
    const newerStartedAt = writeChildMarker(sibFd, 4242);
    closeSync(sibFd);

    expect(newerStartedAt).not.toBe(ourStartedAt);
    expect(isOurs(lockPath, process.pid, 4242, ourStartedAt)).toBe(false);
    // The newer marker IS ours from the sibling's perspective.
    expect(isOurs(lockPath, process.pid, 4242, newerStartedAt)).toBe(true);
  });
});
