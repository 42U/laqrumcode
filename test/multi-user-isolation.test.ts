/**
 * GH #13 — industry-grade OS-user isolation (Phase 1).
 *
 * Covers the two pure/POSIX-deterministic units of the fix:
 *   1. pickPort() — UID-offset managed SurrealDB port, env override, and the
 *      no-getuid (Windows) fallback to the legacy flat port.
 *   2. findListenerUidViaProc() — the /proc-based owner lookup that the runtime
 *      owner guard uses to refuse attaching to another OS user's graph. Driven
 *      against an injected fixture /proc tree so it runs cross-platform in CI
 *      (the real kernel /proc can't be faked, hence the procRoot injection).
 *
 * The higher-level findExistingKongcodeSurreal owner-guard branching is exercised
 * indirectly here via its two building blocks; the network-fingerprint half is
 * already covered by bootstrap reuse behavior and needs a live SurrealDB.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickPort, findListenerUidViaProc, LEGACY_MANAGED_SURREAL_PORT } from "../src/engine/bootstrap.js";

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `kc-mui-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Build one row of /proc/net/tcp. local is "HEXHOST:HEXPORT" little-endian.
function tcpRow(slot: number, localHost: string, port: number, st: string, inode: string): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const local = `${localHost}:${portHex}`;
  // sl local rem st tx:rx tr:when retr uid timeout inode ...
  return `   ${slot}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 ...`;
}

// Cross-platform getuid mock. process.getuid is ABSENT on Windows, so
// vi.spyOn(process, "getuid") throws there. Assign/restore the property
// directly (deleting it to simulate the non-POSIX/Windows path) so these
// POSIX-semantics tests run on every CI platform.
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

describe("pickPort (GH #13 UID-offset managed port)", () => {
  const origPort = process.env.KONGCODE_SURREAL_PORT;

  afterEach(() => {
    if (origPort === undefined) delete process.env.KONGCODE_SURREAL_PORT;
    else process.env.KONGCODE_SURREAL_PORT = origPort;
  });

  it("KONGCODE_SURREAL_PORT override always wins", () => {
    process.env.KONGCODE_SURREAL_PORT = "29999";
    expect(pickPort()).toBe(29999);
  });

  it("offsets the legacy base port by getuid() % 10000", () => {
    delete process.env.KONGCODE_SURREAL_PORT;
    withGetuid(1234, () => expect(pickPort()).toBe(LEGACY_MANAGED_SURREAL_PORT + 1234));
  });

  it("wraps the UID offset with mod 10000 to stay in range", () => {
    delete process.env.KONGCODE_SURREAL_PORT;
    // 412345 % 10000 = 2345
    withGetuid(412345, () => expect(pickPort()).toBe(LEGACY_MANAGED_SURREAL_PORT + 2345));
  });

  it("two distinct UIDs get distinct ports (collision avoidance)", () => {
    delete process.env.KONGCODE_SURREAL_PORT;
    const a = withGetuid(1000, () => pickPort());
    const b = withGetuid(1001, () => pickPort());
    expect(a).not.toBe(b);
  });

  it("derives a per-user managed port when getuid is unavailable (Windows) — no flat collision (E5)", () => {
    delete process.env.KONGCODE_SURREAL_PORT;
    // E5: Windows OS users are NOT isolated by a flat port on loopback TCP, so
    // pickPort() now offsets the managed-Surreal port by a stable hash of the
    // username into the [LEGACY, LEGACY+10000) window (mirrors the IPC port
    // derivation). Assert it lands in-window and is deterministic per user;
    // cross-user distinctness is covered by fix-e5-e14-bootstrap.test.ts.
    const a = withGetuid(undefined, () => pickPort());
    const b = withGetuid(undefined, () => pickPort());
    expect(a).toBeGreaterThanOrEqual(LEGACY_MANAGED_SURREAL_PORT);
    expect(a).toBeLessThan(LEGACY_MANAGED_SURREAL_PORT + 10000);
    expect(a).toBe(b); // deterministic for the same username
  });
});

describe("findListenerUidViaProc (GH #13 owner guard)", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // Lay down a fixture /proc: net/tcp with a LISTEN row on `port` -> `inode`,
  // and /proc/<pid>/fd/<fd> -> socket:[<inode>], owned (by virtue of the temp
  // dir) by the current test user. statSync(.../<pid>).uid therefore equals the
  // real getuid() of the test runner.
  function layout(opts: {
    port: number;
    inode: string;
    listenHost?: string; // default IPv4 loopback (little-endian 127.0.0.1)
    pid?: number;
    linkInode?: string; // inode the fd actually points at (default = inode)
    state?: string; // tcp state hex (default 0A = LISTEN)
    statusUid?: number; // if set, also writes a status file with this Uid line
  }): { procRoot: string; pid: number } {
    root = makeTmpDir(`proc-${opts.port}`);
    const procRoot = join(root, "proc");
    mkdirSync(join(procRoot, "net"), { recursive: true });
    const host = opts.listenHost ?? "0100007F"; // 127.0.0.1
    const st = opts.state ?? "0A";
    writeFileSync(
      join(procRoot, "net", "tcp"),
      "  sl  local_address rem_address   st ...\n" +
        tcpRow(0, host, opts.port, st, opts.inode) + "\n",
    );
    const pid = opts.pid ?? 4242;
    const fdDir = join(procRoot, String(pid), "fd");
    mkdirSync(fdDir, { recursive: true });
    // A non-socket fd (a real file) plus the socket symlink, to prove we skip
    // non-socket fds and match the right inode.
    const realFile = join(root, "somefile");
    writeFileSync(realFile, "x");
    symlinkSync(realFile, join(fdDir, "0"));
    symlinkSync(`socket:[${opts.linkInode ?? opts.inode}]`, join(fdDir, "7"));
    if (opts.statusUid !== undefined) {
      writeFileSync(
        join(procRoot, String(pid), "status"),
        `Name:\tsurreal\nUid:\t${opts.statusUid}\t${opts.statusUid}\t${opts.statusUid}\t${opts.statusUid}\n`,
      );
    }
    return { procRoot, pid };
  }

  // POSIX-only: /proc + statSync().uid resolution. On Windows statSync().uid is
  // always 0 and the production guard never calls this path (caller gates on
  // getuid), so the uid-resolution assertion is meaningless there.
  it.skipIf(process.platform === "win32")("resolves the owner UID of the LISTEN socket on the port", () => {
    const { procRoot } = layout({ port: 18765, inode: "987654" });
    const uid = findListenerUidViaProc(18765, procRoot);
    // Owner of the pid dir is whoever created the temp tree == the test runner.
    expect(uid).toBe(typeof process.getuid === "function" ? process.getuid() : null);
    expect(uid).not.toBeNull();
  });

  it.skipIf(process.platform === "win32")("matches IPv6 loopback (::1) rows in net/tcp6", () => {
    root = makeTmpDir("proc-v6");
    const procRoot = join(root, "proc");
    mkdirSync(join(procRoot, "net"), { recursive: true });
    const inode = "55501";
    // ::1 in /proc/net/tcp6 is stored as 00000000000000000000000001000000.
    writeFileSync(
      join(procRoot, "net", "tcp6"),
      "  sl  local_address ... st ... inode\n" +
        tcpRow(0, "00000000000000000000000001000000", 18790, "0A", inode) + "\n",
    );
    const fdDir = join(procRoot, "9001", "fd");
    mkdirSync(fdDir, { recursive: true });
    symlinkSync(`socket:[${inode}]`, join(fdDir, "3"));
    const uid = findListenerUidViaProc(18790, procRoot);
    expect(uid).toBe(typeof process.getuid === "function" ? process.getuid() : null);
  });

  it("returns null when no LISTEN socket matches the port (nothing to adopt)", () => {
    const { procRoot } = layout({ port: 18765, inode: "111" });
    expect(findListenerUidViaProc(29999, procRoot)).toBeNull();
  });

  it("ignores non-LISTEN sockets (e.g. ESTABLISHED on the same port)", () => {
    // st = 01 (ESTABLISHED) must not be treated as a listener.
    const { procRoot } = layout({ port: 18765, inode: "222", state: "01" });
    expect(findListenerUidViaProc(18765, procRoot)).toBeNull();
  });

  it("ignores non-loopback / public binds", () => {
    // 0101A8C0 == 192.168.1.1 little-endian — not loopback or wildcard.
    const { procRoot } = layout({ port: 18765, inode: "333", listenHost: "0101A8C0" });
    expect(findListenerUidViaProc(18765, procRoot)).toBeNull();
  });

  it("matches a wildcard (0.0.0.0) bind", () => {
    const { procRoot } = layout({ port: 18765, inode: "444", listenHost: "00000000" });
    expect(findListenerUidViaProc(18765, procRoot)).not.toBeNull();
  });

  it("returns null when the matching inode has no owning fd (orphan inode)", () => {
    // Listener row references inode 999 but the fd points at a different inode.
    const { procRoot } = layout({ port: 18765, inode: "999", linkInode: "1000" });
    expect(findListenerUidViaProc(18765, procRoot)).toBeNull();
  });

  it("returns null when /proc is entirely absent", () => {
    expect(findListenerUidViaProc(18765, join(tmpdir(), "definitely-not-proc-xyz"))).toBeNull();
  });
});
