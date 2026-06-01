import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasMigratableFiles, migrateWorkspace } from "../src/engine/workspace-migrate.js";

// --- Mock SurrealStore ---

function mockStore(available = true) {
  const records: Record<string, unknown>[] = [];
  return {
    isAvailable: () => available,
    queryFirst: async (_sql: string, params?: { record?: Record<string, unknown> }) => {
      // v0.7.79: commitKnowledge writes via queryFirst (returns id) for
      // commit-time CREATEs. The test mock tracks both paths so assertions
      // on `_records` stay agnostic to which write API the writer uses.
      if (params?.record) records.push(params.record);
      return [] as unknown[];
    },
    queryExec: async (_sql: string, params?: { record?: Record<string, unknown> }) => {
      if (params?.record) records.push(params.record);
    },
    relate: async () => {},
    createMemory: async () => "memory:test",
    _records: records,
  };
}

// --- Mock EmbeddingService ---

function mockEmbeddings(available = false) {
  return {
    isAvailable: () => available,
    embed: async () => new Array(1024).fill(0),
  };
}

// --- Temp workspace helper ---

async function makeTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kongbrain-test-"));
}

// ── hasMigratableFiles ───────────────────────────────────────────────────────

describe("hasMigratableFiles", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempWorkspace(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns false for empty directory", async () => {
    expect(await hasMigratableFiles(dir)).toBe(false);
  });

  it("detects IDENTITY.md", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "agent identity");
    expect(await hasMigratableFiles(dir)).toBe(true);
  });

  it("detects MEMORY.md", async () => {
    await writeFile(join(dir, "MEMORY.md"), "memory index");
    expect(await hasMigratableFiles(dir)).toBe(true);
  });

  it("detects SKILLS.md", async () => {
    await writeFile(join(dir, "SKILLS.md"), "skills index");
    expect(await hasMigratableFiles(dir)).toBe(true);
  });

  it("detects skills/ directory", async () => {
    await mkdir(join(dir, "skills"));
    expect(await hasMigratableFiles(dir)).toBe(true);
  });

  it("detects memory/ directory", async () => {
    await mkdir(join(dir, "memory"));
    expect(await hasMigratableFiles(dir)).toBe(true);
  });

  it("does NOT detect README.md (user file)", async () => {
    await writeFile(join(dir, "README.md"), "# My Project");
    expect(await hasMigratableFiles(dir)).toBe(false);
  });

  it("does NOT detect package.json (user file)", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    expect(await hasMigratableFiles(dir)).toBe(false);
  });

  it("does NOT detect SOUL.md (stays for graduation)", async () => {
    await writeFile(join(dir, "SOUL.md"), "soul content");
    expect(await hasMigratableFiles(dir)).toBe(false);
  });

  it("does NOT detect HEARTBEAT.md (owned by OpenClaw core)", async () => {
    await writeFile(join(dir, "HEARTBEAT.md"), "check inbox");
    expect(await hasMigratableFiles(dir)).toBe(false);
  });
});

// ── migrateWorkspace safety ──────────────────────────────────────────────────

