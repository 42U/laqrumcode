/**
 * G3 — graphExpand read-path liveness gate.
 *
 * graphExpand traverses ->(edges)->? and <-(edges)<-? from live seeds and
 * projected EVERY neighbor with NO liveness filter, so superseded/archived/
 * pruned (dead) nodes resurfaced as live retrieval hits — a recall back-door
 * (dead knowledge re-entering context). Verified live: one seed expanded to 11
 * neighbors, only 1 live. The fix appends a NONE-tolerant union-of-dead-markers
 * WHERE to both traversal statements. This guards against the filter being
 * dropped (the bug would silently return) — mocks queryBatch and asserts every
 * emitted traversal carries the liveness predicate.
 */
import { describe, it, expect, vi } from "vitest";
import { SurrealStore } from "../src/engine/surreal.js";

function storeCapturingStmts() {
  const store = new SurrealStore({ url: "ws://127.0.0.1:0/rpc", ns: "t", db: "t", user: "u", pass: "p" } as never);
  const stmts: string[] = [];
  (store as unknown as { queryBatch: (s: string[]) => Promise<unknown[][]> }).queryBatch = vi.fn(
    async (s: string[]) => { stmts.push(...s); return s.map(() => []); },
  );
  return { store, stmts };
}

describe("G3: graphExpand applies a liveness filter to traversed neighbors", () => {
  it("every traversal statement carries the dead-marker liveness WHERE", async () => {
    const { store, stmts } = storeCapturingStmts();
    await store.graphExpand(["concept:seed_abc"], [0.1, 0.2, 0.3], 1);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      // forward (->?) and reverse (<-?) traversals must BOTH be liveness-gated
      expect(s, `traversal missing liveness gate: ${s}`).toMatch(/superseded_at IS NONE/);
      expect(s).toMatch(/pruned_at IS NONE/);
      expect(s).toMatch(/active = true OR active IS NONE/);
      expect(s).toMatch(/status IS NONE OR status = 'active'/);
      // the WHERE must sit on the traversal target, before LIMIT
      expect(s).toMatch(/->\?\s+WHERE .*LIMIT|<-\?\s+WHERE .*LIMIT/s);
    }
  });

  it("does not over-filter by construction: the predicate only excludes present-and-dead values", () => {
    // Documents the NONE-tolerance contract verified live (a node type lacking a
    // marker field reads NONE and passes). If someone tightens a clause to drop
    // the `IS NONE` / `IS NONE OR` escape, live nodes of other tables would be
    // wrongly filtered — this asserts the escapes are present in each clause.
    const { store, stmts } = storeCapturingStmts();
    return store.graphExpand(["concept:seed_abc"], [0.1], 1).then(() => {
      const s = stmts[0];
      expect(s).toContain("active IS NONE");      // live rows without `active` pass
      expect(s).toContain("status IS NONE");      // live rows without `status` pass
      expect(s).toContain("superseded_at IS NONE"); // live rows without supersession pass
    });
  });
});
