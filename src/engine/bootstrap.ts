import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

interface PlatformEntry {
  platform: string;
  ext: string;
  binaryName: string;
  sha256: string | null;
}

interface Manifest {
  surrealdb: {
    version: string;
    releaseUrl: string;
    platforms: Record<string, PlatformEntry>;
  };
  embeddingModel: {
    name: string;
    url: string;
    sha256: string | null;
  };
  rerankerModel?: {
    name: string;
    url: string;
    sha256: string | null;
  };
  nodeLlamaCpp?: {
    version: string;
    mainTarballUrl: string;
    mainSha256: string;
    platformTarballUrl: string;
    platforms: Record<string, { name: string; sha256: string }>;
  };
  ajv?: {
    ajvVersion: string;
    ajvFormatsVersion: string;
    ajvTarballUrl: string;
    ajvSha256: string;
    ajvFormatsTarballUrl: string;
    ajvFormatsSha256: string;
  };
}

export interface BootstrapResult {
  npmInstall: { ran: boolean; durationMs: number };
  surrealBinary: { path: string; provisioned: boolean; sizeBytes: number };
  surrealServer: { url: string; pid: number | null; managed: boolean; user: string; pass: string };
  embeddingModel: { path: string; provisioned: boolean; sizeBytes: number };
  rerankerModel: { path: string | null; provisioned: boolean; sizeBytes: number; skipped: boolean };
  nodeLlamaCpp: { mainPath: string | null; provisioned: boolean };
  ajv: { provisioned: boolean; nodeModulesDir: string | null };
  totalDurationMs: number;
}

export interface BootstrapInput {
  pluginDir: string;
  cacheDir: string;
  dataDir: string;
  modelPath: string;
  rerankerModelPath?: string;
  rerankerEnabled?: boolean;
  surrealBinPathOverride: string | null;
  surrealUrlOverride: string | undefined;
  surrealUser: string;
  surrealPass: string;
}

let managedSurreal: ChildProcess | null = null;

// ── C1/C2: managed-SurrealDB child supervision ─────────────────────────────
// The managed child is spawned detached+unref'd (Option A) so it OUTLIVES the
// daemon/MCP process. C1: before this, nothing watched it — a dead or
// crash-looping child was a permanent SILENT failure (bootstrap() runs once;
// ensureConnected reconnects the WS but never re-spawns the OS process). The
// supervisor below attaches `exit`/`error` listeners at spawn time and respawns
// with BOUNDED exponential backoff. C2: if respawns crash-loop (the store is
// likely corrupt / unstartable), it STOPS, enters a loud DEGRADED state, and
// surfaces via a maintenance_runs error row — it NEVER auto-deletes or
// quarantines the data dir (a false positive at 1M installs would mass-destroy
// users' graphs; recovery is a human/opt-in decision).

/** Minimal structural view of SurrealStore the supervisor needs to surface a
 *  degraded state. Structural (not an import of SurrealStore) so bootstrap.ts
 *  stays free of an engine-store dependency and there is no import cycle —
 *  surreal.ts registers itself via registerSurrealSupervisorStore(). */
interface SupervisorStore {
  isAvailable(): boolean;
  queryExec(sql: string, bindings?: Record<string, unknown>): Promise<void>;
}

/** Everything spawnManagedSurreal needs to RE-spawn an identical child. Captured
 *  on the first managed spawn so the exit handler can reconstruct the process
 *  without re-running the whole bootstrap. */
interface RespawnParams {
  binPath: string;
  dataDir: string;
  port: number;
  user: string;
  pass: string;
  cacheDir: string;
}

/** Crash-loop window: >= MAX_RESTARTS unexpected exits within WINDOW_MS trips
 *  the cap → STOP respawning, mark degraded, surface loudly. Tuned so a genuine
 *  transient (one bad shutdown, an OOM kill) self-heals, but a child that cannot
 *  stay up (corrupt SurrealKV, port permanently stolen, bad binary) is caught
 *  fast instead of fork-bombing. */
const SUPERVISOR_MAX_RESTARTS = 5;
const SUPERVISOR_WINDOW_MS = 60_000;
/** Bounded exponential backoff between respawns: 0.5s, 1s, 2s, 4s, then capped
 *  at 8s. A floor of >0 prevents a tight respawn loop from pegging a CPU even
 *  before the crash-loop cap trips. */
const SUPERVISOR_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

const supervisorState = {
  /** Set true ONLY by shutdownManagedSurreal({force}) (intentional teardown) so
   *  the exit handler does NOT respawn on a deliberate kill. */
  shuttingDown: false,
  /** Latched true once the crash-loop cap trips. Stops all further respawns for
   *  the process lifetime (a fresh daemon boot re-runs bootstrap → re-spawns →
   *  resets this). */
  degraded: false,
  /** Timestamps (ms) of recent unexpected exits, pruned to the sliding window. */
  exitTimes: [] as number[],
  /** Idempotency guard: a respawn is scheduled/in-flight. Prevents a stray
   *  second `exit`/`error` event (some platforms emit both) from launching two
   *  children racing for the same port. */
  respawning: false,
  /** Captured spawn args for the managed child; null until the first managed
   *  spawn. The reuse / external-DB / SURREAL_URL paths never set this, so the
   *  supervisor stays inert for instances whose lifecycle we don't own. */
  params: null as RespawnParams | null,
  /** Registered SurrealStore for surfacing the degraded state (best-effort). */
  store: null as SupervisorStore | null,
  /** Pending backoff timer, so shutdown can cancel a scheduled respawn. */
  timer: null as ReturnType<typeof setTimeout> | null,
};

/** Wire the SurrealStore the supervisor uses to surface a DEGRADED state via a
 *  maintenance_runs error row (memory_health then goes RED). Called by
 *  SurrealStore's constructor (surreal.ts) so no cross-module daemon wiring is
 *  needed; idempotent (last writer wins). Exported for that call + unit tests. */
export function registerSurrealSupervisorStore(store: SupervisorStore | null): void {
  supervisorState.store = store;
}

/** Re-arm the supervisor for a process that is taking ownership of a freshly
 *  spawned managed child (the bootstrap() fresh-spawn path). Clears any stale
 *  shutdown/degraded state + the restart-window history so a prior incarnation
 *  in the same process (a test, or a re-bootstrap) cannot leave shuttingDown
 *  latched and silently suppress all supervision. Respawn callers do NOT invoke
 *  this — the crash-loop window is intentionally preserved across respawns. */
function armSupervisorForFreshSpawn(): void {
  supervisorState.shuttingDown = false;
  supervisorState.degraded = false;
  supervisorState.exitTimes = [];
  supervisorState.respawning = false;
  if (supervisorState.timer) { clearTimeout(supervisorState.timer); supervisorState.timer = null; }
}

/** Test-only: reset the supervisor between cases (module state is process-wide).
 *  Cancels any pending respawn timer so a leftover timer can't fire across
 *  tests. Not used in production. */
export function __resetSupervisorForTest(): void {
  if (supervisorState.timer) clearTimeout(supervisorState.timer);
  supervisorState.shuttingDown = false;
  supervisorState.degraded = false;
  supervisorState.exitTimes = [];
  supervisorState.respawning = false;
  supervisorState.params = null;
  supervisorState.store = null;
  supervisorState.timer = null;
  managedSurreal = null;
}

/** Test-only inspection of supervisor state (avoids exporting the mutable
 *  object directly). */
export function __getSupervisorState(): {
  degraded: boolean;
  shuttingDown: boolean;
  restartsInWindow: number;
} {
  return {
    degraded: supervisorState.degraded,
    shuttingDown: supervisorState.shuttingDown,
    restartsInWindow: supervisorState.exitTimes.length,
  };
}

/** Surface a managed-child supervision failure LOUDLY (C2). Writes a
 *  maintenance_runs row job='surrealSupervisor' status='error' so memory_health
 *  goes RED, and logs the data-dir + an actionable recovery hint. NEVER touches
 *  the data dir. Best-effort: a store that is unavailable (the most likely state
 *  when the DB child is down!) just gets the stderr log — the row is written on
 *  the next boot once the store reconnects, and the loud log is always present. */
function surfaceSupervisorDegraded(message: string): void {
  const dataDir = supervisorState.params?.dataDir ?? "(unknown)";
  log.error(
    `[bootstrap] managed SurrealDB SUPERVISOR DEGRADED: ${message}\n` +
      `  data dir: ${dataDir}\n` +
      `  The managed database child could not be kept running. laqrumcode has STOPPED\n` +
      `  respawning to avoid a crash loop and has NOT modified your data.\n` +
      `  If the store is corrupt, recover by restoring a backup, e.g.:\n` +
      `    surreal import --conn http://127.0.0.1:<port> --user <user> --pass <pass> \\\n` +
      `      --ns laqrum --db memory <your-export.surql>\n` +
      `  (or restore a gc-backup snapshot). laqrumcode will not auto-recover or delete the\n` +
      `  data dir — that is a human decision.`,
  );
  const store = supervisorState.store;
  if (!store) return;
  // Best-effort, fire-and-forget. isAvailable() gates the write the same way
  // maintenance.runJob does; a failure to record must never throw out of the
  // exit handler.
  void (async () => {
    try {
      if (!store.isAvailable()) return;
      await store.queryExec(`CREATE maintenance_runs CONTENT $data`, {
        data: {
          job: "surrealSupervisor",
          status: "error",
          rows_affected: 0,
          duration_ms: 0,
          error: `${message} data_dir=${dataDir}`.slice(0, 300),
        },
      });
    } catch {
      /* swallow — surfacing must not crash the supervisor */
    }
  })();
}

