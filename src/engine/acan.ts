/**
 * ACAN — Attentive Cross-Attention Network for learned memory scoring.
 *
 * Replaces the fixed 6-signal WMR weights in scoreResults() with a learned
 * cross-attention model. Ships dormant — auto-trains and activates when
 * enough retrieval outcome data accumulates (5000+ labeled pairs).
 *
 * Ported from kongbrain — uses SurrealStore instead of module-level DB.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  openSync, writeSync, closeSync, unlinkSync, statSync, constants,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import type { SurrealStore } from "./surreal.js";
import { assertRecordId } from "./surreal.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";

// ── Types ──

export interface ACANWeights {
  W_q: number[][];
  W_k: number[][];
  W_final: number[];
  bias: number;
  version: number;
  trainedAt?: number;
  trainedOnSamples?: number;
}

export interface ACANCandidate {
  embedding: number[];
  recency: number;
  importance: number;
  access: number;
  neighborBonus: number;
  provenUtility: number;
  reflectionBoost?: number;
}

interface TrainingSample {
  query_embedding: number[];
  memory_embedding: number[];
  retrieval_score: number;
  was_neighbor: boolean;
  utilization: number;
  importance: number;
  access_count: number;
  recency: number;
}

interface TrainingConfig {
  epochs: number;
  lr: number;
  earlyStopPatience: number;
  lrDecayPatience: number;
  lrFloor: number;
  valSplit: number;
}

// ── Module state ──

let _weights: ACANWeights | null = null;
let _active = false;
// Remembered between initACAN and maybeReloadWeights so a later score call
// can detect a weights file that's been rewritten by a sibling MCP process.
let _weightsDir: string | undefined = undefined;
let _loadedMtime = 0;

const ATTN_DIM = 64;
const EMBED_DIM = 1024;
const FEATURE_COUNT = 7;
const WEIGHTS_FILENAME = "acan_weights.json";
const LOCK_FILENAME = "acan_weights.lock";
// If a lockfile is older than 30min, assume the owner crashed and steal it.
// Training takes seconds on small samples, at most a couple minutes on large;
// a legitimately-held lock will never approach 30min.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const TRAINING_THRESHOLD = 5000;
const MAX_TRAINING_SAMPLES = 15000;

/**
 * Claim an exclusive training lock. Returns a release function, or null if
 * another process holds the lock. Stale locks (older than LOCK_MAX_AGE_MS)
 * are stolen automatically.
 */
function acquireTrainingLock(lockPath: string): (() => void) | null {
  const tryCreate = (): (() => void) | null => {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(fd);
      return () => {
        try { unlinkSync(lockPath); } catch { /* may already be gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return null;
    }
  };

  const release = tryCreate();
  if (release) return release;

  // Exists — check age. Stale = steal it.
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > LOCK_MAX_AGE_MS) {
      try { unlinkSync(lockPath); } catch { /* raced with another stealer */ }
      return tryCreate();
    }
  } catch { /* raced — lock vanished; fall through */ }
  return null;
}

function getKongDir(): string {
  const dir = join(homedir(), ".kongbrain");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  epochs: 80,
  lr: 0.001,
  earlyStopPatience: 8,
  lrDecayPatience: 4,
  lrFloor: 0.00005,
  valSplit: 0.2,
};

// ── Weight loading / saving ──

function loadWeights(path: string): ACANWeights | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw.version !== 1) return null;
    if (!Array.isArray(raw.W_q) || raw.W_q.length !== EMBED_DIM) return null;
    if (!Array.isArray(raw.W_k) || raw.W_k.length !== EMBED_DIM) return null;
    if (!Array.isArray(raw.W_final) || raw.W_final.length !== FEATURE_COUNT) return null;
    if (typeof raw.bias !== "number") return null;
    // Validate inner dimensions — check first, middle, and last rows to catch crafted files
    const checkIndices = [0, Math.floor(EMBED_DIM / 2), EMBED_DIM - 1];
    for (const i of checkIndices) {
      if (!Array.isArray(raw.W_q[i]) || raw.W_q[i].length !== ATTN_DIM) return null;
      if (!Array.isArray(raw.W_k[i]) || raw.W_k[i].length !== ATTN_DIM) return null;
    }
    // Validate numeric values — NaN/Infinity from a bad training run would corrupt scoring.
    // JSON.stringify(NaN) produces null, so we must also reject null/non-number values.
    if (typeof raw.bias !== "number" || !isFinite(raw.bias)) return null;
    if (!raw.W_final.every((v: unknown) => typeof v === "number" && isFinite(v as number))) return null;
    // Spot-check W_q/W_k (full scan too expensive for 1024x64 matrices)
    for (const i of checkIndices) {
      if (!raw.W_q[i].every((v: unknown) => typeof v === "number" && isFinite(v as number))) return null;
      if (!raw.W_k[i].every((v: unknown) => typeof v === "number" && isFinite(v as number))) return null;
    }
    return raw as ACANWeights;
  } catch (e) {
    swallow("acan:loadWeights", e);
    return null;
  }
}

