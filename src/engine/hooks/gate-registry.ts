/**
 * Extensible gate registry.
 *
 * Gates are PreToolUse checks that can deny tool calls based on profile,
 * tool type, and context. Three built-in gates ship with kongcode
 * (config-protection, edit-gate, bash-gate). Users add arbitrary gates
 * via ~/.kongcode/gates.json — no code changes required.
 *
 * The registry runs all active gates in priority order (lowest first)
 * on each PreToolUse invocation. First deny wins.
 *
 * Both built-in and config-driven gates are loaded once on first use.
 * Daemon restart required to pick up changes (same as profile env).
 */

import type { GlobalPluginState, SessionState } from "../state.js";
import type { HookResponse } from "../../http-api.js";
import type { HookProfile } from "./profile.js";
import { shouldHookRun } from "./profile.js";
import { isProtectedConfigFile } from "./config-protection.js";
import { checkFileEditGate, checkBashGate } from "./edit-gates.js";
import { log } from "../log.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────

export interface GateContext {
  state: GlobalPluginState;
  session: SessionState;
  toolName: string;
  toolInput: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface GateDefinition {
  /** Stable id — used with KONGCODE_DISABLED_HOOKS to selectively disable. */
  id: string;
  description?: string;
  /** Which hook profiles activate this gate. */
  profiles: HookProfile[];
  /** Which tools this gate applies to. undefined or empty = all tools. */
  tools?: ReadonlySet<string>;
  /** Lower runs first. Default 50. Built-ins use 10/20/30. */
  priority?: number;
  /** Origin: "builtin" for shipped gates, "config" for ~/.kongcode/gates.json. */
  source?: "builtin" | "config";
  /** Return null to allow, HookResponse to deny. */
  check(ctx: GateContext): Promise<HookResponse | null>;
}

// ── Registry state ────────────────────────────────────────────────────

const gates: GateDefinition[] = [];
let initialized = false;

// ── Public API ────────────────────────────────────────────────────────

export function registerGate(gate: GateDefinition): void {
  const idx = gates.findIndex(g => g.id === gate.id);
  if (idx >= 0) gates[idx] = gate;
  else gates.push(gate);
  gates.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
}

export function unregisterGate(id: string): boolean {
  const idx = gates.findIndex(g => g.id === id);
  if (idx < 0) return false;
  gates.splice(idx, 1);
  return true;
}

export function listGates(): readonly GateDefinition[] {
  ensureInitialized();
  return gates;
}

/**
 * Run all active gates for the given tool call context.
 * Returns the first deny response, or null if all gates pass.
 */
export async function runGates(ctx: GateContext): Promise<HookResponse | null> {
  ensureInitialized();
  for (const gate of gates) {
    if (!shouldHookRun(gate.id, gate.profiles)) continue;
    if (gate.tools && gate.tools.size > 0 && !gate.tools.has(ctx.toolName)) continue;
    const result = await gate.check(ctx);
    if (result) return result;
  }
  return null;
}

// ── Deny helper (shared by built-in wrappers and config gates) ────────

const TIER0_PREFIX =
  "Remember your tier0 directives are important to the user and make you more helpful. " +
  "Make sure you're following the Tier-0 rules (RECALL BEFORE GUESSING, " +
  "MEMORY REFLEX, GRAPH-AWARE SAVING, AUTO-SEAL CONTRACT, ACTIVE HOOK PROFILE). " +
  "And remember to save knowledge gems along the way. ";

export function makeDenyResponse(gateId: string, message: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${TIER0_PREFIX}kongcode/${gateId}: ${message}`,
    },
  };
}

// ── Built-in gate registration ────────────────────────────────────────

const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit"]);

function registerBuiltinGates(): void {
  registerGate({
    id: "config-protection",
    description: "Block edits to lint/format config files",
    profiles: ["standard", "strict"],
    tools: FILE_EDIT_TOOLS,
    priority: 10,
    source: "builtin",
    async check(ctx) {
      const filePath = ctx.toolInput?.file_path as string | undefined;
      if (!filePath || !isProtectedConfigFile(filePath)) return null;
      return makeDenyResponse(
        "config-protection",
        `editing ${filePath} is blocked under the current hook profile. ` +
        `Lint/format configs should not be weakened to make code pass — fix the code instead. ` +
        `Set KONGCODE_ALLOW_CONFIG_EDIT=1 to override (and restart the daemon).`,
      );
    },
  });

  registerGate({
    id: "edit-gate",
    description: "Block first edit to a file until the agent has read it",
    profiles: ["standard", "strict"],
    tools: FILE_EDIT_TOOLS,
    priority: 20,
    source: "builtin",
    async check(ctx) {
      const filePath = ctx.toolInput?.file_path as string | undefined;
      if (!filePath) return null;
      return checkFileEditGate(ctx.state, ctx.session, filePath);
    },
  });

  registerGate({
    id: "bash-gate",
    description: "Block destructive shell commands until authorized",
    profiles: ["strict"],
    tools: new Set(["Bash"]),
    priority: 30,
    source: "builtin",
    async check(ctx) {
      const command = ctx.toolInput?.command as string | undefined;
      if (!command) return null;
      return checkBashGate(ctx.state, ctx.session, command);
    },
  });
}

// ── Config-driven gate loading ────────────────────────────────────────

interface ConfigGateEntry {
  id: string;
  description?: string;
  tools: string[];
  profiles: string[];
  match: { field: string; pattern: string };
  deny_message: string;
  priority?: number;
}

function loadConfigGates(): void {
  const configPath = join(homedir(), ".kongcode", "gates.json");
  if (!existsSync(configPath)) return;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as { gates?: unknown };
    if (!Array.isArray(config.gates)) {
      log.warn(`[gate-registry] ${configPath}: expected { gates: [...] }`);
      return;
    }

    let loaded = 0;
    for (const entry of config.gates as ConfigGateEntry[]) {
      if (!entry.id || !entry.match?.field || !entry.match?.pattern || !entry.deny_message) {
        log.warn(`[gate-registry] skipping incomplete gate entry: ${JSON.stringify(entry).slice(0, 120)}`);
        continue;
      }
      if (!Array.isArray(entry.tools) || !Array.isArray(entry.profiles)) {
        log.warn(`[gate-registry] gate "${entry.id}": tools and profiles must be arrays`);
        continue;
      }

      let re: RegExp;
      try {
        re = new RegExp(entry.match.pattern);
      } catch (e) {
        log.warn(`[gate-registry] gate "${entry.id}": invalid regex: ${(e as Error).message}`);
        continue;
      }

      const validProfiles = entry.profiles.filter(
        (p): p is HookProfile => p === "minimal" || p === "standard" || p === "strict",
      );
      if (validProfiles.length === 0) {
        log.warn(`[gate-registry] gate "${entry.id}": no valid profiles (minimal|standard|strict)`);
        continue;
      }

      const field = entry.match.field;
      const msg = entry.deny_message;
      const gateId = entry.id;
      registerGate({
        id: gateId,
        description: entry.description,
        profiles: validProfiles,
        tools: new Set(entry.tools),
        priority: entry.priority ?? 50,
        source: "config",
        async check(ctx) {
          const value = ctx.toolInput[field];
          if (typeof value !== "string") return null;
          if (!re.test(value)) return null;
          return makeDenyResponse(gateId, msg);
        },
      });
      loaded++;
    }

    if (loaded > 0) {
      log.info(`[gate-registry] loaded ${loaded} config gate(s) from ${configPath}`);
    }
  } catch (e) {
    log.warn(`[gate-registry] failed to load ${configPath}: ${(e as Error).message}`);
  }
}

// ── Lazy init ─────────────────────────────────────────────────────────

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  registerBuiltinGates();
  loadConfigGates();
}

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * Reset to empty. If skipAutoInit is true, ensureInitialized() becomes
 * a no-op — use this when tests register gates manually and don't want
 * builtins auto-loaded.
 * @internal
 */
export function _resetRegistryForTests(skipAutoInit = false): void {
  gates.length = 0;
  initialized = skipAutoInit;
}
