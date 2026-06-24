import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { sweepStaleSockets, __testing as httpApiTesting } from "../src/http-api.js";

// All existing assertions in this suite rely on alive-sibling sockets being
// PRESERVED. The reaper added in 0.4.3 would SIGTERM the test runner (which
// is process.ppid here) and kill the suite mid-run. Force keep-siblings
// semantics for those tests; the reaper has its own dedicated suite below
// where a controlled child process is the SIGTERM target.
const ORIGINAL_KEEP = process.env.LAQRUMCODE_KEEP_SIBLINGS;

describe("sweepStaleSockets — keep-siblings semantics (LAQRUMCODE_KEEP_SIBLINGS=1)", () => {
  let dir: string;

  beforeEach(() => {
    process.env.LAQRUMCODE_KEEP_SIBLINGS = "1";
    dir = mkdtempSync(join(tmpdir(), "laqrumcode-sweep-"));
  });

  afterEach(() => {
    if (ORIGINAL_KEEP === undefined) delete process.env.LAQRUMCODE_KEEP_SIBLINGS;
    else process.env.LAQRUMCODE_KEEP_SIBLINGS = ORIGINAL_KEEP;
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(name: string) {
    writeFileSync(join(dir, name), "");
  }

  it("removes socket files whose PID is dead (ESRCH)", () => {
    // PID 99999999 is well above the typical pid_max and effectively guaranteed dead.
    touch(".laqrumcode-99999999.sock");
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, ".laqrumcode-99999999.sock"))).toBe(false);
  });

  it("preserves the own-pid socket", () => {
    touch(`.laqrumcode-${process.pid}.sock`);
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `.laqrumcode-${process.pid}.sock`))).toBe(true);
  });

  it("preserves a socket whose PID is currently alive", () => {
    // Use the parent pid — guaranteed alive while this test runs.
    const aliveParent = process.ppid;
    touch(`.laqrumcode-${aliveParent}.sock`);
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `.laqrumcode-${aliveParent}.sock`))).toBe(true);
  });

  it("ignores files that don't match the .laqrumcode-<pid>.sock pattern", () => {
    touch(".laqrumcode.sock"); // legacy single-socket name — no pid
    touch(".laqrumcode-port"); // port file
    touch("random.txt");
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, ".laqrumcode.sock"))).toBe(true);
    expect(existsSync(join(dir, ".laqrumcode-port"))).toBe(true);
    expect(existsSync(join(dir, "random.txt"))).toBe(true);
  });

  it("mixed case: sweeps dead, keeps alive + own + non-matching in one pass", () => {
    touch(".laqrumcode-99999999.sock"); // dead
    touch(".laqrumcode-99999998.sock"); // dead
    touch(`.laqrumcode-${process.pid}.sock`); // own
    touch(`.laqrumcode-${process.ppid}.sock`); // alive
    touch(".laqrumcode.sock"); // legacy

    sweepStaleSockets(dir, process.pid);

    expect(existsSync(join(dir, ".laqrumcode-99999999.sock"))).toBe(false);
    expect(existsSync(join(dir, ".laqrumcode-99999998.sock"))).toBe(false);
    expect(existsSync(join(dir, `.laqrumcode-${process.pid}.sock`))).toBe(true);
    expect(existsSync(join(dir, `.laqrumcode-${process.ppid}.sock`))).toBe(true);
    expect(existsSync(join(dir, ".laqrumcode.sock"))).toBe(true);
  });

  it("is a no-op on a non-existent directory", () => {
    expect(() => sweepStaleSockets(join(dir, "does-not-exist"), process.pid)).not.toThrow();
  });
});

