/**
 * Tests for identity.ts and cognitive-bootstrap.ts — first-boot seeding.
 *
 * identity.ts: Seeds agent self-knowledge (who am I) into identity_chunk table.
 * cognitive-bootstrap.ts: Seeds operational knowledge (how do I work) into core_memory + identity_chunk.
 * WAKEUP.md: User-defined personality/identity on first run.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  seedIdentity,
  hasUserIdentity,
  findWakeupFile,
  readWakeupFile,
  deleteWakeupFile,
  saveUserIdentity,
  buildWakeupPrompt,
} from "../src/engine/identity.js";
import { seedCognitiveBootstrap } from "../src/engine/cognitive-bootstrap.js";

// ── Helpers ──

function makeTmpDir(): string {
  const dir = join(tmpdir(), `kongbrain-boot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockStore(identityCount = 0, coreHasBootstrap = false) {
  return {
    isAvailable: () => true,
    queryFirst: vi.fn(async (sql: string) => {
      // Identity-chunk version-tag check (0.4.0+): source = $source AND bootstrap_version = $v.
      // Treat identityCount as "chunks under the current version" for version-matched queries.
      if (sql.includes("FROM identity_chunk") && sql.includes("bootstrap_version")) return [{ count: identityCount }];
      // Legacy identity-chunk count query for the seedIdentity (agent self-knowledge) flow.
      if (sql.includes("FROM identity_chunk") && sql.includes("count()")) return [{ count: identityCount }];
      // 0.4.0+ uses a version-tag check (SQL: `... WHERE text CONTAINS $tag ...`).
      if (sql.includes("FROM core_memory") && sql.includes("CONTAINS $tag")) return [{ cnt: coreHasBootstrap ? 1 : 0 }];
      return [];
    }),
    queryExec: vi.fn(async () => {}),
    createCoreMemory: vi.fn(async () => "core_memory:cm1"),
  } as any;
}

function mockEmbeddings(available = true) {
  return {
    isAvailable: () => available,
    embed: vi.fn(async () => new Array(1024).fill(0)),
  } as any;
}

// ── seedIdentity ──

describe("seedIdentity", () => {
  it("seeds all identity chunks on first run", async () => {
    const store = mockStore(0);
    const embeddings = mockEmbeddings();

    const count = await seedIdentity(store, embeddings);

    expect(count).toBe(11); // 11 IDENTITY_CHUNKS in the source
    expect(store.queryExec).toHaveBeenCalled();
    expect(embeddings.embed).toHaveBeenCalledTimes(11);
  });

  it("skips seeding when already fully seeded", async () => {
    const store = mockStore(11); // already has 11 chunks
    const embeddings = mockEmbeddings();

    const count = await seedIdentity(store, embeddings);

    expect(count).toBe(0);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("re-seeds when count is stale (partial seeding)", async () => {
    const store = mockStore(5); // only 5 of 11
    const embeddings = mockEmbeddings();

    const count = await seedIdentity(store, embeddings);

    expect(count).toBe(11);
    // v0.7.93 append-only: was DELETE — now soft-deactivates prior chunks
    // via UPDATE active=false + archived_at + archive_reason so old version
    // chunks stay queryable for forensic audit.
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE identity_chunk SET"),
      expect.any(Object),
    );
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("active = false"),
      expect.any(Object),
    );
  });

  it("returns 0 when store unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    expect(await seedIdentity(store, mockEmbeddings())).toBe(0);
  });

  it("returns 0 when embeddings unavailable", async () => {
    expect(await seedIdentity(mockStore(), mockEmbeddings(false))).toBe(0);
  });
});

// ── WAKEUP.md file operations ──

describe("WAKEUP.md operations", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("findWakeupFile returns path when WAKEUP.md exists", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "WAKEUP.md"), "# My Agent\nBe friendly.");
    expect(findWakeupFile(dir)).toBe(join(dir, "WAKEUP.md"));
  });

  it("findWakeupFile returns null when no WAKEUP.md", () => {
    dir = makeTmpDir();
    expect(findWakeupFile(dir)).toBeNull();
  });

  it("readWakeupFile returns trimmed content", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "WAKEUP.md"), "  # My Agent\nBe friendly.  \n");
    const content = readWakeupFile(join(dir, "WAKEUP.md"));
    expect(content).toBe("# My Agent\nBe friendly.");
  });

  it("deleteWakeupFile removes the file", () => {
    dir = makeTmpDir();
    const path = join(dir, "WAKEUP.md");
    writeFileSync(path, "content");
    deleteWakeupFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("deleteWakeupFile does not throw on missing file", () => {
    dir = makeTmpDir();
    expect(() => deleteWakeupFile(join(dir, "nonexistent.md"))).not.toThrow();
  });
});

// ── hasUserIdentity ──

describe("hasUserIdentity", () => {
  it("returns false when no user identity exists", async () => {
    const store = mockStore();
    store.queryFirst = vi.fn(async () => [{ count: 0 }]);
    expect(await hasUserIdentity(store)).toBe(false);
  });

  it("returns true when user identity exists", async () => {
    const store = mockStore();
    store.queryFirst = vi.fn(async () => [{ count: 3 }]);
    expect(await hasUserIdentity(store)).toBe(true);
  });

  it("returns true when store unavailable (fail-safe)", async () => {
    const store = { isAvailable: () => false } as any;
    expect(await hasUserIdentity(store)).toBe(true);
  });
});

// ── saveUserIdentity ──

describe("saveUserIdentity", () => {
  it("saves identity chunks with embeddings", async () => {
    const store = mockStore();
    const embeddings = mockEmbeddings();

    const count = await saveUserIdentity(
      ["I am a friendly coding assistant", "I prefer TypeScript"],
      store, embeddings,
    );

    expect(count).toBe(2);
    expect(embeddings.embed).toHaveBeenCalledTimes(2);
    // v0.7.93 append-only: was DELETE — now soft-deactivates prior user
    // identity via UPDATE active=false + archived_at + archive_reason.
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE identity_chunk SET"),
      expect.any(Object),
    );
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("user_identity_replaced"),
      expect.any(Object),
    );
  });

  it("returns 0 for empty chunks array", async () => {
    expect(await saveUserIdentity([], mockStore(), mockEmbeddings())).toBe(0);
  });

  it("skips empty/whitespace chunks", async () => {
    const store = mockStore();
    const count = await saveUserIdentity(["valid", "  ", "", "also valid"], store, mockEmbeddings());
    expect(count).toBe(2);
  });

  it("returns 0 when store or embeddings unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    expect(await saveUserIdentity(["test"], store, mockEmbeddings())).toBe(0);
    expect(await saveUserIdentity(["test"], mockStore(), mockEmbeddings(false))).toBe(0);
  });
});

// ── buildWakeupPrompt ──

describe("buildWakeupPrompt", () => {
  it("returns system addition and first message", () => {
    const result = buildWakeupPrompt("You are a sarcastic engineer who loves Rust.");

    expect(result.systemAddition).toContain("FIRST RUN");
    expect(result.systemAddition).toContain("IDENTITY ESTABLISHMENT");
    expect(result.firstMessage).toContain("WAKEUP.md");
    expect(result.firstMessage).toContain("sarcastic engineer");
    expect(result.firstMessage).toContain("Introduce yourself");
  });

  it("includes the full wakeup content in firstMessage", () => {
    const content = "# Agent Config\n\nBe concise. No emojis. Use TypeScript.";
    const result = buildWakeupPrompt(content);
    expect(result.firstMessage).toContain(content);
  });
});

// ── seedCognitiveBootstrap ──

describe("seedCognitiveBootstrap", () => {
  it("seeds core memory and identity chunks on first run", async () => {
    const store = mockStore(0, false);
    const embeddings = mockEmbeddings();

    const result = await seedCognitiveBootstrap(store, embeddings);

    expect(result.coreSeeded).toBe(6); // 6 CORE_ENTRIES (added AUTO-SEAL CONTRACT in 0.4.0)
    expect(result.identitySeeded).toBe(6); // 6 IDENTITY_CHUNKS in cognitive-bootstrap
    expect(store.createCoreMemory).toHaveBeenCalledTimes(6);
  });

  it("skips core memory when already seeded", async () => {
    const store = mockStore(0, true); // coreHasBootstrap = true
    const embeddings = mockEmbeddings();

    const result = await seedCognitiveBootstrap(store, embeddings);

    expect(result.coreSeeded).toBe(0);
    expect(store.createCoreMemory).not.toHaveBeenCalled();
  });

  it("skips identity chunks when already fully seeded", async () => {
    const store = mockStore(6, false); // 6 identity chunks already exist
    const embeddings = mockEmbeddings();

    const result = await seedCognitiveBootstrap(store, embeddings);

    expect(result.identitySeeded).toBe(0);
  });

  it("skips identity seeding when embeddings unavailable", async () => {
    const store = mockStore(0, false);
    const embeddings = mockEmbeddings(false);

    const result = await seedCognitiveBootstrap(store, embeddings);

    expect(result.coreSeeded).toBe(6); // 6 core entries (doesn't need embeddings)
    expect(result.identitySeeded).toBe(0); // skipped
  });

  it("returns zeros when store unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;

    const result = await seedCognitiveBootstrap(store, mockEmbeddings());
    expect(result).toEqual({ identitySeeded: 0, coreSeeded: 0 });
  });
});
