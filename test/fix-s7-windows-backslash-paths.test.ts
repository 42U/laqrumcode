/**
 * S7 regression — Windows backslash paths silently dropped by extractExtPaths.
 *
 * extractExtPaths tokenizes on whitespace + wrapping punctuation via
 * TOKEN_SPLIT_RE, but that class did NOT include the backslash. So a Windows
 * path like `C:\Users\x\foo.ts` stayed a single token. EXT_TOKEN_RE's head
 * class is `[\w./~-]*` (no `:` and no `\`), so the leading `C:` makes the
 * anchored whole-token match fail — and the path is silently dropped. The old
 * `\b`-anchored EXT_PATH_RE matched the trailing `foo.ts` for free; losing that
 * is a functional regression that degrades the PreCompact FILES: summary on
 * Windows.
 *
 * Fix: add `\\` to TOKEN_SPLIT_RE so backslash-separated segments split into
 * their tail filename token. The tail `foo.ts` then matches EXT_TOKEN_RE. (This
 * restores the bare-filename hint for FILES:; it intentionally does not
 * reconstruct the full backslash path and need not clear the edit-gate, which
 * keys on the surfaced path verbatim.)
 */
import { describe, it, expect } from "vitest";
import { extractExtPaths } from "../src/hook-handlers/post-tool-use.js";

function collect(text: string): string[] {
  const out: string[] = [];
  extractExtPaths(text, (p) => out.push(p));
  return out;
}

describe("S7: extractExtPaths recovers the tail filename from Windows paths", () => {
  it("yields foo.ts from C:\\Users\\x\\foo.ts", () => {
    expect(collect("C:\\Users\\x\\foo.ts")).toContain("foo.ts");
  });

  it("recovers a backslash path embedded mid-sentence", () => {
    expect(collect("see C:\\proj\\src\\main.rs for it")).toContain("main.rs");
  });

  it("handles a UNC-style path", () => {
    expect(collect("\\\\server\\share\\app\\index.tsx")).toContain("index.tsx");
  });

  it("handles multiple backslash paths on one line", () => {
    const got = collect("D:\\a\\one.py and E:\\b\\two.json");
    expect(got).toEqual(expect.arrayContaining(["one.py", "two.json"]));
  });
});

describe("S7: the backslash split does not regress Unix / grep extraction", () => {
  it("still captures a full relative Unix path", () => {
    expect(collect("src/engine/state.ts")).toContain("src/engine/state.ts");
  });

  it("still strips a grep :line:col suffix", () => {
    expect(collect("src/foo.ts:12:5")).toContain("src/foo.ts");
  });

  it("still captures bare filenames", () => {
    const got = collect("plain.md and config.json");
    expect(got).toEqual(expect.arrayContaining(["plain.md", "config.json"]));
  });
});
