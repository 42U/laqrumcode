#!/usr/bin/env node
/**
 * Retrieval-quality benchmark over the labeled `retrieval_outcome` table.
 *
 * Each row is a (query, retrieved-memory) outcome carrying a `utilization` label
 * (0–1: how much the LLM actually used that memory) and the `retrieval_score`
 * (cosine) it was surfaced at. Grouping by (session_id, turn_id) reconstructs
 * each query's retrieved SET, so the RANKING within a set can be scored against
 * the labels.
 *
 * Reports mean NDCG@k / MRR / Recall@k for the raw cosine ranking (baseline) vs a
 * static-feature WMR re-rank. This is the offline harness that should gate ranker
 * changes (the v0.8.3 hard-negative ACAN loss, a future listwise RankNet, HNSW
 * M/EFC, a hybrid arm) with a NUMBER instead of a guess. It is read-only.
 *
 * Caveats (v1): `retrieval_outcome` has no memory_embedding and no proven-utility
 * or reflection signal, so the WMR arm here is the STATIC-feature subset only
 * (cosine, recency, importance, access, neighbor) — not the full live WMR. And it
 * scores re-ranking WITHIN the already-retrieved set; it cannot measure recall of
 * items HNSW never surfaced (that needs a held-out qrel set). Treat the absolute
 * numbers as a baseline to move, not ground truth.
 *
 * Env: SRC_URL, SURREAL_NS=laqrum, SURREAL_DB=memory, SURREAL_USER, SURREAL_PASS,
 *      REL_THRESHOLD=0.5 (utilization >= this counts as "relevant" for MRR/Recall),
 *      K=10
 *   node scripts/retrieval-benchmark.mjs
 */
import { Surreal } from "surrealdb";

const CFG = {
  url: process.env.SRC_URL || "ws://127.0.0.1:8000/rpc",
  ns: process.env.SURREAL_NS || "laqrum",
  db: process.env.SURREAL_DB || "memory",
  user: process.env.SURREAL_USER || "root",
  pass: process.env.SURREAL_PASS || "root",
};
const REL = Number(process.env.REL_THRESHOLD || 0.5);
const K = Number(process.env.K || 10);

const dcg = (rels, k) => rels.slice(0, k).reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
const ndcg = (rels, k) => { const idcg = dcg([...rels].sort((a, b) => b - a), k); return idcg > 0 ? dcg(rels, k) / idcg : null; };
const accessBoost = (n) => (n > 0 ? Math.min(Math.log1p(n) / Math.log1p(50), 1) : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
// Static-feature subset of the live WMR formula (graph-context.ts scoreResults).
const wmr = (r) => 0.35 * (r.retrieval_score ?? 0) + 0.18 * (r.recency ?? 0) + 0.07 * ((r.importance ?? 5) / 10) + 0.02 * accessBoost(r.access_count ?? 0) + 0.10 * (r.was_neighbor ? 1 : 0);

const s = new Surreal();
await s.connect(CFG.url);
await s.signin({ username: CFG.user, password: CFG.pass });
await s.use({ namespace: CFG.ns, database: CFG.db });
const rows = (await s.query(
  "SELECT session_id, turn_id, retrieval_score, utilization, was_neighbor, importance, recency, access_count FROM retrieval_outcome WHERE utilization != NONE AND retrieval_score != NONE",
))?.[0] || [];
await s.close();

const groups = new Map();
for (const r of rows) { const k = `${r.session_id}|${r.turn_id}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }

const acc = { cosNdcg: [], wmrNdcg: [], cosMrr: [], wmrMrr: [], cosRec: [], wmrRec: [], sizes: [] };
let evaluable = 0;
for (const items of groups.values()) {
  if (items.length < 2) continue;
  const utils = items.map((i) => i.utilization);
  if (Math.max(...utils) === Math.min(...utils)) continue; // flat labels → no ranking signal
  evaluable++;
  acc.sizes.push(items.length);
  const byCos = [...items].sort((a, b) => (b.retrieval_score ?? 0) - (a.retrieval_score ?? 0));
  const byWmr = [...items].sort((a, b) => wmr(b) - wmr(a));
  const relsCos = byCos.map((i) => i.utilization), relsWmr = byWmr.map((i) => i.utilization);
  const nc = ndcg(relsCos, K), nw = ndcg(relsWmr, K);
  if (nc != null) acc.cosNdcg.push(nc);
  if (nw != null) acc.wmrNdcg.push(nw);
  const firstRel = (arr) => { const idx = arr.findIndex((u) => u >= REL); return idx < 0 ? 0 : 1 / (idx + 1); };
  acc.cosMrr.push(firstRel(relsCos)); acc.wmrMrr.push(firstRel(relsWmr));
  const totalRel = utils.filter((u) => u >= REL).length;
  if (totalRel > 0) {
    acc.cosRec.push(relsCos.slice(0, K).filter((u) => u >= REL).length / totalRel);
    acc.wmrRec.push(relsWmr.slice(0, K).filter((u) => u >= REL).length / totalRel);
  }
}

console.log(JSON.stringify({
  rows: rows.length, groups: groups.size, evaluableGroups: evaluable, avgSetSize: +mean(acc.sizes).toFixed(1), relThreshold: REL, k: K,
  cosine_baseline: { ndcg: +mean(acc.cosNdcg).toFixed(4), mrr: +mean(acc.cosMrr).toFixed(4), recall: +mean(acc.cosRec).toFixed(4) },
  wmr_static: { ndcg: +mean(acc.wmrNdcg).toFixed(4), mrr: +mean(acc.wmrMrr).toFixed(4), recall: +mean(acc.wmrRec).toFixed(4) },
  deltaNdcg: +(mean(acc.wmrNdcg) - mean(acc.cosNdcg)).toFixed(4),
}, null, 2));