describe("migrateWorkspace", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempWorkspace(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("skips when DB unavailable", async () => {
    const result = await migrateWorkspace(dir, mockStore(false) as any, mockEmbeddings() as any);
    expect(result.ingested).toBe(0);
    expect(result.details[0]).toContain("not available");
  });

  it("returns empty when no files exist", async () => {
    const result = await migrateWorkspace(dir, mockStore() as any, mockEmbeddings() as any);
    expect(result.ingested).toBe(0);
    expect(result.details).toContain("No OpenClaw workspace files found to migrate");
  });

  it("ingests IDENTITY.md as artifact", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    const store = mockStore();
    const result = await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    expect(result.ingested).toBe(1);
    expect(result.details.some(d => d.includes("IDENTITY.md"))).toBe(true);
    expect(store._records.some(r => r.path === "IDENTITY.md")).toBe(true);
  });

  it("ingests skills/*/SKILL.md as skill records", async () => {
    await mkdir(join(dir, "skills", "deploy"), { recursive: true });
    await writeFile(join(dir, "skills", "deploy", "SKILL.md"), `---
name: deploy
description: Deploy the application
---

# Deploy

1. Build the project
2. Run tests
3. Push to production
`);
    const store = mockStore();
    const result = await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    expect(result.skills).toBe(1);
    // Should create both a skill record and an artifact record
    expect(store._records.some(r => (r as any).name === "deploy")).toBe(true);
    expect(store._records.some(r => (r as any).type === "skill-definition")).toBe(true);
  });

  it("leaves a slash-discovery stub on disk instead of archiving an ingested SKILL.md", async () => {
    await mkdir(join(dir, "skills", "deploy"), { recursive: true });
    await writeFile(join(dir, "skills", "deploy", "SKILL.md"), `---
name: deploy
description: Deploy the application
---

# Deploy

1. Build the project
2. Run tests
`);
    const result = await migrateWorkspace(dir, mockStore() as any, mockEmbeddings() as any);
    expect(result.skills).toBe(1);

    // The stub stays on disk for slash discovery — NOT moved into the archive.
    const stubExists = await stat(join(dir, "skills", "deploy", "SKILL.md")).then(() => true).catch(() => false);
    expect(stubExists).toBe(true);
    const archived = await stat(join(dir, ".kongbrain-archive", "skills", "deploy", "SKILL.md")).then(() => true).catch(() => false);
    expect(archived).toBe(false);

    // Its on-disk body is now the 5-line stub pointing at get_skill_body.
    const onDisk = await readFile(join(dir, "skills", "deploy", "SKILL.md"), "utf-8");
    expect(onDisk).toContain("name: deploy");
    expect(onDisk).toContain("get_skill_body");
    expect(onDisk).not.toContain("Build the project"); // full body no longer on disk
  });

  it("skips an already-DB-resident stub SKILL.md (mints no duplicate row, leaves it untouched)", async () => {
    await mkdir(join(dir, "skills", "kongcode-release"), { recursive: true });
    const stub = `---
name: kongcode-release
description: Ship a new kongcode version
---

Body in kongcode DB. Call \`mcp__plugin_kongcode_kongcode__get_skill_body\` with \`name="kongcode-release"\` to load full instructions.
`;
    await writeFile(join(dir, "skills", "kongcode-release", "SKILL.md"), stub);
    const store = mockStore();
    const result = await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    // Already a stub → not re-ingested as a junk skill row.
    expect(result.skills).toBe(0);
    expect(store._records.some(r => (r as any).name === "kongcode-release")).toBe(false);

    // Stub left byte-identical on disk, not archived.
    const onDisk = await readFile(join(dir, "skills", "kongcode-release", "SKILL.md"), "utf-8");
    expect(onDisk).toBe(stub);
    const archived = await stat(join(dir, ".kongbrain-archive", "skills", "kongcode-release", "SKILL.md")).then(() => true).catch(() => false);
    expect(archived).toBe(false);
  });

  it("NEVER touches README.md", async () => {
    await writeFile(join(dir, "README.md"), "# My Project\n\nThis is my project.");
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    const store = mockStore();
    await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    // README.md should still be on disk, unarchived
    const readmeExists = await stat(join(dir, "README.md")).then(() => true).catch(() => false);
    expect(readmeExists).toBe(true);

    // And should NOT be in the DB
    expect(store._records.some(r => (r as any).path === "README.md")).toBe(false);
  });

  it("NEVER touches package.json", async () => {
    await writeFile(join(dir, "package.json"), '{"name": "user-project"}');
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    await migrateWorkspace(dir, mockStore() as any, mockEmbeddings() as any);

    const exists = await stat(join(dir, "package.json")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("NEVER touches src/ directory files", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;");
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    const store = mockStore();
    await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    const exists = await stat(join(dir, "src", "index.ts")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    expect(store._records.some(r => (r as any).path?.includes("src/"))).toBe(false);
  });

  it("NEVER touches docs/ directory files", async () => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "api.md"), "# API Docs");
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    const store = mockStore();
    await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    const exists = await stat(join(dir, "docs", "api.md")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("leaves SOUL.md in place", async () => {
    await writeFile(join(dir, "SOUL.md"), "Be kind and thorough.");
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    const store = mockStore();
    await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    const soulExists = await stat(join(dir, "SOUL.md")).then(() => true).catch(() => false);
    expect(soulExists).toBe(true);
    expect(store._records.some(r => (r as any).path === "SOUL.md")).toBe(false);
  });

  it("leaves HEARTBEAT.md in place", async () => {
    await writeFile(join(dir, "HEARTBEAT.md"), "check inbox every hour");
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    const store = mockStore();
    await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    const hbExists = await stat(join(dir, "HEARTBEAT.md")).then(() => true).catch(() => false);
    expect(hbExists).toBe(true);
    expect(store._records.some(r => (r as any).path === "HEARTBEAT.md")).toBe(false);
  });

  it("archives ingested files to .kongbrain-archive/", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");
    await migrateWorkspace(dir, mockStore() as any, mockEmbeddings() as any);

    // Original should be gone
    const origExists = await stat(join(dir, "IDENTITY.md")).then(() => true).catch(() => false);
    expect(origExists).toBe(false);

    // Archive should exist
    const archiveExists = await stat(join(dir, ".kongbrain-archive", "IDENTITY.md")).then(() => true).catch(() => false);
    expect(archiveExists).toBe(true);
  });

  it("is idempotent — second run skips", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "I am an agent with many skills.");

    // First run: mock store says no marker exists
    const store1 = mockStore();
    const result1 = await migrateWorkspace(dir, store1 as any, mockEmbeddings() as any);
    expect(result1.ingested).toBe(1);

    // Second run: mock store says marker exists
    const store2 = mockStore();
    store2.queryFirst = async () => [{ id: "artifact:marker" }] as unknown[];
    const result2 = await migrateWorkspace(dir, store2 as any, mockEmbeddings() as any);
    expect(result2.ingested).toBe(0);
    expect(result2.details[0]).toContain("already migrated");
  });

  it("handles memory/ daily logs", async () => {
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(join(dir, "memory", "2026-03-27.md"), "Today we worked on the auth module.");
    const store = mockStore();
    const result = await migrateWorkspace(dir, store as any, mockEmbeddings() as any);

    expect(result.ingested).toBe(1);
    expect(store._records.some(r => (r as any).type === "daily-memory")).toBe(true);
  });
});
