import { chmodSync, createWriteStream, existsSync, readFileSync, statSync, } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { log } from "./log.js";
const execFileAsync = promisify(execFile);
let managedSurreal = null;
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
export function resolvePluginDir() {
    if (process.env.KONGCODE_PLUGIN_DIR)
        return process.env.KONGCODE_PLUGIN_DIR;
    try {
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        // bootstrap.js at <pluginDir>/dist/engine/ — walk up two levels.
        return join(moduleDir, "..", "..");
    }
    catch {
        // SEA / CJS path: process.execPath is the SEA binary at
        // <pluginDir>/bin/kongcode-{daemon,mcp}-<platform>. Walk up ONE level.
        return join(dirname(process.execPath), "..");
    }
}
function detectPlatformKey() {
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
    return `${process.platform}-${arch}`;
}
async function downloadFile(url, destPath, expectedSha256) {
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
    const body = res.body;
    for await (const chunk of body) {
        if (hasher)
            hasher.update(chunk);
        bytes += chunk.length;
        if (!writer.write(chunk)) {
            await new Promise((resolve) => writer.once("drain", () => resolve()));
        }
    }
    await new Promise((resolve, reject) => {
        writer.end((err) => (err ? reject(err) : resolve()));
    });
    if (hasher && expectedSha256) {
        const actual = hasher.digest("hex");
        if (actual !== expectedSha256) {
            await rm(tmpPath, { force: true });
            throw new Error(`sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
        }
    }
    await rename(tmpPath, destPath);
    return { sizeBytes: bytes };
}
async function ensureNpmDeps(pluginDir) {
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
    log.info(`[bootstrap] node_modules missing under ${pluginDir} — running 'npm ci --omit=dev' (one-time first-run cost, ~1-2 min)`);
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
async function ensureSurrealBinary(cacheDir, manifest, override) {
    if (override) {
        if (!existsSync(override)) {
            throw new Error(`SURREAL_BIN_PATH points to missing file: ${override}`);
        }
        return { path: override, provisioned: false, sizeBytes: statSync(override).size };
    }
    const platformKey = detectPlatformKey();
    const platform = manifest.surrealdb.platforms[platformKey];
    if (!platform) {
        throw new Error(`kongcode bootstrap does not have a SurrealDB binary mapping for platform "${platformKey}". ` +
            `Supported: ${Object.keys(manifest.surrealdb.platforms).join(", ")}. ` +
            `Workaround: install SurrealDB ${manifest.surrealdb.version} manually and set SURREAL_BIN_PATH, ` +
            `or point SURREAL_URL at an existing SurrealDB instance.`);
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
    log.info(`[bootstrap] Downloading SurrealDB ${manifest.surrealdb.version} for ${platformKey}: ${url}`);
    const archivePath = join(versionedDir, `surreal.${platform.ext}`);
    const dl = await downloadFile(url, archivePath, platform.sha256);
    if (platform.ext === "tgz" || platform.ext === "tar.gz") {
        await execFileAsync("tar", ["-xzf", archivePath, "-C", versionedDir]);
        await rm(archivePath, { force: true });
    }
    else {
        // Single-file binary (Windows .exe). Move into place under the expected name.
        await rename(archivePath, binPath);
    }
    if (!existsSync(binPath)) {
        throw new Error(`extraction did not produce expected binary at ${binPath}. archive may have a different layout.`);
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
async function ensureNodeLlamaCpp(cacheDir, manifest, pluginDir) {
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
        log.warn(`[bootstrap] node-llama-cpp: no platform mapping for ${platformKey} — embeddings will fail unless KONGCODE_NODE_LLAMA_CPP_PATH is set.`);
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
    log.info(`[bootstrap] Downloading node-llama-cpp ${version} (main + ${platformName} binding) for ${platformKey}`);
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
async function ensureAjv(cacheDir, manifest, pluginDir) {
    // Skip if local node_modules has both. dev tree fast-path.
    if (existsSync(join(pluginDir, "node_modules", "ajv", "package.json")) &&
        existsSync(join(pluginDir, "node_modules", "ajv-formats", "package.json"))) {
        return { provisioned: false, nodeModulesDir: null };
    }
    if (!manifest.ajv) {
        return { provisioned: false, nodeModulesDir: null };
    }
    const nativeNodeModules = join(cacheDir, "native", "node_modules");
    const ajvDir = join(nativeNodeModules, "ajv");
    const ajvFormatsDir = join(nativeNodeModules, "ajv-formats");
    const bothPresent = existsSync(join(ajvDir, "package.json")) &&
        existsSync(join(ajvFormatsDir, "package.json"));
    if (bothPresent) {
        return { provisioned: false, nodeModulesDir: nativeNodeModules };
    }
    const ajvUrl = manifest.ajv.ajvTarballUrl.replaceAll("{version}", manifest.ajv.ajvVersion);
    const ajvFormatsUrl = manifest.ajv.ajvFormatsTarballUrl.replaceAll("{version}", manifest.ajv.ajvFormatsVersion);
    log.info(`[bootstrap] Downloading ajv ${manifest.ajv.ajvVersion} + ajv-formats ${manifest.ajv.ajvFormatsVersion} for SEA-bundle MCP client`);
    const ajvTarball = join(nativeNodeModules, `ajv-${manifest.ajv.ajvVersion}.tgz`);
    const ajvFormatsTarball = join(nativeNodeModules, `ajv-formats-${manifest.ajv.ajvFormatsVersion}.tgz`);
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
async function ensureEmbeddingModel(modelPath, manifest) {
    if (existsSync(modelPath)) {
        return { path: modelPath, provisioned: false, sizeBytes: statSync(modelPath).size };
    }
    log.info(`[bootstrap] Downloading BGE-M3 embedding model (~420MB, one-time): ${manifest.embeddingModel.url}`);
    const dl = await downloadFile(manifest.embeddingModel.url, modelPath, manifest.embeddingModel.sha256);
    return { path: modelPath, provisioned: true, sizeBytes: dl.sizeBytes };
}
async function ensureRerankerModel(modelPath, manifest, enabled) {
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
    log.info(`[bootstrap] Downloading bge-reranker-v2-m3 (~606MB, one-time): ${manifest.rerankerModel.url}`);
    try {
        const dl = await downloadFile(manifest.rerankerModel.url, modelPath, manifest.rerankerModel.sha256);
        return { path: modelPath, provisioned: true, sizeBytes: dl.sizeBytes, skipped: false };
    }
    catch (e) {
        log.warn(`[bootstrap] reranker download failed (recall will fall back to WMR/ACAN): ${e.message}`);
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
async function isKongcodeSurreal(url, user, pass) {
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
        if (!res.ok)
            return false;
        const data = (await res.json());
        const tables = data?.[0]?.result?.tables;
        if (!tables || typeof tables !== "object")
            return false;
        return KONGCODE_FINGERPRINT_TABLES.some((t) => t in tables);
    }
    catch {
        return false;
    }
}
/** Find an existing kongcode SurrealDB that the bootstrap should reuse instead
 *  of spawning a duplicate. Probes a list of candidate ports (bootstrap-managed,
 *  legacy 8000 from older Docker setups, alternate 8042 from older READMEs).
 *  For each port that responds, fingerprints the schema to confirm it's
 *  kongcode's — protecting users who run multiple SurrealDB instances for
 *  unrelated apps (e.g. trading) from accidental cross-connection.
 *
 *  Returns the first match. SURREAL_URL env var still takes precedence in the
 *  parent caller — this function only runs when the user hasn't pinned a URL. */
async function findExistingKongcodeSurreal(cacheDir, managedPort, user, pass) {
    // Dedup'd candidate list. Order is load-bearing: legacy ports (8000 from
    // Docker setups, alternate 8042 from older READMEs) come BEFORE the
    // bootstrap-managed default. Reasoning: a user who's been running kongcode
    // pre-0.6 has their canonical data on the legacy port; a managed instance
    // on 18765 is either today's accidentally-spawned duplicate (small,
    // disposable) or empty. Always prefer the user's pre-existing data.
    // The fingerprint check (isKongcodeSurreal) ensures we only pick a port
    // that actually has kongcode tables — empty/wrong-app SurrealDBs are
    // rejected and we fall through to the next candidate.
    const candidates = Array.from(new Set([8000, 8042, managedPort]));
    for (const port of candidates) {
        // Cheap alive-check first to avoid burning the 3s isKongcodeSurreal
        // timeout on dead ports.
        try {
            const ok = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(1_500),
            }).then((r) => r.ok).catch(() => false);
            if (!ok)
                continue;
        }
        catch {
            continue;
        }
        const url = `ws://127.0.0.1:${port}/rpc`;
        if (!(await isKongcodeSurreal(url, user, pass))) {
            log.debug(`[bootstrap] port ${port} responds but isn't a kongcode DB — skipping`);
            continue;
        }
        // If this is the bootstrap-managed port and we have a pid file, the
        // returned pid lets us track the surviving detached child. For
        // non-managed ports (8000, 8042), the user owns the process — pid stays
        // null and shutdown handlers leave it alone.
        let pid = null;
        if (port === managedPort) {
            try {
                const raw = readFileSync(join(cacheDir, SURREAL_PID_FILENAME), "utf-8").trim();
                const p = Number(raw);
                if (Number.isFinite(p) && p > 0) {
                    // Verify the PID still owns a process — stale pid file from an
                    // ungracefully terminated surreal would otherwise confuse shutdown.
                    try {
                        process.kill(p, 0);
                        pid = p;
                    }
                    catch {
                        // pid file points at a dead process; the responding instance
                        // is something else (race condition, port reuse). Still
                        // legitimate kongcode (we fingerprinted), just not ours.
                    }
                }
            }
            catch {
                // No pid file is fine — surreal might have been started by an
                // unrelated process (Docker, brew services, manual launch).
            }
        }
        log.info(`[bootstrap] found existing kongcode SurrealDB at ${url}` +
            (pid !== null ? ` (managed pid=${pid})` : ` (external — not managing lifecycle)`));
        return { url, pid, port };
    }
    return null;
}
async function writeSurrealPidFile(cacheDir, pid) {
    await mkdir(cacheDir, { recursive: true });
    try {
        chmodSync(cacheDir, 0o700);
    }
    catch { }
    await writeFile(join(cacheDir, SURREAL_PID_FILENAME), String(pid), "utf-8");
}
async function spawnManagedSurreal(binPath, dataDir, port, user, pass, cacheDir) {
    await mkdir(dataDir, { recursive: true });
    try {
        chmodSync(dataDir, 0o700);
    }
    catch { }
    // KONGCODE_DETACH_SURREAL=0 forces the legacy child-tied-to-parent behavior
    // (mainly for tests + advanced setups that want the old cleanup-on-MCP-exit
    // semantics). Default: detach so the child outlives the MCP.
    const detach = process.env.KONGCODE_DETACH_SURREAL !== "0";
    // SurrealDB v3 syntax: `surreal start surrealkv:<absolute-path> --bind host:port`
    // Credentials passed via env vars to keep them out of /proc/<pid>/cmdline.
    const child = spawn(binPath, [
        "start",
        `surrealkv:${dataDir}`,
        "--bind",
        `127.0.0.1:${port}`,
        "--log",
        "warn",
    ], {
        detached: detach,
        env: { ...process.env, SURREAL_USER: user, SURREAL_PASS: pass },
        // When detached, ignore stdio entirely — leaving pipes open creates a
        // back-channel that prevents the parent from cleanly exiting and
        // disowning the child. With ignore, the child becomes a true daemon.
        stdio: detach ? "ignore" : ["ignore", "pipe", "pipe"],
    });
    if (detach) {
        // Disown: parent's event loop won't wait on this child anymore. Combined
        // with detached:true, the child survives parent (MCP) death and becomes
        // an init-reparented orphan. Plugin update / Claude Code restart / MCP
        // crash all leave SurrealDB running.
        child.unref();
    }
    else {
        child.stdout?.on("data", (d) => log.debug(`[surreal] ${String(d).trim()}`));
        child.stderr?.on("data", (d) => log.debug(`[surreal] ${String(d).trim()}`));
        child.on("exit", (code, signal) => {
            log.warn(`[surreal] managed child exited code=${code} signal=${signal}`);
        });
    }
    if (child.pid) {
        await writeSurrealPidFile(cacheDir, child.pid).catch((e) => {
            log.warn(`[bootstrap] failed to write surreal pid file: ${e.message}`);
        });
    }
    return child;
}
async function waitForSurrealReady(port, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok)
                return;
        }
        catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`managed SurrealDB did not become ready on 127.0.0.1:${port} within ${timeoutMs}ms` +
        (lastErr ? ` (last error: ${lastErr.message})` : ""));
}
function loadManifest(pluginDir) {
    const path = join(pluginDir, "bin-manifest.json");
    return JSON.parse(readFileSync(path, "utf-8"));
}
function pickPort() {
    const env = Number(process.env.KONGCODE_SURREAL_PORT);
    return Number.isFinite(env) && env > 0 ? env : 18765;
}
/**
 * Idempotent first-run bootstrap. Provisions npm deps, SurrealDB binary, embedding
 * model, and a managed SurrealDB child process. Returns the URL the MCP server
 * should connect to (either the managed child or SURREAL_URL override).
 *
 * Skips bootstrap entirely when KONGCODE_SKIP_BOOTSTRAP=1 is set.
 * Skips the SurrealDB child when SURREAL_URL points at an external server.
 */
