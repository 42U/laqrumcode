import { type ChildProcess } from "node:child_process";
export interface BootstrapResult {
    npmInstall: {
        ran: boolean;
        durationMs: number;
    };
    surrealBinary: {
        path: string;
        provisioned: boolean;
        sizeBytes: number;
    };
    surrealServer: {
        url: string;
        pid: number | null;
        managed: boolean;
        user: string;
        pass: string;
    };
    embeddingModel: {
        path: string;
        provisioned: boolean;
        sizeBytes: number;
    };
    rerankerModel: {
        path: string | null;
        provisioned: boolean;
        sizeBytes: number;
        skipped: boolean;
    };
    nodeLlamaCpp: {
        mainPath: string | null;
        provisioned: boolean;
    };
    ajv: {
        provisioned: boolean;
        nodeModulesDir: string | null;
    };
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
/** Minimal structural view of SurrealStore the supervisor needs to surface a
 *  degraded state. Structural (not an import of SurrealStore) so bootstrap.ts
 *  stays free of an engine-store dependency and there is no import cycle —
 *  surreal.ts registers itself via registerSurrealSupervisorStore(). */
interface SupervisorStore {
    isAvailable(): boolean;
    queryExec(sql: string, bindings?: Record<string, unknown>): Promise<void>;
}
/** Wire the SurrealStore the supervisor uses to surface a DEGRADED state via a
 *  maintenance_runs error row (memory_health then goes RED). Called by
 *  SurrealStore's constructor (surreal.ts) so no cross-module daemon wiring is
 *  needed; idempotent (last writer wins). Exported for that call + unit tests. */
export declare function registerSurrealSupervisorStore(store: SupervisorStore | null): void;
/** Test-only: reset the supervisor between cases (module state is process-wide).
 *  Cancels any pending respawn timer so a leftover timer can't fire across
 *  tests. Not used in production. */
export declare function __resetSupervisorForTest(): void;
/** Test-only inspection of supervisor state (avoids exporting the mutable
 *  object directly). */
export declare function __getSupervisorState(): {
    degraded: boolean;
    shuttingDown: boolean;
    restartsInWindow: number;
};
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
export declare function resolvePluginDir(): string;
/**
 * Per-host inactivity (in ms) the download watchdog tolerates with NO bytes
 * before it tears the transfer down. Exported so the regression test can drive
 * it without waiting the production interval.
 */
export declare const DOWNLOAD_INACTIVITY_MS = 30000;
export declare function downloadFile(url: string, destPath: string, expectedSha256: string | null, opts?: {
    inactivityMs?: number;
    connectTimeoutMs?: number;
}): Promise<{
    sizeBytes: number;
}>;
export interface ManagedSurrealCred {
    user: string;
    pass: string;
}
/** Read-or-create the managed-instance credential. Idempotent: if the file
 *  already exists and parses to a {user, pass} with non-empty strings, it is
 *  returned unchanged — this is what lets a freshly-booting daemon reuse the
 *  exact secret a previously-spawned detached child (Option A) is already
 *  running with. Otherwise a fresh credential is generated and written.
 *
 *  - user: `kong_<uid>` on POSIX (matches the iKong per-user naming precedent),
 *    plain `kong` where getuid is unavailable (Windows).
 *  - pass: 24 random bytes, base64url (~32 chars, URL/CLI-safe, no padding).
 *  - File perms tightened to 0600 best-effort (cross-platform: chmod is a
 *    no-op-ish on Windows and is wrapped in try/catch so it never throws).
 *
 *  Never throws on a read parse error — a corrupt/legacy file is treated as
 *  absent and regenerated (the managed child would then be respawned with the
 *  new secret on its next lifecycle, same graceful-migration path as a
 *  pre-Phase-2 root:root child). */
export declare function getOrCreateManagedCred(cacheDir: string): ManagedSurrealCred;
/** Resolve which credential the daemon should use to connect to a REUSED /
 *  DISCOVERED SurrealDB. This is the security-critical Phase-2 decision,
 *  extracted as a pure function so it is unit-testable without standing up the
 *  full bootstrap (npm ci + binary/model downloads).
 *
 *  Inputs:
 *   - discoveredPid: findExistingKongcodeSurreal's returned pid. Non-null ⟺ a
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
export declare function resolveReusedTargetCred(args: {
    discoveredPid: number | null;
    credFileExists: boolean;
    configured: ManagedSurrealCred;
    generated: ManagedSurrealCred;
}): ManagedSurrealCred;
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
export declare function findListenerUidViaProc(port: number, procRoot?: string): number | null;
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
export declare function findExistingKongcodeSurreal(cacheDir: string, managedPort: number, user: string, pass: string, resolveOwnerUid?: (port: number) => number | null): Promise<{
    url: string;
    pid: number | null;
    port: number;
} | null>;
/** Spawn (and supervise) the managed SurrealDB child. Exported for the C1/C2
 *  supervision regression test, which drives spawn → exit → respawn/cap without
 *  standing up the full bootstrap; production callers reach it via bootstrap(). */
export declare function spawnManagedSurreal(binPath: string, dataDir: string, port: number, user: string, pass: string, cacheDir: string): Promise<ChildProcess>;
/** The historical single-user managed SurrealDB port. Kept as a named constant
 *  because it's also the legacy candidate that {@link findExistingKongcodeSurreal}
 *  must probe (gated by the owner guard) so an upgrading single-user install's
 *  data is still discovered. */
export declare const LEGACY_MANAGED_SURREAL_PORT = 18765;
/** Width of the managed-SurrealDB per-user port window. The window is
 *  [LEGACY_MANAGED_SURREAL_PORT, LEGACY_MANAGED_SURREAL_PORT + RANGE - 1] =
 *  [18765, 28764]. This MUST stay in sync with the rest of the system's port
 *  partitioning: the daemon IPC window (daemon-spawn.ts PORT_OFFSET_BASE=28765)
 *  and the read-only UI window (ui-server.ts UI_PORT_BASE) both start ABOVE this
 *  ceiling so the three never collide. Both the POSIX (uid) and the Windows
 *  (username-hash) derivations below land inside this single window. */
export declare const MANAGED_SURREAL_PORT_RANGE = 10000;
/** Pick the port for the bootstrap-managed SurrealDB.
 *
 *  GH #13 (multi-user port collision): on a shared host, every OS user's
 *  bootstrap previously hardcoded 18765, so the 2nd user's managed SurrealDB
 *  collided with the 1st user's. We derive a per-user port by offsetting into
 *  the managed-SurrealDB window (MANAGED_SURREAL_PORT_RANGE wide). Two different
 *  users almost never land on the same port; even if they did, the process-owner
 *  guard in findExistingKongcodeSurreal prevents cross-user adoption.
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
 *  - KONGCODE_SURREAL_PORT override always wins (explicit operator intent).
 *  - POSIX: 18765 + (getuid() % RANGE).
 *  - Windows / no getuid: 18765 + (fnv1a32(os.userInfo().username) % RANGE).
 *  - Degenerate (no uid AND no username): flat 18765 — the only safe choice;
 *    isolation then leans on the per-install cred + process-owner guard. */
export declare function pickPort(): number;
/**
 * Idempotent first-run bootstrap. Provisions npm deps, SurrealDB binary, embedding
 * model, and a managed SurrealDB child process. Returns the URL the MCP server
 * should connect to (either the managed child or SURREAL_URL override).
 *
 * Skips bootstrap entirely when KONGCODE_SKIP_BOOTSTRAP=1 is set.
 * Skips the SurrealDB child when SURREAL_URL points at an external server.
 */
export declare function bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
/** Per Option A architecture: the surreal child is detached + unref'd on spawn,
 *  so MCP exit does not affect its lifecycle. By default this function is a
 *  no-op — calling it during MCP shutdown leaves the surreal child running so
 *  the next MCP boot can attach to it (preserving turn-ingestion across
 *  plugin updates, Claude Code restarts, etc.).
 *
 *  Pass { force: true } to actually SIGTERM the child — used by tests and any
 *  future "kongcode stop" CLI command that explicitly tears everything down. */
export declare function shutdownManagedSurreal(opts?: {
    force?: boolean;
}): void;
export {};
