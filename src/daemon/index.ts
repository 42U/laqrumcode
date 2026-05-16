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

import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, readdirSync, rmSync, openSync, writeSync, closeSync, statSync, constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
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
import { handleCreateSkill } from "../tools/create-skill.js";
import { handleGetSkillBody } from "../tools/get-skill-body.js";
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
import { startDrainScheduler, stopDrainScheduler } from "./auto-drain.js";
import { configureReranker, disposeReranker, initReranker, isRerankerActive } from "../engine/graph-context.js";
import { disposeSharedLlama } from "../engine/llama-loader.js";
import { detectResourceProfile } from "../engine/resource-tier.js";
import { registerRetrievalQualityCleanup } from "../engine/retrieval-quality.js";

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

  // Wire session-removed cleanup so per-session staged retrieval entries
  // (now keyed by sessionId after the Map refactor) get purged when a
  // session ends. Without this, the module-scoped Map would leak entries
  // indefinitely as new sessions arrive.
  registerRetrievalQualityCleanup(globalState);

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
      initReranker(config.reranker.modelPath).catch(e =>
        log.warn(`[daemon] eager reranker init failed (will retry lazily): ${(e as Error).message}`),
      );
      log.info(`[daemon] reranker configured with eager init (model at ${config.reranker.modelPath})`);
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

/** Marker written inside daemon.pid as JSON. Distinguishes a real kongcode
 *  daemon from any other process that might recycle the same PID. */
interface DaemonPidMarker {
  marker: "kongcode-daemon";
  pid: number;
  startedAt: number;
  daemonVersion: string;
}

/** Stale-recovery window: if a daemon lock file is older than this (mtime)
 *  AND its PID is dead/non-daemon, we steal it. Mirrors acan.ts's pattern. */
const DAEMON_LOCK_STALE_AGE_MS = 30 * 60 * 1000;

/** Empty/tiny-marker tightened recovery window: if a daemon lock file is
 *  unparseable AND smaller than this (bytes), we treat it as a partial-write
 *  crash artifact. The O_EXCL openSync claims the file before writeSync runs;
 *  a SIGKILL between those two syscalls leaves an empty (0-byte) file. A real
 *  daemon's marker JSON is ~120 bytes minimum (marker + pid + startedAt +
 *  daemonVersion). Below 10 bytes there's no possible valid content. */
const DAEMON_LOCK_EMPTY_THRESHOLD_BYTES = 10;

/** A daemon process that JUST started (still in its tiny race window
 *  between O_EXCL and writeSync) has an mtime that's seconds old at most.
 *  Anything older than this is past the legitimate write window and the
 *  PID-owning process is presumed dead. Used together with the empty-size
 *  check to short-circuit the 30-min stale wait for crash-during-write. */
const DAEMON_LOCK_EMPTY_STALE_AGE_MS = 5_000;

/** Read /proc/<pid>/cmdline on Linux and check it looks like a kongcode daemon.
 *  cmdline is NUL-separated. We require 'node' in argv[0] AND a hint that the
 *  process is the daemon — either 'kongcode' anywhere or a path component like
 *  'daemon/index.js'/'daemon/index.cjs'. On non-Linux platforms /proc is
 *  unavailable so we conservatively return null ('cannot verify').
 *
 *  Returns true  → confirmed to be a kongcode daemon (don't steal lock)
 *  Returns false → confirmed to be a different process (safe to steal)
 *  Returns null  → cannot determine (treat as 'maybe alive' on linux, fall
 *                  back to PID-alive on other platforms) */
