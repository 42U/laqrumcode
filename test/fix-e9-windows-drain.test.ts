/**
 * Regression tests for E9 — background knowledge-extraction (auto-drain) is
 * non-functional on Windows.
 *
 * Two POSIX-only assumptions broke drain on win32:
 *
 *   1. findClaudeBin resolved the binary by shelling out to `which claude`
 *      (no such command on Windows) and probing POSIX-only install dirs
 *      (~/.local/bin, /usr/local/bin, /opt/claude/bin). The npm-installed CLI
 *      on Windows is `claude.cmd` under %APPDATA%\npm (or the npm prefix's
 *      node_modules\.bin), so the lookup found nothing → drain self-disabled
 *      ("claude binary not found").
 *
 *   2. spawn(claudeBin, ...) ran with no `shell` option. Node's spawn() cannot
 *      exec a .cmd file directly (per child_process docs — same constraint
 *      bootstrap.ts hits with npm.cmd); without shell:true on win32 the spawn
 *      throws ENOENT/EINVAL and the child never starts.
 *
 * The fix splits the platform-specific lookup into the pure resolveClaudeBin
 * (platform + injected probes) and the shell decision into the pure
 * drainSpawnNeedsShell(platform), so both are unit-testable WITHOUT mocking
 * process.platform / child_process / fs — the repo idiom for platform-branched
 * logic (cf. resolveTransport(env, plat), computeDrainCooldown).
 *
 * These tests FAIL against the old code: resolveClaudeBin/drainSpawnNeedsShell
 * did not exist, and the old findClaudeBin had no win32 branch at all.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { __testing, type ClaudeBinProbes } from "../src/daemon/auto-drain.js";

const { resolveClaudeBin, drainSpawnNeedsShell } = __testing;

/** Build probes that report the given set of existing files. `lookup` maps a
 *  command name ("where" / "which") to its stdout (or null for "command
 *  failed / not present"). */
function makeProbes(opts: {
  existing: Set<string>;
  lookup?: Record<string, string | null>;
  home: string;
  appData?: string;
}): ClaudeBinProbes {
  return {
    runLookup: (cmd) => (opts.lookup ? opts.lookup[cmd] ?? null : null),
    fileExists: (p) => opts.existing.has(p),
    home: opts.home,
    appData: opts.appData ?? "",
  };
}

