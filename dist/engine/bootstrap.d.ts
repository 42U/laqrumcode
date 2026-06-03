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
/** The historical single-user managed SurrealDB port. Kept as a named constant
 *  because it's also the legacy candidate that {@link findExistingKongcodeSurreal}
 *  must probe (gated by the owner guard) so an upgrading single-user install's
 *  data is still discovered. */
export declare const LEGACY_MANAGED_SURREAL_PORT = 18765;
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
