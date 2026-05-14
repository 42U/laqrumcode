#!/usr/bin/env node
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";

const config = parsePluginConfig({});
const store = new SurrealStore(config.surreal);
await store.initialize();

const wt = process.argv[2] ?? "causal_graduate";

const distinct = await store.queryFirst(
  `SELECT count() AS n FROM (
     SELECT session_id FROM pending_work
     WHERE work_type = $wt AND status = 'pending'
     GROUP BY session_id
   ) GROUP ALL`,
  { wt },
);

const total = await store.queryFirst(
  `SELECT count() AS n FROM pending_work
   WHERE work_type = $wt AND status = 'pending' GROUP ALL`,
  { wt },
);

const top = await store.queryFirst(
  `SELECT session_id, count() AS n FROM pending_work
   WHERE work_type = $wt AND status = 'pending'
   GROUP BY session_id ORDER BY n DESC LIMIT 10`,
  { wt },
);

const timeRange = await store.queryFirst(
  `SELECT math::min(created_at) AS oldest, math::max(created_at) AS newest
   FROM pending_work
   WHERE work_type = $wt AND status = 'pending' GROUP ALL`,
  { wt },
);

const sessionCheck = await store.queryFirst(
  `SELECT count() AS n FROM session WHERE cleanup_completed != true GROUP ALL`,
);

const orphansSample = await store.queryFirst(
  `SELECT id, kc_session_id, started_at, cleanup_completed
   FROM session WHERE cleanup_completed != true
   ORDER BY started_at DESC LIMIT 5`,
);

console.log(`\n=== ${wt} pending diagnostic ===`);
console.log(`Total pending: ${total[0]?.n}`);
console.log(`Distinct session_id: ${distinct[0]?.n}`);
console.log(`Oldest: ${timeRange[0]?.oldest}`);
console.log(`Newest: ${timeRange[0]?.newest}`);
console.log(`\nTop session_id by count:`);
for (const r of top) console.log(`  ${r.n}x  ${r.session_id}`);
console.log(`\nOrphaned sessions (cleanup_completed != true): ${sessionCheck[0]?.n}`);
console.log(`Sample orphans:`);
for (const o of orphansSample) console.log(`  ${o.id}  kc=${o.kc_session_id}  started=${o.started_at}`);

process.exit(0);
