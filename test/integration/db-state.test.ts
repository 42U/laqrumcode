/**
 * DB-state invariants — live integration test.
 *
 * Reads the production laqrumcode SurrealDB and asserts three invariants
 * that caught real bugs in the v0.7.93–v0.7.95 investigation:
 *
 *   1. Embedding coverage: zero unembedded rows on every content table.
 *      Catches maintenance-backfill regressions, embedder crashes that
 *      drop rows on the floor, and schema additions that don't backfill.
 *
 *   2. turn_archive self-match cardinal: a row's own embedding must be
 *      its own top-1 cosine match. Catches dimension drift, vector
 *      corruption, and model swaps without re-embed.
 *
 *   3. concept supersede-chain integrity: when a concept is soft-superseded
 *      (active=false, superseded_by set), the superseder's name must equal
 *      the superseded name. Catches v0.7.92-class bugs where supersede
 *      promoted an unrelated concept.
 *
 * Skip behavior: skips cleanly if the laqrumcode daemon socket is absent
 * (matches the `daemon-tool-roundtrip` integration test gate). Opt out
 * explicitly with `SKIP_DB_STATE=1`.
 *
 * Read-only — issues no writes. Targets the live production DB on
 * purpose: these invariants are vacuous on an empty test namespace.
 *
 * Promoted from `scripts/probe-validation.mjs`, `scripts/probe-spot-check.mjs`,
 * and `scripts/verify-v0794.mjs` (May 2026 investigation). Those scripts
 * are removed; this is their durable successor.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Surreal } from "surrealdb";
import { parsePluginConfig } from "../../src/engine/config.js";

const SOCKET_PATH =
  process.env.LAQRUMCODE_DAEMON_SOCKET ?? join(homedir(), ".laqrumcode-daemon.sock");

const RUN_LIVE =
  existsSync(SOCKET_PATH) && process.env.SKIP_DB_STATE !== "1";

const CONTENT_TABLES = [
  "concept",
  "memory",
  "artifact",
  "turn",
  "turn_archive",
  "monologue",
  "identity_chunk",
  "skill",
  "reflection",
] as const;

describe.skipIf(!RUN_LIVE)("laqrumcode DB state invariants (live, read-only)", () => {
  let db: Surreal | undefined;

  beforeAll(async () => {
    const config = parsePluginConfig({});
    const { url, ns, db: dbName, user, pass } = config.surreal;
    db = new Surreal();
    await db.connect(url, {
      namespace: ns,
      database: dbName,
      authentication: { username: user, password: pass },
    });
  }, 15_000);

  afterAll(async () => {
    if (db) await db.close();
  });

  async function q<T = unknown>(
    sql: string,
    bindings?: Record<string, unknown>,
  ): Promise<T[]> {
    if (!db) throw new Error("db not connected");
    const r = await db.query(sql, bindings);
    const rows = Array.isArray(r) ? r[r.length - 1] : r;
    return (Array.isArray(rows) ? rows : []).filter(Boolean) as T[];
  }

  // 0.7.118: the invariant is "every RETRIEVAL-ELIGIBLE row is embedded".
  // Archived/superseded/pruned rows are deliberately outside retrieval (e.g.
  // the 2026-06-10 stub sweep archived 5.5k rows; junk drain output gets
  // archived rather than embedded) — counting them made the invariant fail
  // on healthy graphs.
  const ACTIVE_FILTER: Partial<Record<(typeof CONTENT_TABLES)[number], string>> = {
    concept: "superseded_at IS NONE",
    memory: '(status IS NONE OR status != "archived")',
    turn: "pruned_at IS NONE",
    skill: "superseded_at IS NONE",
  };

  describe("embedding coverage", () => {
    for (const table of CONTENT_TABLES) {
      it(`${table} has zero unembedded active rows`, async () => {
        const active = ACTIVE_FILTER[table];
        const rows = await q<{ c: number }>(
          `SELECT count() AS c FROM ${table}
             WHERE (embedding IS NONE OR array::len(embedding) = 0)${active ? ` AND ${active}` : ""}
             GROUP ALL`,
        );
        const count = rows[0]?.c ?? 0;
        expect(
          count,
          `${table} has ${count} unembedded active rows; expected 0 (run the embedding backfill)`,
        ).toBe(0);
      });
    }
  });

  describe("turn_archive self-match cardinal", () => {
    it("a sampled row's own embedding is its own top-1 cosine hit", async () => {
      const sample = await q<{ id: string; embedding: number[] }>(
        `SELECT id, embedding FROM turn_archive
           WHERE embedding != NONE AND array::len(embedding) > 0
           LIMIT 1`,
      );
      if (sample.length === 0) {
        // No embedded turn_archive rows yet — vacuously pass.
        return;
      }
      const srcId = String(sample[0].id);
      const vec = sample[0].embedding;
      expect(vec.length, "embedding vector length must be > 0").toBeGreaterThan(0);

      const hits = await q<{ id: string; score: number }>(
        `SELECT id, vector::similarity::cosine(embedding, $vec) AS score
           FROM turn_archive
           WHERE embedding != NONE AND array::len(embedding) > 0
           ORDER BY score DESC LIMIT 3`,
        { vec },
      );
      expect(hits.length, "no hits returned").toBeGreaterThan(0);
      expect(
        String(hits[0].id),
        `top-1 was ${String(hits[0].id)} (score=${hits[0].score}); expected source ${srcId}`,
      ).toBe(srcId);
      expect(
        hits[0].score,
        "cosine(v, v) should be 1.0 within fp tolerance",
      ).toBeGreaterThan(0.999);
    });
  });

  describe("active field discipline (pending_work + skill)", () => {
    // Regression for the v0.7.95 → v0.7.96 deadlock pattern: pre-migration
    // rows lack the `active` field, the SELECT guard tolerates NONE, but a
    // claim `UPDATE ... RETURN AFTER` re-coerces and throws `Couldn't coerce
    // ... Expected bool but found NONE`. pending_work had 468 NONE rows that
    // deadlocked fetch_pending_work; skill had 52 NONE rows that were a
    // latent landmine (no RETURN AFTER caller yet, but the moment one is
    // added, the bomb goes off).
    //
    // Both tables now use TYPE option<bool>, but a NONE row still signals
    // either a new pre-backfill migration ghost or a writer bypassing the
    // DEFAULT. Either way, surface it.
    const tablesWithActiveDiscipline = ["pending_work", "skill"] as const;
    for (const table of tablesWithActiveDiscipline) {
      it(`zero ${table} rows have active IS NONE`, async () => {
        const rows = await q<{ c: number }>(
          `SELECT count() AS c FROM ${table} WHERE active IS NONE GROUP ALL`,
        );
        const count = rows[0]?.c ?? 0;
        expect(
          count,
          `${count} ${table} rows have active IS NONE — backfill with ` +
            `UPDATE ${table} SET active = true WHERE active IS NONE`,
        ).toBe(0);
      });
    }
  });

  describe("supersede self-reference integrity (W2-4)", () => {
    // Regression for the Phase X type::record bug (commit e6f426d). Before
    // the fix, `WHERE id != $sid` with $sid bound as a JS string failed to
    // exclude self under SurrealDB v3 strict type comparison (Thing != string
    // is always TRUE). Every new skill self-superseded immediately, leaving
    // active=false + superseded_by=id. 730 rows healed in v0.7.96 X.5.
    //
    // Any non-zero count here = either the type::record fix regressed OR a
    // new untested writer landed without the guard. Surface it loudly.
    const tablesWithSupersede = ["skill", "memory", "reflection"] as const;
    for (const table of tablesWithSupersede) {
      it(`zero ${table} rows have superseded_by pointing to themselves`, async () => {
        const rows = await q<{ c: number }>(
          `SELECT count() AS c FROM ${table}
             WHERE superseded_by != NONE AND id = superseded_by GROUP ALL`,
        );
        const count = rows[0]?.c ?? 0;
        expect(
          count,
          `${count} ${table} rows have superseded_by = id (self-ref). ` +
            `Run the heal in laqrumcode-heal-skill-corruption skill ` +
            `(skill:j12hn8rf00muaww4rv0g) and ensure all id != $X SELECTs ` +
            `use type::record($X).`,
        ).toBe(0);
      });
    }
  });

  describe("concept supersede-chain integrity", () => {
    it("every soft-superseded concept's superseder has the same name", async () => {
      const rows = await q<{ id: string; name: string; superseded_by: string }>(
        `SELECT id, name, superseded_by FROM concept
           WHERE active = false AND superseded_by != NONE LIMIT 1000`,
      );

      const mismatches: Array<{ id: string; name: string; supName: string | null }> = [];
      for (const row of rows) {
        if (!row.superseded_by) continue;
        const rawSup = String(row.superseded_by);
        const supId = rawSup.startsWith("concept:") ? rawSup : `concept:${rawSup}`;
        const sup = await q<{ name: string }>(`SELECT name FROM ${supId} LIMIT 1`);
        const supName = sup[0]?.name ?? null;
        if (supName && row.name && supName !== row.name) {
          mismatches.push({ id: String(row.id), name: row.name, supName });
        }
      }

      expect(
        mismatches,
        `${mismatches.length} supersede name-mismatches (first 5): ${JSON.stringify(mismatches.slice(0, 5))}`,
      ).toEqual([]);
    });
  });
});