function cmdlineLooksLikeKongcodeDaemon(pid: number): boolean | null {
  if (platform() !== "linux") return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!raw) return false;
    // cmdline is NUL-separated; rejoin with spaces for substring tests.
    const joined = raw.replace(/\0/g, " ").toLowerCase();
    if (!joined.includes("node")) return false;
    if (joined.includes("kongcode-daemon")) return true;
    if (joined.includes("daemon/index.js") || joined.includes("daemon/index.cjs")) return true;
    if (joined.includes("kongcode") && joined.includes("daemon")) return true;
    return false;
  } catch {
    // /proc/<pid>/cmdline missing → PID isn't running. Caller treats this
    // as 'stale lock, safe to steal' via the separate isPidAlive check.
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Module-level: holds the daemon.pid fd for the daemon's lifetime so the
 *  file stays exclusively claimed. Released by removeOwnPidFile() on exit. */
let daemonLockFd: number | null = null;

/** Acquire an exclusive lock on daemon.pid. Refuses to start if another live
 *  kongcode daemon already owns it. Returns true on success; on failure
 *  exits the process (the daemon singleton invariant is non-negotiable).
 *
 *  Lock-stealing rules:
 *    - File doesn't exist           → take it.
 *    - File exists, JSON parse fails → if mtime > DAEMON_LOCK_STALE_AGE_MS old, steal.
 *    - File exists, PID dead         → steal.
 *    - File exists, PID alive but cmdline says non-daemon → steal (PID recycled).
 *    - File exists, PID alive AND cmdline matches daemon  → REFUSE (exit 1). */
function acquireDaemonSingletonLock(): void {
  const path = pidFilePath();
  try { mkdirSync(dirname(path), { recursive: true }); } catch {}

  const writeMarker = (fd: number) => {
    const marker: DaemonPidMarker = {
      marker: "kongcode-daemon",
      pid: process.pid,
      startedAt: Date.now(),
      daemonVersion: DAEMON_VERSION,
    };
    writeSync(fd, JSON.stringify(marker));
  };

  const tryCreate = (): number | null => {
    try {
      // O_EXCL atomically claims the file. Fails with EEXIST if it's there.
      const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeMarker(fd);
      return fd;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw e;
    }
  };

  let fd = tryCreate();
  if (fd !== null) {
    daemonLockFd = fd;
    log.info(`[daemon] acquired singleton lock ${path} (pid=${process.pid})`);
    return;
  }

  // Lock exists — figure out whether to steal it.
  let holderPid: number | null = null;
  let holderMarker: DaemonPidMarker | null = null;
  try {
    const raw = readFileSync(path, "utf8");
    // Try JSON marker (new format) first.
    try {
      const parsed = JSON.parse(raw) as DaemonPidMarker;
      if (parsed && parsed.marker === "kongcode-daemon" && Number.isFinite(parsed.pid)) {
        holderMarker = parsed;
        holderPid = parsed.pid;
      }
    } catch {
      // Legacy plain-PID format (pre-singleton). Read as a number.
      const n = Number(raw.trim());
      if (Number.isFinite(n) && n > 0) holderPid = n;
    }
  } catch (e) {
    log.warn(`[daemon] couldn't read existing pid file: ${(e as Error).message}`);
  }

  let stale = false;
  let reason = "";
  if (holderPid === null) {
    // Unparseable. Two fallback signals:
    //  (a) Very old file → presumably abandoned long ago, stale.
    //  (b) Empty/tiny + non-fresh file → SIGKILL between O_EXCL and writeSync;
    //      the holder PID is unrecoverable from the empty file but the
    //      write window is sub-millisecond on any reasonable disk, so any
    //      file >5s old that's still empty is from a process that's gone.
    //      Tightens the recovery time from 30min to 5s for the crash-during-
    //      write case carryover Reviewer E flagged.
    try {
      const st = statSync(path);
      const age = Date.now() - st.mtimeMs;
      if (age > DAEMON_LOCK_STALE_AGE_MS) {
        stale = true;
        reason = `unparseable, age=${Math.round(age/1000)}s`;
      } else if (st.size < DAEMON_LOCK_EMPTY_THRESHOLD_BYTES && age > DAEMON_LOCK_EMPTY_STALE_AGE_MS) {
        stale = true;
        reason = `empty/partial marker (${st.size}B), age=${Math.round(age/1000)}s — crash between O_EXCL and writeSync`;
      }
    } catch {}
  } else if (!isPidAlive(holderPid)) {
    stale = true;
    reason = `pid ${holderPid} not alive`;
  } else {
    // PID is alive. Verify it's actually a kongcode daemon, not a recycled PID.
    const looksLike = cmdlineLooksLikeKongcodeDaemon(holderPid);
    if (looksLike === false) {
      stale = true;
      reason = `pid ${holderPid} alive but cmdline doesn't match kongcode daemon (recycled PID)`;
    } else {
      // looksLike === true OR null (non-Linux: cannot verify, must assume valid).
      stale = false;
    }
  }

  if (!stale) {
    const versionInfo = holderMarker ? ` v${holderMarker.daemonVersion} startedAt=${new Date(holderMarker.startedAt).toISOString()}` : "";
    log.error(`[daemon] REFUSING TO START — another kongcode daemon already owns ${path} (pid=${holderPid}${versionInfo}). Stop the existing daemon first or remove the lock file if you're certain it's stale.`);
    process.exit(1);
  }

  log.warn(`[daemon] stealing stale daemon lock at ${path}: ${reason}`);
  // KNOWN TOCTOU: between unlinkSync and tryCreate's O_EXCL open, a sibling
  // daemon attempting the same stale-recovery can win the create. The window
  // is sub-millisecond (two syscalls) and the failure mode is benign: the
  // losing process gets EEXIST → tryCreate returns null → we log and exit.
  // The winning daemon proceeds normally. We accept "one of two daemon spawn
  // attempts fails loudly" as preferable to alternatives like flock (less
  // portable across Linux/macOS/Windows) or rename-into-place (no atomicity
  // guarantee on macOS APFS for cross-fs renames). Detection + exit is the
  // safe failure mode — never silently end up with two daemons.
  try { unlinkSync(path); } catch {}
  fd = tryCreate();
  if (fd === null) {
    log.error(`[daemon] lost race acquiring daemon lock at ${path}; another process beat us — refusing to start`);
    process.exit(1);
  }
  daemonLockFd = fd;
  log.info(`[daemon] acquired singleton lock ${path} (pid=${process.pid}, stole stale)`);
}

function writeOwnPidFile(): void {
  // Now a no-op — the singleton lock function above already wrote the marker.
  // Kept as a stable call-site for clarity; if someone wants to rewrite the
  // marker (e.g. after a config change) they can call this.
  if (daemonLockFd === null) {
    // Defensive: should never happen because main() always calls
    // acquireDaemonSingletonLock first. Fall back to legacy behavior so the
    // daemon doesn't silently lose its pid file.
    const path = pidFilePath();
    try { mkdirSync(dirname(path), { recursive: true }); } catch {}
    writeFileSync(path, String(process.pid), "utf8");
    log.warn(`[daemon] writeOwnPidFile called without singleton lock — falling back to legacy write`);
  }
}

function removeOwnPidFile(): void {
  const path = pidFilePath();
  // Close the held fd first (idempotent).
  if (daemonLockFd !== null) {
    try { closeSync(daemonLockFd); } catch {}
    daemonLockFd = null;
  }
  try {
    if (!existsSync(path)) return;
    // Verify the file still records OUR identity before unlinking — protects
    // against a racing-replacement daemon's marker getting clobbered.
    const raw = readFileSync(path, "utf8");
    let ours = false;
    try {
      const parsed = JSON.parse(raw) as DaemonPidMarker;
      ours = parsed && parsed.marker === "kongcode-daemon" && parsed.pid === process.pid;
    } catch {
      // Legacy plain-PID file.
      ours = Number(raw.trim()) === process.pid;
    }
    if (ours) {
      unlinkSync(path);
      log.info(`[daemon] removed pid file ${path}`);
    } else {
      log.warn(`[daemon] not removing pid file — owned by different daemon now`);
    }
  } catch (e) {
    log.warn(`[daemon] couldn't remove pid file: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  log.info(`[daemon] starting kongcode-daemon ${DAEMON_VERSION} (pid=${process.pid})`);

  // Acquire daemon singleton lock BEFORE binding the socket. Two daemons
  // bound to the same .kongcode-daemon.sock both run startDrainScheduler
  // and double-process pending_work — a major amplifier of the duplicate-row
  // bug. The lock fd is held for the daemon's lifetime; cleaned up by
  // removeOwnPidFile() during graceful shutdown.
  acquireDaemonSingletonLock();

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
    stopDrainScheduler();
    try { await server.close(); } catch {}
    try { await stopHttpApi(); } catch (e) { log.warn(`[daemon] stopHttpApi: ${(e as Error).message}`); }
    if (globalState) {
      try { await globalState.shutdown(); } catch (e) { log.warn(`[daemon] shutdown: ${(e as Error).message}`); }
    }
    try { await disposeReranker(); } catch {}
    try { await disposeSharedLlama(); } catch {}
    shutdownManagedSurreal({ force: true });
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
    handlerName: string,
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
      // Outer try/catch so handler exceptions surface as tool-result content
      // (which the model can interpret) instead of raw JSON-RPC transport
      // errors. Mirrors the wrapper added to mcp-server.ts handleToolCall.
      try {
        return await handler(globalState, session, args);
      } catch (err) {
        log.error("toolCall failed", { name: handlerName, err });
        return {
          content: [{
            type: "text",
            text: `Tool ${handlerName} failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    };
  };

  // All 12 tool handlers wired through the same wrapToolHandler adapter.
  // Each one closes over daemon-owned globalState; per-session state is
  // resolved by sessionId from the IPC envelope.
  server.register("tool.introspect", wrapToolHandler(handleIntrospect, "introspect"));
  server.register("tool.recall", wrapToolHandler(handleRecall, "recall"));
  server.register("tool.coreMemory", wrapToolHandler(handleCoreMemory, "core_memory"));
  server.register("tool.fetchPendingWork", wrapToolHandler(handleFetchPendingWork, "fetch_pending_work"));
  server.register("tool.commitWorkResults", wrapToolHandler(handleCommitWorkResults, "commit_work_results"));
  server.register("tool.createKnowledgeGems", wrapToolHandler(handleCreateKnowledgeGems, "create_knowledge_gems"));
  server.register("tool.memoryHealth", wrapToolHandler(handleMemoryHealth, "memory_health"));
  server.register("tool.linkHierarchy", wrapToolHandler(handleLinkHierarchy, "link_hierarchy"));
  server.register("tool.supersede", wrapToolHandler(handleSupersede, "supersede"));
  server.register("tool.recordFinding", wrapToolHandler(handleRecordFinding, "record_finding"));
  server.register("tool.clusterScan", wrapToolHandler(handleClusterScan, "cluster_scan"));
  server.register("tool.whatIsMissing", wrapToolHandler(handleWhatIsMissing, "what_is_missing"));
  server.register("tool.createSkill", wrapToolHandler(handleCreateSkill, "create_skill"));
  server.register("tool.getSkillBody", wrapToolHandler(handleGetSkillBody, "get_skill_body"));

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
  // SIGHUP: Node's default action is to terminate without cleanup, which
  // would leave the singleton lock + daemon.pid stranded and the SurrealDB
  // child orphaned. We treat it as a graceful-shutdown trigger — the next
  // client connect will respawn a fresh daemon via ensureDaemon. This also
  // covers the case where the daemon was started from a foreground shell
  // that later exited; without unref'ing all child fds, Node would receive
  // SIGHUP on shell teardown.
  process.on("SIGHUP", () => { gracefulCleanup("SIGHUP"); });
  // Defensive: log uncaught exceptions / unhandled rejections so a future
  // bug can be diagnosed from the daemon.log instead of disappearing into
  // detached-process limbo. We do NOT exit on these — the JSON-RPC layer
  // already rejects pending requests when sockets close, and an isolated
  // handler crash shouldn't take down the whole daemon.
  process.on("uncaughtException", (err) => {
    log.error(`[daemon] uncaughtException — continuing: ${err.message}`, err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error(`[daemon] unhandledRejection — continuing:`, reason);
  });

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