export async function bootstrap(input) {
    const start = Date.now();
    const manifest = loadManifest(input.pluginDir);
    const npmInstall = await ensureNpmDeps(input.pluginDir);
    const nodeLlamaCpp = await ensureNodeLlamaCpp(input.cacheDir, manifest, input.pluginDir);
    const ajv = await ensureAjv(input.cacheDir, manifest, input.pluginDir);
    const embeddingModel = await ensureEmbeddingModel(input.modelPath, manifest);
    const rerankerModel = await ensureRerankerModel(input.rerankerModelPath ?? "", manifest, input.rerankerEnabled !== false && !!input.rerankerModelPath);
    // External-SurrealDB path: user explicitly opted out via SURREAL_URL.
    if (input.surrealUrlOverride) {
        log.info(`[bootstrap] SURREAL_URL set to ${input.surrealUrlOverride} — skipping managed SurrealDB child.`);
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
    const surrealBinary = await ensureSurrealBinary(input.cacheDir, manifest, input.surrealBinPathOverride);
    // Tighten data/cache directory permissions on every bootstrap, not just
    // when spawning SurrealDB. The existing-reuse path skips spawnManagedSurreal
    // entirely, so the chmod in that function never fires for resumed instances.
    for (const dir of [input.cacheDir, input.dataDir]) {
        try {
            await mkdir(dir, { recursive: true });
            chmodSync(dir, 0o700);
        }
        catch { }
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
    const existing = await findExistingKongcodeSurreal(input.cacheDir, port, input.surrealUser, input.surrealPass);
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
    managedSurreal = await spawnManagedSurreal(surrealBinary.path, input.dataDir, port, input.surrealUser, input.surrealPass, input.cacheDir);
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
export function shutdownManagedSurreal(opts) {
    if (!opts?.force) {
        if (managedSurreal && !managedSurreal.killed) {
            log.debug(`[bootstrap] surreal child detached (pid=${managedSurreal.pid}) — leaving alive for next MCP boot`);
        }
        managedSurreal = null;
        return;
    }
    if (managedSurreal && !managedSurreal.killed) {
        log.info(`[bootstrap] force SIGTERM managed SurrealDB child pid=${managedSurreal.pid}`);
        try {
            managedSurreal.kill("SIGTERM");
        }
        catch (e) {
            log.warn(`[bootstrap] failed to SIGTERM child: ${e.message}`);
        }
        managedSurreal = null;
    }
}
