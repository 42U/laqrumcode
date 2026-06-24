import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePluginConfig } from "../src/engine/config.js";

describe("parsePluginConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all LaqrumBrain-related env vars
    delete process.env.SURREAL_URL;
    delete process.env.SURREAL_HTTP_URL;
    delete process.env.SURREAL_USER;
    delete process.env.SURREAL_PASS;
    delete process.env.SURREAL_NS;
    delete process.env.SURREAL_DB;
    delete process.env.EMBED_MODEL_PATH;
    delete process.env.LAQRUMCODE_CACHE_DIR;
    delete process.env.LAQRUMCODE_DATA_DIR;
    delete process.env.SURREAL_BIN_PATH;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it("returns sensible defaults with no input", () => {
    const config = parsePluginConfig();
    expect(config.surreal.url).toBe("ws://localhost:8000/rpc");
    expect(config.surreal.user).toBe("root");
    expect(config.surreal.pass).toBe("root");
    expect(config.surreal.ns).toBe("laqrum");
    expect(config.surreal.db).toBe("memory");
    expect(config.embedding.dimensions).toBe(1024);
    expect(config.embedding.modelPath).toBe(
      join(homedir(), ".laqrumcode", "cache", "models", "bge-m3-Q4_K_M.gguf"),
    );
    expect(config.paths.cacheDir).toBe(join(homedir(), ".laqrumcode", "cache"));
    expect(config.paths.dataDir).toBe(join(homedir(), ".laqrumcode", "data"));
    expect(config.paths.surrealBinPath).toBeNull();
  });

  it("returns defaults with empty object", () => {
    const config = parsePluginConfig({});
    expect(config.surreal.url).toBe("ws://localhost:8000/rpc");
    expect(config.surreal.ns).toBe("laqrum");
  });

  it("reads values from plugin config", () => {
    const config = parsePluginConfig({
      surreal: {
        url: "ws://db.example.com:9000/rpc",
        user: "admin",
        pass: "secret",
        ns: "prod",
        db: "brain",
      },
      embedding: {
        modelPath: "/custom/model.gguf",
        dimensions: 768,
      },
    });
    expect(config.surreal.url).toBe("ws://db.example.com:9000/rpc");
    expect(config.surreal.user).toBe("admin");
    expect(config.surreal.pass).toBe("secret");
    expect(config.surreal.ns).toBe("prod");
    expect(config.surreal.db).toBe("brain");
    expect(config.embedding.modelPath).toBe("/custom/model.gguf");
    expect(config.embedding.dimensions).toBe(768);
  });

  it("plugin config takes priority over env vars", () => {
    process.env.SURREAL_URL = "ws://env-override:1234/rpc";
    process.env.SURREAL_USER = "envuser";
    process.env.SURREAL_PASS = "envpass";
    process.env.SURREAL_NS = "envns";
    process.env.SURREAL_DB = "envdb";
    process.env.EMBED_MODEL_PATH = "/env/model.gguf";

    const config = parsePluginConfig({
      surreal: { url: "ws://plugin-config:8000/rpc", user: "pluginuser" },
    });

    // Plugin config wins over env vars
    expect(config.surreal.url).toBe("ws://plugin-config:8000/rpc");
    expect(config.surreal.user).toBe("pluginuser");
    // Fields not in plugin config fall back to env vars
    expect(config.surreal.pass).toBe("envpass");
    expect(config.surreal.ns).toBe("envns");
    expect(config.surreal.db).toBe("envdb");
    expect(config.embedding.modelPath).toBe("/env/model.gguf");
  });

  it("derives httpUrl from ws url", () => {
    const config = parsePluginConfig({
      surreal: { url: "ws://localhost:8000/rpc" },
    });
    expect(config.surreal.httpUrl).toBe("http://localhost:8000/sql");
  });

  it("derives httpUrl from wss url", () => {
    const config = parsePluginConfig({
      surreal: { url: "wss://secure.db.com:443/rpc" },
    });
    expect(config.surreal.httpUrl).toBe("https://secure.db.com:443/sql");
  });

  it("SURREAL_HTTP_URL overrides derived httpUrl", () => {
    process.env.SURREAL_HTTP_URL = "http://custom:9999/sql";
    const config = parsePluginConfig({
      surreal: { url: "ws://localhost:8000/rpc" },
    });
    expect(config.surreal.httpUrl).toBe("http://custom:9999/sql");
  });

  it("ignores non-string config values and uses defaults", () => {
    const config = parsePluginConfig({
      surreal: { url: 12345, user: null, pass: undefined },
    });
    expect(config.surreal.url).toBe("ws://localhost:8000/rpc");
    expect(config.surreal.user).toBe("root");
    expect(config.surreal.pass).toBe("root");
  });

  it("returns default thresholds with no input", () => {
    const config = parsePluginConfig();
    expect(config.thresholds.daemonTokenThreshold).toBe(4000);
    expect(config.thresholds.midSessionCleanupThreshold).toBe(25_000);
    expect(config.thresholds.extractionTimeoutMs).toBe(60_000);
    expect(config.thresholds.maxPendingThinking).toBe(20);
  });

  it("reads threshold values from plugin config", () => {
    const config = parsePluginConfig({
      thresholds: {
        daemonTokenThreshold: 8000,
        midSessionCleanupThreshold: 50_000,
        extractionTimeoutMs: 30_000,
        maxPendingThinking: 10,
      },
    });
    expect(config.thresholds.daemonTokenThreshold).toBe(8000);
    expect(config.thresholds.midSessionCleanupThreshold).toBe(50_000);
    expect(config.thresholds.extractionTimeoutMs).toBe(30_000);
    expect(config.thresholds.maxPendingThinking).toBe(10);
  });

  it("ignores non-number threshold values and uses defaults", () => {
    const config = parsePluginConfig({
      thresholds: { daemonTokenThreshold: "fast", extractionTimeoutMs: null },
    });
    expect(config.thresholds.daemonTokenThreshold).toBe(4000);
    expect(config.thresholds.extractionTimeoutMs).toBe(60_000);
  });
});