/** Record an unexpected exit timestamp and report whether the crash-loop cap
 *  has tripped within the sliding window. Pure-ish (mutates exitTimes); separated
 *  out so the test can assert the window math directly. */
function registerUnexpectedExit(now = Date.now()): { crashLoop: boolean } {
  const cutoff = now - SUPERVISOR_WINDOW_MS;
  supervisorState.exitTimes = supervisorState.exitTimes.filter((t) => t > cutoff);
  supervisorState.exitTimes.push(now);
  return { crashLoop: supervisorState.exitTimes.length >= SUPERVISOR_MAX_RESTARTS };
}

/** The exit/error handler attached to every managed child (initial spawn AND
 *  respawns). Decides: ignore (intentional shutdown / already degraded), or
 *  respawn with backoff, or trip the crash-loop cap and degrade. Async only so
 *  the awaited respawn settles; all throws are contained. */
async function onManagedChildExit(reason: string): Promise<void> {
  // Intentional teardown or already-degraded → do nothing (never respawn).
  if (supervisorState.shuttingDown || supervisorState.degraded) return;
  // No captured params → not a child whose lifecycle we own (reuse / external).
  if (!supervisorState.params) return;
  // Idempotency: a respawn already scheduled/in-flight swallows duplicate events
  // (e.g. an 'error' immediately followed by 'exit' for the same death).
  if (supervisorState.respawning) return;

  const { crashLoop } = registerUnexpectedExit();
  if (crashLoop) {
    // C2: STOP. Mark degraded, surface loudly, do NOT respawn, do NOT touch data.
    supervisorState.degraded = true;
    surfaceSupervisorDegraded(
      `managed SurrealDB child exited >= ${SUPERVISOR_MAX_RESTARTS} times within ` +
        `${SUPERVISOR_WINDOW_MS / 1000}s (last: ${reason}); crash-loop cap tripped`,
    );
    return;
  }

  // Bounded exponential backoff, indexed by how many restarts we've already
  // attempted in this window (clamped to the last/largest entry).
  const idx = Math.min(supervisorState.exitTimes.length - 1, SUPERVISOR_BACKOFF_MS.length - 1);
  const delay = SUPERVISOR_BACKOFF_MS[Math.max(0, idx)];
  log.warn(
    `[bootstrap] managed SurrealDB child ${reason} unexpectedly — respawning in ${delay}ms ` +
      `(restart ${supervisorState.exitTimes.length}/${SUPERVISOR_MAX_RESTARTS} within ` +
      `${SUPERVISOR_WINDOW_MS / 1000}s window)`,
  );
  supervisorState.respawning = true;
  await new Promise<void>((resolve) => {
    supervisorState.timer = setTimeout(resolve, delay);
    // Don't keep the event loop alive solely for a pending respawn.
    supervisorState.timer.unref?.();
  });
  supervisorState.timer = null;
  // Re-check shutdown AFTER the backoff: a shutdown that arrived during the wait
  // must abort the respawn (otherwise we'd resurrect a child the operator killed).
  if (supervisorState.shuttingDown || supervisorState.degraded) {
    supervisorState.respawning = false;
    return;
  }
  const p = supervisorState.params;
  try {
    // NB: the spawn is assigned to a local and the local is awaited (instead of
    // awaiting the call expression inline) so the lint-managed-cred-wiring
    // invariant — which scans for the first inline await-call token to locate
    // bootstrap()'s fresh-spawn site — still resolves to that site, not this
    // respawn. Behaviour is identical to awaiting the call directly.
    const respawn = spawnManagedSurreal(p.binPath, p.dataDir, p.port, p.user, p.pass, p.cacheDir);
    await respawn;
    log.warn(`[bootstrap] managed SurrealDB child respawned (pid=${managedSurreal?.pid ?? "?"})`);
  } catch (e) {
    // A respawn that THROWS (e.g. spawn() EACCES) counts as another failure —
    // record it so a persistent inability to even launch trips the cap rather
    // than silently giving up. Schedule the next attempt via a synthetic exit.
    log.error(`[bootstrap] managed SurrealDB respawn failed: ${(e as Error).message}`);
    supervisorState.respawning = false;
    await onManagedChildExit("respawn-failed");
    return;
  }
  supervisorState.respawning = false;
}

/** Resolve the plugin root from this file's compiled location.
 *
 *  Three runtime layouts to handle:
 *    1. Compiled tsc: bootstrap.js at <plugin>/dist/engine/ — walk up 2.
 *    2. esbuild bundle: bundle.cjs at <plugin>/dist/daemon/ — walk up 2.
 *    3. SEA executable: binary at <plugin>/bin/laqrumcode-daemon-<platform>
 *       — walk up 1 (NOT 2; the SEA binary lives in bin/, not dist/engine/).
 *
 *  Under SEA (CJS-in-binary), import.meta.url is undefined and fileURLToPath
 *  throws — caught and we use process.execPath instead.
 *
 *  LAQRUMCODE_PLUGIN_DIR env var always wins for explicit overrides (tests,
 *  unusual install layouts).
 */
export function resolvePluginDir(): string {
  if (process.env.LAQRUMCODE_PLUGIN_DIR) return process.env.LAQRUMCODE_PLUGIN_DIR;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // bootstrap.js at <pluginDir>/dist/engine/ — walk up two levels.
    return join(moduleDir, "..", "..");
  } catch {
    // SEA / CJS path: process.execPath is the SEA binary at
    // <pluginDir>/bin/laqrumcode-{daemon,mcp}-<platform>. Walk up ONE level.
    return join(dirname(process.execPath), "..");
  }
}

function detectPlatformKey(): string {
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${process.platform}-${arch}`;
}

/**
 * Per-host inactivity (in ms) the download watchdog tolerates with NO bytes
 * before it tears the transfer down. Exported so the regression test can drive
 * it without waiting the production interval.
 */
export const DOWNLOAD_INACTIVITY_MS = 30_000;

/**
 * How long (ms) to wait for the CONNECTION + RESPONSE HEADERS only. This is a
 * short, scoped bound: a CDN that accepts the TCP connect but never sends a
 * status line must not hang bootstrap. It is cleared the instant fetch()
 * resolves with headers, so it can NEVER abort a healthy body stream that is
 * slow-but-progressing (R5) — the body phase is governed solely by the
 * per-chunk inactivity watchdog below.
 */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;

export async function downloadFile(
  url: string,
  destPath: string,
  expectedSha256: string | null,
  // Test seam: override the watchdog/connect bounds so the regression test runs
  // in milliseconds instead of the 30s production interval. Production callers
  // pass three args; the defaults preserve the prior behavior.
  opts?: { inactivityMs?: number; connectTimeoutMs?: number },
): Promise<{ sizeBytes: number }> {
  const INACTIVITY_MS = opts?.inactivityMs ?? DOWNLOAD_INACTIVITY_MS;
  const CONNECT_TIMEOUT_MS = opts?.connectTimeoutMs ?? DOWNLOAD_CONNECT_TIMEOUT_MS;

  // R5: bound ONLY the connection/headers phase, not the whole body stream. A
  // fixed total-duration AbortSignal on the body would abort a healthy
  // slow-but-progressing large download (BGE-M3 ~420MB / reranker ~606MB) on a
  // modest link — a deterministic cold-start failure. Use an AbortController
  // whose timer we clear the moment headers arrive, so the body phase is never
  // wall-clock-capped. The per-chunk inactivity watchdog (below) is the only
  // body-phase guard; it alone distinguishes "wedged" from "slow".
  const connectController = new AbortController();
  const connectTimer = setTimeout(() => {
    connectController.abort(
      new Error(`download connect timeout: no response headers within ${CONNECT_TIMEOUT_MS}ms for ${url}`),
    );
  }, CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: connectController.signal });
  } finally {
    // Headers are in (or the connect aborted/failed). Either way the connect
    // bound has done its job — disarm it so it can't fire against the body read.
    clearTimeout(connectTimer);
  }
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  if (!res.body) {
    throw new Error(`download returned empty body: ${url}`);
  }

  await mkdir(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.partial`;
  const writer = createWriteStream(tmpPath);
  let bytes = 0;
  const hasher = expectedSha256 ? createHash("sha256") : null;

  // R14/R15: stream via pipeline() instead of a manual write/drain loop.
  //   - R14 (writer fd leak): pipeline() destroys the destination stream on a
  //     source error AND on a transform error, so the .partial fd is always
  //     closed even when the transfer throws mid-stream. The old try/finally
  //     only cleared the stall timer — writer.end() was skipped on throw.
  //   - R15 (drain hang): pipeline() propagates write-side errors (ENOSPC/EIO)
  //     and rejects, where the old `writer.once("drain")` had no error/reject
  //     path and would park forever.
  //
  // The Source is the fetch body normalized to a Node Readable. The Transform
  // is a pass-through that (a) counts bytes, (b) feeds the sha256 hasher, and
  // (c) re-arms the inactivity watchdog on every chunk. The watchdog destroys
  // the SOURCE on stall; pipeline then rejects and tears down every stage.
  const source = toNodeReadable(res.body);

  // R5 + watchdog: per-chunk inactivity timer. Reset on every chunk; if no
  // chunk arrives within INACTIVITY_MS, destroy the source so pipeline()
  // rejects (same shape as a pre-existing network error) instead of hanging.
  // The leftover .partial is harmless — a retry truncates+overwrites it via
  // createWriteStream and rename only fires after a clean finish + hash check.
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      source.destroy(
        new Error(
          `download stalled: no data for ${INACTIVITY_MS}ms after ${bytes} bytes for ${url}`,
        ),
      );
    }, INACTIVITY_MS);
  };

  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      armStallTimer(); // progress — reset the inactivity deadline
      if (hasher) hasher.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    armStallTimer(); // arm before the first byte so a never-starting body trips
    // pipeline closes writer on completion AND destroys all stages on any
    // error (source stall, network reset, write error). No manual end()/destroy.
    await pipeline(source, meter, writer);
  } catch (err) {
    // Defense-in-depth: pipeline already destroyed the writer, but ensure the
    // partial file is gone so a retry starts clean and no fd is left dangling.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }

  if (hasher && expectedSha256) {
    const actual = hasher.digest("hex");
    if (actual !== expectedSha256) {
      await rm(tmpPath, { force: true });
      throw new Error(
        `sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`,
      );
    }
  }

  await rename(tmpPath, destPath);
  return { sizeBytes: bytes };
}