// The reaper's SIGTERM path depends on `cmdlineLooksLikeLaqrumcodeMcp` returning
// a definitive true/false, which it only does on Linux via /proc/<pid>/cmdline.
// On macOS/Windows the helper returns null and the sweep deliberately skips
// SIGTERM (defense-in-depth on PID recycling). Tests in this suite assert the
// SIGTERM-and-reap behavior, so they only make sense on Linux.
describe.runIf(process.platform === "linux")("sweepStaleSockets — reaper (default-on, linux)", () => {
  let dir: string;
  let child: ChildProcess | null = null;

  function touch(name: string) {
    writeFileSync(join(dir, name), "");
  }

  function spawnSleeper(): Promise<ChildProcess> {
    // Round-2 safety patch added cmdlineLooksLikeLaqrumcodeMcp(pid): before
    // SIGTERMing a sibling PID, /proc/<pid>/cmdline must contain "node" AND
    // one of the laqrumcode-MCP markers ("mcp-client/index.js", "laqrumcode-mcp",
    // or "laqrumcode" + "mcp"). A bare `bash -c "sleep 30"` won't match and the
    // reaper correctly refuses to SIGTERM it (PID-recycle protection).
    //
    // To exercise the reaper end-to-end we spawn node with a marker argument
    // so the cmdline check passes. The argv is purely cosmetic from node's
    // perspective — it never reads "laqrumcode-mcp" — but /proc/PID/cmdline
    // sees the exact bytes we exec'd with.
    return new Promise((resolve, reject) => {
      const c = spawn(
        process.execPath,
        ["-e", "setTimeout(()=>{}, 30000)", "laqrumcode-mcp"],
        { stdio: "ignore", detached: false },
      );
      c.on("error", reject);
      c.on("spawn", () => resolve(c));
    });
  }

  function waitForExit(p: ChildProcess, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      if (p.exitCode != null || p.signalCode != null) return resolve(true);
      const t = setTimeout(() => resolve(false), timeoutMs);
      p.once("exit", () => { clearTimeout(t); resolve(true); });
    });
  }

  beforeEach(() => {
    delete process.env.LAQRUMCODE_KEEP_SIBLINGS; // ensure default-on
    dir = mkdtempSync(join(tmpdir(), "laqrumcode-reap-"));
  });

  afterEach(() => {
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    child = null;
    if (ORIGINAL_KEEP !== undefined) process.env.LAQRUMCODE_KEEP_SIBLINGS = ORIGINAL_KEEP;
    rmSync(dir, { recursive: true, force: true });
  });

  it("SIGTERMs an alive sibling MCP and removes its socket file", async () => {
    child = await spawnSleeper();
    const siblingPid = child.pid!;
    touch(`.laqrumcode-${siblingPid}.sock`);

    sweepStaleSockets(dir, process.pid);

    const exited = await waitForExit(child);
    expect(exited).toBe(true);
    // On POSIX, `child.kill("SIGTERM")` produces signalCode === "SIGTERM".
    // On Windows, Node implements .kill() as TerminateProcess — the child
    // exits but signalCode stays null and exitCode reflects termination.
    // Either signature is acceptable; what matters is "the child got reaped."
    if (process.platform === "win32") {
      expect(child.signalCode === "SIGTERM" || child.exitCode !== null).toBe(true);
    } else {
      expect(child.signalCode).toBe("SIGTERM");
    }
    expect(existsSync(join(dir, `.laqrumcode-${siblingPid}.sock`))).toBe(false);
  });

  it("opt-out via LAQRUMCODE_KEEP_SIBLINGS=1 leaves the sibling alive", async () => {
    process.env.LAQRUMCODE_KEEP_SIBLINGS = "1";
    child = await spawnSleeper();
    const siblingPid = child.pid!;
    touch(`.laqrumcode-${siblingPid}.sock`);

    sweepStaleSockets(dir, process.pid);

    // Sibling should still be alive (not SIGTERMed)
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(existsSync(join(dir, `.laqrumcode-${siblingPid}.sock`))).toBe(true);
    delete process.env.LAQRUMCODE_KEEP_SIBLINGS;
  });

  it("never reaps the own-pid socket even when default-on", () => {
    touch(`.laqrumcode-${process.pid}.sock`);
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `.laqrumcode-${process.pid}.sock`))).toBe(true);
  });

  it("still removes truly-dead PID socket files (ESRCH path unchanged)", () => {
    touch(".laqrumcode-99999999.sock");
    sweepStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, ".laqrumcode-99999999.sock"))).toBe(false);
  });

  // Negative-cmdline branch: spawn a NON-node child (`bash -c 'sleep 30'`) so
  // /proc/PID/cmdline does NOT contain "node" and the laqrumcode-MCP markers
  // are absent. cmdlineLooksLikeLaqrumcodeMcp must return false, and the reaper
  // must skip SIGTERM (PID-recycle protection) — while still unlinking the
  // orphan socket file. This is the "recycled PID, innocent process"
  // scenario that the round-2 cmdline guard was added to defend against.
  it("does NOT SIGTERM an alive non-matching process (cmdline check returns false)", async function () {
    // Skip on non-Linux: /proc isn't available, cmdline check returns null,
    // and the reaper skips SIGTERM for a different reason. The behavior we're
    // exercising is specifically the Linux false-branch.
    if (process.platform !== "linux") return;

    const c = await new Promise<ChildProcess>((resolve, reject) => {
      const proc = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: false });
      proc.on("error", reject);
      proc.on("spawn", () => resolve(proc));
    });
    child = c;
    const innocentPid = c.pid!;
    touch(`.laqrumcode-${innocentPid}.sock`);

    sweepStaleSockets(dir, process.pid);

    // 1. The bash child must still be alive — cmdline didn't match, so
    //    sweepStaleSockets must NOT have SIGTERMed it.
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();
    // Briefly wait to confirm no delayed exit. Reaper's SIGTERM would have
    // fired synchronously; if the child is still here after a yield it's safe
    // to assert "not reaped".
    await new Promise((r) => setTimeout(r, 50));
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();

    // 2. The orphan socket file must have been unlinked. The reaper still
    //    cleans up the stale socket entry — it just doesn't signal the
    //    stranger process whose PID was recycled into that filename.
    expect(existsSync(join(dir, `.laqrumcode-${innocentPid}.sock`))).toBe(false);
  });
});

