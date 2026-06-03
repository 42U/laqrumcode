import {
  chmodSync,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
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
  surrealServer: { url: string; pid: number | null; managed: boolean };
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

/** Resolve the plugin root from this file's compiled location.
 *
 *  Three runtime layouts to handle:
 *    1. Compiled tsc: bootstrap.js at <plugin>/dist/engine/ — walk up 2.
 *    2. esbuild bundle: bundle.cjs at <plugin>/dist/daemon/ — walk up 2.
 *    3. SEA executable: binary at <plugin>/bin/kongcode-daemon-<platform>
 *       — walk up 1 (NOT 2; the SEA binary lives in bin/, not dist/engine/).
 *
 *  Under SEA (CJS-in-binary), import.meta.url is undefined and fileURLToPath
 *  throws — caught and we use process.execPath instead.
 *
 *  KONGCODE_PLUGIN_DIR env var always wins for explicit overrides (tests,
 *  unusual install layouts).
 */
export function resolvePluginDir(): string {
  if (process.env.KONGCODE_PLUGIN_DIR) return process.env.KONGCODE_PLUGIN_DIR;
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // bootstrap.js at <pluginDir>/dist/engine/ — walk up two levels.
    return join(moduleDir, "..", "..");
  } catch {
    // SEA / CJS path: process.execPath is the SEA binary at
    // <pluginDir>/bin/kongcode-{daemon,mcp}-<platform>. Walk up ONE level.
    return join(dirname(process.execPath), "..");
  }
}