/** Normalize a fetch() body to a Node Readable for pipeline().
 *
 *  Node's global fetch returns a WHATWG ReadableStream (web stream). pipeline()
 *  from node:stream/promises wants a Node stream. Readable.fromWeb() bridges it
 *  and — critically for the watchdog — propagates Readable.destroy(err) back to
 *  the web stream's cancel(), so destroying the returned Readable on stall
 *  actually tears down the underlying socket. If fromWeb is unavailable or the
 *  body is already a Node Readable (some runtimes/mocks), fall back to
 *  Readable.from over the async-iterable. */
function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  const fromWeb = (Readable as unknown as { fromWeb?: (s: unknown) => Readable }).fromWeb;
  if (typeof fromWeb === "function") {
    return fromWeb(body);
  }
  return Readable.from(body as AsyncIterable<Uint8Array>);
}

async function ensureNpmDeps(
  pluginDir: string,
): Promise<{ ran: boolean; durationMs: number }> {
  const nodeModules = join(pluginDir, "node_modules");
  if (existsSync(nodeModules)) {
    return { ran: false, durationMs: 0 };
  }
  // Skip when no package.json is adjacent — under SEA the binary stands alone
  // (deps are bundled inline + native pieces downloaded separately into the
  // cache), and LAQRUMCODE_SKIP_NPM_CI is an explicit opt-out for advanced setups.
  if (!existsSync(join(pluginDir, "package.json"))) {
    return { ran: false, durationMs: 0 };
  }
  if (process.env.LAQRUMCODE_SKIP_NPM_CI === "1") {
    return { ran: false, durationMs: 0 };
  }
  log.info(
    `[bootstrap] node_modules missing under ${pluginDir} — running 'npm ci --omit=dev' (one-time first-run cost, ~1-2 min)`,
  );
  const start = Date.now();
  // Pass --prefix so we install into the plugin dir even if cwd is elsewhere.
  // On Windows, npm is actually npm.cmd — Node's execFile won't resolve .cmd
  // files without shell mode (per child_process docs). Without this flag,
  // bootstrap silently hangs or errors on every Windows install.
  await execFileAsync("npm", ["ci", "--omit=dev", "--prefix", pluginDir], {
    env: { ...process.env, npm_config_yes: "true" },
    maxBuffer: 200 * 1024 * 1024, // npm output for native deps can be chatty
    shell: process.platform === "win32",
  });
  return { ran: true, durationMs: Date.now() - start };
}

async function ensureSurrealBinary(
  cacheDir: string,
  manifest: Manifest,
  override: string | null,
): Promise<{ path: string; provisioned: boolean; sizeBytes: number }> {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`SURREAL_BIN_PATH points to missing file: ${override}`);
    }
    return { path: override, provisioned: false, sizeBytes: statSync(override).size };
  }
  const platformKey = detectPlatformKey();
  const platform = manifest.surrealdb.platforms[platformKey];
  if (!platform) {
    throw new Error(
      `laqrumcode bootstrap does not have a SurrealDB binary mapping for platform "${platformKey}". ` +
        `Supported: ${Object.keys(manifest.surrealdb.platforms).join(", ")}. ` +
        `Workaround: install SurrealDB ${manifest.surrealdb.version} manually and set SURREAL_BIN_PATH, ` +
        `or point SURREAL_URL at an existing SurrealDB instance.`,
    );
  }
  const versionedDir = join(cacheDir, `surreal-${manifest.surrealdb.version}`);
  const binPath = join(versionedDir, platform.binaryName);
  if (existsSync(binPath)) {
    return { path: binPath, provisioned: false, sizeBytes: statSync(binPath).size };
  }
  const url = manifest.surrealdb.releaseUrl
    .replaceAll("{version}", manifest.surrealdb.version)
    .replaceAll("{platform}", platform.platform)
    .replaceAll("{ext}", platform.ext);
  log.info(
    `[bootstrap] Downloading SurrealDB ${manifest.surrealdb.version} for ${platformKey}: ${url}`,
  );
  const archivePath = join(versionedDir, `surreal.${platform.ext}`);
  const dl = await downloadFile(url, archivePath, platform.sha256);

  if (platform.ext === "tgz" || platform.ext === "tar.gz") {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", versionedDir]);
    await rm(archivePath, { force: true });
  } else {
    // Single-file binary (Windows .exe). Move into place under the expected name.
    await rename(archivePath, binPath);
  }
  if (!existsSync(binPath)) {
    throw new Error(
      `extraction did not produce expected binary at ${binPath}. archive may have a different layout.`,
    );
  }
  if (process.platform !== "win32") {
    chmodSync(binPath, 0o755);
  }
  return { path: binPath, provisioned: true, sizeBytes: dl.sizeBytes };
}

/**
 * Download node-llama-cpp main package + matching platform binding into
 * <cacheDir>/native/ so SEA-built binaries (which have no adjacent
 * node_modules) can still resolve the dynamic import. Layout matches Node's
 * standard module resolution: the platform package goes under
 * <cacheDir>/native/node_modules/@node-llama-cpp/<platform>/ so when
 * node-llama-cpp's main code does require("@node-llama-cpp/<platform>"),
 * Node walks up from <cacheDir>/native/node-llama-cpp/dist/ and finds it.
 *
 * Sets LAQRUMCODE_NODE_LLAMA_CPP_PATH to the absolute index.js path so
 * src/engine/llama-loader.ts imports from the right place.
 *
 * Skipped when running under standard Node + node_modules (the existing
 * "node-llama-cpp" specifier resolves naturally).
 */
