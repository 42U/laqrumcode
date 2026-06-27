/**
 * ACAN — Attentive Cross-Attention Network for learned memory scoring.
 *
 * Replaces the fixed 6-signal WMR weights in scoreResults() with a learned
 * cross-attention model. Ships dormant — auto-trains and activates when
 * enough retrieval outcome data accumulates (5000+ labeled pairs).
 *
 * Ported from laqrumbrain — uses SurrealStore instead of module-level DB.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, writeSync, closeSync, unlinkSync, statSync, constants, } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import { assertRecordId } from "./surreal.js";
import { swallow } from "./errors.js";
import { log } from "./log.js";
// ── Module state ──
let _weights = null;
let _active = false;
// Remembered between initACAN and maybeReloadWeights so a later score call
// can detect a weights file that's been rewritten by a sibling MCP process.
let _weightsDir = undefined;
let _loadedMtime = 0;
// Mutex guarding maybeReloadWeights against concurrent invocations.
// scoreWithACAN is called once per retrieval; under burst load (multiple
// turns racing through retrieval, or a stop hook firing while preflight is
// in flight), two callers could both observe `mtime > _loadedMtime` and
// both re-enter loadWeights(). With this mutex, the second caller sees an
// in-flight reload, awaits its completion (in a fire-and-forget chain so
// scoreWithACAN's sync signature is preserved), and exits without
// re-reading. Cleared in a try/finally so a thrown error doesn't strand
// future reloads.
let _reloading = null;
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
function acquireTrainingLock(lockPath) {
    const tryCreate = () => {
        try {
            const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
            closeSync(fd);
            return () => {
                try {
                    unlinkSync(lockPath);
                }
                catch { /* may already be gone */ }
            };
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            return null;
        }
    };
    const release = tryCreate();
    if (release)
        return release;
    // Exists — check age. Stale = steal it.
    try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_MAX_AGE_MS) {
            try {
                unlinkSync(lockPath);
            }
            catch { /* raced with another stealer */ }
            return tryCreate();
        }
    }
    catch { /* raced — lock vanished; fall through */ }
    return null;
}
/**
 * Legacy default. Pre-0.x ACAN weights were written to ~/.laqrumbrain/acan_weights.json
 * back when this code lived in the laqrumbrain plugin. Existing user systems have
 * ~2.7MB of trained weights at that path that we must not orphan.
 *
 * New code paths should pass a `weightsDir` argument (typically
 * `state.config.paths.cacheDir`, i.e. ~/.laqrumcode/cache). The legacy default
 * is kept here for un-passed callers so existing installs keep working until
 * the one-time forward-migration in maintenance.ts runs.
 */
