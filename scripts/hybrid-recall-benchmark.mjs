#!/usr/bin/env node
/**
 * Hybrid retrieval benchmark — does the v0.8.4 dense+sparse hybrid improve RECALL
 * over dense-only? Uses SOURCE-DOC RECOVERY as objective ground truth: for a
 * sample of real concepts, build a short query from that concept's distinctive
 * (document-frequency-filtered) terms, then measure the rank of the SOURCE
 * concept under (a) dense cosine alone, (b) BM25 full-text alone, (c) RRF(dense +
 * BM25) — the hybrid. Reports MRR + Recall@K for dense-only vs hybrid, overall
 * and stratified by term rarity (where the hybrid should help most).
 *
 * Standalone: loads BGE-M3 directly (no laqrumcode daemon needed) + talks to
 * SurrealDB. Deterministic sampling (no RNG) so re-runs are comparable.
 *   N=120 K=10 node scripts/hybrid-recall-benchmark.mjs
 */
import { getLlama } from "node-llama-cpp";
import { Surreal } from "surrealdb";

const MODEL = process.env.EMBED_MODEL_PATH || "/home/zero/.laqrumcode/cache/models/bge-m3-Q4_K_M.gguf";
const N = Number(process.env.N || 120);
const K = Number(process.env.K || 10);
const POOL = 200; // candidate depth per arm before fusion

const STOP = new Set("the a an is are was were be been being have has had do does did will would could should can may might to of in for on with at by from as into about and or but if so not no this that these those it its you we they my your our their what which who how when where why all any some more just than then over under such also there here".split(" "));
const terms = (t) => String(t).toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); };
const rrf = (lists, k = 60) => { const m = new Map(); for (const l of lists) l.forEach((id, r) => m.set(id, (m.get(id) || 0) + 1 / (k + r + 1))); return m; };
const rankOf = (id, ordered) => { const i = ordered.indexOf(id); return i < 0 ? Infinity : i + 1; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const s = new Surreal();
await s.connect("ws://127.0.0.1:8000/rpc");
await s.signin({ username: "root", password: "root" });
await s.use({ namespace: "laqrum", database: "memory" });
console.error("loading concept corpus...");
const rows = (await s.query("SELECT meta::id(id) AS id, content, embedding FROM concept WHERE embedding != NONE AND content != NONE AND superseded_at IS NONE"))?.[0] || [];
const corpusN = rows.length;
console.error("corpus:", corpusN, "concepts");
const ids = rows.map((r) => r.id), embs = rows.map((r) => r.embedding), contents = rows.map((r) => r.content);
const df = new Map();
for (const c of contents) for (const w of new Set(terms(c))) df.set(w, (df.get(w) || 0) + 1);

console.error("loading BGE-M3...");
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: MODEL });
const ec = await model.createEmbeddingContext();
const embed = async (t) => Array.from((await ec.getEmbeddingFor(t)).vector);

// Sample evenly across the corpus; query = the 3 rarest distinctive terms (DF in [2, N/8]).
const sample = [];
for (let i = 0; i < N * 4 && sample.length < N; i++) {
  const idx = Math.floor((i * corpusN) / (N * 4)) % corpusN;
  const tms = [...new Set(terms(contents[idx]))].filter((w) => { const d = df.get(w) || 0; return d >= 2 && d <= corpusN / 8; });
  if (tms.length < 2) continue;
  tms.sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0));
  const q = tms.slice(0, 3);
  sample.push({ target: ids[idx], q, rarity: mean(q.map((w) => df.get(w))) });
}
console.error("evaluable queries:", sample.length);

const R = { dMRR: [], bMRR: [], rMRR: [], dR: [], rR: [], rare_d: [], rare_r: [] };
let done = 0;
for (const { target, q, rarity } of sample) {
  const qemb = await embed(q.join(" "));
  const denseIds = ids.map((id, i) => [id, cosine(qemb, embs[i])]).sort((a, b) => b[1] - a[1]).slice(0, POOL).map((x) => x[0]);
  const where = q.map((_, i) => `content @${i + 1}@ $t${i}`).join(" OR ");
  const scoreSum = q.map((_, i) => `search::score(${i + 1})`).join(" + ");
  const p = {}; q.forEach((t, i) => { p[`t${i}`] = t; });
  const bm = (await s.query(`SELECT meta::id(id) AS id, (${scoreSum}) AS sc FROM concept WHERE (${where}) AND superseded_at IS NONE ORDER BY sc DESC LIMIT ${POOL}`, p))?.[0] || [];
  const bm25Ids = bm.map((r) => r.id);
  const fused = rrf([denseIds, bm25Ids]);
  const rrfIds = [...new Set([...denseIds, ...bm25Ids])].sort((a, b) => (fused.get(b) || 0) - (fused.get(a) || 0));
  const rd = rankOf(target, denseIds), rb = rankOf(target, bm25Ids), rr = rankOf(target, rrfIds);
  R.dMRR.push(rd === Infinity ? 0 : 1 / rd); R.bMRR.push(rb === Infinity ? 0 : 1 / rb); R.rMRR.push(rr === Infinity ? 0 : 1 / rr);
  R.dR.push(rd <= K ? 1 : 0); R.rR.push(rr <= K ? 1 : 0);
  if (rarity <= 8) { R.rare_d.push(rd === Infinity ? 0 : 1 / rd); R.rare_r.push(rr === Infinity ? 0 : 1 / rr); }
  if (++done % 20 === 0) console.error("  ", done, "/", sample.length);
}
await s.close();

console.log(JSON.stringify({
  corpus: corpusN, queries: sample.length, k: K, poolPerArm: POOL,
  dense_only: { MRR: +mean(R.dMRR).toFixed(4), [`recall@${K}`]: +mean(R.dR).toFixed(4) },
  bm25_only: { MRR: +mean(R.bMRR).toFixed(4) },
  hybrid_dense_plus_bm25_rrf: { MRR: +mean(R.rMRR).toFixed(4), [`recall@${K}`]: +mean(R.rR).toFixed(4) },
  delta_hybrid_vs_dense: { MRR: +(mean(R.rMRR) - mean(R.dMRR)).toFixed(4), [`recall@${K}`]: +(mean(R.rR) - mean(R.dR)).toFixed(4) },
  rare_term_subset: { n: R.rare_d.length, dense_MRR: +mean(R.rare_d).toFixed(4), hybrid_MRR: +mean(R.rare_r).toFixed(4), delta: +(mean(R.rare_r) - mean(R.rare_d)).toFixed(4) },
}, null, 2));
process.exit(0);
