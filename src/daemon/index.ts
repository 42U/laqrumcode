/**
 * kongcode-daemon entry point.
 *
 * Long-lived background process spawned by the first kongcode-mcp client
 * that doesn't find an existing daemon. Owns SurrealStore, EmbeddingService,
 * ACAN weights, hook event queue, and all tool/hook handlers. Outlives any
 * individual Claude Code session — plugin updates restart only the thin
 * client, never this daemon (unless the binary itself changed).
 *
 * Lifecycle:
 *   1. Acquire spawn lock (prevents two clients from racing to fork two daemons).
 *   2. Verify no other daemon is alive (PID file + ping).
 *   3. Run bootstrap — provision SurrealDB binary + child, BGE-M3 model,
 *      node-llama-cpp native binding. Same logic as 0.6.x mcp-server but
 *      hosted in the daemon process.
 *   4. Initialize SurrealStore + EmbeddingService.
 *   5. Register IPC handlers for every method in IPC_METHODS.
 *   6. Open IPC socket(s). Write PID file. Drop spawn lock.
 *   7. Serve requests until SIGTERM or `meta.shutdown`.
 *
 * Handlers in this initial scaffold are stubs — meta.handshake works,
 * everything else returns a "not yet implemented" error. Subsequent
 * commits migrate tool/hook handlers from the legacy mcp-server.ts.
 */

import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  PROTOCOL_VERSION,
  DEFAULT_DAEMON_SOCKET_PATH,
  DEFAULT_DAEMON_TCP_PORT,
  DAEMON_PID_FILE,
  type MetaHandshakeResponse,
  type MetaHealthResponse,
  type ToolOrHookRequest,
} from "../shared/ipc-types.js";
import { DaemonServer } from "./server.js";
import { log } from "../engine/log.js";
import { parsePluginConfig } from "../engine/config.js";
import { bootstrap, resolvePluginDir, shutdownManagedSurreal } from "../engine/bootstrap.js";
import { SurrealStore } from "../engine/surreal.js";
import { EmbeddingService } from "../engine/embeddings.js";
import { GlobalPluginState } from "../engine/state.js";
import { handleIntrospect } from "../tools/introspect.js";
import { handleRecall } from "../tools/recall.js";
import { handleCoreMemory } from "../tools/core-memory.js";
import {
  handleFetchPendingWork,
  handleCommitWorkResults,
  handleCreateKnowledgeGems,
} from "../tools/pending-work.js";
import { handleMemoryHealth } from "../tools/memory-health.js";
import { handleLinkHierarchy } from "../tools/link-hierarchy.js";
import { handleSupersede } from "../tools/supersede.js";
import { handleRecordFinding } from "../tools/record-finding.js";
import { handleClusterScan } from "../tools/cluster-scan.js";
import { handleWhatIsMissing } from "../tools/what-is-missing.js";
import { handleSessionStart } from "../hook-handlers/session-start.js";
import { handleSessionEnd } from "../hook-handlers/session-end.js";
import { handleUserPromptSubmit } from "../hook-handlers/user-prompt-submit.js";
import { handlePreToolUse } from "../hook-handlers/pre-tool-use.js";
import { handlePostToolUse } from "../hook-handlers/post-tool-use.js";
import { handleStop } from "../hook-handlers/stop.js";
import { handlePreCompact } from "../hook-handlers/pre-compact.js";
import { handlePostCompact } from "../hook-handlers/post-compact.js";
import { handleTaskCreated, handleSubagentStop } from "../hook-handlers/subagent.js";
import { startHttpApi, stopHttpApi, registerHookHandler } from "../http-api.js";
import type { HookResponse } from "../http-api.js";
import { startDrainScheduler } from "./auto-drain.js";
import { configureReranker, disposeReranker, isRerankerActive } from "../engine/graph-context.js";
import { disposeSharedLlama } from "../engine/llama-loader.js";
import { detectResourceProfile } from "../engine/resource-tier.js";

/** Daemon version reported via meta.handshake. Read from package.json at
 *  runtime (dev), or injected by esbuild --define at bundle time (SEA). */