describe("E9: resolveClaudeBin — win32", () => {
  const HOME = "C:\\Users\\dev";
  const APPDATA = "C:\\Users\\dev\\AppData\\Roaming";

  it("uses `where claude` output and returns the first existing line (claude.cmd)", () => {
    const cmdPath = join(APPDATA, "npm", "claude.cmd");
    const probes = makeProbes({
      existing: new Set([cmdPath]),
      lookup: {
        // `where` can print several lines; the .cmd is the runnable shim.
        where: `${cmdPath}\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1`,
        which: null, // would be wrong to consult on win32
      },
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBe(cmdPath);
  });

  it("does NOT fall back to `which` on win32 (which is a POSIX-ism)", () => {
    // Only `which` reports a path, and it points at a POSIX-style location that
    // does NOT exist on disk. A correct win32 resolver ignores `which`.
    const probes = makeProbes({
      existing: new Set<string>(), // nothing exists
      lookup: { which: "/usr/local/bin/claude", where: null },
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBeNull();
  });

  it("falls back to %APPDATA%\\npm\\claude.cmd when `where` finds nothing", () => {
    const cmdPath = join(APPDATA, "npm", "claude.cmd");
    const probes = makeProbes({
      existing: new Set([cmdPath]),
      lookup: { where: null }, // `where` returned nonzero / no match
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBe(cmdPath);
  });

  it("falls back to the npm prefix node_modules\\.bin\\claude.cmd", () => {
    const cmdPath = join(APPDATA, "npm", "node_modules", ".bin", "claude.cmd");
    const probes = makeProbes({
      existing: new Set([cmdPath]),
      lookup: { where: null },
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBe(cmdPath);
  });

  it("prefers claude.cmd over claude.exe in the same dir (cmd is shell-runnable)", () => {
    const root = join(APPDATA, "npm");
    const cmdPath = join(root, "claude.cmd");
    const exePath = join(root, "claude.exe");
    const probes = makeProbes({
      existing: new Set([cmdPath, exePath]),
      lookup: { where: null },
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBe(cmdPath);
  });

  it("resolves claude.exe when no .cmd is present", () => {
    const exePath = join(APPDATA, "npm", "claude.exe");
    const probes = makeProbes({
      existing: new Set([exePath]),
      lookup: { where: null },
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBe(exePath);
  });

  it("uses %APPDATA% even when the env var maps to the home-relative path differently", () => {
    // When APPDATA is empty (some stripped environments), it still probes the
    // home-relative AppData\\Roaming\\npm location.
    const cmdPath = join(HOME, "AppData", "Roaming", "npm", "claude.cmd");
    const probes = makeProbes({
      existing: new Set([cmdPath]),
      lookup: { where: null },
      home: HOME,
      appData: "", // APPDATA not set
    });
    expect(resolveClaudeBin("win32", probes)).toBe(cmdPath);
  });

  it("returns null when nothing is found anywhere on win32", () => {
    const probes = makeProbes({
      existing: new Set<string>(),
      lookup: { where: null, which: null },
      home: HOME,
      appData: APPDATA,
    });
    expect(resolveClaudeBin("win32", probes)).toBeNull();
  });
});

describe("E9: resolveClaudeBin — POSIX path is unchanged", () => {
  const HOME = "/home/dev";

  it("uses `which claude` output when it exists", () => {
    const whichPath = "/home/dev/.local/bin/claude";
    const probes = makeProbes({
      existing: new Set([whichPath]),
      lookup: { which: whichPath },
      home: HOME,
    });
    expect(resolveClaudeBin("linux", probes)).toBe(whichPath);
  });

  it("falls back to ~/.local/bin/claude when `which` finds nothing", () => {
    const localBin = join(HOME, ".local/bin/claude");
    const probes = makeProbes({
      existing: new Set([localBin]),
      lookup: { which: null },
      home: HOME,
    });
    expect(resolveClaudeBin("linux", probes)).toBe(localBin);
  });

  it("falls back to /usr/local/bin/claude", () => {
    const probes = makeProbes({
      existing: new Set(["/usr/local/bin/claude"]),
      lookup: { which: null },
      home: HOME,
    });
    expect(resolveClaudeBin("linux", probes)).toBe("/usr/local/bin/claude");
  });

  it("falls back to /opt/claude/bin/claude", () => {
    const probes = makeProbes({
      existing: new Set(["/opt/claude/bin/claude"]),
      lookup: { which: null },
      home: HOME,
    });
    expect(resolveClaudeBin("linux", probes)).toBe("/opt/claude/bin/claude");
  });

  it("does NOT consult `where` on POSIX", () => {
    // `where` reporting a path must be ignored on linux; only `which` counts.
    const probes = makeProbes({
      existing: new Set(["C:\\nope\\claude.cmd"]),
      lookup: { where: "C:\\nope\\claude.cmd", which: null },
      home: HOME,
    });
    expect(resolveClaudeBin("linux", probes)).toBeNull();
  });

  it("ignores a `which` hit whose path does not exist on disk", () => {
    const probes = makeProbes({
      existing: new Set<string>(), // which printed a path, but file is gone
      lookup: { which: "/stale/claude" },
      home: HOME,
    });
    expect(resolveClaudeBin("linux", probes)).toBeNull();
  });

  it("returns null when nothing is found on POSIX (darwin)", () => {
    const probes = makeProbes({
      existing: new Set<string>(),
      lookup: { which: null },
      home: HOME,
    });
    expect(resolveClaudeBin("darwin", probes)).toBeNull();
  });
});

describe("E9: drainSpawnNeedsShell — spawn options carry shell on win32 only", () => {
  it("is true on win32 (claude.cmd needs the shell to exec)", () => {
    expect(drainSpawnNeedsShell("win32")).toBe(true);
  });

  it("is false on linux (direct-exec, no shell-injection surface)", () => {
    expect(drainSpawnNeedsShell("linux")).toBe(false);
  });

  it("is false on darwin", () => {
    expect(drainSpawnNeedsShell("darwin")).toBe(false);
  });
});
