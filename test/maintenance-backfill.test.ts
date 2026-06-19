import { describe, it, expect, vi } from "vitest";
import type { GlobalPluginState } from "../src/engine/state.js";

/** Reach into the maintenance module's private backfill function. The export
 *  is a side-effect of how runBootstrapMaintenance is structured — it calls
 *  backfillSessionTurnCounts internally. We test through that public seam. */
async function importMaintenance() {
  return await import("../src/engine/maintenance.js");
}

describe("backfillSessionTurnCounts (via runBootstrapMaintenance)", () => {
  it("issues UPDATE keyed by kc_session_id, not raw record id", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests(); // 0.7.118 once-guard

    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      // Match the backfill SELECT
      if (sql.includes("FROM turn") && sql.includes("session_id IS NOT NONE")) {
        return [
          { session_id: "8nnp5wuuo89f51y9mugq", n: 5 },
          { session_id: "f03ce275-971c-423f-8f03-5fe966897a64", n: 3 },
        ];
      }
      return [];
    });

    const queryExec = vi.fn().mockResolvedValue(undefined);

    const fakeState: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => true,
        queryFirst,
        queryExec,
        // unused-but-referenced surface — stubbed to no-op
        runMemoryMaintenance: async () => {},
        archiveOldTurns: async () => {},
        consolidateMemories: async () => {},
        garbageCollectMemories: async () => {},
        garbageCollectConcepts: async () => {},
        purgeStalePendingWork: async () => {},
        purgeOldRetrievalOutcomes: async () => 0,
      } as any,
      embeddings: { embed: async () => [] } as any,
      config: {
        thresholds: { acanTrainingThreshold: 1 },
      } as any,
    };

    runBootstrapMaintenance(fakeState as GlobalPluginState);

    // The fire-and-forget Promise.all means we need to wait briefly for
    // the backfill UPDATE calls to land.
    await new Promise(r => setTimeout(r, 50));

    // The backfill should have called queryExec with kc_session_id-keyed UPDATEs
    const updateCalls = queryExec.mock.calls.filter(c =>
      typeof c[0] === "string" && c[0].includes("UPDATE session") && c[0].includes("kc_session_id"),
    );
    expect(updateCalls.length).toBeGreaterThan(0);

    // Verify the parameters use kc_session_id, NOT a raw record id interpolation
    for (const call of updateCalls) {
      const sql = call[0] as string;
      expect(sql).toContain("kc_session_id = $kc");
      expect(sql).not.toMatch(/UPDATE\s+[a-f0-9-]{36}/); // no raw UUID in target

      const params = call[1] as Record<string, unknown>;
      expect(params).toHaveProperty("kc");
      expect(params).toHaveProperty("n");
    }
  });

  it("skips backfill entirely when store is unavailable", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests(); // 0.7.118 once-guard

    const queryFirst = vi.fn();
    const queryExec = vi.fn();

    const fakeState: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => false,
        queryFirst,
        queryExec,
        runMemoryMaintenance: async () => {},
        archiveOldTurns: async () => {},
        consolidateMemories: async () => {},
        garbageCollectMemories: async () => {},
        garbageCollectConcepts: async () => {},
        purgeStalePendingWork: async () => {},
        purgeOldRetrievalOutcomes: async () => 0,
      } as any,
      embeddings: { embed: async () => [] } as any,
      config: { thresholds: { acanTrainingThreshold: 1 } } as any,
    };

    runBootstrapMaintenance(fakeState as GlobalPluginState);
    await new Promise(r => setTimeout(r, 50));

    // No queries should have been issued
    expect(queryFirst).not.toHaveBeenCalled();
    expect(queryExec).not.toHaveBeenCalled();
  });

  it("guards UPDATE against non-zero turn_count rows (idempotent)", async () => {
    const { runBootstrapMaintenance, __resetBootstrapMaintenanceForTests } = await importMaintenance();
    __resetBootstrapMaintenanceForTests(); // 0.7.118 once-guard

    const queryFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM turn")) {
        return [{ session_id: "abc-123", n: 5 }];
      }
      return [];
    });

    const queryExec = vi.fn().mockResolvedValue(undefined);

    const fakeState: Partial<GlobalPluginState> = {
      store: {
        isAvailable: () => true,
        queryFirst,
        queryExec,
        runMemoryMaintenance: async () => {},
        archiveOldTurns: async () => {},
        consolidateMemories: async () => {},
        garbageCollectMemories: async () => {},
        garbageCollectConcepts: async () => {},
        purgeStalePendingWork: async () => {},
        purgeOldRetrievalOutcomes: async () => 0,
      } as any,
      embeddings: { embed: async () => [] } as any,
      config: { thresholds: { acanTrainingThreshold: 1 } } as any,
    };

    runBootstrapMaintenance(fakeState as GlobalPluginState);
    await new Promise(r => setTimeout(r, 50));

    const updateCall = queryExec.mock.calls.find(c =>
      typeof c[0] === "string" && c[0].includes("UPDATE session"),
    );
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const sql = updateCall[0] as string;
      expect(sql).toMatch(/turn_count\s*==\s*0\s*OR\s*turn_count\s*IS\s*NONE/);
    }
  });
});