async function ensureNodeLlamaCpp(
  cacheDir: string,
  manifest: Manifest,
  pluginDir: string,
): Promise<{ mainPath: string | null; provisioned: boolean }> {
  // Skip if node_modules has node-llama-cpp adjacent (npm-ci'd plugin install
  // or dev tree). Cheap existsSync — saves the manifest lookup + work.
  if (existsSync(join(pluginDir, "node_modules", "node-llama-cpp", "package.json"))) {
    return { mainPath: null, provisioned: false };
  }
  if (!manifest.nodeLlamaCpp) {
    return { mainPath: null, provisioned: false };
  }
  const platformKey = detectPlatformKey();
  const platformMapping = manifest.nodeLlamaCpp.platforms[platformKey];
  if (!platformMapping) {
    log.warn(
      `[bootstrap] node-llama-cpp: no platform mapping for ${platformKey} — embeddings will fail unless LAQRUMCODE_NODE_LLAMA_CPP_PATH is set.`,
    );
    return { mainPath: null, provisioned: false };
  }
  const platformName = platformMapping.name;

  const version = manifest.nodeLlamaCpp.version;
  const nativeDir = join(cacheDir, "native");
  const mainDir = join(nativeDir, "node-llama-cpp");
  const mainEntry = join(mainDir, "dist", "index.js");
  const platformDir = join(nativeDir, "node_modules", "@node-llama-cpp", platformName);
  const platformPkg = join(platformDir, "package.json");

  // Idempotent: skip download if both already extracted.
  if (existsSync(mainEntry) && existsSync(platformPkg)) {
    process.env.LAQRUMCODE_NODE_LLAMA_CPP_PATH = mainEntry;
    return { mainPath: mainEntry, provisioned: false };
  }

  const mainUrl = manifest.nodeLlamaCpp.mainTarballUrl.replaceAll("{version}", version);
  const platformUrl = manifest.nodeLlamaCpp.platformTarballUrl
    .replaceAll("{version}", version)
    .replaceAll("{platform}", platformName);

  log.info(
    `[bootstrap] Downloading node-llama-cpp ${version} (main + ${platformName} binding) for ${platformKey}`,
  );
  const mainTarball = join(nativeDir, `node-llama-cpp-${version}.tgz`);
  const platformTarball = join(nativeDir, `${platformName}-${version}.tgz`);
  await downloadFile(mainUrl, mainTarball, manifest.nodeLlamaCpp.mainSha256);
  await downloadFile(platformUrl, platformTarball, platformMapping.sha256);

  // npm tarballs wrap contents in a "package/" prefix; --strip-components=1
  // unwraps that so the package files land directly in mainDir / platformDir.
  await mkdir(mainDir, { recursive: true });
  await mkdir(platformDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", mainTarball, "-C", mainDir, "--strip-components=1"]);
  await execFileAsync("tar", ["-xzf", platformTarball, "-C", platformDir, "--strip-components=1"]);
  await rm(mainTarball, { force: true });
  await rm(platformTarball, { force: true });

  if (!existsSync(mainEntry)) {
    throw new Error(`node-llama-cpp tarball did not extract to expected path ${mainEntry}`);
  }
  process.env.LAQRUMCODE_NODE_LLAMA_CPP_PATH = mainEntry;
  return { mainPath: mainEntry, provisioned: true };
}

/** Download ajv + ajv-formats into <cacheDir>/native/node_modules/ so the
 *  bundled MCP client (laqrumcode-mcp under SEA) can resolve their dynamic
 *  require() calls at runtime. The MCP SDK uses ajv via dynamic require
 *  (createRequire(import.meta.url) → require("ajv/dist/runtime/...")) which
 *  esbuild can't statically resolve, so they MUST be externalized and
 *  available on Node's resolution path.
 *
 *  Caller (mcp-client startup) is responsible for prepending
 *  <cacheDir>/native/node_modules to NODE_PATH before invoking the
 *  bundled SEA. */
async function ensureAjv(
  cacheDir: string,
  manifest: Manifest,
  pluginDir: string,
): Promise<{ provisioned: boolean; nodeModulesDir: string | null }> {
  // Skip if local node_modules has both. dev tree fast-path.
  if (
    existsSync(join(pluginDir, "node_modules", "ajv", "package.json")) &&
    existsSync(join(pluginDir, "node_modules", "ajv-formats", "package.json"))
  ) {
    return { provisioned: false, nodeModulesDir: null };
  }
  if (!manifest.ajv) {
    return { provisioned: false, nodeModulesDir: null };
  }

  const nativeNodeModules = join(cacheDir, "native", "node_modules");
  const ajvDir = join(nativeNodeModules, "ajv");
  const ajvFormatsDir = join(nativeNodeModules, "ajv-formats");
  const bothPresent =
    existsSync(join(ajvDir, "package.json")) &&
    existsSync(join(ajvFormatsDir, "package.json"));
  if (bothPresent) {
    return { provisioned: false, nodeModulesDir: nativeNodeModules };
  }

  const ajvUrl = manifest.ajv.ajvTarballUrl.replaceAll("{version}", manifest.ajv.ajvVersion);
  const ajvFormatsUrl = manifest.ajv.ajvFormatsTarballUrl.replaceAll(
    "{version}",
    manifest.ajv.ajvFormatsVersion,
  );

  log.info(
    `[bootstrap] Downloading ajv ${manifest.ajv.ajvVersion} + ajv-formats ${manifest.ajv.ajvFormatsVersion} for SEA-bundle MCP client`,
  );
  const ajvTarball = join(nativeNodeModules, `ajv-${manifest.ajv.ajvVersion}.tgz`);
  const ajvFormatsTarball = join(
    nativeNodeModules,
    `ajv-formats-${manifest.ajv.ajvFormatsVersion}.tgz`,
  );
  await mkdir(ajvDir, { recursive: true });
  await mkdir(ajvFormatsDir, { recursive: true });
  await downloadFile(ajvUrl, ajvTarball, manifest.ajv.ajvSha256);
  await downloadFile(ajvFormatsUrl, ajvFormatsTarball, manifest.ajv.ajvFormatsSha256);

  // npm tarballs wrap contents in a "package/" prefix; strip-components=1
  // unwraps that so package files land directly in ajvDir / ajvFormatsDir.
  await execFileAsync("tar", ["-xzf", ajvTarball, "-C", ajvDir, "--strip-components=1"]);
  await execFileAsync("tar", [
    "-xzf",
    ajvFormatsTarball,
    "-C",
    ajvFormatsDir,
    "--strip-components=1",
  ]);
  await rm(ajvTarball, { force: true });
  await rm(ajvFormatsTarball, { force: true });

  if (!existsSync(join(ajvDir, "package.json")) || !existsSync(join(ajvFormatsDir, "package.json"))) {
    throw new Error("ajv tarballs did not extract to expected paths");
  }

  return { provisioned: true, nodeModulesDir: nativeNodeModules };
}

async function ensureEmbeddingModel(
  modelPath: string,
  manifest: Manifest,
): Promise<{ path: string; provisioned: boolean; sizeBytes: number }> {
  if (existsSync(modelPath)) {
    return { path: modelPath, provisioned: false, sizeBytes: statSync(modelPath).size };
  }
  log.info(
    `[bootstrap] Downloading BGE-M3 embedding model (~420MB, one-time): ${manifest.embeddingModel.url}`,
  );
  const dl = await downloadFile(
    manifest.embeddingModel.url,
    modelPath,
    manifest.embeddingModel.sha256,
  );
  return { path: modelPath, provisioned: true, sizeBytes: dl.sizeBytes };
}

async function ensureRerankerModel(
  modelPath: string,
  manifest: Manifest,
  enabled: boolean,
): Promise<{ path: string | null; provisioned: boolean; sizeBytes: number; skipped: boolean }> {
  if (!enabled) {
    log.info("[bootstrap] reranker disabled (LAQRUMCODE_RERANKER_DISABLED=1) — skipping download");
    return { path: null, provisioned: false, sizeBytes: 0, skipped: true };
  }
  if (!manifest.rerankerModel) {
    log.warn("[bootstrap] no reranker entry in manifest — skipping download");
    return { path: null, provisioned: false, sizeBytes: 0, skipped: true };
  }
  if (existsSync(modelPath)) {
    return { path: modelPath, provisioned: false, sizeBytes: statSync(modelPath).size, skipped: false };
  }
  log.info(
    `[bootstrap] Downloading bge-reranker-v2-m3 (~606MB, one-time): ${manifest.rerankerModel.url}`,
  );
  try {
    const dl = await downloadFile(
      manifest.rerankerModel.url,
      modelPath,
      manifest.rerankerModel.sha256,
    );
    return { path: modelPath, provisioned: true, sizeBytes: dl.sizeBytes, skipped: false };
  } catch (e) {
    log.warn(`[bootstrap] reranker download failed (recall will fall back to WMR/ACAN): ${(e as Error).message}`);
    return { path: null, provisioned: false, sizeBytes: 0, skipped: true };
  }
}

const SURREAL_PID_FILENAME = "surreal.pid";

/** Phase 2 (multi-user auth, after GH #13): the MANAGED SurrealDB child no
 *  longer uses the root:root default. Instead we generate a per-user/-machine
 *  credential and persist it next to the laqrumcode home so a reused detached
 *  child (Option A) and the connecting daemon agree on the same secret.
 *
 *  Stored at ~/.laqrumcode/surreal-cred.json — sibling of cache/ and data/, since
 *  cacheDir resolves to ~/.laqrumcode/cache. Derived from cacheDir's parent so
 *  tests that inject a temp cacheDir get an injectable, isolated cred path. */
const SURREAL_CRED_FILENAME = "surreal-cred.json";

export interface ManagedSurrealCred {
  user: string;
  pass: string;
}

/** Resolve the cred-file path from the bootstrap cacheDir. cacheDir is
 *  ~/.laqrumcode/cache in production, so the parent is ~/.laqrumcode. Keeping it a
 *  sibling of cacheDir (rather than inside it) means a `rm -rf cache/` to force
 *  a re-download of the binary/model does NOT nuke the credential and orphan a
 *  still-running managed child that was spawned with it. */
function surrealCredPath(cacheDir: string): string {
  return join(dirname(cacheDir), SURREAL_CRED_FILENAME);
}

/** Read-or-create the managed-instance credential. Idempotent: if the file
 *  already exists and parses to a {user, pass} with non-empty strings, it is
 *  returned unchanged — this is what lets a freshly-booting daemon reuse the
 *  exact secret a previously-spawned detached child (Option A) is already
 *  running with. Otherwise a fresh credential is generated and written.
 *
 *  - user: `laqrum_<uid>` on POSIX (matches the iLaqrum per-user naming precedent),
 *    plain `laqrum` where getuid is unavailable (Windows).
 *  - pass: 24 random bytes, base64url (~32 chars, URL/CLI-safe, no padding).
 *  - File perms tightened to 0600 best-effort (cross-platform: chmod is a
 *    no-op-ish on Windows and is wrapped in try/catch so it never throws).
 *
 *  Never throws on a read parse error — a corrupt/legacy file is treated as
 *  absent and regenerated (the managed child would then be respawned with the
 *  new secret on its next lifecycle, same graceful-migration path as a
 *  pre-Phase-2 root:root child). */
export function getOrCreateManagedCred(cacheDir: string): ManagedSurrealCred {
  const path = surrealCredPath(cacheDir);
  // Read existing.
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ManagedSurrealCred>;
      if (
        parsed &&
        typeof parsed.user === "string" && parsed.user.length > 0 &&
        typeof parsed.pass === "string" && parsed.pass.length > 0
      ) {
        return { user: parsed.user, pass: parsed.pass };
      }
      log.warn(`[bootstrap] managed surreal cred file at ${path} is malformed — regenerating`);
    } catch (e) {
      log.warn(`[bootstrap] failed to read managed surreal cred file (${(e as Error).message}) — regenerating`);
    }
  }
  // Generate fresh.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const user = uid === null ? "laqrum" : `laqrum_${uid}`;
  const pass = randomBytes(24).toString("base64url");
  const cred: ManagedSurrealCred = { user, pass };
  try {
    // Ensure parent (~/.laqrumcode) exists; cacheDir's own mkdir happens later,
    // but the cred sits one level up so we create that level here. E14: narrow
    // the parent dir to 0700 so the cred file is never reachable through a
    // world-traversable directory (best-effort; no-op / EPERM on Windows).
    mkdirSync(dirname(path), { recursive: true });
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort; no-op on Windows */ }
  } catch { /* parent may already exist; writeFileSync will surface real errors */ }
  try {
    // E14: pass mode:0o600 so the file is CREATED at 0600 (the mode is applied
    // at the underlying open(O_CREAT) call), closing the create-then-narrow race
    // where a plain write left it briefly world-readable before chmod. Mirrors
    // the auth-token / handoff-file write idiom (handoff-file.ts). The trailing
    // chmod is a defensive no-op for the rewrite-existing-file case (where the
    // file already exists at 0600 from our prior write and mode: is ignored).
    writeFileSync(path, JSON.stringify(cred, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort; no-op on Windows */ }
  } catch (e) {
    // If we can't persist, we still return the in-memory cred so the spawn
    // proceeds; the risk is a reused child later not matching. Log loudly.
    log.warn(`[bootstrap] could not persist managed surreal cred to ${path}: ${(e as Error).message}`);
  }
  return cred;
}