const DAEMON_VERSION: string = (() => {
  // @ts-expect-error — replaced by esbuild --define at bundle time
  try { if (typeof __KONGCODE_VERSION__ === "string") return __KONGCODE_VERSION__; } catch {}
  try {
    const pkgPath = join(resolvePluginDir(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.version === "string") return pkg.version;
  } catch {}
  return "0.0.0";
})();

/** Lex-compare dotted versions ("0.7.5" vs "0.7.22"). Returns negative/0/positive
 *  the way Array.sort expects. Skips a full semver dep — kongcode's versions
 *  are always plain MAJOR.MINOR.PATCH, no prereleases on the daemon channel. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s) || 0);
  const pb = b.split(".").map((s) => Number(s) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

type BootstrapPhase = MetaHandshakeResponse["bootstrapPhase"];
let bootstrapPhase: BootstrapPhase = "starting";
let bootstrapError: { message: string; stack?: string } | null = null;
const startedAt = Date.now();

/** Module-level state — once initialized, every IPC handler closes over this.
 *  Mirrors mcp-server.ts's globalState pattern but lives in the daemon now. */
let globalState: GlobalPluginState | null = null;

const resourceProfile = detectResourceProfile();

function setBootstrapPhase(p: BootstrapPhase, err?: Error): void {
  bootstrapPhase = p;
  if (p === "failed" && err) {
    bootstrapError = { message: err.message, stack: err.stack };
  }
}

function pruneStalePluginCache(): void {
  const cacheBase = join(homedir(), ".claude", "plugins", "cache", "kongcode-marketplace", "kongcode");
  if (!existsSync(cacheBase)) return;
  try {
    const entries = readdirSync(cacheBase, { withFileTypes: true });
    const stale = entries.filter(e => e.isDirectory() && e.name !== DAEMON_VERSION);
    if (stale.length === 0) return;
    for (const dir of stale) {
      const full = join(cacheBase, dir.name);
      try {
        rmSync(full, { recursive: true, force: true });
        log.info(`[daemon] pruned stale plugin cache: ${dir.name}`);
      } catch (e) {
        log.warn(`[daemon] failed to prune ${dir.name}: ${(e as Error).message}`);
      }
    }
    log.info(`[daemon] pruned ${stale.length} stale version(s) from plugin cache, kept ${DAEMON_VERSION}`);
  } catch (e) {
    log.warn(`[daemon] plugin cache prune failed: ${(e as Error).message}`);
  }
}

/** Initialize the daemon's state stack — bootstrap, SurrealStore, EmbeddingService,
 *  GlobalPluginState. Equivalent to mcp-server.ts:initialize() but hosted in the
 *  daemon process so all clients share one copy of these heavy resources.
 *
 *  Failures degrade rather than abort: a failed bootstrap leaves the daemon up
 *  but tool handlers return errors via globalState being null, just like mcp-server
 *  did. The user-facing surfacing happens through MetaHandshakeResponse's
 *  bootstrapPhase + bootstrapError fields. */
async function initializeStack(): Promise<void> {
  log.info("[daemon] initializing kongcode stack...");
  setBootstrapPhase("starting");

  const config = parsePluginConfig();
  log.info(
    `[daemon] resource tier: ${resourceProfile.tier} ` +
    `(ram=${resourceProfile.totalRamMb}MB, cpus=${resourceProfile.cpuCount}, ` +
    `gpu=${resourceProfile.llamaGpu}, threads=${resourceProfile.llamaMaxThreads})`,
  );

  if (config.surreal.user === "root" && config.surreal.pass === "root") {
    log.warn(
      "[daemon] SurrealDB using default credentials (root:root). " +
      "Set SURREAL_USER and SURREAL_PASS env vars for stronger auth.",
    );
  }

  if (process.env.KONGCODE_SKIP_BOOTSTRAP !== "1") {
    setBootstrapPhase("npm-install");
    try {
      const result = await bootstrap({
        pluginDir: resolvePluginDir(),
        cacheDir: config.paths.cacheDir,
        dataDir: config.paths.dataDir,
        modelPath: config.embedding.modelPath,
        rerankerModelPath: config.reranker.modelPath,
        rerankerEnabled: config.reranker.enabled,
        surrealBinPathOverride: config.paths.surrealBinPath,
        surrealUrlOverride: process.env.SURREAL_URL,
        surrealUser: config.surreal.user,
        surrealPass: config.surreal.pass,
      });
      if (result.surrealServer.managed || result.surrealServer.url) {
        // Bootstrap may have detected an existing kongcode SurrealDB on a
        // legacy port (8000/8042) and returned its URL. Either way, point
        // the store at whatever bootstrap chose.
        (config.surreal as { url: string }).url = result.surrealServer.url;
      }
      log.info(
        `[bootstrap] complete in ${result.totalDurationMs}ms ` +
          `(npm=${result.npmInstall.ran ? "ran" : "skip"}, ` +
          `surreal=${result.surrealBinary.provisioned ? "downloaded" : "cached"}, ` +
          `llama=${result.nodeLlamaCpp.mainPath ? (result.nodeLlamaCpp.provisioned ? "downloaded" : "cached") : "via-npm"}, ` +
          `model=${result.embeddingModel.provisioned ? "downloaded" : "cached"})`,
      );
    } catch (err) {
      log.error("[bootstrap] failed — daemon entering degraded mode:", err);
      setBootstrapPhase("failed", err instanceof Error ? err : new Error(String(err)));
      return; // No point setting up store/embeddings if bootstrap exploded.
    }
  } else {
    log.info("[bootstrap] skipped (KONGCODE_SKIP_BOOTSTRAP=1)");
  }

  const store = new SurrealStore(config.surreal);
  const embeddings = new EmbeddingService(config.embedding, resourceProfile);
  globalState = new GlobalPluginState(config, store, embeddings);
  globalState.workspaceDir = process.env.KONGCODE_PROJECT_DIR ?? process.cwd();

  setBootstrapPhase("connecting-store");
  try {
    await store.initialize();
    log.info("[daemon] SurrealDB connected");
  } catch (err) {
    log.error("[daemon] SurrealDB connection failed — running in degraded mode:", err);
  }

  if (store.isAvailable()) {
    embeddings.setStore(store);
  }

  setBootstrapPhase("loading-embeddings");
  try {
    await embeddings.initialize();
    log.info("[daemon] Embedding model loaded");
  } catch (err) {
    log.error("[daemon] Embedding model failed — vector search disabled:", err);
  }

  // Cross-encoder reranker (bge-reranker-v2-m3). Optional — if the model file
  // doesn't exist OR KONGCODE_RERANKER_DISABLED=1, recall falls back to
  // WMR/ACAN scoring without reranking. The model file (~606MB) is
  // downloaded by bootstrap when enabled. Same configuration that hit
  // 98.2% R@5 on LongMemEval in kongclaw.
  if (config.reranker.enabled) {
    if (existsSync(config.reranker.modelPath)) {
      configureReranker(config.reranker.modelPath, resourceProfile);
      log.info(`[daemon] reranker configured for lazy init (model at ${config.reranker.modelPath})`);
    } else {
      log.warn(`[daemon] reranker model not found at ${config.reranker.modelPath} — recall will use WMR/ACAN only`);
    }
  }

  // Start auto-drain scheduler — restores the auto-extraction behavior that
  // lived in the in-process MemoryDaemon before commit 4f7b962 removed the
  // Anthropic SDK. Spawns `claude --agent kongcode:memory-extractor -p ...`
  // when pending_work backlog exceeds threshold. Self-disables if claude
  // binary not findable. Skipped here only when bootstrap completely failed
  // (globalState would be null). Configurable via env vars
  // KONGCODE_AUTO_DRAIN, KONGCODE_AUTO_DRAIN_THRESHOLD,
  // KONGCODE_AUTO_DRAIN_INTERVAL_MS.
  if (globalState) {
    const drainThreshold = (() => {
      const env = process.env.KONGCODE_AUTO_DRAIN_THRESHOLD;
      if (env !== undefined) {
        const n = Number(env);
        return Number.isFinite(n) && n >= 0 ? n : 5;
      }
      return 5;
    })();
    const drainIntervalMs = (() => {
      const env = process.env.KONGCODE_AUTO_DRAIN_INTERVAL_MS;
      if (env !== undefined) {
        const n = Number(env);
        return Number.isFinite(n) && n >= 0 ? n : resourceProfile.drainIntervalMs;
      }
      return resourceProfile.drainIntervalMs;
    })();
    const drainMaxDaily = (() => {
      const env = process.env.KONGCODE_AUTO_DRAIN_MAX_DAILY;
      if (env !== undefined) {
        const n = Number(env);
        return Number.isFinite(n) && n >= 0 ? n : 50;
      }
      return 50;
    })();
    startDrainScheduler(globalState, {
      threshold: drainThreshold,
      intervalMs: drainIntervalMs,
      cacheDir: config.paths.cacheDir,
      maxDaily: drainMaxDaily,
    });
  }

  // Register hook handlers + start the legacy HTTP API on a per-PID Unix
  // socket. hook-proxy.cjs (the script Claude Code's hooks.json invokes)
  // expects to find ~/.kongcode-<pid>.sock and POST hook events to it.
  // Without this, SessionStart/UserPromptSubmit/Stop all silently no-op
  // because the new IPC socket (~/.kongcode-daemon.sock) isn't what
  // hook-proxy.cjs looks for. Same handlers as the IPC routes — we just
  // expose them over both transports for compat.
  registerHookHandler("session-start", handleSessionStart);
  registerHookHandler("session-end", handleSessionEnd);
  registerHookHandler("user-prompt-submit", handleUserPromptSubmit);
  registerHookHandler("pre-tool-use", handlePreToolUse);
  registerHookHandler("post-tool-use", handlePostToolUse);
  registerHookHandler("stop", handleStop);
  registerHookHandler("pre-compact", handlePreCompact);
  registerHookHandler("post-compact", handlePostCompact);
  registerHookHandler("task-created", handleTaskCreated);
  registerHookHandler("subagent-stop", handleSubagentStop);

  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const hookSocketPath = `${homeDir}/.kongcode-${process.pid}.sock`;
  try {
    await startHttpApi(globalState!, hookSocketPath, homeDir);
    log.info(`[daemon] hook HTTP API listening on ${hookSocketPath}`);
  } catch (err) {
    log.error("[daemon] failed to start hook HTTP API:", err);
  }

  pruneStalePluginCache();

  setBootstrapPhase("ready");
  log.info("[daemon] kongcode stack ready");
}

function pidFilePath(): string {
  return join(homedir(), DAEMON_PID_FILE);
}

function writeOwnPidFile(): void {
  const path = pidFilePath();
  // mkdir before write — first run on a fresh machine may not have the
  // cache dir yet. Same path 0.6.3 already creates for surreal.pid.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {}
  writeFileSync(path, String(process.pid), "utf8");
  log.info(`[daemon] wrote pid file ${path} (pid=${process.pid})`);
}

function removeOwnPidFile(): void {
  const path = pidFilePath();
  try {
    if (!existsSync(path)) return;
    const recorded = Number(readFileSync(path, "utf8").trim());
    // Only remove if the file still records OUR pid — protects against
    // racing daemon instances stomping on each other's pid files during
    // a brief restart window.
    if (recorded === process.pid) {
      unlinkSync(path);
      log.info(`[daemon] removed pid file ${path}`);
    }
  } catch (e) {
    log.warn(`[daemon] couldn't remove pid file: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  log.info(`[daemon] starting kongcode-daemon ${DAEMON_VERSION} (pid=${process.pid})`);

  // Resolve socket / port from env with sensible defaults.
  const socketPath = process.env.KONGCODE_DAEMON_SOCKET ?? DEFAULT_DAEMON_SOCKET_PATH;
  const tcpPortEnv = process.env.KONGCODE_DAEMON_PORT;
  const tcpPort = tcpPortEnv ? Number(tcpPortEnv) : DEFAULT_DAEMON_TCP_PORT;

  // Disable Unix socket if explicitly told to (Windows or paranoid setups).
  const useUds = process.env.KONGCODE_DAEMON_TRANSPORT !== "tcp" && process.platform !== "win32";

  // Idle reaper config: 6s default (per user direction — anything longer
  // mostly just holds RAM for nobody). The only real value of staying
  // alive past the last disconnect is absorbing a fast close-and-reopen,
  // and Claude Code restarts land within ~3-5s on warm cache. 6s gives
  // a small grace window past that and reaps cleanly otherwise. Set 0 to
  // reap immediately. Set higher (e.g. 30 min) for shared-server /
  // cron-driven setups where intermittent clients don't want a cold-start
  // penalty between disconnects. The timer arms on listen() and on every
  // disconnect-to-zero; cancels on every connect.
  const idleTimeoutMs = (() => {
    const env = process.env.KONGCODE_DAEMON_IDLE_TIMEOUT_MS;
    if (env !== undefined) {
      const n = Number(env);
      return Number.isFinite(n) && n >= 0 ? n : resourceProfile.idleTimeoutMs;
    }
    return resourceProfile.idleTimeoutMs;
  })();

  let shuttingDown = false;
  const gracefulCleanup = async (reason: string): Promise<never> => {
    if (shuttingDown) return new Promise(() => {});
    shuttingDown = true;
    log.info(`[daemon] graceful exit: ${reason}`);
    try { await server.close(); } catch {}
    try { await stopHttpApi(); } catch (e) { log.warn(`[daemon] stopHttpApi: ${(e as Error).message}`); }
    if (globalState) {
      try { await globalState.shutdown(); } catch (e) { log.warn(`[daemon] shutdown: ${(e as Error).message}`); }
    }
    try { await disposeReranker(); } catch {}
    try { await disposeSharedLlama(); } catch {}
    shutdownManagedSurreal();
    removeOwnPidFile();
    process.exit(0);
  };

  const reaperExit = (reason: string) => () => { gracefulCleanup(reason); };

  const server = new DaemonServer({
    socketPath: useUds ? socketPath : null,
    tcpPort: Number.isFinite(tcpPort) && tcpPort > 0 ? tcpPort : null,
    log: {
      info: (m) => log.info(m),
      warn: (m) => log.warn(m),
      error: (m, e) => log.error(m, e),
    },
    // Fires once when (a) supersede flagged and (b) last client disconnects.
    // Triggered by a newer-version mcp-client calling meta.requestSupersede,
    // letting older still-attached clients keep working until they finish
    // before we hand control over to fresh daemon code on the next spawn.
    onSupersedeReady: reaperExit("supersede flag set + last client disconnected"),
    // Fires when the idle timer expires (configurable via
    // KONGCODE_DAEMON_IDLE_TIMEOUT_MS, default 30min). Daemon has had zero
    // attached clients for the duration. Frees BGE-M3 + SurrealDB
    // connection so RAM isn't pinned indefinitely. Next client connect
    // triggers a fresh spawn via ensureDaemon.
    idleTimeoutMs,
    onIdleReap: reaperExit(`idle timeout (${Math.round(idleTimeoutMs / 1000)}s) elapsed with no clients`),
  });

  // ── Meta handlers (always available, no bootstrap dependency) ──

  server.register("meta.handshake", async (params, ctx) => {
    // Register caller identity if provided. Pre-0.7.22 clients send empty
    // params and stay anonymous (still counted in activeClients but absent
    // from the per-client registry). 0.7.22+ clients send {clientInfo}.
    const p = (params as { clientInfo?: { pid: number; version: string; sessionId: string } }) ?? {};
    if (p.clientInfo && typeof p.clientInfo.pid === "number" && p.clientInfo.version && p.clientInfo.sessionId) {
      ctx.registerIdentity(p.clientInfo);
    }
    const resp: MetaHandshakeResponse = {
      daemonVersion: DAEMON_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      startedAt,
      bootstrapPhase,
      bootstrapError,
    };
    return resp;
  });

  server.register("meta.health", async () => {
    // Decorate the base server stats with daemon-owned subsystem health
    // (reranker, future: ACAN, embeddings) so callers can verify init
    // succeeded without inferring from RSS or grepping logs.
    const baseStats = server.getStats();
    const resp: MetaHealthResponse = {
      ok: true,
      stats: {
        ...baseStats,
        rerankerActive: isRerankerActive(),
      },
    };
    return resp;
  });

  server.register("meta.requestSupersede", async (params) => {
    const { clientVersion } = (params as { clientVersion?: string }) ?? {};
    const accepted = !!clientVersion && compareSemver(clientVersion, DAEMON_VERSION) > 0;
    if (accepted) {
      log.info(`[daemon] supersede requested by client v${clientVersion} (daemon v${DAEMON_VERSION}) — will exit when last client disconnects`);
      server.markPendingSupersede();
    } else {
      log.info(`[daemon] supersede declined: client v${clientVersion ?? "?"} not newer than daemon v${DAEMON_VERSION}`);
    }
    return {
      accepted,
      daemonVersion: DAEMON_VERSION,
      attachedClients: server.attachedClientCount,
    };
  });

  server.register("meta.shutdown", async () => {
    log.info("[daemon] shutdown requested via meta.shutdown");
    setImmediate(() => { gracefulCleanup("meta.shutdown"); });
    return { ok: true };
  });

  // ── Tool handlers (incremental migration from mcp-server.ts) ──
  //
  // Each handler closes over the module-level globalState (initialized
  // by initializeStack()). The IPC adapter unpacks the standard
  // {sessionId, args} envelope and dispatches to the existing handler
  // function unchanged. Handlers that haven't been migrated yet return
  // HANDLER_ERROR via the dispatcher (no registration = "not bound").

  /** Wrap an existing (state, session, args) → response handler in a
   *  daemon-side IPC adapter. Resolves the per-session state from
   *  globalState's session map (creates a transient one keyed by
   *  sessionId if absent — matches mcp-server.ts's getSession() shape). */
  const wrapToolHandler = (
    handler: (state: GlobalPluginState, session: import("../engine/state.js").SessionState, args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ) => {
    return async (params: unknown) => {
      if (!globalState) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        return {
          content: [{
            type: "text",
            text: `kongcode daemon is still initializing (phase=${bootstrapPhase}, ${elapsed}s elapsed). Try again shortly.`,
          }],
        };
      }
      const env = params as ToolOrHookRequest | undefined;
      const sessionId = env?.sessionId ?? "daemon-default";
      const args = (env?.args ?? {}) as Record<string, unknown>;
      const session = globalState.getOrCreateSession(sessionId, sessionId);
      return await handler(globalState, session, args);
    };
  };

  // All 12 tool handlers wired through the same wrapToolHandler adapter.
  // Each one closes over daemon-owned globalState; per-session state is
  // resolved by sessionId from the IPC envelope.
  server.register("tool.introspect", wrapToolHandler(handleIntrospect));
  server.register("tool.recall", wrapToolHandler(handleRecall));
  server.register("tool.coreMemory", wrapToolHandler(handleCoreMemory));
  server.register("tool.fetchPendingWork", wrapToolHandler(handleFetchPendingWork));
  server.register("tool.commitWorkResults", wrapToolHandler(handleCommitWorkResults));
  server.register("tool.createKnowledgeGems", wrapToolHandler(handleCreateKnowledgeGems));
  server.register("tool.memoryHealth", wrapToolHandler(handleMemoryHealth));
  server.register("tool.linkHierarchy", wrapToolHandler(handleLinkHierarchy));
  server.register("tool.supersede", wrapToolHandler(handleSupersede));
  server.register("tool.recordFinding", wrapToolHandler(handleRecordFinding));
  server.register("tool.clusterScan", wrapToolHandler(handleClusterScan));
  server.register("tool.whatIsMissing", wrapToolHandler(handleWhatIsMissing));

  // Hook handlers — different signature from tools: (state, payload) → HookResponse,
  // where payload is the raw Claude Code hook event (already includes session_id,
  // cwd, transcript_path, etc.). The IPC params is the payload itself; no extra
  // envelope wrapping needed since the hook handler reads what it needs from there.
  const wrapHookHandler = (
    handler: (state: GlobalPluginState, payload: Record<string, unknown>) => Promise<HookResponse>,
  ) => {
    return async (params: unknown) => {
      if (!globalState) {
        // Hooks fail-open: return an empty hookSpecificOutput so Claude Code's
        // pipeline isn't blocked by a still-initializing daemon.
        return {};
      }
      const payload = (params ?? {}) as Record<string, unknown>;
      return await handler(globalState, payload);
    };
  };

  server.register("hook.sessionStart", wrapHookHandler(handleSessionStart));
  server.register("hook.sessionEnd", wrapHookHandler(handleSessionEnd));
  server.register("hook.userPromptSubmit", wrapHookHandler(handleUserPromptSubmit));
  server.register("hook.preToolUse", wrapHookHandler(handlePreToolUse));
  server.register("hook.postToolUse", wrapHookHandler(handlePostToolUse));
  server.register("hook.stop", wrapHookHandler(handleStop));
  server.register("hook.preCompact", wrapHookHandler(handlePreCompact));
  server.register("hook.postCompact", wrapHookHandler(handlePostCompact));
  server.register("hook.taskCreated", wrapHookHandler(handleTaskCreated));
  server.register("hook.subagentStop", wrapHookHandler(handleSubagentStop));

  // ── Lifecycle ──

  process.on("SIGTERM", () => { gracefulCleanup("SIGTERM"); });
  process.on("SIGINT", () => { gracefulCleanup("SIGINT"); });

  await server.listen();
  writeOwnPidFile();

  // Server is up and serving meta.* immediately. Stack initialization runs
  // async — clients that connect during this window see bootstrapPhase
  // progressing through the real lifecycle (npm-install → ... → ready).
  // Tool handlers return "still initializing" until globalState is set.
  initializeStack().catch((err) => {
    log.error("[daemon] initializeStack rejected:", err);
    setBootstrapPhase("failed", err instanceof Error ? err : new Error(String(err)));
  });

  log.info(`[daemon] ready — protocol v${PROTOCOL_VERSION}, daemon v${DAEMON_VERSION}`);
}

main().catch((err) => {
  log.error("[daemon] fatal error:", err);
  bootstrapPhase = "failed";
  bootstrapError = { message: (err as Error).message, stack: (err as Error).stack };
  removeOwnPidFile();
  process.exit(1);
});
