/**
 * Daemon tool round-trip integration test (v0.7.85).
 *
 * Targets a live kongcode-daemon at the default socket path. Verifies the new
 * `tool.getSkillBody` IPC method is reachable end-to-end through the real
 * JSON-RPC transport plus `wrapToolHandler` dispatch plus real SurrealDB.
 * This is the runtime defense that complements the static lint test in
 * `test/lint-mcp-tool-wiring-invariant.test.ts`. Together they prevent the
 * v0.7.84 failure class: a new tool wired only into `src/mcp-server.ts` but
 * missing from the daemon-split path.
 *
 * Skip behavior: when no daemon socket exists at `~/.kongcode-daemon.sock`
 * (e.g. CI without a started daemon), tests skip cleanly. The static lint
 * always runs and catches the v0.7.84 class statically.
 *
 * Read-only operations only — no DB writes — to avoid polluting the
 * production graph this targets. The write path (`tool.createSkill`) is
 * covered by:
 *   - the unit-test of `commitKnowledge` (same code path as the handler)
 *   - `scripts/migrate-skills-to-db.mjs` (which exercises CREATE skill with
 *     the same field shape)
 *
 * Future tightening (v0.7.86+): spawn an isolated daemon with a unique
 * namespace + stubbed embeddings so the test can also write/round-trip
 * `tool.createSkill` without polluting the production DB.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IpcClient } from "../../src/mcp-client/ipc-client.js";

const SOCKET_PATH =
  process.env.KONGCODE_DAEMON_SOCKET ?? join(homedir(), ".kongcode-daemon.sock");

const RUN_LIVE = existsSync(SOCKET_PATH);

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
}

describe.skipIf(!RUN_LIVE)("daemon tool round-trip (live IPC)", () => {
  let client: IpcClient;

  beforeAll(async () => {
    client = new IpcClient({
      socketPath: SOCKET_PATH,
      defaultTimeoutMs: 15_000,
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    await client.connect();
  }, 30_000);

  afterAll(() => {
    if (client) client.close();
  });

  it("tool.getSkillBody returns kongcode-release body via daemon-split path", async () => {
    const result = await client.call<ToolResponse>(
      "tool.getSkillBody",
      { sessionId: "rt-test", args: { name: "kongcode-release" } },
    );
    const text = result?.content?.[0]?.text ?? "";
    // Reconstructed frontmatter at the top.
    expect(text).toMatch(/^---\nname:\s*kongcode-release/);
    expect(text).toMatch(/description:/);
    // Body is the 7000+ char release procedure.
    expect(text.length).toBeGreaterThan(1000);
  }, 15_000);

  it("tool.getSkillBody for missing name returns 'no skill found'", async () => {
    const result = await client.call<ToolResponse>(
      "tool.getSkillBody",
      { sessionId: "rt-test", args: { name: "_definitely_not_a_real_skill_v085" } },
    );
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/no active skill found/i);
  }, 15_000);

  it("tool.getSkillBody with empty name returns validation error", async () => {
    const result = await client.call<ToolResponse>(
      "tool.getSkillBody",
      { sessionId: "rt-test", args: { name: "" } },
    );
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/`name` is required/);
  }, 15_000);

  it("tool.getSkillBody for kongcode-health returns its body too", async () => {
    // Second known migrated skill — verifies the lookup isn't accidentally
    // hard-coded to kongcode-release.
    const result = await client.call<ToolResponse>(
      "tool.getSkillBody",
      { sessionId: "rt-test", args: { name: "kongcode-health" } },
    );
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/^---\nname:\s*kongcode-health/);
    expect(text.length).toBeGreaterThan(500);
  }, 15_000);
});
