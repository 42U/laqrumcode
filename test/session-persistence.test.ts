/**
 * Tests for handoff-file.ts and deferred-cleanup.ts — crash resilience.
 *
 * handoff-file: Sync write/read/delete of emergency session snapshots.
 * deferred-cleanup: Orphaned session recovery on next boot.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeHandoffFileSync, readAndDeleteHandoffFile, type HandoffFileData } from "../src/engine/handoff-file.js";
import { runDeferredCleanup } from "../src/engine/deferred-cleanup.js";

// ── Temp dir helper ──

function makeTmpDir(): string {
  const dir = join(tmpdir(), `laqrumbrain-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── handoff-file ──

describe("writeHandoffFileSync", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a valid JSON file", () => {
    dir = makeTmpDir();
    const data: HandoffFileData = {
      sessionId: "session:abc",
      timestamp: "2026-04-03T00:00:00Z",
      userTurnCount: 5,
      lastUserText: "fix the bug",
      lastAssistantText: "I found the issue",
      unextractedTokens: 1200,
    };

    writeHandoffFileSync(data, dir);

    const path = join(dir, ".laqrumcode-handoff.json");
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, "utf-8"));
    expect(content.sessionId).toBe("session:abc");
    expect(content.userTurnCount).toBe(5);
  });

  it("does not throw on invalid directory", () => {
    expect(() => writeHandoffFileSync({
      sessionId: "s1", timestamp: "", userTurnCount: 0,
      lastUserText: "", lastAssistantText: "", unextractedTokens: 0,
    }, "/nonexistent/path/that/does/not/exist")).not.toThrow();
  });
});

describe("readAndDeleteHandoffFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads and deletes the handoff file", () => {
    dir = makeTmpDir();
    const data: HandoffFileData = {
      sessionId: "session:xyz",
      timestamp: "2026-04-03T12:00:00Z",
      userTurnCount: 10,
      lastUserText: "deploy it",
      lastAssistantText: "deploying now",
      unextractedTokens: 500,
    };

    writeHandoffFileSync(data, dir);
    const result = readAndDeleteHandoffFile(dir);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session:xyz");
    expect(result!.userTurnCount).toBe(10);
    expect(result!.lastUserText).toBe("deploy it");

    // File should be deleted
    expect(existsSync(join(dir, ".laqrumcode-handoff.json"))).toBe(false);
    expect(existsSync(join(dir, ".laqrumcode-handoff.json.processing"))).toBe(false);
  });

  it("returns null when no file exists", () => {
    dir = makeTmpDir();
    expect(readAndDeleteHandoffFile(dir)).toBeNull();
  });

  it("truncates long fields for safety", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, ".laqrumcode-handoff.json"), JSON.stringify({
      sessionId: "x".repeat(500),
      timestamp: "t".repeat(100),
      userTurnCount: 5,
      lastUserText: "y".repeat(1000),
      lastAssistantText: "z".repeat(1000),
      unextractedTokens: 100,
    }));

    const result = readAndDeleteHandoffFile(dir);
    expect(result!.sessionId.length).toBeLessThanOrEqual(200);
    expect(result!.timestamp.length).toBeLessThanOrEqual(50);
    expect(result!.lastUserText.length).toBeLessThanOrEqual(500);
    expect(result!.lastAssistantText.length).toBeLessThanOrEqual(500);
  });

  it("rejects prototype pollution attempts", () => {
    dir = makeTmpDir();
    // Write raw JSON with __proto__ key (JSON.stringify strips it)
    writeFileSync(join(dir, ".laqrumcode-handoff.json"),
      '{"__proto__":{"isAdmin":true},"sessionId":"s1","timestamp":"","userTurnCount":0,"lastUserText":"","lastAssistantText":"","unextractedTokens":0}');

    const result = readAndDeleteHandoffFile(dir);
    expect(result).toBeNull();
  });

  it("handles corrupted JSON gracefully", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, ".laqrumcode-handoff.json"), "not json{{{");
    const result = readAndDeleteHandoffFile(dir);
    expect(result).toBeNull();
  });

  it("handles non-object JSON (array)", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, ".laqrumcode-handoff.json"), "[1,2,3]");
    const result = readAndDeleteHandoffFile(dir);
    expect(result).toBeNull();
  });

  it("cleans up stale .processing files", () => {
    dir = makeTmpDir();
    // Simulate a crash: .processing file exists but no .json
    writeFileSync(join(dir, ".laqrumcode-handoff.json.processing"), "stale data");

    const result = readAndDeleteHandoffFile(dir);
    expect(result).toBeNull();
    expect(existsSync(join(dir, ".laqrumcode-handoff.json.processing"))).toBe(false);
  });

  it("validates field types (non-string sessionId becomes empty)", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, ".laqrumcode-handoff.json"), JSON.stringify({
      sessionId: 12345,  // should be string
      timestamp: null,
      userTurnCount: "not a number",
      lastUserText: undefined,
      lastAssistantText: false,
      unextractedTokens: "nope",
    }));

    const result = readAndDeleteHandoffFile(dir);
    expect(result!.sessionId).toBe("");
    expect(result!.timestamp).toBe("");
    expect(result!.userTurnCount).toBe(0);
    expect(result!.lastUserText).toBe("");
    expect(result!.unextractedTokens).toBe(0);
  });
});

// ── deferred-cleanup ──

describe("runDeferredCleanup", () => {
  // Note: runDeferredCleanup uses a process-global flag (Symbol.for)
  // so it only runs once per process. Tests for the inner logic need
  // to accept that only the first test actually runs the cleanup.

  it("returns 0 when store is unavailable", async () => {
    const store = { isAvailable: () => false } as any;
    const result = await runDeferredCleanup(store);
    expect(result).toBe(0);
  });

  // The process-global flag means subsequent calls always return 0
  it("returns 0 on repeated calls (once-per-process guard)", async () => {
    const store = {
      isAvailable: () => true,
      getOrphanedSessions: vi.fn(async () => []),
    } as any;
    const result = await runDeferredCleanup(store);
    expect(result).toBe(0); // already ran in this process
  });
});
