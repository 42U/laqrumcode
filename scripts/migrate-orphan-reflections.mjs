#!/usr/bin/env node
/**
 * One-shot migration: heal orphaned `reflection` rows that have no
 * `->reflects_on` edge.
 *
 * Symptom: Stage 1+2 audit found 17 of 60 reflection rows on this dev install
 * with `array::len(->reflects_on) = 0`. Root cause was
 * `src/daemon/heuristic-drain.ts:157` discarding the returned record id and
 * never calling `store.relate(id, "reflects_on", item.surreal_session_id)` —
 * the parallel writer at `src/tools/pending-work.ts:commitReflection` does so
 * correctly. The code-side fix lands in Stage 3 Phase 1. This script heals
 * the historical orphans the bug already produced.
 *
 * For each orphan reflection row, try to resolve the parent session via
 *   session WHERE kc_session_id = $reflection.session_id
 * and CREATE the missing `reflects_on` edge. If no session row matches, the
 * reflection cannot be properly anchored — DELETE it (the row is unrecoverable
 * provenance-less data). Two-pass: SELECT all orphans, then per-orphan resolve
 * or delete.
 *
 * Usage (from repo root):
 *   node scripts/migrate-orphan-reflections.mjs            # dry-run
 *   node scripts/migrate-orphan-reflections.mjs --apply    # actually mutate
 *   node scripts/migrate-orphan-reflections.mjs --verbose
 *
 * Idempotent: a second --apply pass finds zero orphans and is a no-op.
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

async function qFirst(db, sql, bindings) {
  const result = await db.query(sql, bindings);
  const rows = Array.isArray(result) ? result[result.length - 1] : result;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function qExec(db, sql, bindings) {
  await db.query(sql, bindings);
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[migrate-orphan-reflections] FATAL: no Surreal URL resolvable from config.");
    process.exit(2);
  }
  const { url, ns, db: dbName, user, pass } = config.surreal;

  const db = new Surreal();
  await db.connect(url, {
    namespace: ns,
    database: dbName,
    authentication: { username: user, password: pass },
  });

  try {
    await db.query("RETURN 1;");
  } catch (e) {
    console.error(`[migrate-orphan-reflections] FATAL: connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[migrate-orphan-reflections] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[migrate-orphan-reflections] surreal ${url}  ns=${ns}  db=${dbName}`);

  // Total reflection rows (sanity check).
  const totalRows = await qFirst(db, "SELECT count() AS n FROM reflection GROUP ALL");
  const total = Number(totalRows?.[0]?.n ?? 0);
  console.log(`[migrate-orphan-reflections] reflection rows total: ${total}`);

  // Orphans = reflection rows whose outbound reflects_on edge array is empty.
  // The traversal `->reflects_on` returns the edge records; len=0 means none.
  const orphans = await qFirst(
    db,
    `SELECT id, session_id, text, created_at FROM reflection
       WHERE array::len(->reflects_on) = 0
       ORDER BY created_at ASC`,
  );
  console.log(`[migrate-orphan-reflections] orphan rows (no reflects_on): ${orphans.length}`);
  if (orphans.length === 0) {
    console.log("[migrate-orphan-reflections] nothing to do.");
    await db.close().catch(() => {});
    process.exit(0);
  }

  let healed = 0;
  let deleted = 0;
  let errors = 0;

  for (const orphan of orphans) {
    const reflectionId = String(orphan.id);
    const sessionIdStr = orphan.session_id ?? null;

    if (!sessionIdStr) {
      // No session_id at all — unrecoverable, slate for delete.
      if (VERBOSE) console.log(`  ${reflectionId}: no session_id, ${APPLY ? "deleting" : "would delete"}`);
      if (APPLY) {
        try {
          await qExec(db, `DELETE ${reflectionId}`);
          deleted++;
        } catch (e) {
          console.error(`  ${reflectionId}: DELETE failed: ${e?.message ?? e}`);
          errors++;
        }
      } else {
        deleted++;
      }
      continue;
    }

    // Resolve session by kc_session_id bridge field.
    const matches = await qFirst(
      db,
      `SELECT id FROM session WHERE kc_session_id = $sid LIMIT 1`,
      { sid: sessionIdStr },
    );
    const sessionRow = matches[0];

    if (!sessionRow?.id) {
      if (VERBOSE) console.log(`  ${reflectionId}: session_id=${sessionIdStr} not found, ${APPLY ? "deleting" : "would delete"}`);
      if (APPLY) {
        try {
          await qExec(db, `DELETE ${reflectionId}`);
          deleted++;
        } catch (e) {
          console.error(`  ${reflectionId}: DELETE failed: ${e?.message ?? e}`);
          errors++;
        }
      } else {
        deleted++;
      }
      continue;
    }

    const sessionId = String(sessionRow.id);
    if (VERBOSE) console.log(`  ${reflectionId} -> ${sessionId} (kc_session_id=${sessionIdStr}) ${APPLY ? "relating" : "would relate"}`);
    if (APPLY) {
      try {
        // RELATE syntax mirrors what SurrealStore.relate emits internally.
        // Direct interpolation safe: both ids came from prior SELECT results
        // (typed Thing values from the surrealdb client), not from user input.
        await db.query(`RELATE ${reflectionId}->reflects_on->${sessionId}`);
        healed++;
      } catch (e) {
        console.error(`  ${reflectionId}: RELATE failed: ${e?.message ?? e}`);
        errors++;
      }
    } else {
      healed++;
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`  orphans found: ${orphans.length}`);
  console.log(`  ${APPLY ? "healed" : "would heal"}: ${healed}`);
  console.log(`  ${APPLY ? "deleted" : "would delete"}: ${deleted}`);
  if (errors > 0) console.log(`  errors: ${errors}`);
  if (!APPLY) console.log("\n(dry-run — re-run with --apply to actually mutate)");

  await db.close().catch(() => {});
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[migrate-orphan-reflections] FATAL:", e);
  process.exit(1);
});
