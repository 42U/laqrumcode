/**
 * Tests for skills.ts — skill extraction, retrieval, formatting,
 * outcome tracking, supersession, and causal graduation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findRelevantSkills,
  formatSkillContext,
  recordSkillOutcome,
  supersedeOldSkills,
  type Skill,
} from "../src/engine/skills.js";

// ── Mock helpers ──

function mockStore() {
  return {
    isAvailable: () => true,
    getSessionTurns: vi.fn(async () => [
      { role: "user", text: "fix the bug in auth.ts" },
      { role: "assistant", text: "I'll look at it" },
      { role: "user", text: "it crashes on login" },
      { role: "assistant", text: "Found the issue — null check missing" },
      { role: "user", text: "great, fix it" },
    ]),
    queryFirst: vi.fn(async () => [{ id: "skill:new1" }]),
    queryExec: vi.fn(async () => {}),
    relate: vi.fn(async () => {}),
  } as any;
}

function makeSampleSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill:s1",
    name: "Debug auth flow",
    description: "Step-by-step auth debugging",
    preconditions: "failing login test",
    steps: [
      { tool: "bash", description: "Run test suite" },
      { tool: "read", description: "Read error output" },
      { tool: "edit", description: "Fix the issue" },
    ],
    postconditions: "all tests pass",
    successCount: 5,
    failureCount: 1,
    avgDurationMs: 30000,
    confidence: 0.9,
    active: true,
    score: 0.85,
    ...overrides,
  };
}

// ── findRelevantSkills ──

describe("findRelevantSkills", () => {
  it("returns skills above 0.4 similarity threshold", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([
      { id: "skill:s1", name: "Deploy", description: "deploy flow", steps: [], score: 0.75, success_count: 3, failure_count: 0 },
      { id: "skill:s2", name: "Low match", description: "irrelevant", steps: [], score: 0.2, success_count: 1, failure_count: 0 },
    ]);

    const queryVec = new Array(1024).fill(0.1);
    const skills = await findRelevantSkills(queryVec, 5, store);

    expect(skills).toHaveLength(1); // only s1 above 0.4
    expect(skills[0].name).toBe("Deploy");
  });

  it("returns empty when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    const skills = await findRelevantSkills(new Array(1024).fill(0), 3, store);
    expect(skills).toEqual([]);
  });

  it("returns empty when store is undefined", async () => {
    const skills = await findRelevantSkills(new Array(1024).fill(0), 3, undefined);
    expect(skills).toEqual([]);
  });
});

// ── formatSkillContext ──

describe("formatSkillContext", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillContext([])).toBe("");
  });

  it("formats skill with success rate", () => {
    const result = formatSkillContext([makeSampleSkill()]);
    expect(result).toContain("<skill_context>");
    expect(result).toContain("Debug auth flow");
    expect(result).toContain("5/6 successful");
    expect(result).toContain("[bash] Run test suite");
  });

  it("shows 'new' for skills with no outcomes", () => {
    const result = formatSkillContext([makeSampleSkill({ successCount: 0, failureCount: 0 })]);
    expect(result).toContain("(new)");
  });

  it("includes preconditions and postconditions", () => {
    const result = formatSkillContext([makeSampleSkill()]);
    expect(result).toContain("Pre: failing login test");
    expect(result).toContain("Post: all tests pass");
  });

  it("numbers steps sequentially", () => {
    const result = formatSkillContext([makeSampleSkill()]);
    expect(result).toContain("1. [bash]");
    expect(result).toContain("2. [read]");
    expect(result).toContain("3. [edit]");
  });
});

// ── recordSkillOutcome ──

describe("recordSkillOutcome", () => {
  it("increments success_count on success", async () => {
    const store = mockStore();
    await recordSkillOutcome("skill:s1", true, 5000, store);
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("success_count"),
      { dur: 5000 },
    );
  });

  it("increments failure_count on failure", async () => {
    const store = mockStore();
    await recordSkillOutcome("skill:s1", false, 3000, store);
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("failure_count"),
      { dur: 3000 },
    );
  });

  it("rejects invalid skill IDs", async () => {
    const store = mockStore();
    await recordSkillOutcome("not-a-record-id", true, 1000, store);
    expect(store.queryExec).not.toHaveBeenCalled();
  });

  it("no-ops when store is unavailable", async () => {
    const store = mockStore();
    store.isAvailable = () => false;
    await recordSkillOutcome("skill:s1", true, 1000, store);
    expect(store.queryExec).not.toHaveBeenCalled();
  });
});

// ── supersedeOldSkills ──

describe("supersedeOldSkills", () => {
  it("deactivates same-named skills with similarity >= 0.82", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([
      { id: "skill:old1", score: 0.90 },
      { id: "skill:old2", score: 0.50 },
    ]);

    await supersedeOldSkills("skill:new1", "my-skill", new Array(1024).fill(0.1), store);

    // Only old1 (0.90 >= 0.82) should be deactivated
    expect(store.queryExec).toHaveBeenCalledTimes(1);
    // Phase 0 fix: UPDATE now uses direct interpolation of the record id
    // instead of parameterized `$id` (which SurrealDB rejects for string params).
    // The `id` binding is gone; the id is interpolated into the SQL itself.
    expect(store.queryExec).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE skill:old1 SET active = false"),
      expect.objectContaining({ newId: "skill:new1" }),
    );
  });

  it("no-ops with empty embedding", async () => {
    const store = mockStore();
    await supersedeOldSkills("skill:new1", "my-skill", [], store);
    expect(store.queryFirst).not.toHaveBeenCalled();
  });

  // Regression test for the 2026-05-17 bug where supersedeOldSkills was
  // matching purely on cosine similarity and was nuking unrelated skills
  // (dockex-docker-build wrongly deactivated kongcode-health, extract-pdf-gems,
  // kongcode-backup-semantic). The fix requires name equality.
  it("scopes the candidate query to name equality", async () => {
    const store = mockStore();
    store.queryFirst.mockResolvedValue([]);

    await supersedeOldSkills("skill:new1", "my-skill", new Array(1024).fill(0.1), store);

    // The SELECT must include `name = $newName` and the bindings must carry
    // the newName so different-named skills cannot land in the candidate set.
    expect(store.queryFirst).toHaveBeenCalledTimes(1);
    const [sql, bindings] = store.queryFirst.mock.calls[0]!;
    expect(sql).toMatch(/name\s*=\s*\$newName/);
    expect(bindings).toMatchObject({ newName: "my-skill", sid: "skill:new1" });
  });

  it("no-ops when newName is empty", async () => {
    const store = mockStore();
    await supersedeOldSkills("skill:new1", "", new Array(1024).fill(0.1), store);
    expect(store.queryFirst).not.toHaveBeenCalled();
  });
});