function saveWeights(weights: ACANWeights, path: string): void {
  // Atomic write: multiple MCPs can train concurrently, so a partial write
  // from one process must not be visible to another reading the file.
  // write-to-tmp then rename() is atomic on the same filesystem.
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(weights), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, path);
}

export function initACAN(weightsDir?: string): boolean {
  _weightsDir = weightsDir;
  const dir = weightsDir ?? getKongDir();
  const path = join(dir, WEIGHTS_FILENAME);
  _weights = loadWeights(path);
  _active = _weights !== null;
  try {
    _loadedMtime = existsSync(path) ? statSync(path).mtimeMs : 0;
  } catch { _loadedMtime = 0; }
  return _active;
}

export function isACANActive(): boolean {
  return _active;
}

/**
 * Hot-reload weights if the file has been rewritten since we last loaded.
 * Lets sibling MCP processes' retrains take effect here without a restart.
 * Cheap when nothing's changed (one statSync per score call).
 */
function maybeReloadWeights(): void {
  if (!_weights) return;
  const dir = _weightsDir ?? getKongDir();
  const path = join(dir, WEIGHTS_FILENAME);
  try {
    if (!existsSync(path)) return;
    const mtime = statSync(path).mtimeMs;
    if (mtime > _loadedMtime) {
      initACAN(_weightsDir);
      log.info(`[acan] hot-reloaded weights (sibling MCP retrained)`);
    }
  } catch { /* non-fatal, keep current weights */ }
}

// ── Linear algebra ──

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function projectVec(vec: number[], matrix: number[][]): number[] {
  const out = new Array(matrix[0].length).fill(0);
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] === 0) continue;
    const row = matrix[i];
    for (let j = 0; j < out.length; j++) out[j] += vec[i] * row[j];
  }
  return out;
}

// ── ACAN inference ──

export function scoreWithACAN(queryEmbedding: number[], candidates: ACANCandidate[]): number[] {
  maybeReloadWeights();
  if (!_weights || candidates.length === 0) return [];

  const q = projectVec(queryEmbedding, _weights.W_q);
  const scale = Math.sqrt(ATTN_DIM);
  const scores: number[] = [];

  for (const cand of candidates) {
    const k = projectVec(cand.embedding, _weights.W_k);
    const attnLogit = dot(q, k) / scale;
    const features = [
      attnLogit, cand.recency, cand.importance, cand.access,
      cand.neighborBonus, cand.provenUtility, cand.reflectionBoost ?? 0,
    ];
    scores.push(dot(features, _weights.W_final) + _weights.bias);
  }

  return scores;
}

// ── Training data fetching ──

async function getTrainingDataCount(store: SurrealStore): Promise<number> {
  if (!store.isAvailable()) return 0;
  try {
    const flat = await store.queryFirst<{ count: number }>(
      `SELECT count() AS count FROM retrieval_outcome WHERE query_embedding != NONE GROUP ALL`,
    );
    return flat[0]?.count ?? 0;
  } catch (e) {
    swallow("acan:count", e);
    return 0;
  }
}

async function fetchTrainingData(store: SurrealStore): Promise<TrainingSample[]> {
  if (!store.isAvailable()) return [];

  const outcomes = await store.queryFirst<any>(
    `SELECT query_embedding, memory_id, memory_table,
            IF llm_relevance != NONE THEN llm_relevance ELSE utilization END AS utilization,
            retrieval_score, was_neighbor,
            importance, access_count, recency, created_at
     FROM retrieval_outcome
     WHERE query_embedding != NONE
     ORDER BY created_at DESC
     LIMIT $maxSamples`,
    { maxSamples: MAX_TRAINING_SAMPLES },
  );
  if (outcomes.length === 0) return [];

  const uniqueMemIds = [...new Set(outcomes.map((r: any) => String(r.memory_id)))];
  const embeddingMap = new Map<string, number[]>();

  // Group IDs by table for batched fetches instead of one query per ID
  const byTable = new Map<string, string[]>();
  for (const mid of uniqueMemIds) {
    try {
      assertRecordId(mid);
      const table = mid.split(":")[0];
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table)!.push(mid);
    } catch { /* skip invalid */ }
  }
  await Promise.all([...byTable.entries()].map(async ([table, ids]) => {
    try {
      // Direct interpolation — SurrealDB treats string-array bindings as
      // literal strings, not record references, causing silent empty results.
      const idList = ids.join(", ");
      const rows = await store.queryFirst<{ id: string; embedding: number[] }>(
        `SELECT id, embedding FROM ${table} WHERE id IN [${idList}] AND embedding != NONE`,
      );
      for (const row of rows) {
        if (row.embedding) embeddingMap.set(String(row.id), row.embedding);
      }
    } catch (e) { swallow("acan:fetchEmb", e); }
  }));

  const samples: TrainingSample[] = [];
  for (const row of outcomes) {
    const memEmb = embeddingMap.get(String(row.memory_id));
    if (!memEmb || !row.query_embedding) continue;
    samples.push({
      query_embedding: row.query_embedding,
      memory_embedding: memEmb,
      retrieval_score: row.retrieval_score ?? 0,
      was_neighbor: row.was_neighbor ?? false,
      utilization: row.utilization ?? 0,
      importance: row.importance ?? 0.5,
      access_count: row.access_count ?? 0,
      recency: row.recency ?? 0.5,
    });
  }
  return samples;
}