function detectPlatformKey(): string {
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${process.platform}-${arch}`;
}

async function downloadFile(
  url: string,
  destPath: string,
  expectedSha256: string | null,
): Promise<{ sizeBytes: number }> {
  const res = await fetch(url, { redirect: "follow" });
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

  // Node's fetch returns a web ReadableStream; iterate it as bytes.
  // ReadableStream is async-iterable in Node 18+; cast through unknown.
  const body = res.body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of body) {
    if (hasher) hasher.update(chunk);
    bytes += chunk.length;
    if (!writer.write(chunk)) {
      await new Promise<void>((resolve) => writer.once("drain", () => resolve()));
    }
  }
  await new Promise<void>((resolve, reject) => {
    writer.end((err: unknown) => (err ? reject(err) : resolve()));
  });

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

async function ensureNpmDeps(
  pluginDir: string,
): Promise<{ ran: boolean; durationMs: number }> {
  const nodeModules = join(pluginDir, "node_modules");
  if (existsSync(nodeModules)) {
    return { ran: false, durationMs: 0 };
  }
  // Skip when no package.json is adjacent — under SEA the binary stands alone
  // (deps are bundled inline + native pieces downloaded separately into the
  // cache), and KONGCODE_SKIP_NPM_CI is an explicit opt-out for advanced setups.
  if (!existsSync(join(pluginDir, "package.json"))) {
    return { ran: false, durationMs: 0 };
  }
  if (process.env.KONGCODE_SKIP_NPM_CI === "1") {
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
      `kongcode bootstrap does not have a SurrealDB binary mapping for platform "${platformKey}". ` +
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
 * Sets KONGCODE_NODE_LLAMA_CPP_PATH to the absolute index.js path so
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
      `[bootstrap] node-llama-cpp: no platform mapping for ${platformKey} — embeddings will fail unless KONGCODE_NODE_LLAMA_CPP_PATH is set.`,
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
    process.env.KONGCODE_NODE_LLAMA_CPP_PATH = mainEntry;
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
  process.env.KONGCODE_NODE_LLAMA_CPP_PATH = mainEntry;
  return { mainPath: mainEntry, provisioned: true };
}

/** Download ajv + ajv-formats into <cacheDir>/native/node_modules/ so the
 *  bundled MCP client (kongcode-mcp under SEA) can resolve their dynamic
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
    log.info("[bootstrap] reranker disabled (KONGCODE_RERANKER_DISABLED=1) — skipping download");
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

/** Tables that are unique to kongcode's schema — used as a fingerprint to
 *  distinguish "this is our DB" from "this is a SurrealDB someone else
 *  happens to be running on the same port" (e.g., a trading bot's DB).
 *  These names are kongcode-specific enough that a generic SurrealDB
 *  install or a different application would not have them. */
const KONGCODE_FINGERPRINT_TABLES = ["monologue", "identity_chunk", "acan_state", "causal"];

/** Probe a candidate SurrealDB URL to determine if it's a kongcode database.
 *  Three checks: HTTP /health alive, auth succeeds against kong/memory ns/db,
 *  INFO FOR DB returns at least one kongcode-fingerprint table.
 *
 *  Returns true only when all three pass. False on any failure (timeout,
 *  auth fail, wrong ns/db, missing tables). */
async function isKongcodeSurreal(
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
        "surreal-ns": "kong",
        "surreal-db": "memory",
      },
      body: "INFO FOR DB;",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as Array<{ result?: { tables?: Record<string, unknown> } }>;
    const tables = data?.[0]?.result?.tables;
    if (!tables || typeof tables !== "object") return false;
    return KONGCODE_FINGERPRINT_TABLES.some((t) => t in tables);
  } catch {
    return false;
  }
}

/**
 * Find the OS-user (UID) that owns the process LISTENING on a loopback TCP
 * `port`, using only the Linux `/proc` filesystem.
 *
 * --- Threat model (GH #13) ---
 * On a shared host, OS user B must never connect to OS user A's kongcode
 * memory graph. The schema fingerprint (isKongcodeSurreal) confirms a port
 * speaks "kongcode", but NOT *whose* kongcode it is. Without an owner check,
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
        const uid = Number(uidStr);
        if (Number.isFinite(uid)) return uid;
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

/** Find an existing kongcode SurrealDB that the bootstrap should reuse instead
 *  of spawning a duplicate. Probes a list of candidate ports, fingerprints the
 *  schema to confirm it's kongcode's, AND (GH #13) verifies the listening
 *  process is owned by the current OS user before connecting.
 *
 *  --- Threat model (GH #13 cross-user data isolation) ---
 *  The schema fingerprint proves a port speaks "kongcode" but not WHOSE. On a
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
export async function findExistingKongcodeSurreal(
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
    // Cheap alive-check first to avoid burning the 3s isKongcodeSurreal
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
    if (!(await isKongcodeSurreal(url, user, pass))) {
      log.debug(`[bootstrap] port ${port} responds but isn't a kongcode DB — skipping`);
      continue;
    }

    // GH #13 owner guard. Only enforced on POSIX (ourUid !== null).
    if (ourUid !== null) {
      const ownerUid = resolveOwnerUid(port);
      if (ownerUid !== null && ownerUid !== ourUid) {
        log.warn(
          `[bootstrap] port ${port} hosts a kongcode DB owned by uid ${ownerUid} ` +
            `(we are uid ${ourUid}) — refusing to connect to another user's graph (GH #13).`,
        );
        continue;
      }
      if (ownerUid === null && managedSurfacePorts.has(port)) {
        // Owner unknown on one of our managed-surface ports. Be conservative:
        // only adopt it if we hold a live pid file for our own managed surreal.
        if (ourLivePid === null) {
          log.warn(
            `[bootstrap] port ${port} hosts a kongcode DB but its owner UID could ` +
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
      `[bootstrap] found existing kongcode SurrealDB at ${url}` +
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

async function spawnManagedSurreal(
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
      const res = await fetch(`http://127.0.0.1:${port}/health`);
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
 *  because it's also the legacy candidate that {@link findExistingKongcodeSurreal}
 *  must probe (gated by the owner guard) so an upgrading single-user install's
 *  data is still discovered. */
export const LEGACY_MANAGED_SURREAL_PORT = 18765;

/** Pick the port for the bootstrap-managed SurrealDB.
 *
 *  GH #13 (multi-user port collision): on a shared host, every OS user's
 *  bootstrap previously hardcoded 18765, so the 2nd user's managed SurrealDB
 *  collided with the 1st user's. We derive a per-user port by offsetting with
 *  the caller's UID (mod 10000 to stay in a sane range). Two different users
 *  almost never land on the same port; even if they did, the process-owner
 *  guard in findExistingKongcodeSurreal prevents cross-user adoption.
 *
 *  - KONGCODE_SURREAL_PORT override always wins (explicit operator intent).
 *  - POSIX: 18765 + (getuid() % 10000).
 *  - Windows / no getuid: falls back to the legacy 18765 (Windows users are
 *    OS-isolated by separate accounts/sessions, not by port). */
export function pickPort(): number {
  const env = Number(process.env.KONGCODE_SURREAL_PORT);
  if (Number.isFinite(env) && env > 0) return env;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === null ? LEGACY_MANAGED_SURREAL_PORT : LEGACY_MANAGED_SURREAL_PORT + (uid % 10000);
}

/**
 * Idempotent first-run bootstrap. Provisions npm deps, SurrealDB binary, embedding
 * model, and a managed SurrealDB child process. Returns the URL the MCP server
 * should connect to (either the managed child or SURREAL_URL override).
 *
 * Skips bootstrap entirely when KONGCODE_SKIP_BOOTSTRAP=1 is set.
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
  //  2. The user has an existing kongcode SurrealDB elsewhere (e.g. Docker
  //     on the historical port 8000). Reusing it preserves their data
  //     instead of silently spawning a duplicate that splits writes.
  // Both cases are fingerprint-checked (kongcode-specific tables present)
  // so we never accidentally connect to an unrelated SurrealDB on the same
  // machine — e.g., a trading bot's DB. SURREAL_URL still takes precedence
  // and is handled in the surrealUrlOverride branch above.
  const existing = await findExistingKongcodeSurreal(
    input.cacheDir,
    port,
    input.surrealUser,
    input.surrealPass,
  );
  if (existing) {
    return {
      npmInstall,
      surrealBinary,
      surrealServer: { url: existing.url, pid: existing.pid, managed: existing.pid !== null },
      embeddingModel,
      rerankerModel,
      nodeLlamaCpp,
      ajv,
      totalDurationMs: Date.now() - start,
    };
  }

  managedSurreal = await spawnManagedSurreal(
    surrealBinary.path,
    input.dataDir,
    port,
    input.surrealUser,
    input.surrealPass,
    input.cacheDir,
  );
  await waitForSurrealReady(port);
  const url = `ws://127.0.0.1:${port}/rpc`;
  log.info(`[bootstrap] managed SurrealDB ready on ${url} (pid=${managedSurreal.pid})`);

  return {
    npmInstall,
    surrealBinary,
    surrealServer: { url, pid: managedSurreal.pid ?? null, managed: true },
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
 *  future "kongcode stop" CLI command that explicitly tears everything down. */
export function shutdownManagedSurreal(opts?: { force?: boolean }): void {
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
