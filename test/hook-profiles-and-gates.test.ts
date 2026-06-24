/**
 * Tests for the hook profile dispatcher, config-protection denylist,
 * and first-touch edit/bash gates introduced in 0.7.47.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldHookRun,
  getActiveProfile,
  _resetProfileCacheForTests,
  seedHookProfileDirective,
} from "../src/engine/hooks/profile.js";
import {
  isProtectedConfigFile,
  listProtectedBasenames,
  _resetConfigProtectionCacheForTests,
} from "../src/engine/hooks/config-protection.js";
import {
  checkFileEditGate,
  checkBashGate,
} from "../src/engine/hooks/edit-gates.js";
import {
  registerGate,
  unregisterGate,
  listGates,
  runGates,
  makeDenyResponse,
  _resetRegistryForTests,
  type GateDefinition,
  type GateContext,
} from "../src/engine/hooks/gate-registry.js";
import { handlePostToolUse } from "../src/hook-handlers/post-tool-use.js";
import { GlobalPluginState, SessionState } from "../src/engine/state.js";

beforeEach(() => {
  delete process.env.LAQRUMCODE_HOOK_PROFILE;
  delete process.env.LAQRUMCODE_DISABLED_HOOKS;
  delete process.env.LAQRUMCODE_ALLOW_CONFIG_EDIT;
  delete process.env.LAQRUMCODE_GATE_TIMEOUT_MS;
  _resetProfileCacheForTests();
  _resetConfigProtectionCacheForTests();
});

describe("hook profile dispatcher", () => {
  it("defaults to standard when no env is set", () => {
    expect(getActiveProfile()).toBe("standard");
  });

  it("accepts minimal | standard | strict", () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "minimal";
    _resetProfileCacheForTests();
    expect(getActiveProfile()).toBe("minimal");

    process.env.LAQRUMCODE_HOOK_PROFILE = "strict";
    _resetProfileCacheForTests();
    expect(getActiveProfile()).toBe("strict");
  });

  it("ignores garbage profile values and falls back to standard", () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "paranoid";
    _resetProfileCacheForTests();
    expect(getActiveProfile()).toBe("standard");
  });

  it("shouldHookRun matches profile against required list", () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();
    expect(shouldHookRun("edit-gate", ["standard", "strict"])).toBe(true);
    expect(shouldHookRun("bash-gate", ["strict"])).toBe(false);

    process.env.LAQRUMCODE_HOOK_PROFILE = "strict";
    _resetProfileCacheForTests();
    expect(shouldHookRun("bash-gate", ["strict"])).toBe(true);

    process.env.LAQRUMCODE_HOOK_PROFILE = "minimal";
    _resetProfileCacheForTests();
    expect(shouldHookRun("edit-gate", ["standard", "strict"])).toBe(false);
    expect(shouldHookRun("config-protection", ["standard", "strict"])).toBe(false);
  });

  it("LAQRUMCODE_DISABLED_HOOKS suppresses a specific hook id", () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    process.env.LAQRUMCODE_DISABLED_HOOKS = "edit-gate";
    _resetProfileCacheForTests();
    expect(shouldHookRun("edit-gate", ["standard", "strict"])).toBe(false);
    expect(shouldHookRun("config-protection", ["standard", "strict"])).toBe(true);
  });

  it("seedHookProfileDirective writes a Tier-0 row tagged for dedup", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    const queryExec = vi.fn(async () => undefined);
    const createCoreMemory = vi.fn(async () => "core_memory:abc");
    const store = {
      isAvailable: () => true,
      queryExec,
      createCoreMemory,
    };

    await seedHookProfileDirective(store);

    expect(queryExec).toHaveBeenCalledOnce();
    const deleteSql = queryExec.mock.calls[0][0] as string;
    expect(deleteSql).toContain("[kc_hook_profile_v1]");

    expect(createCoreMemory).toHaveBeenCalledOnce();
    const [text, category, priority, tier] = createCoreMemory.mock.calls[0];
    expect(text).toContain("ACTIVE HOOK PROFILE: standard");
    expect(text).toContain("[kc_hook_profile_v1]");
    expect(category).toBe("operations");
    expect(priority).toBe(88);
    expect(tier).toBe(0);
  });

  it("seedHookProfileDirective skips when store is unavailable", async () => {
    const createCoreMemory = vi.fn();
    await seedHookProfileDirective({
      isAvailable: () => false,
      queryExec: async () => undefined,
      createCoreMemory,
    });
    expect(createCoreMemory).not.toHaveBeenCalled();
  });
});

describe("config-protection denylist", () => {
  it("blocks ESLint, Prettier, Biome, Ruff, and EditorConfig configs", () => {
    expect(isProtectedConfigFile("/repo/.eslintrc.js")).toBe(true);
    expect(isProtectedConfigFile("/repo/.prettierrc")).toBe(true);
    expect(isProtectedConfigFile("/repo/biome.json")).toBe(true);
    expect(isProtectedConfigFile("/repo/.ruff.toml")).toBe(true);
    expect(isProtectedConfigFile("/repo/.editorconfig")).toBe(true);
    expect(isProtectedConfigFile("/repo/eslint.config.mjs")).toBe(true);
  });

  it("does NOT block project-metadata files", () => {
    // Carve-outs: these files hold real metadata, not just lint config.
    expect(isProtectedConfigFile("/repo/pyproject.toml")).toBe(false);
    expect(isProtectedConfigFile("/repo/package.json")).toBe(false);
    expect(isProtectedConfigFile("/repo/tsconfig.json")).toBe(false);
  });

  it("does NOT block source files", () => {
    expect(isProtectedConfigFile("/repo/src/index.ts")).toBe(false);
    expect(isProtectedConfigFile("/repo/.gitignore")).toBe(false);
  });

  it("matches by basename, ignoring directory depth", () => {
    expect(isProtectedConfigFile("/a/b/c/d/biome.json")).toBe(true);
    expect(isProtectedConfigFile("/biome.json")).toBe(true);
  });

  it("LAQRUMCODE_ALLOW_CONFIG_EDIT=1 disables the check", () => {
    process.env.LAQRUMCODE_ALLOW_CONFIG_EDIT = "1";
    _resetConfigProtectionCacheForTests();
    expect(isProtectedConfigFile("/repo/biome.json")).toBe(false);
  });

  it("LAQRUMCODE_ALLOW_CONFIG_EDIT=0 / 'false' / '' does NOT bypass", () => {
    for (const v of ["0", "false", "", "FALSE"]) {
      process.env.LAQRUMCODE_ALLOW_CONFIG_EDIT = v;
      _resetConfigProtectionCacheForTests();
      expect(isProtectedConfigFile("/repo/biome.json")).toBe(true);
    }
  });

  it("listProtectedBasenames returns a non-empty sorted list", () => {
    const names = listProtectedBasenames();
    expect(names.length).toBeGreaterThan(10);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Edit-gate / bash-gate tests
// ─────────────────────────────────────────────────────────────────────

function makeMockState(queryFirstResult: Array<{ id: string }> = []) {
  const queryFirst = vi.fn(async () => queryFirstResult);
  const store = {
    isAvailable: () => true,
    queryFirst,
  } as unknown as GlobalPluginState["store"];
  return {
    state: { store } as unknown as GlobalPluginState,
    queryFirst,
  };
}

function makeSession(): SessionState {
  const s = new SessionState("sess-test", "sess-test");
  s.surrealSessionId = "session:abc";
  return s;
}

describe("checkFileEditGate", () => {
  it("blocks the first edit when no investigation evidence exists", async () => {
    const { state, queryFirst } = makeMockState([]); // store has no matching turn
    const session = makeSession();

    const r = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(r).not.toBeNull();
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(r?.hookSpecificOutput?.permissionDecisionReason).toContain("/repo/src/foo.ts");
    expect(queryFirst).toHaveBeenCalledOnce();
  });

  it("allows when a prior file-aware tool call observed the path this session (0.7.48 fix)", async () => {
    const { state, queryFirst } = makeMockState([]);
    const session = makeSession();
    // Simulate pre-tool-use.ts having recorded a prior Read of this path.
    session._observedFilePaths.add("/repo/src/foo.ts");

    const r = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(r).toBeNull();
    // Hot-path observation short-circuits the store query.
    expect(queryFirst).not.toHaveBeenCalled();
  });

  it("allows when the path appears in the user's last message", async () => {
    const { state, queryFirst } = makeMockState([]);
    const session = makeSession();
    session.lastUserText = "please fix /repo/src/foo.ts";

    const r = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(r).toBeNull();
    // User-message authorization short-circuits the store query.
    expect(queryFirst).not.toHaveBeenCalled();
  });

  it("allows when the store has a prior turn mentioning the path", async () => {
    const { state, queryFirst } = makeMockState([{ id: "turn:abc" }]);
    const session = makeSession();

    const r = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(r).toBeNull();
    expect(queryFirst).toHaveBeenCalledOnce();
  });

  it("caches the decision so a second edit in the same session is a no-op query", async () => {
    const { state, queryFirst } = makeMockState([{ id: "turn:abc" }]);
    const session = makeSession();

    await checkFileEditGate(state, session, "/repo/src/foo.ts");
    await checkFileEditGate(state, session, "/repo/src/foo.ts");

    expect(queryFirst).toHaveBeenCalledOnce(); // second call hit the in-memory cache
  });

  it("fail-open when the store is unavailable (no enforcement without state)", async () => {
    const session = makeSession();
    const state = {
      store: { isAvailable: () => false, queryFirst: vi.fn() },
    } as unknown as GlobalPluginState;

    const r = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(r).toBeNull();
  });

  it("fail-open when the store query throws", async () => {
    const session = makeSession();
    const state = {
      store: {
        isAvailable: () => true,
        queryFirst: vi.fn(async () => { throw new Error("db down"); }),
      },
    } as unknown as GlobalPluginState;

    const r = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(r).toBeNull();
  });

  it("idle timeout wipes the cache so a stale 'cleared' file gets re-gated", async () => {
    process.env.LAQRUMCODE_GATE_TIMEOUT_MS = "1"; // 1ms ⇒ instant expiry
    const { state, queryFirst } = makeMockState([{ id: "turn:abc" }]);
    const session = makeSession();

    await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(queryFirst).toHaveBeenCalledTimes(1);

    // Wait > 1ms; cache should expire on next call.
    await new Promise((res) => setTimeout(res, 5));

    // Second call should re-query (cache wiped).
    queryFirst.mockResolvedValueOnce([]);
    const r2 = await checkFileEditGate(state, session, "/repo/src/foo.ts");
    expect(queryFirst).toHaveBeenCalledTimes(2);
    expect(r2).not.toBeNull(); // empty result this time → deny
  });
});

describe("checkBashGate", () => {
  it("returns null for non-destructive commands", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    const r = await checkBashGate(state, session, "ls -la");
    expect(r).toBeNull();
  });

  it("blocks rm -rf on first attempt", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    const r = await checkBashGate(state, session, "rm -rf /tmp/foo");
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(r?.hookSpecificOutput?.permissionDecisionReason).toContain("rm -rf");
  });

  it("blocks DROP TABLE", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    const r = await checkBashGate(state, session, "psql -c 'DROP TABLE users'");
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks DELETE FROM without WHERE", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    const r = await checkBashGate(state, session, "psql -c 'DELETE FROM users'");
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows DELETE FROM with a WHERE clause", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    const r = await checkBashGate(state, session, "psql -c 'DELETE FROM users WHERE id = 1'");
    expect(r).toBeNull();
  });

  it("blocks git push --force", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "git push --force"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect((await checkBashGate(state, session, "git push -f origin main"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks rm with separated -r -f flags", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "rm -r -f /tmp/foo"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks rm --recursive --force (long flags)", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "rm --recursive --force /tmp/foo"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks /bin/rm -rf (absolute path)", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "/bin/rm -rf /tmp/foo"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks git push origin main --force (late flag)", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "git push origin main --force"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks git -c flag.x=y reset --hard (intervening flags)", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "git -c advice.detachedHead=false reset --hard"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("blocks git clean -fd", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    expect((await checkBashGate(state, session, "git clean -fd"))?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows when the user's message authorizes the command verbatim", async () => {
    const { state, queryFirst } = makeMockState([]);
    const session = makeSession();
    session.lastUserText = "go ahead and rm -rf /tmp/foo";
    const r = await checkBashGate(state, session, "rm -rf /tmp/foo");
    expect(r).toBeNull();
    expect(queryFirst).not.toHaveBeenCalled();
  });

  it("allows when the user's message names the destructive verb", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    session.lastUserText = "drop table users please";
    const r = await checkBashGate(state, session, "psql -c 'DROP TABLE users'");
    expect(r).toBeNull();
  });

});

describe("PostToolUse path extraction (clears edit-gate via recall/Grep/Glob)", () => {
  function makePostToolUseState(session: SessionState): GlobalPluginState {
    return {
      store: { isAvailable: () => false } as unknown as GlobalPluginState["store"],
      embeddings: { isAvailable: () => false } as unknown as GlobalPluginState["embeddings"],
      getSession: (k: string) => k === session.sessionKey ? session : undefined,
    } as unknown as GlobalPluginState;
  }

  it("extracts slash-paths and known-extension filenames from recall results", async () => {
    const session = new SessionState("sess-pt", "sess-pt");
    const state = makePostToolUseState(session);

    await handlePostToolUse(state, {
      session_id: "sess-pt",
      tool_name: "mcp__plugin_laqrumcode_laqrumcode__recall",
      tool_response: "Found 2 results: /home/zero/voidorigin/laqrumcode/src/foo.ts and ./relative/bar.py — also schema.surql is relevant.",
    });

    expect(session._observedFilePaths.has("/home/zero/voidorigin/laqrumcode/src/foo.ts")).toBe(true);
    expect(session._observedFilePaths.has("./relative/bar.py")).toBe(true);
    expect(session._observedFilePaths.has("schema.surql")).toBe(true);
  });

  it("extracts paths from Grep results", async () => {
    const session = new SessionState("sess-pt2", "sess-pt2");
    const state = makePostToolUseState(session);

    await handlePostToolUse(state, {
      session_id: "sess-pt2",
      tool_name: "Grep",
      tool_response: "src/engine/state.ts:42:  readonly _observedFilePaths\nsrc/hook-handlers/pre-tool-use.ts:15:  // observation pass",
    });

    expect(session._observedFilePaths.has("src/engine/state.ts")).toBe(true);
    expect(session._observedFilePaths.has("src/hook-handlers/pre-tool-use.ts")).toBe(true);
  });

  it("does NOT extract paths from non-observing tools (e.g. Bash)", async () => {
    const session = new SessionState("sess-pt3", "sess-pt3");
    const state = makePostToolUseState(session);

    await handlePostToolUse(state, {
      session_id: "sess-pt3",
      tool_name: "Bash",
      tool_response: "/home/zero/foo.ts exists",
    });

    expect(session._observedFilePaths.size).toBe(0);
  });

  it("strips trailing punctuation from extracted paths", async () => {
    const session = new SessionState("sess-pt4", "sess-pt4");
    const state = makePostToolUseState(session);

    await handlePostToolUse(state, {
      session_id: "sess-pt4",
      tool_name: "Glob",
      tool_response: "Found: /a/b.ts, /c/d.js. Also see /e/f.py!",
    });

    expect(session._observedFilePaths.has("/a/b.ts")).toBe(true);
    expect(session._observedFilePaths.has("/c/d.js")).toBe(true);
    expect(session._observedFilePaths.has("/e/f.py")).toBe(true);
  });

  it("recall path extraction unblocks a follow-up edit-gate check end-to-end", async () => {
    const session = new SessionState("sess-pt5", "sess-pt5");
    session.surrealSessionId = "session:abc";
    const ptState = makePostToolUseState(session);

    // Step 1: a recall call returns the path.
    await handlePostToolUse(ptState, {
      session_id: "sess-pt5",
      tool_name: "mcp__plugin_laqrumcode_laqrumcode__recall",
      tool_response: "Top hit: /repo/src/target.ts (score 0.91)",
    });

    // Step 2: edit-gate check on that exact path.
    const gateState = {
      store: { isAvailable: () => true, queryFirst: vi.fn(async () => []) } as unknown as GlobalPluginState["store"],
    } as unknown as GlobalPluginState;
    const r = await checkFileEditGate(gateState, session, "/repo/src/target.ts");
    expect(r).toBeNull();
  });

  it("does NOT block on a path that's never been surfaced", async () => {
    const session = new SessionState("sess-pt6", "sess-pt6");
    session.surrealSessionId = "session:abc";

    const gateState = {
      store: { isAvailable: () => true, queryFirst: vi.fn(async () => []) } as unknown as GlobalPluginState["store"],
    } as unknown as GlobalPluginState;
    const r = await checkFileEditGate(gateState, session, "/repo/src/never-mentioned.ts");
    expect(r).not.toBeNull(); // expected: still denied, gate works as-designed
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("Bash gate cache (regression)", () => {
  it("caches the per-pattern decision (rm -rf only blocks once, even on different paths)", async () => {
    const { state, queryFirst } = makeMockState([{ id: "turn:abc" }]);
    const session = makeSession();

    const first = await checkBashGate(state, session, "rm -rf /tmp/a");
    expect(first).toBeNull();

    // Second rm -rf on a different path: cache hit, no extra query.
    const second = await checkBashGate(state, session, "rm -rf /tmp/b");
    expect(second).toBeNull();
    expect(queryFirst).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Gate registry tests
// ─────────────────────────────────────────────────────────────────────

describe("gate registry", () => {
  beforeEach(() => {
    // skipAutoInit=true prevents lazy init from loading builtins,
    // so each test controls the gate list precisely.
    _resetRegistryForTests(true);
    _resetProfileCacheForTests();
  });

  it("registerGate adds a gate and listGates returns it", () => {
    registerGate({
      id: "test-gate",
      profiles: ["standard"],
      priority: 50,
      async check() { return null; },
    });
    const gates = listGates();
    expect(gates).toHaveLength(1);
    expect(gates[0].id).toBe("test-gate");
  });

  it("registerGate replaces a gate with the same id", () => {
    registerGate({ id: "g1", profiles: ["standard"], async check() { return null; } });
    registerGate({ id: "g1", profiles: ["strict"], async check() { return null; } });
    const gates = listGates();
    expect(gates).toHaveLength(1);
    expect(gates[0].profiles).toEqual(["strict"]);
  });

  it("unregisterGate removes a gate by id", () => {
    registerGate({ id: "g1", profiles: ["standard"], async check() { return null; } });
    expect(unregisterGate("g1")).toBe(true);
    expect(listGates()).toHaveLength(0);
  });

  it("unregisterGate returns false for unknown id", () => {
    expect(unregisterGate("nonexistent")).toBe(false);
  });

  it("gates are sorted by priority (lower first)", () => {
    registerGate({ id: "high", profiles: ["standard"], priority: 90, async check() { return null; } });
    registerGate({ id: "low", profiles: ["standard"], priority: 10, async check() { return null; } });
    registerGate({ id: "mid", profiles: ["standard"], priority: 50, async check() { return null; } });
    const ids = listGates().map(g => g.id);
    expect(ids).toEqual(["low", "mid", "high"]);
  });

  it("runGates returns null when no gates are registered", async () => {
    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Edit", toolInput: {}, payload: {},
    });
    expect(result).toBeNull();
  });

  it("runGates returns first deny from matching gates", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    registerGate({
      id: "g-allow",
      profiles: ["standard"],
      priority: 10,
      async check() { return null; },
    });
    registerGate({
      id: "g-deny",
      profiles: ["standard"],
      priority: 20,
      async check() { return makeDenyResponse("g-deny", "blocked"); },
    });
    registerGate({
      id: "g-never-reached",
      profiles: ["standard"],
      priority: 30,
      async check() { throw new Error("should not run"); },
    });

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Bash", toolInput: {}, payload: {},
    });
    expect(result).not.toBeNull();
    expect(result?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toContain("g-deny");
  });

  it("runGates skips gates whose profile is not active", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    const checkFn = vi.fn(async () => makeDenyResponse("strict-only", "nope"));
    registerGate({
      id: "strict-only",
      profiles: ["strict"],
      priority: 10,
      check: checkFn,
    });

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Bash", toolInput: {}, payload: {},
    });
    expect(result).toBeNull();
    expect(checkFn).not.toHaveBeenCalled();
  });

  it("runGates skips gates whose tool set does not match", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    const checkFn = vi.fn(async () => makeDenyResponse("edit-only", "nope"));
    registerGate({
      id: "edit-only",
      profiles: ["standard"],
      tools: new Set(["Edit"]),
      priority: 10,
      check: checkFn,
    });

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Bash", toolInput: {}, payload: {},
    });
    expect(result).toBeNull();
    expect(checkFn).not.toHaveBeenCalled();
  });

  it("gates with no tools set apply to all tools", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    registerGate({
      id: "universal",
      profiles: ["standard"],
      priority: 10,
      async check() { return makeDenyResponse("universal", "applies everywhere"); },
    });

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "AnyTool", toolInput: {}, payload: {},
    });
    expect(result).not.toBeNull();
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toContain("universal");
  });

  it("LAQRUMCODE_DISABLED_HOOKS disables a registered gate", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    process.env.LAQRUMCODE_DISABLED_HOOKS = "my-gate";
    _resetProfileCacheForTests();

    registerGate({
      id: "my-gate",
      profiles: ["standard"],
      priority: 10,
      async check() { return makeDenyResponse("my-gate", "blocked"); },
    });

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Bash", toolInput: {}, payload: {},
    });
    expect(result).toBeNull();
  });
});

describe("gate registry lazy init loads builtins", () => {
  beforeEach(() => {
    _resetRegistryForTests(false); // allow lazy init
    _resetProfileCacheForTests();
    _resetConfigProtectionCacheForTests();
    delete process.env.LAQRUMCODE_HOOK_PROFILE;
    delete process.env.LAQRUMCODE_DISABLED_HOOKS;
  });

  it("listGates returns 3 built-in gates after lazy init", () => {
    const gates = listGates();
    const ids = gates.map(g => g.id);
    expect(ids).toContain("config-protection");
    expect(ids).toContain("edit-gate");
    expect(ids).toContain("bash-gate");
    expect(gates.length).toBeGreaterThanOrEqual(3);
  });

  it("built-in gates are in priority order: config-protection < edit-gate < bash-gate", () => {
    const gates = listGates();
    const cp = gates.find(g => g.id === "config-protection")!;
    const eg = gates.find(g => g.id === "edit-gate")!;
    const bg = gates.find(g => g.id === "bash-gate")!;
    expect(cp.priority!).toBeLessThan(eg.priority!);
    expect(eg.priority!).toBeLessThan(bg.priority!);
  });

  it("builtin config-protection gate blocks .eslintrc via runGates", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Edit",
      toolInput: { file_path: "/repo/.eslintrc.js" }, payload: {},
    });
    expect(result?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toContain("config-protection");
  });

  it("builtin edit-gate blocks first edit to unknown file via runGates", async () => {
    process.env.LAQRUMCODE_HOOK_PROFILE = "standard";
    _resetProfileCacheForTests();

    const { state } = makeMockState([]);
    const session = makeSession();
    const result = await runGates({
      state, session, toolName: "Write",
      toolInput: { file_path: "/repo/src/new-file.ts" }, payload: {},
    });
    expect(result?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toContain("edit-gate");
  });
});

describe("makeDenyResponse", () => {
  it("includes gate id and message in the deny reason", () => {
    const resp = makeDenyResponse("my-gate", "you cannot do this");
    expect(resp.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(resp.hookSpecificOutput?.permissionDecisionReason).toContain("laqrumcode/my-gate:");
    expect(resp.hookSpecificOutput?.permissionDecisionReason).toContain("you cannot do this");
  });

  it("includes Tier-0 prefix", () => {
    const resp = makeDenyResponse("test", "reason");
    expect(resp.hookSpecificOutput?.permissionDecisionReason).toContain("tier0 directives");
  });
});