// ── Background training ──

function trainInBackground(
  samples: TrainingSample[],
  weightsPath: string,
  warmStart?: ACANWeights,
  config?: Partial<TrainingConfig>,
  releaseLock?: () => void,
): void {
  const cfg = { ...DEFAULT_TRAINING_CONFIG, ...config };

  const workerCode = `
    import { parentPort, workerData } from "node:worker_threads";
    const { samples, cfg, warmStart, EMBED_DIM, ATTN_DIM, FEATURE_COUNT } = workerData;
    function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
    function projectVec(vec, matrix) {
      const out = new Array(matrix[0].length).fill(0);
      for (let i = 0; i < vec.length; i++) { if (vec[i] === 0) continue; const row = matrix[i]; for (let j = 0; j < out.length; j++) out[j] += vec[i] * row[j]; }
      return out;
    }
    function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
    const n = samples.length;
    const auxFeatures = samples.map(s => [s.recency, s.importance, s.access_count, s.was_neighbor ? 1.0 : 0.0, 0.0, 0.0]);
    const indices = shuffle(Array.from({ length: n }, (_, i) => i));
    const valSize = Math.max(1, Math.floor(n * cfg.valSplit));
    const valIdx = indices.slice(0, valSize);
    const trainIdx = indices.slice(valSize);
    const nTrain = trainIdx.length;
    let W_q, W_k, W_final, bias;
    if (warmStart) { W_q = JSON.parse(JSON.stringify(warmStart.W_q)); W_k = JSON.parse(JSON.stringify(warmStart.W_k)); W_final = [...warmStart.W_final]; bias = warmStart.bias; }
    else { const xQK = Math.sqrt(2/(EMBED_DIM+ATTN_DIM)), xF = Math.sqrt(2/(FEATURE_COUNT+1)); W_q = []; W_k = []; for (let i = 0; i < EMBED_DIM; i++) { W_q.push(Array.from({length:ATTN_DIM}, () => (Math.random()*2-1)*xQK)); W_k.push(Array.from({length:ATTN_DIM}, () => (Math.random()*2-1)*xQK)); } W_final = Array.from({length:FEATURE_COUNT}, () => (Math.random()*2-1)*xF); W_final[0] = 0.3; bias = 0.0; }
    const scale = Math.sqrt(ATTN_DIM);
    function evalLoss(idxList) { let total = 0; for (const si of idxList) { const s = samples[si]; const q = projectVec(s.query_embedding, W_q); const k = projectVec(s.memory_embedding, W_k); const attn = dot(q,k)/scale; const features = [attn,...auxFeatures[si]]; const score = dot(features, W_final)+bias; const err = score - s.utilization; total += err*err; } return total/idxList.length; }
    let lr = cfg.lr, bestValLoss = Infinity, epochsSinceImprovement = 0, epochsSinceLrDecay = 0, lastTrainLoss = Infinity, actualEpochs = 0;
    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
      actualEpochs = epoch+1; shuffle(trainIdx); let totalLoss = 0;
      for (const si of trainIdx) { const s = samples[si]; const q = projectVec(s.query_embedding, W_q); const k = projectVec(s.memory_embedding, W_k); const attn = dot(q,k)/scale; const features = [attn,...auxFeatures[si]]; const score = dot(features, W_final)+bias; const err = score - s.utilization; totalLoss += err*err; const dScore = (2/nTrain)*err; for (let j = 0; j < FEATURE_COUNT; j++) W_final[j] -= lr*dScore*features[j]; bias -= lr*dScore; const dAttn = dScore*W_final[0]; const dQ = new Array(ATTN_DIM), dK = new Array(ATTN_DIM); for (let j = 0; j < ATTN_DIM; j++) { dQ[j] = dAttn*k[j]/scale; dK[j] = dAttn*q[j]/scale; } for (let i = 0; i < EMBED_DIM; i++) { if (s.query_embedding[i]!==0) { const qi=s.query_embedding[i], row=W_q[i]; for (let j=0;j<ATTN_DIM;j++) row[j]-=lr*dQ[j]*qi; } if (s.memory_embedding[i]!==0) { const mi=s.memory_embedding[i], row=W_k[i]; for (let j=0;j<ATTN_DIM;j++) row[j]-=lr*dK[j]*mi; } } }
      lastTrainLoss = totalLoss/nTrain; const valLoss = evalLoss(valIdx);
      if (valLoss < bestValLoss) { bestValLoss = valLoss; epochsSinceImprovement = 0; epochsSinceLrDecay = 0; } else { epochsSinceImprovement++; epochsSinceLrDecay++; }
      if (epochsSinceLrDecay >= cfg.lrDecayPatience && lr > cfg.lrFloor) { lr = Math.max(lr*0.5, cfg.lrFloor); epochsSinceLrDecay = 0; }
      if (epochsSinceImprovement >= cfg.earlyStopPatience) break;
    }
    parentPort.postMessage({ weights: { W_q, W_k, W_final, bias, version: 1, trainedAt: Date.now(), trainedOnSamples: n }, trainLoss: lastTrainLoss, valLoss: bestValLoss, actualEpochs, finalLr: lr, config: cfg });
  `;

  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerCode)}`), {
    workerData: { samples, cfg, warmStart: warmStart ?? null, EMBED_DIM, ATTN_DIM, FEATURE_COUNT },
  });

  worker.unref();

  worker.on("message", (msg: any) => {
    try {
      saveWeights(msg.weights, weightsPath);
      _weights = msg.weights;
      _active = true;
      log.info(`[acan] training complete: trainedOn=${msg.weights.trainedOnSamples} valLoss=${msg.valLoss?.toFixed?.(4) ?? "?"} epochs=${msg.actualEpochs ?? "?"}`);
    } catch (e) {
      swallow.warn("acan:saveWeights", e);
    }
    releaseLock?.();
    worker.terminate();
  });

  worker.on("error", (err) => {
    swallow.warn("acan:worker", err);
    releaseLock?.();
    worker.terminate();
  });
}

// ── Startup: auto-train and activate ──

const STALENESS_GROWTH_FACTOR = 0.5;
const STALENESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function checkACANReadiness(
  store?: SurrealStore,
  trainingThreshold?: number,
  weightsDir?: string,
): Promise<void> {
  if (!store) return;
  const threshold = trainingThreshold ?? TRAINING_THRESHOLD;
  const dir = weightsDir ?? getKongDir();
  const weightsPath = join(dir, WEIGHTS_FILENAME);
  const hasWeights = initACAN(weightsDir);
  const count = await getTrainingDataCount(store);

  if (hasWeights && _weights) {
    const trainedOn = _weights.trainedOnSamples ?? 0;
    const trainedAt = _weights.trainedAt ?? 0;
    const growthRatio = trainedOn > 0 ? (count - trainedOn) / trainedOn : Infinity;
    const ageMs = Date.now() - trainedAt;
    const isStale = growthRatio >= STALENESS_GROWTH_FACTOR || ageMs >= STALENESS_MAX_AGE_MS;
    if (!isStale) return;
  } else if (count < threshold) {
    return;
  }

  // Gate training with a cross-process lockfile so concurrent MCPs don't
  // duplicate work (or race on writing weights). First one in wins; others
  // skip this cycle and pick up the new weights via mtime-reload next time.
  const lockPath = join(dir, LOCK_FILENAME);
  const releaseLock = acquireTrainingLock(lockPath);
  if (!releaseLock) {
    log.info(`[acan] training lock held by another process, skipping this cycle`);
    return;
  }

  try {
    const samples = await fetchTrainingData(store);
    if (samples.length < threshold) {
      log.warn(`[acan] retrain skipped: samples=${samples.length} < threshold=${threshold} (count=${count})`);
      releaseLock();
      return;
    }
    log.info(`[acan] retrain triggered: samples=${samples.length} prevTrainedOn=${_weights?.trainedOnSamples ?? 0}`);
    trainInBackground(samples, weightsPath, hasWeights ? _weights ?? undefined : undefined, undefined, releaseLock);
  } catch (e) {
    swallow.warn("acan:readiness", e);
    releaseLock();
  }
}
