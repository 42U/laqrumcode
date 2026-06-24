#!/usr/bin/env node
/**
 * laqrumcode forget — selective, REVERSIBLE forget for privacy / decluttering.
 *
 * Honors the D4 founder rule ("Nothing should be getting deleted"): NOTHING is
 * DELETEd. Matching content is SOFT-DEACTIVATED so it stops surfacing in
 * retrieval, the row + an audit annotation (archive_reason='forget:…') survive,
 * and `--undo` fully reactivates it.
 *
 * Per-table mechanism (matches the live retrieval candidate filters,
 * src/engine/surreal.ts): memory → status='archived'; concept → superseded_at
 * set. Both are excluded by the retrieval query the moment the flag is set, with
 * no change to the hot path.
 *
 * Selectors (v1):  --query <substr>   case-insensitive substring of the content
 *                  --before <date>    created_at older than an ISO date
 * (Project/session scoping via edges is a planned follow-up.)
 *
 * Safety: DRY-RUN by default — prints what WOULD be forgotten. Pass --commit to
 * apply. `--undo` reactivates everything previously forgotten by this tool.
 *
 *   node scripts/forget.mjs --query "api key"            # preview
 *   node scripts/forget.mjs --query "api key" --commit   # apply
 *   node scripts/forget.mjs --before 2026-01-01 --commit
 *   node scripts/forget.mjs --undo --commit              # reactivate all forgets
 *
 * Env: SURREAL_URL/USER/PASS/NS/DB (same defaults as backup-jsonl.mjs).
 */
import { Surreal } from "/home/zero/voidorigin/laqrumcode/node_modules/surrealdb/dist/surrealdb.mjs";

const URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const USER = process.env.SURREAL_USER || "root";
const PASS = process.env.SURREAL_PASS || "root";
const NS = process.env.SURREAL_NS || "laqrum";
const DB = process.env.SURREAL_DB || "memory";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const query = val("--query");
const before = val("--before");
const undo = has("--undo");
const commit = has("--commit");

function usage(msg) {
  if (msg) console.error(`forget: ${msg}\n`);
  console.error(`Usage:
  node scripts/forget.mjs --query "<substring>" [--commit]   soft-forget matching memories/concepts
  node scripts/forget.mjs --before <ISO-date>   [--commit]   soft-forget content older than a date
  node scripts/forget.mjs --undo                [--commit]   reactivate everything forgotten by this tool

  (no --commit = DRY RUN: preview only. Nothing is ever DELETEd — forget is reversible.)`);
  process.exit(msg ? 1 : 0);
}

if (has("--help") || has("-h")) usage();
const selectorCount = [query, before, undo].filter(Boolean).length;
if (selectorCount === 0) usage("specify one of --query, --before, or --undo");
if (selectorCount > 1) usage("specify exactly one of --query, --before, --undo");

// Normalize a bare YYYY-MM-DD to a full ISO instant.
function isoDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  return s;
}

const db = new Surreal();
await db.connect(URL);
await db.signin({ username: USER, password: PASS });
await db.use({ namespace: NS, database: DB });

const flat = (r) => (Array.isArray(r) ? r.flat() : []);
const count = async (sql, binds) => {
  const r = await db.query(`SELECT count() AS c FROM (${sql}) GROUP ALL`, binds);
  const rows = flat(r);
  return rows[0]?.c ?? 0;
};

try {
  if (undo) {
    // Reactivate everything this tool forgot (archive_reason starts with "forget:").
    const memWhere = `archive_reason != NONE AND string::starts_with(archive_reason, 'forget:')`;
    const memN = await count(`SELECT id FROM memory WHERE ${memWhere}`);
    const conN = await count(`SELECT id FROM concept WHERE ${memWhere}`);
    console.log(`forget --undo: ${memN} memor${memN === 1 ? "y" : "ies"} + ${conN} concept${conN === 1 ? "" : "s"} to reactivate`);
    if (!commit) { console.log(`(dry run — re-run with --commit to apply)`); }
    else {
      await db.query(`UPDATE memory SET status = 'active', archived_at = NONE, archive_reason = NONE WHERE ${memWhere}`);
      await db.query(`UPDATE concept SET superseded_at = NONE, archive_reason = NONE WHERE ${memWhere}`);
      console.log(`Reactivated ${memN + conN} item(s).`);
    }
  } else {
    // Build the per-table WHERE for the selector (only touch currently-live rows).
    let reason, memWhere, conWhere, binds;
    if (query) {
      const q = query.toLowerCase();
      reason = `forget:query=${query}`;
      binds = { q };
      memWhere = `string::contains(string::lowercase(text), $q) AND (status = 'active' OR status IS NONE)`;
      conWhere = `string::contains(string::lowercase(content), $q) AND superseded_at IS NONE`;
    } else {
      const iso = isoDate(before);
      reason = `forget:before=${before}`;
      binds = { iso };
      memWhere = `created_at < type::datetime($iso) AND (status = 'active' OR status IS NONE)`;
      conWhere = `created_at < type::datetime($iso) AND superseded_at IS NONE`;
    }

    const memN = await count(`SELECT id FROM memory WHERE ${memWhere}`, binds);
    const conN = await count(`SELECT id FROM concept WHERE ${conWhere}`, binds);
    console.log(`forget (${reason}):`);
    console.log(`  memory:  ${memN} match${memN === 1 ? "" : "es"}`);
    console.log(`  concept: ${conN} match${conN === 1 ? "" : "es"}`);

    // Show a few samples so the operator sees what they're forgetting.
    if (memN > 0) {
      const s = flat(await db.query(`SELECT VALUE text FROM memory WHERE ${memWhere} LIMIT 3`, binds));
      s.forEach((t) => console.log(`    mem: ${String(t).slice(0, 90).replace(/\n/g, " ")}`));
    }
    if (conN > 0) {
      const s = flat(await db.query(`SELECT VALUE content FROM concept WHERE ${conWhere} LIMIT 3`, binds));
      s.forEach((t) => console.log(`    con: ${String(t).slice(0, 90).replace(/\n/g, " ")}`));
    }

    if (!commit) {
      console.log(`\n(dry run — nothing changed. Re-run with --commit to soft-forget. Reverse later with --undo.)`);
    } else if (memN + conN === 0) {
      console.log(`\nNothing matched — nothing to do.`);
    } else {
      await db.query(`UPDATE memory SET status = 'archived', archived_at = time::now(), archive_reason = $r WHERE ${memWhere}`, { ...binds, r: reason });
      await db.query(`UPDATE concept SET superseded_at = time::now(), archive_reason = $r WHERE ${conWhere}`, { ...binds, r: reason });
      console.log(`\nSoft-forgot ${memN + conN} item(s) — they no longer surface in retrieval. Reverse with: node scripts/forget.mjs --undo --commit`);
    }
  }
} catch (e) {
  console.error("forget failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await db.close();
}
