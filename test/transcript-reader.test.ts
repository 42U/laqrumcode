/**
 * Tests for the Claude Code transcript reader.
 *
 * Stop hook uses this to recover the assistant's response text — without
 * it, retrieval_outcome rows stop being written (Apr 15 → Apr 26 outage).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLatestAssistantText, readTurnTokenUsage } from "../src/engine/transcript-reader.js";

const SAMPLE_LINES = [
  { type: "user", message: { role: "user", content: "first prompt" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "first reply" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "final assistant reply text" }],
    },
  },
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "laqrumcode-transcript-"));
  path = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLatestAssistantText", () => {
  it("returns the latest assistant message text from a JSONL transcript", () => {
    writeFileSync(path, SAMPLE_LINES.map(l => JSON.stringify(l)).join("\n") + "\n");
    expect(readLatestAssistantText(path)).toBe("final assistant reply text");
  });

  it("joins multiple text blocks within an assistant message with newlines", () => {
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "tool_use", id: "x" },
          { type: "text", text: "part two" },
        ],
      },
    }) + "\n");
    expect(readLatestAssistantText(path)).toBe("part one\npart two");
  });

  it("returns empty string when transcript has no assistant text", () => {
    writeFileSync(path, JSON.stringify({
      type: "user",
      message: { role: "user", content: "only a user prompt" },
    }) + "\n");
    expect(readLatestAssistantText(path)).toBe("");
  });

  it("returns empty string when path is missing or unreadable", () => {
    expect(readLatestAssistantText("")).toBe("");
    expect(readLatestAssistantText("/nonexistent/path/x.jsonl")).toBe("");
  });

  it("ignores malformed JSON lines and recovers good ones", () => {
    writeFileSync(path, [
      "{not valid json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "good text" }] } }),
      "another garbage line",
      "",
    ].join("\n") + "\n");
    expect(readLatestAssistantText(path)).toBe("good text");
  });

  it("handles assistant message with string content (not an array)", () => {
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "plain string content" },
    }) + "\n");
    expect(readLatestAssistantText(path)).toBe("plain string content");
  });

  it("only keeps assistant messages — tool_result blocks in user messages are ignored", () => {
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real reply" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "tool output text" }] } }),
    ].join("\n") + "\n");
    expect(readLatestAssistantText(path)).toBe("real reply");
  });
});

describe("readTurnTokenUsage", () => {
  it("returns latest assistant input_tokens (incl. cache) + sum of output_tokens for the turn", () => {
    writeFileSync(path, [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "thinking" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 8500, cache_creation_input_tokens: 0 } },
      }),
    ].join("\n") + "\n");
    const usage = readTurnTokenUsage(path);
    // input = latest assistant: 5 + 8500 + 0 = 8505 (not summed across messages — each input_tokens is cumulative)
    // output = sum across both assistant messages: 50 + 30 = 80
    expect(usage).toEqual({ inputTokens: 8505, outputTokens: 80 });
  });

  it("stops at the previous turn's user prompt (turn boundary)", () => {
    writeFileSync(path, [
      JSON.stringify({ type: "user", message: { role: "user", content: "first turn prompt" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first reply" }],
          usage: { input_tokens: 100, output_tokens: 999 } }, // should NOT be summed in
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second turn prompt" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "second reply" }],
          usage: { input_tokens: 200, output_tokens: 25 } },
      }),
    ].join("\n") + "\n");
    const usage = readTurnTokenUsage(path);
    expect(usage).toEqual({ inputTokens: 200, outputTokens: 25 });
  });

  it("returns null when transcript is missing or has no usage data", () => {
    expect(readTurnTokenUsage("")).toBeNull();
    expect(readTurnTokenUsage("/nonexistent/x.jsonl")).toBeNull();

    writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: "no assistants here" } }) + "\n");
    expect(readTurnTokenUsage(path)).toBeNull();
  });

  it("handles missing token fields gracefully (treats as 0)", () => {
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }],
        usage: { output_tokens: 12 } }, // no input_tokens
    }) + "\n");
    expect(readTurnTokenUsage(path)).toEqual({ inputTokens: 0, outputTokens: 12 });
  });
});