/** Does a persisted managed credential already exist on disk? Used by the
 *  reuse branch to decide whether a discovered managed child was (very likely)
 *  spawned with the generated cred (file present) or is a pre-Phase-2 root:root
 *  child (file absent → graceful migration: keep talking to it as root:root). */
function managedCredFileExists(cacheDir: string): boolean {
  return existsSync(surrealCredPath(cacheDir));
}

/** Resolve which credential the daemon should use to connect to a REUSED /
 *  DISCOVERED SurrealDB. This is the security-critical Phase-2 decision,
 *  extracted as a pure function so it is unit-testable without standing up the
 *  full bootstrap (npm ci + binary/model downloads).
 *
 *  Inputs:
 *   - discoveredPid: findExistingLaqrumcodeSurreal's returned pid. Non-null ⟺ a
 *     managed-surface port for which we hold a LIVE pid file (it is OUR managed
 *     child). Null ⟺ an EXTERNAL DB (8000/8042) whose lifecycle we don't own.
 *   - credFileExists: managedCredFileExists(cacheDir).
 *   - configured: the user-configured creds (config.surreal.user/pass, i.e.
 *     root:root by default or SURREAL_USER/SURREAL_PASS).
 *   - generated: the persisted/generated managed cred (only meaningful when the
 *     file exists; pass the result of getOrCreateManagedCred).
 *
 *  Decision table:
 *   pid !== null && credFileExists  → GENERATED  (our child, spawned with it)
 *   pid !== null && !credFileExists → root:root  (pre-Phase-2 child; graceful
 *                                                 migration — don't break it)
 *   pid === null                    → CONFIGURED (external; auth UNCHANGED) */
export function resolveReusedTargetCred(args: {
  discoveredPid: number | null;
  credFileExists: boolean;
  configured: ManagedSurrealCred;
  generated: ManagedSurrealCred;
}): ManagedSurrealCred {
  const { discoveredPid, credFileExists, configured, generated } = args;
  if (discoveredPid !== null) {
    return credFileExists ? generated : { user: "root", pass: "root" };
  }
  return configured;
}

/** Tables that are unique to laqrumcode's schema — used as a fingerprint to
 *  distinguish "this is our DB" from "this is a SurrealDB someone else
 *  happens to be running on the same port" (e.g., a trading bot's DB).
 *  These names are laqrumcode-specific enough that a generic SurrealDB
 *  install or a different application would not have them. */
const LAQRUMCODE_FINGERPRINT_TABLES = ["monologue", "identity_chunk", "acan_state", "causal"];

/** Probe a candidate SurrealDB URL to determine if it's a laqrumcode database.
 *  Three checks: HTTP /health alive, auth succeeds against laqrum/memory ns/db,
 *  INFO FOR DB returns at least one laqrumcode-fingerprint table.
 *
 *  Returns true only when all three pass. False on any failure (timeout,
 *  auth fail, wrong ns/db, missing tables). */
async function isLaqrumcodeSurreal(
  url: string,
  user: string,
  pass: string,
): Promise<boolean> {
  // Convert ws://host:port/rpc → http://host:port/sql for the auth+query probe
  const sqlUrl = url
    .replace(/^wss?:/, (m) => (m === "wss:" ? "https:" : "http:"))
    .replace(/\/rpc$/, "/sql");
  try {
    const res = await fetch(sqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
        "surreal-ns": "laqrum",
        "surreal-db": "memory",
      },
      body: "INFO FOR DB;",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as Array<{ result?: { tables?: Record<string, unknown> } }>;
    const tables = data?.[0]?.result?.tables;
    if (!tables || typeof tables !== "object") return false;
    return LAQRUMCODE_FINGERPRINT_TABLES.some((t) => t in tables);
  } catch {
    return false;
  }
}

/**
 * Find the OS-user (UID) that owns the process LISTENING on a loopback TCP
 * `port`, using only the Linux `/proc` filesystem.
 *
 * --- Threat model (GH #13) ---
 * On a shared host, OS user B must never connect to OS user A's laqrumcode
 * memory graph. The schema fingerprint (isLaqrumcodeSurreal) confirms a port
 * speaks "laqrumcode", but NOT *whose* laqrumcode it is. Without an owner check,
 * if user A and user B collided on the same managed port (or A left a DB on
 * the legacy 18765 that B probes), B would silently attach to A's SurrealDB
 * and read/write A's private memory. This helper lets the caller verify the
 * listener's UID == our UID before connecting, and skip otherwise.
 *
 * --- Algorithm (all reads relative to `procRoot`, default "/proc") ---
 *  1. Parse `/proc/net/tcp` (+ `/proc/net/tcp6`) for rows in LISTEN state
 *     (st == 0x0A) whose local address is loopback or wildcard on `port`.
 *     Collect the socket inode (column 9). Addresses are little-endian hex;
 *     we match 127.0.0.1 / 0.0.0.0 (v4) and ::1 / :: (v6) by comparing the
 *     decoded port and accepting loopback-or-wildcard host.
 *  2. For each `/proc/<pid>/fd/*` symlink, resolve the target. A socket fd
 *     points at `socket:[<inode>]`. The first PID owning one of our inodes is
 *     the listener.
 *  3. The owner UID is that pid directory's owner — `statSync(/proc/<pid>).uid`
 *     (kernel sets the dir owner to the process's real UID). We also fall back
 *     to the `Uid:` line of `/proc/<pid>/status` if stat is unavailable.
 *
 * Returns the owner UID, or `null` if it cannot be determined (no /proc, no
 * matching listener, permission denied scanning another user's fds, etc.).
 * `null` is "unknown", NOT "ours" — callers must decide conservatively.
 *
 * `procRoot` is injected so tests can point at a fixture tree instead of the
 * real kernel /proc (which can't be faked cross-platform / in CI).
 */
