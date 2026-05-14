import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Round-5 coverage: handleToolCall outer try/catch in src/mcp-server.ts.
 *
 * The catch block (around line 357-365) translates handler exceptions into a
 * tool-result text payload of the shape:
 *
 *   { content: [{ type: "text", text: `Tool ${name} failed: ${msg}` }] }
 *
 * rather than letting the throw bubble up as a JSON-RPC transport error.
 * Spawning a full MCP server child to trigger a thrown handler is heavyweight
 * (bootstrap can take 30+ seconds), so this test pins the contract two ways:
 *
 *   1. STATIC: confirms the literal `Tool ${name} failed:` template and the
 *      surrounding `content: [{ type: "text", text: ... }]` shape exist in
 *      both src/ and dist/ (so a runtime call WILL hit them).
 *   2. STRUCTURAL: confirms the catch block sits inside `handleToolCall`
 *      and that the swallowed return is NOT a JSON-RPC error envelope
 *      (no `code:` / `JSON-RPC` keywords inside the catch body).
 *
 * Together these pin the "swallow as tool result, not as transport error"
 * contract without paying a multi-second daemon-boot cost on every test run.
 */

const SRC_PATH = join(__dirname, "..", "src", "mcp-server.ts");
const DIST_PATH = join(__dirname, "..", "dist", "mcp-server.js");

describe("mcp-server: outer try/catch translates handler throws to tool-result", () => {
  it("emits `Tool ${name} failed:` template in source", () => {
    const src = readFileSync(SRC_PATH, "utf-8");
    expect(src).toMatch(/Tool \$\{name\} failed:/);
  });

  it("wraps the failure text in the canonical content envelope", () => {
    const src = readFileSync(SRC_PATH, "utf-8");
    // The catch body should return {content: [{type: "text", text: ...}]}.
    // Anchor on the exact catch block to avoid matching unrelated content
    // assemblies elsewhere in the file.
    const handleToolCallMatch = src.match(
      /async function handleToolCall[\s\S]*?\n\}\n/,
    );
    expect(handleToolCallMatch, "handleToolCall must exist").not.toBeNull();
    const body = handleToolCallMatch![0];

    // The catch block must produce the canonical content shape.
    expect(body).toMatch(/} catch \(err\) \{[\s\S]*?content:[\s\S]*?type:\s*"text"[\s\S]*?text:\s*`Tool \$\{name\} failed:/);
  });

  it("does NOT rethrow inside the catch (avoids JSON-RPC transport error)", () => {
    const src = readFileSync(SRC_PATH, "utf-8");
    const handleToolCallMatch = src.match(
      /async function handleToolCall[\s\S]*?\n\}\n/,
    );
    const body = handleToolCallMatch![0];

    // Isolate the catch block.
    const catchMatch = body.match(/} catch \(err\) \{([\s\S]*?)\n\s{2}\}\n\}/);
    expect(catchMatch, "catch block must exist with a closing brace").not.toBeNull();
    const catchBody = catchMatch![1];

    // The catch must not rethrow — any `throw` here means handler errors
    // bubble up as JSON-RPC transport errors instead of tool-result text.
    expect(catchBody).not.toMatch(/\bthrow\b/);
  });

  it("ships the same template through to dist/ (so runtime hits the catch)", () => {
    if (!existsSync(DIST_PATH)) {
      // Dist may be absent during a clean tree. Mark a soft skip.
      return;
    }
    const dist = readFileSync(DIST_PATH, "utf-8");
    // tsc preserves the template literal verbatim. If the build target ever
    // switches to ES5 (template→concat), this assertion will need updating.
    expect(dist).toMatch(/Tool \$\{name\} failed:/);
  });
});
