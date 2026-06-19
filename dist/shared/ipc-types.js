/**
 * IPC contract between kongcode-daemon and kongcode-mcp (the per-Claude-Code
 * client). This file is the single source of truth for what RPC methods
 * exist, what they accept, and what they return.
 *
 * Architecture (v0.7.0+):
 *   kongcode-mcp (thin client, one per Claude Code session)
 *     └── stdio  ── Claude Code (MCP protocol)
 *     └── socket ── kongcode-daemon (JSON-RPC over Unix socket / TCP)
 *
 * The daemon owns SurrealStore, EmbeddingService, ACAN weights, hook handlers,
 * and tool handlers. Clients are stateless relays that translate Claude Code's
 * MCP RPC into our IPC RPC. Multiple clients (multiple Claude Code sessions)
 * connect to one daemon; the daemon serializes per-session state via the
 * sessionId carried on every call.
 *
 * Wire format: JSON-RPC 2.0. Methods are namespaced — `tool.<name>` for MCP
 * tool handlers, `hook.<name>` for Claude Code hook events, `meta.<name>`
 * for daemon-level operations.
 *
 * Versioning: bump PROTOCOL_VERSION on any breaking change. The daemon
 * advertises its supported version in `meta.handshake`; clients refuse to
 * proceed against incompatible daemons (forces daemon restart with new
 * binary on plugin update).
 */
/** Bumped on any breaking IPC change. Clients and daemons compare on connect. */
export const PROTOCOL_VERSION = 1;
/** Default Unix socket path (Linux, macOS). Single shared daemon socket
 *  replaces 0.6.x's per-PID `~/.kongcode-${pid}.sock` pattern. */
export const DEFAULT_DAEMON_SOCKET_PATH = `${process.env.HOME ?? process.env.USERPROFILE ?? "/tmp"}/.kongcode-daemon.sock`;
/** Default TCP fallback port (Windows or where Unix sockets are fragile).
 *  Loopback only. Override via KONGCODE_DAEMON_PORT. */
export const DEFAULT_DAEMON_TCP_PORT = 18764;
/** Daemon PID file location. Written on daemon startup, removed on graceful
 *  shutdown. Used by clients to detect "daemon was running but crashed" vs
 *  "daemon never started." */
export const DAEMON_PID_FILE = ".kongcode/cache/daemon.pid";
/** Lock file held during daemon spawn. Prevents two clients from racing to
 *  fork two daemons simultaneously. */
export const DAEMON_SPAWN_LOCK = ".kongcode/cache/daemon.spawn.lock";
// ── Method namespace ──────────────────────────────────────────────────────
/** Every registered IPC method. Used by the daemon's dispatcher and the
 *  client's stub library. Adding a method requires:
 *    1. Add the literal here
 *    2. Implement the handler in `src/daemon/handlers.ts`
 *    3. Add a typed wrapper in `src/mcp-client/rpc-stub.ts`
 *  All three live in the same repo, so type errors flag missing wiring. */
export const IPC_METHODS = [
    // ── Meta operations ─────────────────────────────────────────────
    /** Returns daemon version, protocol version, uptime, healthy?. Always succeeds if socket connects. */
    "meta.handshake",
    /** Liveness probe — returns {ok: true} if daemon's event loop is responsive. */
    "meta.health",
    /** Drain in-flight requests, close DB cleanly, exit. Used by `kongcode-daemon stop`. */
    "meta.shutdown",
    /** Flag the daemon to exit when the last attached client disconnects.
     *  Used by mcp-clients newer than the running daemon to schedule a code
     *  refresh without killing in-flight sessions on older clients. */
    "meta.requestSupersede",
    // ── MCP tool handlers (mirror src/tools/*.ts) ──────────────────
    "tool.recall",
    "tool.coreMemory",
    "tool.introspect",
    "tool.fetchPendingWork",
    "tool.commitWorkResults",
    "tool.createKnowledgeGems",
    "tool.memoryHealth",
    "tool.linkHierarchy",
    "tool.supersede",
    "tool.recordRetrievalFeedback",
    "tool.recordFinding",
    "tool.clusterScan",
    "tool.whatIsMissing",
    "tool.createSkill",
    "tool.getSkillBody",
    "tool.updateSkill",
    // ── Claude Code hook handlers (mirror src/hook-handlers/*.ts) ──
    "hook.sessionStart",
    "hook.userPromptSubmit",
    "hook.preToolUse",
    "hook.postToolUse",
    "hook.stop",
    "hook.preCompact",
    "hook.postCompact",
    "hook.sessionEnd",
    "hook.taskCreated",
    "hook.subagentStop",
];
/** Type-safety helper: narrows arbitrary strings to known method names at
 *  the dispatcher boundary. Returns null for unknown methods (daemon then
 *  responds with JSON-RPC's standard "Method not found" error -32601). */
export function isKnownMethod(name) {
    return IPC_METHODS.includes(name);
}
/** JSON-RPC framing notes (informational — actual framing handled by transport):
 *
 *  Request:  {"jsonrpc":"2.0", "id":N, "method":"tool.recall", "params":{sessionId, args}}
 *  Response: {"jsonrpc":"2.0", "id":N, "result":{content:[...]} }
 *  Error:    {"jsonrpc":"2.0", "id":N, "error":{code,message,data}}
 *
 *  Transport: line-delimited JSON over Unix socket / TCP (one JSON object per
 *  line). Simpler than length-prefixed; avoids needing a streaming parser.
 *  Each side flushes after \n.
 */
