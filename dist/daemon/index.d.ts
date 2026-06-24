/**
 * laqrumcode-daemon entry point.
 *
 * Long-lived background process spawned by the first laqrumcode-mcp client
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
export {};
