/**
 * Sync handoff file — last-resort session continuity bridge.
 *
 * When the process dies (Ctrl+C×2), there's no async cleanup window.
 * This module writes a minimal JSON snapshot synchronously on exit
 * so the next session's wakeup has context even before deferred
 * extraction runs.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const HANDOFF_FILENAME = ".laqrumcode-handoff.json";

export interface HandoffFileData {
  sessionId: string;
  timestamp: string;
  userTurnCount: number;
  lastUserText: string;
  lastAssistantText: string;
  unextractedTokens: number;
}

/**
 * Synchronously write a handoff file. Safe to call from process.on("exit").
 */
export function writeHandoffFileSync(
  data: HandoffFileData,
  workspaceDir: string,
): void {
  try {
    const path = join(workspaceDir, HANDOFF_FILENAME);
    writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Best-effort — sync exit handler, can't log async
  }
}

/**
 * Read and delete the handoff file. Returns null if not found.
 */
export function readAndDeleteHandoffFile(
  workspaceDir: string,
): HandoffFileData | null {
  const path = join(workspaceDir, HANDOFF_FILENAME);
  const processingPath = path + ".processing";
  // Also clean up stale .processing files from prior crashes
  if (existsSync(processingPath) && !existsSync(path)) {
    try { unlinkSync(processingPath); } catch { /* ignore */ }
  }
  if (!existsSync(path)) return null;
  try {
    // Atomic rename first so a crash between read and delete can't re-process
    renameSync(path, processingPath);
    const raw = readFileSync(processingPath, "utf-8");
    unlinkSync(processingPath);
    const parsed = JSON.parse(raw);
    // Runtime validation — reject prototype pollution and malformed data
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (Object.hasOwn(parsed, "__proto__") || Object.hasOwn(parsed, "constructor")) return null;
    const data: HandoffFileData = {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId.slice(0, 200) : "",
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp.slice(0, 50) : "",
      userTurnCount: typeof parsed.userTurnCount === "number" ? parsed.userTurnCount : 0,
      lastUserText: typeof parsed.lastUserText === "string" ? parsed.lastUserText.slice(0, 500) : "",
      lastAssistantText: typeof parsed.lastAssistantText === "string" ? parsed.lastAssistantText.slice(0, 500) : "",
      unextractedTokens: typeof parsed.unextractedTokens === "number" ? parsed.unextractedTokens : 0,
    };
    return data;
  } catch {
    // Corrupted or deleted between check and read
    try { unlinkSync(processingPath); } catch { /* ignore */ }
    return null;
  }
}