// ── cmdlineLooksLikeLaqrumcodeMcp: contract tests (direct unit) ────────────────
//
// The sweep reaper above exercises cmdlineLooksLikeLaqrumcodeMcp via real
// processes. These tests pin the function's three return values directly
// through the __testing export so future refactors keep the contract:
//
//   true  → laqrumcode MCP confirmed (safe to SIGTERM)
//   false → different process / PID recycled / cmdline unreadable
//   null  → non-Linux platform (cannot determine — skip SIGTERM by default)
//
describe("cmdlineLooksLikeLaqrumcodeMcp — contract", () => {
  it("returns false for a missing /proc entry (PID not running)", () => {
    if (process.platform !== "linux") return;
    // 99999999 is well above the typical pid_max — /proc/<pid>/cmdline is
    // guaranteed missing, the readFileSync throws ENOENT, the catch returns
    // false. (Caller treats this as 'stale, safe to unlink'.)
    const result = httpApiTesting.cmdlineLooksLikeLaqrumcodeMcp(99999999);
    expect(result).toBe(false);
  });

  it("returns false for a process that doesn't contain 'node' in cmdline (bash)", async () => {
    if (process.platform !== "linux") return;
    const proc = await new Promise<ChildProcess>((resolve, reject) => {
      const c = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: false });
      c.on("error", reject);
      c.on("spawn", () => resolve(c));
    });
    try {
      const result = httpApiTesting.cmdlineLooksLikeLaqrumcodeMcp(proc.pid!);
      expect(result).toBe(false);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
  });

  // Non-Linux null branch: directly mock the function via vi.doMock +
  // dynamic re-import so the module-internal platform() returns "darwin".
  // We cannot spy on the named-import `platform` once captured, so we have
  // to re-import http-api.ts with node:os mocked at module boundary. Use
  // vi.resetModules to ensure the re-import sees the mock.
  it("returns null on non-Linux (mocked platform)", async () => {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "darwin" };
    });
    try {
      const mod = await import("../src/http-api.js");
      const result = mod.__testing.cmdlineLooksLikeLaqrumcodeMcp(process.pid);
      expect(result).toBeNull();
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });
});

// ── Round-5: auth-token tmpfile sweep (startHttpApi inline sweep) ───────────
//
// The sweep at src/http-api.ts:517-541 runs at startHttpApi() entry to clean
// up `auth-token.<pid>.tmp` orphans from previously-crashed daemons. The
// logic is inline in startHttpApi (not separately exported), so this suite
// reproduces it bit-for-bit against a tmp directory, exercising the same
// `cmdlineLooksLikeLaqrumcodeMcp` helper that the real path calls. Any change
// to the production sweep rules must be mirrored here, and the source-side
// `cmdlineLooksLikeLaqrumcodeMcp` is the contract surface that decides.
//
// Sweep rules (must stay in lockstep with src/http-api.ts:517-541):
//   - file name matches /^auth-token\.(\d+)\.tmp$/ → consider for sweep
//   - PID alive (process.kill(pid,0) succeeds) AND cmdline matches laqrumcode
//     MCP → leave alone
//   - any other case (dead PID, recycled PID, non-Linux cmdline null) →
//     unlink the orphan
import { readdirSync, unlinkSync } from "node:fs";
function runAuthTokenSweep(cacheDir: string): void {
  const cacheEntries = readdirSync(cacheDir);
  for (const name of cacheEntries) {
    const m = /^auth-token\.(\d+)\.tmp$/.exec(name);
    if (!m) continue;
    const orphanPid = Number(m[1]);
    if (!Number.isFinite(orphanPid)) continue;
    let alive = true;
    try {
      process.kill(orphanPid, 0);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      alive = code !== "ESRCH";
    }
    if (alive && httpApiTesting.cmdlineLooksLikeLaqrumcodeMcp(orphanPid) === true) continue;
    try { unlinkSync(join(cacheDir, name)); } catch { /* ignore */ }
  }
}

