#!/usr/bin/env node
/**
 * One-off destructive reset of soul + graduation state.
 *
 * Why this exists
 * ---------------
 *   The user wants the current `soul:laqrumbrain` singleton, all
 *   `maturity_stage` rows, and any `graduation_event` rows removed so
 *   graduation can occur again naturally. They consider the current soul
 *   a "false start." This script implements that reset.
 *
 * Preservation
 * ------------
 *   Before deleting, the script reads the soul row content (everything in
 *   the row, including emotional_dimensions, self_observations, earned_values,
 *   working_style, revisions) and the full set of maturity_stage and
 *   graduation_event rows. It writes the entire bundle as a `memory` row
 *   with `category='soul_archive'` so the prior identity is recoverable.
 *   The new soul, when it eventually graduates, can recall this archive.
 *
 * Verification afterwards
 * -----------------------
 *   - SELECT count() FROM soul GROUP ALL                 -> 0
 *   - SELECT count() FROM maturity_stage GROUP ALL       -> 0
 *   - SELECT count() FROM graduation_event GROUP ALL     -> 0
 *   - The archive memory row exists with category='soul_archive'.
 *   - hasSoul() returns false (verified by the same SELECT the function
 *     itself runs: SELECT id FROM soul:laqrumbrain).
 *
 * Safety
 * ------
 *   - Dry-run by default. --apply to actually mutate.
 *   - Uses the raw `surrealdb` client (same pattern as predeploy-dedup.mjs
 *     and migrate-concept-superseded-by.mjs) so it does NOT trigger
 *     runSchema() on bootstrap.
 *   - Snapshots data BEFORE any destructive op so the archive is complete
 *     even if a later step fails.
 *   - Archive memory row is created first; deletion only proceeds if the
 *     archive write succeeds.
 *
 * Usage
 * -----
 *   node scripts/reset-soul-graduation.mjs            # dry-run
 *   node scripts/reset-soul-graduation.mjs --apply    # execute
 *   node scripts/reset-soul-graduation.mjs --verbose
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

const RESET_TIMESTAMP = "2026-05-13";
const RESET_REASON = `user-requested reset ${RESET_TIMESTAMP} - false-start cleanup`;

async function qFirst(db, sql, bindings) {
  const r = await db.query(sql, bindings);
  const rows = Array.isArray(r) ? r[r.length - 1] : r;
  return (Array.isArray(rows) ? rows : []).filter(Boolean);
}

async function tableCount(db, name) {
  const rows = await qFirst(db, `SELECT count() AS n FROM ${name} GROUP ALL`);
  return Number(rows?.[0]?.n ?? 0);
}

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[reset-soul] FATAL: no Surreal URL resolvable from config.");
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
    console.error(`[reset-soul] FATAL: SurrealDB connectivity check failed: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  console.log(`[reset-soul] APPLY=${APPLY}  VERBOSE=${VERBOSE}`);
  console.log(`[reset-soul] surreal ${url}  ns=${ns}  db=${dbName}`);

  // ── Step 1: snapshot everything BEFORE any mutation. ──
  console.log(`\n[reset-soul] === SNAPSHOT (pre-delete) ===`);

  const soulRows = await qFirst(db, `SELECT * FROM soul`);
  const maturityRows = await qFirst(db, `SELECT * FROM maturity_stage`);
  const graduationRows = await qFirst(db, `SELECT * FROM graduation_event`);

  const soulCountBefore = soulRows.length;
  const maturityCountBefore = maturityRows.length;
  const graduationCountBefore = graduationRows.length;

  console.log(`  soul rows:            ${soulCountBefore}`);
  console.log(`  maturity_stage rows:  ${maturityCountBefore}`);
  console.log(`  graduation_event rows: ${graduationCountBefore}`);

  if (soulCountBefore === 0 && maturityCountBefore === 0 && graduationCountBefore === 0) {
    console.log(`\n[reset-soul] nothing to reset — all three tables already empty. Exiting.`);
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Step 2: build the archive text. ──
  // Stringify the entire snapshot as JSON so it's human-readable and
  // machine-parseable from the memory table without needing schema. We
  // wrap it in a structured envelope so the next soul can find it by
  // searching for "soul_archive" or the reset reason string.
  const archivePayload = {
    archived_at: new Date().toISOString(),
    reason: RESET_REASON,
    soul: soulRows[0] ?? null,
    soul_all: soulRows,                  // defensive: in case there's somehow >1
    maturity_stage: maturityRows,
    graduation_event: graduationRows,
    counts: {
      soul: soulCountBefore,
      maturity_stage: maturityCountBefore,
      graduation_event: graduationCountBefore,
    },
  };
  const archiveText = [
    `SOUL ARCHIVE — ${RESET_REASON}`,
    ``,
    `This is a snapshot of the prior soul:laqrumbrain singleton + all maturity_stage and`,
    `graduation_event rows, captured before user-requested reset of the graduation state.`,
    `The next soul, when it eventually graduates, can recall this archive to understand`,
    `what the prior identity looked like.`,
    ``,
    `Archived at: ${archivePayload.archived_at}`,
    `Counts: soul=${soulCountBefore}, maturity_stage=${maturityCountBefore}, graduation_event=${graduationCountBefore}`,
    ``,
    `--- FULL SNAPSHOT (JSON) ---`,
    JSON.stringify(archivePayload, null, 2),
  ].join("\n");

  if (VERBOSE) {
    console.log(`\n[reset-soul] archive text preview (first 800 chars):`);
    console.log(archiveText.slice(0, 800));
    if (archiveText.length > 800) console.log(`  …and ${archiveText.length - 800} more chars`);
  }

  if (!APPLY) {
    console.log(`\n=== SUMMARY (dry-run) ===`);
    console.log(`  would archive: 1 memory row (category=soul_archive, ${archiveText.length} chars of text)`);
    console.log(`  would delete:  ${soulCountBefore} soul row(s)`);
    console.log(`  would delete:  ${maturityCountBefore} maturity_stage row(s)`);
    console.log(`  would delete:  ${graduationCountBefore} graduation_event row(s)`);
    console.log(`\n(dry-run — re-run with --apply to actually reset)`);
    await db.close().catch(() => {});
    process.exit(0);
  }

  // ── Steps 3-4 (atomic): archive CREATE + three DELETEs in a single
  // BEGIN/COMMIT TRANSACTION. The previous shape ran them as four
  // independent statements — if any DELETE failed mid-sequence we'd end up
  // with an archive row whose subject rows still existed (or worse, partial
  // deletes with no archive row). With one transaction, either everything
  // commits (archive present, all three tables empty) or nothing does
  // (archive write rolled back, original rows intact).
  //
  // RETURN at the end of the COMMIT block surfaces the created memory id
  // back to the client; SurrealDB's transaction semantics return the result
  // of the last RETURN statement in the block.
  console.log(`\n[reset-soul] === ARCHIVE + DELETE (single transaction) ===`);
  let archiveMemoryId = null;
  let soulDeleted = 0, maturityDeleted = 0, graduationDeleted = 0;
  try {
    const txnSql = [
      `BEGIN TRANSACTION;`,
      // Step A: write archive memory row, capture its id in a transaction var.
      `LET $archive = (CREATE memory CONTENT $data RETURN id);`,
      // Step B: destructive deletes — if any of these fail the entire
      // transaction (including the archive CREATE) rolls back.
      `DELETE soul;`,
      `DELETE maturity_stage;`,
      `DELETE graduation_event;`,
      // Step C: surface the archive id so the client can verify after commit.
      `RETURN $archive;`,
      `COMMIT TRANSACTION;`,
    ].join("\n");

    const txnRes = await db.query(txnSql, {
      data: {
        text: archiveText,
        category: "soul_archive",
        importance: 0.9,        // high — recoverable identity history
        confidence: 1.0,
        source: "scripts/reset-soul-graduation.mjs",
        status: "active",
      },
    });

    // The result array from db.query contains one entry per top-level
    // statement. The RETURN $archive entry is the one we want. db.query
    // shape can be [statementResults] or [[result]] depending on client
    // version — try both shapes defensively.
    const flat = Array.isArray(txnRes) ? txnRes.flat(2).filter(Boolean) : [];
    for (const item of flat) {
      if (item && typeof item === "object" && "id" in item) {
        archiveMemoryId = String(item.id);
        break;
      }
    }
    if (!archiveMemoryId) {
      throw new Error(`transaction did not surface archive id (got: ${JSON.stringify(txnRes).slice(0, 400)})`);
    }
    soulDeleted = soulCountBefore;
    maturityDeleted = maturityCountBefore;
    graduationDeleted = graduationCountBefore;

    console.log(`  archive memory_id:          ${archiveMemoryId}`);
    console.log(`  DELETE soul                 -> ${soulDeleted} row(s) removed`);
    console.log(`  DELETE maturity_stage       -> ${maturityDeleted} row(s) removed`);
    console.log(`  DELETE graduation_event     -> ${graduationDeleted} row(s) removed`);
  } catch (e) {
    console.error(`[reset-soul] FATAL: transaction rolled back — soul/maturity/graduation rows preserved, no archive written.`);
    console.error(`  error: ${e?.message ?? e}`);
    await db.close().catch(() => {});
    process.exit(2);
  }

  // ── Step 5: verification pass. ──
  console.log(`\n[reset-soul] === VERIFICATION ===`);
  const soulCountAfter = await tableCount(db, "soul");
  const maturityCountAfter = await tableCount(db, "maturity_stage");
  const graduationCountAfter = await tableCount(db, "graduation_event");

  // hasSoul() runs: SELECT id FROM soul:laqrumbrain. Replicate exactly.
  const hasSoulRows = await qFirst(db, `SELECT id FROM soul:laqrumbrain`);
  const hasSoulNow = hasSoulRows.length > 0;

  // Confirm the archive row still exists.
  const archiveCheck = await qFirst(
    db,
    `SELECT id, category, string::len(text) AS text_len FROM memory WHERE id = $id`,
    { id: archiveMemoryId },
  );
  const archiveExists = archiveCheck.length > 0;
  const archiveCategory = String(archiveCheck[0]?.category ?? "");
  const archiveTextLen = Number(archiveCheck[0]?.text_len ?? 0);

  console.log(`  soul row count:             ${soulCountAfter}  (expected 0)`);
  console.log(`  maturity_stage row count:   ${maturityCountAfter}  (expected 0)`);
  console.log(`  graduation_event row count: ${graduationCountAfter}  (expected 0)`);
  console.log(`  hasSoul() would return:     ${hasSoulNow}  (expected false)`);
  console.log(`  archive row exists:         ${archiveExists}  (expected true)`);
  console.log(`  archive category:           ${archiveCategory}  (expected soul_archive)`);
  console.log(`  archive text length:        ${archiveTextLen} chars`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`  archive memory_id:           ${archiveMemoryId}`);
  console.log(`  soul:            before=${soulCountBefore}  after=${soulCountAfter}`);
  console.log(`  maturity_stage:  before=${maturityCountBefore}  after=${maturityCountAfter}`);
  console.log(`  graduation_event: before=${graduationCountBefore}  after=${graduationCountAfter}`);
  console.log(`  hasSoul() now returns:       ${hasSoulNow}`);

  const allOk =
    soulCountAfter === 0 &&
    maturityCountAfter === 0 &&
    graduationCountAfter === 0 &&
    hasSoulNow === false &&
    archiveExists === true &&
    archiveCategory === "soul_archive";

  await db.close().catch(() => {});
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("[reset-soul] FATAL:", e);
  process.exit(1);
});