function getLaqrumDir() {
    const dir = join(homedir(), ".laqrumbrain");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
const DEFAULT_TRAINING_CONFIG = {
    epochs: 80,
    lr: 0.001,
    earlyStopPatience: 8,
    lrDecayPatience: 4,
    lrFloor: 0.00005,
    valSplit: 0.2,
};
// ── Weight loading / saving ──
function loadWeights(path) {
    try {
        if (!existsSync(path))
            return null;
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        if (raw.version !== 2)
            return null;
        if (!Array.isArray(raw.W_q) || raw.W_q.length !== EMBED_DIM)
            return null;
        if (!Array.isArray(raw.W_k) || raw.W_k.length !== EMBED_DIM)
            return null;
        if (!Array.isArray(raw.W_final) || raw.W_final.length !== FEATURE_COUNT)
            return null;
        if (typeof raw.bias !== "number")
            return null;
        // Validate inner dimensions — check first, middle, and last rows to catch crafted files
        const checkIndices = [0, Math.floor(EMBED_DIM / 2), EMBED_DIM - 1];
        for (const i of checkIndices) {
            if (!Array.isArray(raw.W_q[i]) || raw.W_q[i].length !== ATTN_DIM)
                return null;
            if (!Array.isArray(raw.W_k[i]) || raw.W_k[i].length !== ATTN_DIM)
                return null;
        }
        // Validate numeric values — NaN/Infinity from a bad training run would corrupt scoring.
        // JSON.stringify(NaN) produces null, so we must also reject null/non-number values.
        if (typeof raw.bias !== "number" || !isFinite(raw.bias))
            return null;
        if (!raw.W_final.every((v) => typeof v === "number" && isFinite(v)))
            return null;
        // Spot-check W_q/W_k (full scan too expensive for 1024x64 matrices)
        for (const i of checkIndices) {
            if (!raw.W_q[i].every((v) => typeof v === "number" && isFinite(v)))
                return null;
            if (!raw.W_k[i].every((v) => typeof v === "number" && isFinite(v)))
                return null;
        }
        return raw;
    }
    catch (e) {
        swallow("acan:loadWeights", e);
        return null;
    }
}
// Monotonic per-process counter to disambiguate concurrent saveWeights
// callers within the same PID. Worker threads share process.pid; without
// this, two workers finishing at the same time would write to the same
// `${path}.${pid}.tmp` file and one's data would silently overwrite the
// other's before the rename. v0.7.95 fix.
let _saveWeightsCounter = 0;
function saveWeights(weights, path) {
    // Atomic write: multiple MCPs / worker threads can train concurrently,
    // so a partial write from one caller must not be visible to another
    // reading the file, AND two concurrent in-process callers must not
    // collide on the same tmp file. write-to-tmp then rename() is atomic
    // on the same filesystem; the (pid, counter, random) suffix is unique
    // per saveWeights call so concurrent workers never share a tmp path.
    const dir = join(path, "..");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const uniq = `${process.pid}.${++_saveWeightsCounter}.${Math.random().toString(36).slice(2, 8)}`;
    const tmpPath = `${path}.${uniq}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(weights), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, path);
}
export function initACAN(weightsDir) {
    _weightsDir = weightsDir;
    const dir = weightsDir ?? getLaqrumDir();
    const path = join(dir, WEIGHTS_FILENAME);
    _weights = loadWeights(path);
    _active = _weights !== null;
    try {
        _loadedMtime = existsSync(path) ? statSync(path).mtimeMs : 0;
    }
    catch {
        _loadedMtime = 0;
    }
    return _active;
}
export function isACANActive() {
    return _active;
}
/**
 * Hot-reload weights if the file has been rewritten since we last loaded.
 * Lets sibling MCP processes' retrains take effect here without a restart.
 * Cheap when nothing's changed (one statSync per score call).
 *
 * Concurrent invocations: under burst load two scoring calls could both
 * observe `mtime > _loadedMtime` and both invoke initACAN(). The
 * `_reloading` Promise mutex serializes them — if a reload is already in
 * flight, the second caller skips re-reading entirely (the first call's
 * results will be visible to the next score). The mutex is cleared in a
 * finally so a transient FS error doesn't strand future reloads.
 */
function maybeReloadWeights() {
    if (!_weights)
        return;
    if (_reloading)
        return; // mutex held — first caller is responsible
    const dir = _weightsDir ?? getLaqrumDir();
    const path = join(dir, WEIGHTS_FILENAME);
    // Track whether THIS invocation acquired the mutex. The outer catch must
    // only clear `_reloading` if we set it here — otherwise a transient FS
    // error from a non-acquiring path would strand a legitimate in-flight
    // reload owned by an earlier caller.
    let acquiredReloading = false;
    try {
        if (!existsSync(path))
            return;
        const mtime = statSync(path).mtimeMs;
        if (mtime > _loadedMtime) {
            _reloading = (async () => {
                try {
                    initACAN(_weightsDir);
                    log.info(`[acan] hot-reloaded weights (sibling MCP retrained)`);
                }
                finally {
                    _reloading = null;
                }
            })();
            acquiredReloading = true;
            // Detach: scoreWithACAN's signature stays sync. The current score
            // call uses the prior weights; subsequent calls pick up the new
            // weights once the mutex clears.
            _reloading.catch(() => { });
        }
    }
    catch {
        /* non-fatal, keep current weights */
        if (acquiredReloading)
            _reloading = null;
    }
}
// ── Linear algebra ──
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += a[i] * b[i];
    return sum;
}
function projectVec(vec, matrix) {
    const out = new Array(matrix[0].length).fill(0);
    for (let i = 0; i < vec.length; i++) {
        if (vec[i] === 0)
            continue;
        const row = matrix[i];
        for (let j = 0; j < out.length; j++)
            out[j] += vec[i] * row[j];
    }
    return out;
}
// ── ACAN inference ──
export function scoreWithACAN(queryEmbedding, candidates) {
    maybeReloadWeights();
    if (!_weights || candidates.length === 0)
        return [];
    const q = projectVec(queryEmbedding, _weights.W_q);
    const scale = Math.sqrt(ATTN_DIM);
    const scores = [];
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
async function getTrainingDataCount(store) {
    if (!store.isAvailable())
        return 0;
    try {
        const flat = await store.queryFirst(`SELECT count() AS count FROM retrieval_outcome WHERE query_embedding != NONE AND aux_features != NONE GROUP ALL`);
        return flat[0]?.count ?? 0;
    }
    catch (e) {
        swallow("acan:count", e);
        return 0;
    }
}
async function fetchTrainingData(store) {
    if (!store.isAvailable())
        return [];
    const outcomes = await store.queryFirst(`SELECT query_embedding, memory_id, memory_table,
            IF llm_relevance != NONE THEN llm_relevance ELSE utilization END AS utilization,
            retrieval_score, was_neighbor,
            importance, access_count, recency, aux_features, created_at
     FROM retrieval_outcome
     WHERE query_embedding != NONE AND aux_features != NONE
     ORDER BY created_at DESC
     LIMIT $maxSamples`, { maxSamples: MAX_TRAINING_SAMPLES });
    if (outcomes.length === 0)
        return [];
    const uniqueMemIds = [...new Set(outcomes.map((r) => String(r.memory_id)))];
    const embeddingMap = new Map();
    // Group IDs by table for batched fetches instead of one query per ID
    const byTable = new Map();
    for (const mid of uniqueMemIds) {
        try {
            assertRecordId(mid);
            const table = mid.split(":")[0];
            if (!byTable.has(table))
                byTable.set(table, []);
            byTable.get(table).push(mid);
        }
        catch { /* skip invalid */ }
    }
    await Promise.all([...byTable.entries()].map(async ([table, ids]) => {
        try {
            // Direct interpolation — SurrealDB treats string-array bindings as
            // literal strings, not record references, causing silent empty results.
            const idList = ids.join(", ");
            const rows = await store.queryFirst(`SELECT id, embedding FROM ${table} WHERE id IN [${idList}] AND embedding != NONE`);
            for (const row of rows) {
                if (row.embedding)
                    embeddingMap.set(String(row.id), row.embedding);
            }
        }
        catch (e) {
            swallow("acan:fetchEmb", e);
        }
    }));
    const samples = [];
    for (const row of outcomes) {
        const memEmb = embeddingMap.get(String(row.memory_id));
        if (!memEmb || !row.query_embedding)
            continue;
        // Train/inference parity: require the exact 6-element aux-vector captured at
        // scoring time (graph-context.ts). Rows from before this field existed are
        // skipped — they carry the pre-parity feature semantics (hardcoded-zero
        // provenUtility/reflectionBoost, mis-scaled access) and would re-teach the
        // old skew. getTrainingDataCount mirrors the `aux_features != NONE` gate.
        if (!Array.isArray(row.aux_features) || row.aux_features.length !== 6)
            continue;
        samples.push({
            query_embedding: row.query_embedding,
            memory_embedding: memEmb,
            retrieval_score: row.retrieval_score ?? 0,
            was_neighbor: row.was_neighbor ?? false,
            utilization: row.utilization ?? 0,
            importance: row.importance ?? 0.5,
            access_count: row.access_count ?? 0,
            recency: row.recency ?? 0.5,
            aux_features: row.aux_features,
        });
    }
    return samples;
}
// ── Background training ──
// Exported as a test seam (K34): lets the regression test capture the Worker
// payload + transferList without standing up a real DB / training cycle.
export function trainInBackground(samples, weightsPath, warmStart, config, releaseLock) {
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
    const auxFeatures = samples.map(s => s.aux_features);
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
    parentPort.postMessage({ weights: { W_q, W_k, W_final, bias, version: 2, trainedAt: Date.now(), trainedOnSamples: n }, trainLoss: lastTrainLoss, valLoss: bestValLoss, actualEpochs, finalLr: lr, config: cfg });
  `;
    // K34: the embedding floats dominate the payload — MAX_TRAINING_SAMPLES
    // (15000) samples x 2 embeddings x EMBED_DIM (1024) doubles. Passing them as
    // plain number[] in workerData structured-clones the whole lot into the
    // worker (a second full copy on top of the JS arrays already materialized in
    // the parent — the ~245MB + ~490MB peak). Instead, pack each embedding into
    // its own Float32Array and TRANSFER the backing ArrayBuffers via
    // transferList: the buffers are MOVED into the worker (zero-copy), not
    // duplicated. Float32Array is a drop-in for the worker's dot()/projectVec()
    // (index access + .length only).
    //
    // Each sample gets a FRESH Float32Array so every buffer is unique —
    // embeddingMap reuses the same memory_embedding array instance across
    // outcomes that hit the same memory_id, and transferring one ArrayBuffer
    // twice throws "already detached". The single Float32Array copy here
    // replaces the structured-clone copy that would otherwise happen, so this is
    // still a net reduction (and kills the double-copy peak in the worker).
    //
    // NB: transfer DETACHES the parent's buffers. `samples` must not be read
    // after this point — callers (checkACANReadiness) spawn-and-forget, so OK.
    const transferList = [];
    const packedSamples = samples.map(s => {
        const qe = Float32Array.from(s.query_embedding);
        const me = Float32Array.from(s.memory_embedding);
        transferList.push(qe.buffer, me.buffer);
        return {
            query_embedding: qe,
            memory_embedding: me,
            retrieval_score: s.retrieval_score,
            was_neighbor: s.was_neighbor,
            utilization: s.utilization,
            importance: s.importance,
            access_count: s.access_count,
            recency: s.recency,
            aux_features: s.aux_features,
        };
    });
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerCode)}`), {
        workerData: { samples: packedSamples, cfg, warmStart: warmStart ?? null, EMBED_DIM, ATTN_DIM, FEATURE_COUNT },
        transferList,
    });
    worker.unref();
    worker.on("message", (msg) => {
        try {
            saveWeights(msg.weights, weightsPath);
            _weights = msg.weights;
            _active = true;
            log.info(`[acan] training complete: trainedOn=${msg.weights.trainedOnSamples} valLoss=${msg.valLoss?.toFixed?.(4) ?? "?"} epochs=${msg.actualEpochs ?? "?"}`);
        }
        catch (e) {
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
export async function checkACANReadiness(store, trainingThreshold, weightsDir) {
    if (!store)
        return;
    const threshold = trainingThreshold ?? TRAINING_THRESHOLD;
    const dir = weightsDir ?? getLaqrumDir();
    const weightsPath = join(dir, WEIGHTS_FILENAME);
    const hasWeights = initACAN(weightsDir);
    const count = await getTrainingDataCount(store);
    if (hasWeights && _weights) {
        const trainedOn = _weights.trainedOnSamples ?? 0;
        const trainedAt = _weights.trainedAt ?? 0;
        const growthRatio = trainedOn > 0 ? (count - trainedOn) / trainedOn : Infinity;
        const ageMs = Date.now() - trainedAt;
        const isStale = growthRatio >= STALENESS_GROWTH_FACTOR || ageMs >= STALENESS_MAX_AGE_MS;
        if (!isStale)
            return;
    }
    else if (count < threshold) {
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
    }
    catch (e) {
        swallow.warn("acan:readiness", e);
        releaseLock();
    }
}