describe("auth-token tmpfile sweep — startHttpApi inline sweep contract", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laqrumcode-authtoken-sweep-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(name: string) {
    writeFileSync(join(dir, name), "stale-token-bytes");
  }

  it("unlinks `auth-token.<deadPid>.tmp` for a known-not-alive PID", () => {
    // PID 99999999 is well above pid_max — guaranteed ESRCH.
    touch("auth-token.99999999.tmp");
    expect(existsSync(join(dir, "auth-token.99999999.tmp"))).toBe(true);

    runAuthTokenSweep(dir);

    expect(existsSync(join(dir, "auth-token.99999999.tmp"))).toBe(false);
  });

  it("does NOT unlink a tmpfile whose PID is alive AND cmdline matches laqrumcode MCP", async () => {
    if (process.platform !== "linux") return; // cmdline check is Linux-only
    // Spawn a node process with a laqrumcode-mcp argv marker so
    // cmdlineLooksLikeLaqrumcodeMcp returns true.
    const proc = await new Promise<ChildProcess>((resolve, reject) => {
      const c = spawn(
        process.execPath,
        ["-e", "setTimeout(()=>{}, 30000)", "laqrumcode-mcp"],
        { stdio: "ignore", detached: false },
      );
      c.on("error", reject);
      c.on("spawn", () => resolve(c));
    });
    try {
      const livePid = proc.pid!;
      touch(`auth-token.${livePid}.tmp`);

      runAuthTokenSweep(dir);

      // The tmpfile must remain — the live daemon owns it.
      expect(existsSync(join(dir, `auth-token.${livePid}.tmp`))).toBe(true);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
  });

  it("unlinks a live PID's tmpfile when cmdline does NOT match laqrumcode (recycled-PID guard)", async () => {
    if (process.platform !== "linux") return;
    // bash sleep — alive PID, cmdline does NOT contain node + laqrumcode markers.
    const proc = await new Promise<ChildProcess>((resolve, reject) => {
      const c = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: false });
      c.on("error", reject);
      c.on("spawn", () => resolve(c));
    });
    try {
      const innocentPid = proc.pid!;
      touch(`auth-token.${innocentPid}.tmp`);

      runAuthTokenSweep(dir);

      // The tmpfile must have been unlinked — a recycled PID now owned by an
      // unrelated process shouldn't pin a stale auth-token tmpfile.
      expect(existsSync(join(dir, `auth-token.${innocentPid}.tmp`))).toBe(false);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
  });

  it("ignores files that don't match the auth-token.<digits>.tmp pattern", () => {
    touch("auth-token"); // the real file — must survive
    touch("auth-token.tmp"); // no pid
    touch("auth-token.abc.tmp"); // non-digit pid
    touch("random.txt");

    runAuthTokenSweep(dir);

    expect(existsSync(join(dir, "auth-token"))).toBe(true);
    expect(existsSync(join(dir, "auth-token.tmp"))).toBe(true);
    expect(existsSync(join(dir, "auth-token.abc.tmp"))).toBe(true);
    expect(existsSync(join(dir, "random.txt"))).toBe(true);
  });

  it("sweeps cautiously on non-Linux: NEVER SIGTERMs and treats cmdline=null as 'not us'", async () => {
    // The sweep code path never sends SIGTERM — it only unlinks. The
    // non-Linux behavior is governed by cmdlineLooksLikeLaqrumcodeMcp returning
    // null, which the inline sweep code treats as "not us" → unlink the
    // orphan. Mock platform() to "darwin" via doMock + re-import, then run
    // an equivalent sweep using the re-imported testing surface.
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "darwin" };
    });
    try {
      const mod = await import("../src/http-api.js");
      // Seed a tmpfile for an alive non-matching PID. On Linux we use bash
      // sleep, on actual darwin/win machines we just use our own pid.
      const pidToTest = process.pid;
      touch(`auth-token.${pidToTest}.tmp`);

      // Behavior-equivalent sweep using the mocked module's helper.
      const cmdlineCheck = mod.__testing.cmdlineLooksLikeLaqrumcodeMcp(pidToTest);
      expect(cmdlineCheck).toBeNull();

      // Confirm: the inline sweep guards via `=== true`. null !== true,
      // therefore the orphan would be unlinked. Reproduce that decision:
      const entries = readdirSync(dir);
      for (const name of entries) {
        const m = /^auth-token\.(\d+)\.tmp$/.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        let alive = true;
        try { process.kill(pid, 0); } catch (e: unknown) {
          alive = (e as NodeJS.ErrnoException)?.code !== "ESRCH";
        }
        if (alive && mod.__testing.cmdlineLooksLikeLaqrumcodeMcp(pid) === true) continue;
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }

      // On non-Linux the orphan is gone (null cmdline → "not us" → unlink).
      expect(existsSync(join(dir, `auth-token.${pidToTest}.tmp`))).toBe(false);
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });
});
