import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIST_PATH = join(__dirname, "..", "dist", "mcp-server.js");

describe("MCP handshake ordering (issue #4)", () => {
  it("responds to initialize before init() completes", async () => {
    if (!existsSync(DIST_PATH)) {
      throw new Error(`Run \`npm run build\` first — ${DIST_PATH} missing`);
    }

    const proc = spawn("node", [DIST_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KONGCODE_LOG_LEVEL: "error" },
    });

    try {
      const initMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "kongcode-handshake-test", version: "0.0.1" },
        },
      }) + "\n";

      let buffer = "";
      const responsePromise = new Promise<string>((resolve) => {
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1) {
                proc.stdout!.off("data", onData);
                resolve(line);
                return;
              }
            } catch { /* not a complete JSON message yet */ }
          }
        };
        proc.stdout!.on("data", onData);
      });

      proc.stdin!.write(initMsg);

      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("handshake timeout > 3000ms")), 3000),
        ),
      ]);

      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(1);
      expect(parsed.result?.protocolVersion).toBeDefined();
    } finally {
      proc.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 100));
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }, 6000);
});