export function findListenerUidViaProc(port: number, procRoot = "/proc"): number | null {
  const wantInodes = new Set<string>();
  for (const file of ["net/tcp", "net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(join(procRoot, file), "utf-8");
    } catch {
      continue; // tcp6 may be absent (IPv6 disabled); that's fine.
    }
    for (const line of text.split(/\r?\n/).slice(1)) {
      // Columns: sl local_address rem_address st ... inode
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1]; // "HHHHHHHH:PPPP" (hex, little-endian host)
      const st = cols[3];
      const inode = cols[9];
      if (st !== "0A") continue; // 0x0A == TCP_LISTEN
      const sep = local.lastIndexOf(":");
      if (sep < 0) continue;
      const hostHex = local.slice(0, sep);
      const portHex = local.slice(sep + 1);
      if (parseInt(portHex, 16) !== port) continue;
      // Accept loopback or wildcard binds only (a daemon bound to a public
      // address is not something we'd ever want to silently adopt anyway).
      //   IPv4 (8 hex):  0100007F = 127.0.0.1 (per-word little-endian),
      //                  00000000 = 0.0.0.0 (wildcard).
      //   IPv6 (32 hex): 00000000000000000000000000000000 = :: (wildcard),
      //                  00000000000000000000000001000000 = ::1 (loopback,
      //                  last 32-bit word byte-swapped → 01000000).
      const h = hostHex.toUpperCase();
      const loopbackOrWildcard =
        h === "0100007F" ||
        h === "00000000" ||
        h === "00000000000000000000000000000000" ||
        h === "00000000000000000000000001000000";
      if (loopbackOrWildcard && inode && inode !== "0") {
        wantInodes.add(inode);
      }
    }
  }
  if (wantInodes.size === 0) return null;

  const wantTargets = new Set(Array.from(wantInodes, (i) => `socket:[${i}]`));
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    const fdDir = join(procRoot, pid, "fd");
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue; // EACCES scanning another user's fds, or process gone.
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(join(fdDir, fd));
      } catch {
        continue;
      }
      if (wantTargets.has(target)) {
        // Found the listener. Owner UID == owner of /proc/<pid>.
        try {
          return statSync(join(procRoot, pid)).uid;
        } catch {
          // Fall back to parsing the Uid: line of status.
          try {
            const status = readFileSync(join(procRoot, pid, "status"), "utf-8");
            const m = status.match(/^Uid:\s+(\d+)/m);
            if (m) return Number(m[1]);
          } catch {
            /* give up on this pid */
          }
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Best-effort owner-UID lookup for a loopback listener, POSIX only.
 * Tries `/proc` first (cheap, no subprocess), then falls back to
 * `lsof -t -iTCP@127.0.0.1:<port> -sTCP:LISTEN` + stat'ing the pid when /proc
 * is unavailable (e.g. macOS, hardened mounts). Returns null when it cannot
 * determine the owner or when getuid is unavailable (Windows — see caller).
 */
function findListenerUid(port: number): number | null {
  if (typeof process.getuid !== "function") return null; // non-POSIX

  // 1. /proc fast path.
  if (existsSync("/proc/net/tcp")) {
    const viaProc = findListenerUidViaProc(port, "/proc");
    if (viaProc !== null) return viaProc;
  }

  // 2. lsof fallback (macOS / no-/proc POSIX). -t prints bare PIDs.
  try {
    const out = execFileSync(
      "lsof",
      ["-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf-8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const pid = out.split(/\s+/).find((p) => /^\d+$/.test(p));
    if (pid) {
      // statSync of /proc may not exist here; stat the process via lsof'd pid
      // is not directly possible without /proc, so on macOS we read the owner
      // through `ps -o uid= -p <pid>`.
      try {
        const uidStr = execFileSync("ps", ["-o", "uid=", "-p", pid], {
          encoding: "utf-8",
          timeout: 2_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        // Guard: Number("") === 0 (finite), so an empty or non-numeric `ps`
        // result would mis-resolve to uid 0 (root) and could wrongly accept or
        // reject a port. Require a pure digit string before trusting it; else
        // fall through to null ("owner unknown") and let the caller be
        // conservative.
        if (/^\d+$/.test(uidStr)) {
          const uid = Number(uidStr);
          if (Number.isFinite(uid)) return uid;
        }
      } catch {
        /* ps unavailable */
      }
    }
  } catch {
    /* lsof unavailable or no listener */
  }
  return null;
}

/** Read our own SurrealDB pid file and return the live pid it points at, or
 *  null if absent/stale. Extracted so both the reuse-pid logic and the
 *  owner-guard "do we hold this port?" check share one source of truth. */
function readLiveOwnSurrealPid(cacheDir: string): number | null {
  try {
    const raw = readFileSync(join(cacheDir, SURREAL_PID_FILENAME), "utf-8").trim();
    const p = Number(raw);
    if (!Number.isFinite(p) || p <= 0) return null;
    try {
      process.kill(p, 0); // existence probe; throws ESRCH if dead.
      return p;
    } catch {
      return null; // stale pid file.
    }
  } catch {
    return null; // no pid file.
  }
}

/** Find an existing laqrumcode SurrealDB that the bootstrap should reuse instead
 *  of spawning a duplicate. Probes a list of candidate ports, fingerprints the
 *  schema to confirm it's laqrumcode's, AND (GH #13) verifies the listening
 *  process is owned by the current OS user before connecting.
 *
 *  --- Threat model (GH #13 cross-user data isolation) ---
 *  The schema fingerprint proves a port speaks "laqrumcode" but not WHOSE. On a
 *  shared host, OS user B must never attach to OS user A's SurrealDB and read
 *  A's private memory graph. So for each fingerprinted port we resolve the
 *  listener's UID (findListenerUid → /proc or lsof) and:
 *    - UID determined and != getuid()  → SKIP (never connect; it's someone
 *      else's daemon).
 *    - UID determined and == getuid()  → safe to adopt.
 *    - UID undetermined (no /proc, EACCES, lsof missing):
 *        · managed/legacy-default ports (the UID-offset managed port + the
 *          legacy 18765 single-user default): CONSERVATIVE — skip unless we
 *          hold our own live SurrealDB pid file for it. These ports are the
 *          ones a colliding 2nd user is most likely to hit.
 *        · explicit external shared-infra ports (8000 / 8042): ALLOW (current
 *          behavior preserved). The user deliberately runs shared SurrealDB on
 *          those historical ports; the fingerprint + opt-in nature is the
 *          contract there.
 *  On non-POSIX (no getuid) the guard is skipped entirely: Windows users are
 *  isolated by separate accounts/sessions and loopback ACLs, not by this
 *  /proc-based check, so we keep the legacy allow behavior there.
 *
 *  Returns the first match. SURREAL_URL env var still takes precedence in the
 *  parent caller — this function only runs when the user hasn't pinned a URL. */
export async function findExistingLaqrumcodeSurreal(
  cacheDir: string,
  managedPort: number,
  user: string,
  pass: string,
  // Test seam (GH #13): the owner-UID resolver is injected so the cross-user
  // owner guard can be exercised against a synthetic foreign uid without
  // requiring a second OS account. Defaults to the real /proc+lsof resolver,
  // so the production call site (4 args) is unchanged. Mirrors the procRoot
  // injection already used by findListenerUidViaProc.
  resolveOwnerUid: (port: number) => number | null = findListenerUid,
): Promise<{ url: string; pid: number | null; port: number } | null> {
  // Dedup'd candidate list. Order is load-bearing: legacy external ports (8000
  // from Docker setups, alternate 8042 from older READMEs) come first; then
  // the UID-offset bootstrap-managed port for this user; then the legacy
  // single-user managed default 18765 so an install that predates the GH #13
  // UID-offset (its data sits on the flat 18765) is still discovered after
  // upgrade. The legacy 18765 is gated by the owner guard below, so a 2nd user
  // can't adopt the 1st user's flat-18765 instance.
  const candidates = Array.from(
    new Set([8000, 8042, managedPort, LEGACY_MANAGED_SURREAL_PORT]),
  );
  // Ports we treat as "our managed surface" for the conservative owner-guard
  // branch (skip-on-unknown-owner). External shared-infra ports keep allow.
  const managedSurfacePorts = new Set([managedPort, LEGACY_MANAGED_SURREAL_PORT]);
  const ourLivePid = readLiveOwnSurrealPid(cacheDir);
  const ourUid = typeof process.getuid === "function" ? process.getuid() : null;

  for (const port of candidates) {
    // Cheap alive-check first to avoid burning the 3s isLaqrumcodeSurreal
    // timeout on dead ports.
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_500),
      }).then((r) => r.ok).catch(() => false);
      if (!ok) continue;
    } catch {
      continue;
    }

    const url = `ws://127.0.0.1:${port}/rpc`;
    if (!(await isLaqrumcodeSurreal(url, user, pass))) {
      log.debug(`[bootstrap] port ${port} responds but isn't a laqrumcode DB — skipping`);
      continue;
    }

    // GH #13 owner guard. Only enforced on POSIX (ourUid !== null).
    if (ourUid !== null) {
      const ownerUid = resolveOwnerUid(port);
      if (ownerUid !== null && ownerUid !== ourUid) {
        log.warn(
          `[bootstrap] port ${port} hosts a laqrumcode DB owned by uid ${ownerUid} ` +
            `(we are uid ${ourUid}) — refusing to connect to another user's graph (GH #13).`,
        );
        continue;
      }
      if (ownerUid === null && managedSurfacePorts.has(port)) {
        // Owner unknown on one of our managed-surface ports. Be conservative:
        // only adopt it if we hold a live pid file for our own managed surreal.
        if (ourLivePid === null) {
          log.warn(
            `[bootstrap] port ${port} hosts a laqrumcode DB but its owner UID could ` +
              `not be determined and we hold no pid file for it — skipping to avoid ` +
              `cross-user attach (GH #13).`,
          );
          continue;
        }
      }
    }

    // If this is one of our managed-surface ports and we have a live pid file,
    // the returned pid lets us track the surviving detached child. For external
    // ports (8000, 8042) the user owns the process — pid stays null and
    // shutdown handlers leave it alone.
    let pid: number | null = null;
    if (managedSurfacePorts.has(port)) {
      pid = ourLivePid;
    }

    log.info(
      `[bootstrap] found existing laqrumcode SurrealDB at ${url}` +
        (pid !== null ? ` (managed pid=${pid})` : ` (external — not managing lifecycle)`),
    );
    return { url, pid, port };
  }

  return null;
}

async function writeSurrealPidFile(cacheDir: string, pid: number): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  try { chmodSync(cacheDir, 0o700); } catch {}
  await writeFile(join(cacheDir, SURREAL_PID_FILENAME), String(pid), "utf-8");
}

/** Spawn (and supervise) the managed SurrealDB child. Exported for the C1/C2
 *  supervision regression test, which drives spawn → exit → respawn/cap without
 *  standing up the full bootstrap; production callers reach it via bootstrap(). */
export async function spawnManagedSurreal(
  binPath: string,
  dataDir: string,
  port: number,
  user: string,
  pass: string,
  cacheDir: string,
): Promise<ChildProcess> {
  await mkdir(dataDir, { recursive: true });
  try { chmodSync(dataDir, 0o700); } catch {}
  // SurrealDB v3 syntax: `surreal start surrealkv:<absolute-path> --bind host:port`
  // Credentials passed via env vars to keep them out of /proc/<pid>/cmdline.
  const child = spawn(
    binPath,
    [
      "start",
      `surrealkv:${dataDir}`,
      "--bind",
      `127.0.0.1:${port}`,
      "--log",
      "warn",
    ],
    {
      detached: true,
      env: { ...process.env, SURREAL_USER: user, SURREAL_PASS: pass },
      // When detached, ignore stdio entirely — leaving pipes open creates a
      // back-channel that prevents the parent from cleanly exiting and
      // disowning the child. With ignore, the child becomes a true daemon.
      stdio: "ignore",
    },
  );
  // Disown: parent's event loop won't wait on this child anymore. Combined
  // with detached:true, the child survives parent (MCP) death and becomes
  // an init-reparented orphan. Plugin update / Claude Code restart / MCP
  // crash all leave SurrealDB running.
  child.unref();

  // C1: track the live child + capture the exact args needed to respawn it, then
  // supervise it. managedSurreal is the module-level handle the rest of bootstrap
  // (and shutdownManagedSurreal) already uses; we keep it authoritative here so a
  // respawned child replaces the dead one transparently.
  managedSurreal = child;
  supervisorState.params = { binPath, dataDir, port, user, pass, cacheDir };

  // Supervision listeners (attached to EVERY spawn, including respawns). Both
  // 'error' (spawn-level failure: EACCES, ENOENT) and 'exit' (the process died)
  // route through onManagedChildExit, which decides respawn-vs-degrade. The
  // handler is fully self-guarding (intentional-shutdown flag, crash-loop cap,
  // idempotency) and never throws, so a fire-and-forget void is safe. We do NOT
  // remove the unref() above — supervision does not re-attach the parent's exit
  // to the child; it only reacts to the child's own lifecycle events, which fire
  // regardless of unref (unref governs event-loop keep-alive, not event delivery).
  child.on("error", (err) => {
    void onManagedChildExit(`emitted 'error' (${err.message})`);
  });
  child.on("exit", (code, signal) => {
    // A clean exit during shutdown is expected; onManagedChildExit early-returns
    // on the shuttingDown flag. We pass the code/signal purely for the log line.
    void onManagedChildExit(
      `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
  });

  if (child.pid) {
    await writeSurrealPidFile(cacheDir, child.pid).catch((e) => {
      log.warn(`[bootstrap] failed to write surreal pid file: ${(e as Error).message}`);
    });
  }
  return child;
}

async function waitForSurrealReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      // K38: bound each probe so a stalled connection (port open but server
      // wedged mid-startup) fails fast instead of hanging this single fetch
      // for the whole remaining deadline. The loop deadline governs total wait;
      // matches the AbortSignal.timeout convention at the other fetch sites.
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `managed SurrealDB did not become ready on 127.0.0.1:${port} within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${(lastErr as Error).message})` : ""),
  );
}

function loadManifest(pluginDir: string): Manifest {
  const path = join(pluginDir, "bin-manifest.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** The historical single-user managed SurrealDB port. Kept as a named constant
 *  because it's also the legacy candidate that {@link findExistingLaqrumcodeSurreal}
 *  must probe (gated by the owner guard) so an upgrading single-user install's
 *  data is still discovered. */
export const LEGACY_MANAGED_SURREAL_PORT = 18765;

/** Width of the managed-SurrealDB per-user port window. The window is
 *  [LEGACY_MANAGED_SURREAL_PORT, LEGACY_MANAGED_SURREAL_PORT + RANGE - 1] =
 *  [18765, 28764]. This MUST stay in sync with the rest of the system's port
 *  partitioning: the daemon IPC window (daemon-spawn.ts PORT_OFFSET_BASE=28765)
 *  and the read-only UI window (ui-server.ts UI_PORT_BASE) both start ABOVE this
 *  ceiling so the three never collide. Both the POSIX (uid) and the Windows
 *  (username-hash) derivations below land inside this single window. */
export const MANAGED_SURREAL_PORT_RANGE = 10000;

/** Tiny deterministic 32-bit string hash (FNV-1a). Not cryptographic — only
 *  used to scatter different Windows OS users across the managed-SurrealDB port
 *  window when getuid() is unavailable. Algorithmically identical to
 *  daemon-spawn.ts's stableHash32 (the IPC-port equivalent) so the two
 *  derivations are auditable side by side, but kept LOCAL here on purpose:
 *  src/mcp-client already imports from src/engine (engine/log.js), so importing
 *  daemon-spawn back into this engine module would form a circular dependency.
 *  Stable across processes/platforms/Node versions (pure integer arithmetic).
 *  Returns a non-negative 32-bit int. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime, kept 32-bit via Math.imul
  }
  return h >>> 0; // force unsigned 32-bit
}

/** Pick the port for the bootstrap-managed SurrealDB.
 *
 *  GH #13 (multi-user port collision): on a shared host, every OS user's
 *  bootstrap previously hardcoded 18765, so the 2nd user's managed SurrealDB
 *  collided with the 1st user's. We derive a per-user port by offsetting into
 *  the managed-SurrealDB window (MANAGED_SURREAL_PORT_RANGE wide). Two different
 *  users almost never land on the same port; even if they did, the process-owner
 *  guard in findExistingLaqrumcodeSurreal prevents cross-user adoption.
 *
 *  E5 (multi-OS-user Windows host): the prior code returned the FLAT legacy
 *  18765 for EVERY Windows account (getuid===null), so two users on one Windows
 *  host collided on 18765 — the 2nd user's daemon failed to bind, adopted the
 *  1st user's DB, was rejected by the per-install cred, and wedged in degraded
 *  mode. We now derive per-user on Windows too, mirroring the username-hash
 *  shape resolveTcpPort() (daemon-spawn.ts) uses for the IPC port, but anchored
 *  on the SAME base+range as the POSIX path so the result stays inside the
 *  managed-SurrealDB window [18765, 28764].
 *
 *  - LAQRUMCODE_SURREAL_PORT override always wins (explicit operator intent).
 *  - POSIX: 18765 + (getuid() % RANGE).
 *  - Windows / no getuid: 18765 + (fnv1a32(os.userInfo().username) % RANGE).
 *  - Degenerate (no uid AND no username): flat 18765 — the only safe choice;
 *    isolation then leans on the per-install cred + process-owner guard. */
export function pickPort(): number {
  const env = Number(process.env.LAQRUMCODE_SURREAL_PORT);
  if (Number.isFinite(env) && env > 0) return env;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    return LEGACY_MANAGED_SURREAL_PORT + (uid % MANAGED_SURREAL_PORT_RANGE);
  }
  // Windows (no getuid): scatter by a stable hash of the account username so two
  // accounts on one host don't both land on the flat 18765.
  let username = "";
  try { username = userInfo().username ?? ""; } catch { /* fall through */ }
  if (!username) return LEGACY_MANAGED_SURREAL_PORT;
  return LEGACY_MANAGED_SURREAL_PORT + (fnv1a32(`user:${username}`) % MANAGED_SURREAL_PORT_RANGE);
}

/**
 * Idempotent first-run bootstrap. Provisions npm deps, SurrealDB binary, embedding
 * model, and a managed SurrealDB child process. Returns the URL the MCP server
 * should connect to (either the managed child or SURREAL_URL override).
 *
 * Skips bootstrap entirely when LAQRUMCODE_SKIP_BOOTSTRAP=1 is set.
 * Skips the SurrealDB child when SURREAL_URL points at an external server.
 */
export async function bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
  const start = Date.now();
  const manifest = loadManifest(input.pluginDir);

  const npmInstall = await ensureNpmDeps(input.pluginDir);
  const nodeLlamaCpp = await ensureNodeLlamaCpp(input.cacheDir, manifest, input.pluginDir);
  const ajv = await ensureAjv(input.cacheDir, manifest, input.pluginDir);
  const embeddingModel = await ensureEmbeddingModel(input.modelPath, manifest);
  const rerankerModel = await ensureRerankerModel(
    input.rerankerModelPath ?? "",
    manifest,
    input.rerankerEnabled !== false && !!input.rerankerModelPath,
  );

  // External-SurrealDB path: user explicitly opted out via SURREAL_URL.
  if (input.surrealUrlOverride) {
    log.info(
      `[bootstrap] SURREAL_URL set to ${input.surrealUrlOverride} — skipping managed SurrealDB child.`,
    );
    return {
      npmInstall,
      surrealBinary: { path: "(external)", provisioned: false, sizeBytes: 0 },
      surrealServer: {
        url: input.surrealUrlOverride,
        pid: null,
        managed: false,
        // SURREAL_URL points at an EXTERNAL, user-run SurrealDB. Auth path is
        // UNCHANGED from pre-Phase-2: use exactly the configured creds
        // (config.surreal.user/pass = root, or SURREAL_USER/SURREAL_PASS).
        user: input.surrealUser,
        pass: input.surrealPass,
      },
      embeddingModel,
      rerankerModel,
      nodeLlamaCpp,
      ajv,
      totalDurationMs: Date.now() - start,
    };
  }

  const surrealBinary = await ensureSurrealBinary(
    input.cacheDir,
    manifest,
    input.surrealBinPathOverride,
  );

  // Tighten data/cache directory permissions on every bootstrap, not just
  // when spawning SurrealDB. The existing-reuse path skips spawnManagedSurreal
  // entirely, so the chmod in that function never fires for resumed instances.
  for (const dir of [input.cacheDir, input.dataDir]) {
    try { await mkdir(dir, { recursive: true }); chmodSync(dir, 0o700); } catch {}
  }

  const port = pickPort();

  // Reuse path covers two cases:
  //  1. A previous MCP's detached SurrealDB child is still alive on the
  //     managed port — Option A's keystone. Plugin updates / MCP crashes
  //     don't lose the DB; new MCP attaches to the surviving instance.
  //  2. The user has an existing laqrumcode SurrealDB elsewhere (e.g. Docker
  //     on the historical port 8000). Reusing it preserves their data
  //     instead of silently spawning a duplicate that splits writes.
  // Both cases are fingerprint-checked (laqrumcode-specific tables present)
  // so we never accidentally connect to an unrelated SurrealDB on the same
  // machine — e.g., a trading bot's DB. SURREAL_URL still takes precedence
  // and is handled in the surrealUrlOverride branch above.
  const existing = await findExistingLaqrumcodeSurreal(
    input.cacheDir,
    port,
    input.surrealUser,
    input.surrealPass,
  );
  if (existing) {
    // Per-target credential resolution (Phase 2):
    //  - existing.pid !== null  ⟺ a managed-surface port for which we hold a
    //    live pid file → this is OUR managed child.
    //      · cred file present → it was spawned with the generated cred → use it.
    //      · cred file absent  → it's a pre-Phase-2 root:root child. GRACEFUL
    //        MIGRATION: keep talking to it as root:root so we don't break the
    //        running instance; it adopts the per-user cred on its next respawn
    //        (spawnManagedSurreal always uses the generated cred now).
    //  - existing.pid === null  ⟺ an EXTERNAL DB (8000/8042, lifecycle not
    //    ours). Auth path UNCHANGED: use the configured creds verbatim.
    const credFileExists = managedCredFileExists(input.cacheDir);
    const { user, pass } = resolveReusedTargetCred({
      discoveredPid: existing.pid,
      credFileExists,
      configured: { user: input.surrealUser, pass: input.surrealPass },
      // Only read/mint the cred when the file actually exists (managed child
      // path); for external targets credFileExists is irrelevant and we avoid
      // a needless file write.
      generated: credFileExists ? getOrCreateManagedCred(input.cacheDir) : { user: "", pass: "" },
    });
    return {
      npmInstall,
      surrealBinary,
      surrealServer: { url: existing.url, pid: existing.pid, managed: existing.pid !== null, user, pass },
      embeddingModel,
      rerankerModel,
      nodeLlamaCpp,
      ajv,
      totalDurationMs: Date.now() - start,
    };
  }

  // Fresh managed spawn (no existing laqrumcode DB found). Phase 2: drop the
  // root:root default — generate (or reuse a persisted) per-user credential
  // and spawn the child with it. getOrCreateManagedCred is idempotent, so if a
  // cred file already exists (e.g. a prior managed child that has since died)
  // we reuse the same secret rather than minting a new one.
  // C1: THIS process now owns the child's lifecycle — re-arm the supervisor
  // (clears any stale shutdown/degraded latch from a prior incarnation) before
  // the fresh spawn. Single call so getOrCreateManagedCred stays adjacent to the
  // spawn site below.
  armSupervisorForFreshSpawn();
  const managedCred = getOrCreateManagedCred(input.cacheDir);
  managedSurreal = await spawnManagedSurreal(
    surrealBinary.path,
    input.dataDir,
    port,
    managedCred.user,
    managedCred.pass,
    input.cacheDir,
  );
  await waitForSurrealReady(port);
  const url = `ws://127.0.0.1:${port}/rpc`;
  log.info(`[bootstrap] managed SurrealDB ready on ${url} (pid=${managedSurreal.pid})`);

  return {
    npmInstall,
    surrealBinary,
    surrealServer: { url, pid: managedSurreal.pid ?? null, managed: true, user: managedCred.user, pass: managedCred.pass },
    embeddingModel,
    rerankerModel,
    nodeLlamaCpp,
    ajv,
    totalDurationMs: Date.now() - start,
  };
}

/** Per Option A architecture: the surreal child is detached + unref'd on spawn,
 *  so MCP exit does not affect its lifecycle. By default this function is a
 *  no-op — calling it during MCP shutdown leaves the surreal child running so
 *  the next MCP boot can attach to it (preserving turn-ingestion across
 *  plugin updates, Claude Code restarts, etc.).
 *
 *  Pass { force: true } to actually SIGTERM the child — used by tests and any
 *  future "laqrumcode stop" CLI command that explicitly tears everything down. */
export function shutdownManagedSurreal(opts?: { force?: boolean }): void {
  // C1: signal the supervisor that any subsequent child 'exit'/'error' is
  // INTENTIONAL — onManagedChildExit early-returns on this flag, so we never
  // respawn a child the daemon is deliberately tearing down. Set on BOTH paths:
  //  - non-force (Option A): the child is left alive but this daemon is going
  //    away, so it must stop owning the child's lifecycle; if the child later
  //    dies, a NEW daemon boot's bootstrap re-spawns + re-supervises it (the
  //    supervisor is per-process), not this dying one.
  //  - force: we SIGTERM the child ourselves; the resulting 'exit' must not loop.
  // Cancel any backoff timer already counting down toward a respawn.
  supervisorState.shuttingDown = true;
  if (supervisorState.timer) {
    clearTimeout(supervisorState.timer);
    supervisorState.timer = null;
  }
  if (!opts?.force) {
    if (managedSurreal && !managedSurreal.killed) {
      log.debug(
        `[bootstrap] surreal child detached (pid=${managedSurreal.pid}) — leaving alive for next MCP boot`,
      );
    }
    managedSurreal = null;
    return;
  }
  if (managedSurreal && !managedSurreal.killed) {
    log.info(`[bootstrap] force SIGTERM managed SurrealDB child pid=${managedSurreal.pid}`);
    try {
      managedSurreal.kill("SIGTERM");
    } catch (e) {
      log.warn(`[bootstrap] failed to SIGTERM child: ${(e as Error).message}`);
    }
    managedSurreal = null;
  }
}
