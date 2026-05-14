#!/usr/bin/env node
/**
 * Probe the deployed SurrealDB for:
 *   1. Build version (via the `version()` SQL function, with `INFO FOR ROOT`
 *      / `INFO FOR DB` as fallbacks for context).
 *   2. Whether partial UNIQUE indexes (DEFINE INDEX ... FIELDS ... UNIQUE
 *      WHERE ...) are accepted by the parser/executor.
 *
 * Read-only-ish: creates a throwaway table `surreal_probe_xyz`, defines a
 * partial UNIQUE index on it, removes the table on the way out. No effect on
 * production tables.
 *
 * Uses the raw `surrealdb` client (not SurrealStore.initialize()) so we do
 * NOT trigger schema.surql — that file is the very thing whose compatibility
 * we are probing.
 *
 * Usage:
 *   node scripts/probe-surreal-version.mjs
 */
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../dist/engine/config.js";

const PROBE_TABLE = "surreal_probe_partial_unique";

function fmt(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function main() {
  const { surreal } = parsePluginConfig({});
  console.log(`[probe] url=${surreal.url}  ns=${surreal.ns}  db=${surreal.db}`);

  const db = new Surreal();
  await db.connect(surreal.url, {
    namespace: surreal.ns,
    database: surreal.db,
    authentication: { username: surreal.user, password: surreal.pass },
  });
  console.log("[probe] connected");

  // 1. Version probe. Try `SELECT version()` first — most portable across
  //    SurrealDB 1.x / 2.x / 3.x. Fall back to INFO FOR ROOT / INFO FOR DB.
  let versionStr = null;
  try {
    const r = await db.query("RETURN version();");
    versionStr = Array.isArray(r) ? r[0] : r;
    console.log(`[probe] version() => ${fmt(versionStr)}`);
  } catch (e) {
    console.log(`[probe] version() failed: ${e?.message ?? e}`);
  }

  try {
    const r = await db.query("INFO FOR ROOT;");
    console.log(`[probe] INFO FOR ROOT => ${fmt(r).slice(0, 400)}`);
  } catch (e) {
    console.log(`[probe] INFO FOR ROOT failed: ${e?.message ?? e}`);
  }

  try {
    const r = await db.query("INFO FOR DB;");
    console.log(`[probe] INFO FOR DB (truncated) => ${fmt(r).slice(0, 400)}`);
  } catch (e) {
    console.log(`[probe] INFO FOR DB failed: ${e?.message ?? e}`);
  }

  // 2. Partial UNIQUE index probe. We try the EXACT shape used in
  //    schema.surql line ~499:
  //       DEFINE INDEX ... ON <table> FIELDS a, b UNIQUE WHERE <cond>;
  let partialWorks = false;
  let partialErr = null;
  try {
    // Clean any prior probe artifact.
    await db.query(`REMOVE TABLE IF EXISTS ${PROBE_TABLE};`).catch(() => {});

    // Define the table and a non-trivial partial UNIQUE index.
    await db.query(`DEFINE TABLE ${PROBE_TABLE} SCHEMALESS;`);
    const defineSql = `DEFINE INDEX probe_partial_uniq ON ${PROBE_TABLE} FIELDS a, b UNIQUE WHERE status = 'pending';`;
    console.log(`[probe] attempting: ${defineSql}`);
    const defRes = await db.query(defineSql);
    console.log(`[probe] DEFINE result => ${fmt(defRes).slice(0, 400)}`);

    // Functional check: two pending rows with same (a,b) should fail; one
    // pending + one completed with same (a,b) should succeed.
    await db.query(`CREATE ${PROBE_TABLE} CONTENT { a: 1, b: 2, status: 'pending' };`);
    let fnUniqueRejectedDup = false;
    try {
      await db.query(`CREATE ${PROBE_TABLE} CONTENT { a: 1, b: 2, status: 'pending' };`);
      fnUniqueRejectedDup = false;
    } catch (e) {
      fnUniqueRejectedDup = true;
      console.log(`[probe] (expected) duplicate pending rejected: ${e?.message ?? e}`);
    }
    let fnAllowsAcrossStatus = false;
    try {
      await db.query(`CREATE ${PROBE_TABLE} CONTENT { a: 1, b: 2, status: 'completed' };`);
      fnAllowsAcrossStatus = true;
    } catch (e) {
      fnAllowsAcrossStatus = false;
      console.log(`[probe] (unexpected) completed row rejected: ${e?.message ?? e}`);
    }

    partialWorks = fnUniqueRejectedDup && fnAllowsAcrossStatus;
    console.log(
      `[probe] functional: rejectsDuplicatePending=${fnUniqueRejectedDup}  allowsAcrossStatus=${fnAllowsAcrossStatus}  => partialWorks=${partialWorks}`,
    );
  } catch (e) {
    partialErr = e?.message ?? String(e);
    console.log(`[probe] DEFINE INDEX ... WHERE ... rejected: ${partialErr}`);
  } finally {
    await db.query(`REMOVE TABLE IF EXISTS ${PROBE_TABLE};`).catch(() => {});
  }

  // 3. Sanity-check the COMPOUND UNIQUE fallback (the actual fix) against
  //    the deployed parser — same throwaway table.
  let compoundWorks = false;
  let compoundErr = null;
  try {
    await db.query(`REMOVE TABLE IF EXISTS ${PROBE_TABLE};`).catch(() => {});
    await db.query(`DEFINE TABLE ${PROBE_TABLE} SCHEMALESS;`);
    const compoundSql = `DEFINE INDEX probe_compound_uniq ON ${PROBE_TABLE} FIELDS a, b, status UNIQUE;`;
    console.log(`[probe] attempting: ${compoundSql}`);
    const r = await db.query(compoundSql);
    console.log(`[probe] DEFINE compound result => ${fmt(r).slice(0, 300)}`);

    // (a=1, b=2, pending) is unique. Re-insert should fail; (a=1, b=2, completed) should succeed.
    await db.query(`CREATE ${PROBE_TABLE} CONTENT { a: 1, b: 2, status: 'pending' };`);
    let rejectsDup = false;
    try {
      await db.query(`CREATE ${PROBE_TABLE} CONTENT { a: 1, b: 2, status: 'pending' };`);
    } catch (e) {
      rejectsDup = true;
      console.log(`[probe] (expected) compound dup rejected: ${(e?.message ?? e).toString().slice(0, 200)}`);
    }
    let acrossStatus = false;
    try {
      await db.query(`CREATE ${PROBE_TABLE} CONTENT { a: 1, b: 2, status: 'completed' };`);
      acrossStatus = true;
    } catch (e) {
      console.log(`[probe] (unexpected) compound across-status rejected: ${(e?.message ?? e).toString().slice(0, 200)}`);
    }
    compoundWorks = rejectsDup && acrossStatus;
    console.log(
      `[probe] compound functional: rejectsDuplicate=${rejectsDup}  allowsAcrossStatus=${acrossStatus}  => compoundWorks=${compoundWorks}`,
    );
  } catch (e) {
    compoundErr = e?.message ?? String(e);
    console.log(`[probe] compound UNIQUE failed: ${compoundErr}`);
  } finally {
    await db.query(`REMOVE TABLE IF EXISTS ${PROBE_TABLE};`).catch(() => {});
  }

  console.log("\n=== SUMMARY ===");
  console.log(`version()       : ${fmt(versionStr)}`);
  console.log(`partial UNIQUE  : ${partialWorks ? "SUPPORTED" : "NOT SUPPORTED"}`);
  if (partialErr) console.log(`partial UNIQUE error: ${partialErr}`);
  console.log(`compound UNIQUE : ${compoundWorks ? "SUPPORTED" : "NOT SUPPORTED"}`);
  if (compoundErr) console.log(`compound UNIQUE error: ${compoundErr}`);

  await db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(1);
});
