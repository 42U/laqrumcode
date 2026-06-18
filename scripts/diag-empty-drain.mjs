#!/usr/bin/env node
// One-off diagnostic: reconcile the SessionStart "DRAIN NOW" count against
// what fetch_pending_work would ACTUALLY hand to a drain agent.
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";

const config = parsePluginConfig({});
const store = new SurrealStore(config.surreal);
await store.initialize();

const q = async (sql, vars) => (await store.queryFirst(sql, vars ?? {}));

console.log("\n=== 1. The hook/health clause: status='pending' AND active ===");
const claimable = await q(
  `SELECT count() AS n FROM pending_work WHERE status = "pending" AND (active = true OR active IS NONE) GROUP ALL`,
);
console.log(`claimable pending+active: ${claimable[0]?.n ?? 0}`);

console.log("\n=== 2. Claimable pending+active BY work_type ===");
const byType = await q(
  `SELECT work_type, count() AS n FROM pending_work
   WHERE status = "pending" AND (active = true OR active IS NONE)
   GROUP BY work_type ORDER BY n DESC`,
);
for (const r of byType) console.log(`  ${String(r.n).padStart(5)}  ${r.work_type}`);
if (byType.length === 0) console.log("  (none)");

console.log("\n=== 3. ALL pending_work by status × active ===");
const byStatus = await q(
  `SELECT status, active, count() AS n FROM pending_work GROUP BY status, active ORDER BY status`,
);
for (const r of byStatus) console.log(`  ${String(r.n).padStart(5)}  status=${r.status}  active=${r.active}`);

console.log("\n=== 4. Would self-completing types actually be EMPTY right now? ===");
// causal_graduate eligibility (builder line 353-358)
const chainGroups = await q(
  `SELECT chain_type, count() AS cnt FROM causal_chain
   WHERE success = true AND confidence >= 0.7 AND graduated_at IS NONE
   GROUP BY chain_type`,
);
const eligibleChains = chainGroups.filter(g => g.cnt >= 3);
console.log(`  causal_graduate: ${eligibleChains.length} eligible chain-groups (cnt>=3, ungraduated)` +
  ` -> ${eligibleChains.length === 0 ? "ALL causal_graduate rows self-complete EMPTY" : "has real work"}`);

// soul_evolve eligibility (builder line 403-417)
const soul = await q(`SELECT updated_at FROM soul ORDER BY updated_at DESC LIMIT 1`);
if (!soul[0]) {
  console.log(`  soul_evolve: no soul exists -> ALL soul_evolve rows self-complete EMPTY`);
} else {
  const since = soul[0].updated_at;
  const newRefl = await q(`SELECT count() AS n FROM reflection WHERE created_at > $since GROUP ALL`, { since });
  const newChain = await q(`SELECT count() AS n FROM causal_chain WHERE created_at > $since GROUP ALL`, { since });
  const newMono = await q(`SELECT count() AS n FROM monologue WHERE timestamp > $since GROUP ALL`, { since });
  const r = newRefl[0]?.n ?? 0, c = newChain[0]?.n ?? 0, m = newMono[0]?.n ?? 0;
  console.log(`  soul_evolve: since soul.updated_at=${since} -> reflections=${r} chains=${c} monologues=${m}` +
    ` -> ${(r + c + m) === 0 ? "ALL soul_evolve rows self-complete EMPTY" : "has real work"}`);
}

console.log("\n=== 5. Recently completed (last 30 min) by work_type — catch a just-run drain ===");
const recentDone = await q(
  `SELECT work_type, count() AS n FROM pending_work
   WHERE status = "completed" AND completed_at > time::now() - 30m
   GROUP BY work_type ORDER BY n DESC`,
);
for (const r of recentDone) console.log(`  ${String(r.n).padStart(5)}  ${r.work_type}`);
if (recentDone.length === 0) console.log("  (none in last 30 min)");

console.log("\n=== 6. Oldest claimable pending+active row (purge-risk check) ===");
const oldest = await q(
  `SELECT work_type, created_at FROM pending_work
   WHERE status = "pending" AND (active = true OR active IS NONE)
   ORDER BY created_at ASC LIMIT 3`,
);
for (const r of oldest) console.log(`  ${r.created_at}  ${r.work_type}`);
if (oldest.length === 0) console.log("  (none)");

process.exit(0);
