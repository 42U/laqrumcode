/**
 * K34 regression — ACAN training must hand the embedding floats to the Worker
 * as TRANSFERRED ArrayBuffers (transferList), not structured-cloned number[].
 *
 * The pre-fix code passed `samples` (each with `query_embedding: number[]` +
 * `memory_embedding: number[]`) directly in `workerData`, which structured-
 * clones the entire float payload into the worker — a second full copy on top
 * of the arrays already materialized in the parent (the ~245MB + ~490MB peak
 * the finding targets). The fix packs each embedding into its own Float32Array
 * and transfers the backing buffers (zero-copy move).
 *
 * We mock node:worker_threads to capture the Worker constructor args without
 * running a real training cycle, then assert the transfer contract. Each
 * assertion below FAILS against the pre-fix code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the most recent Worker constructor invocation.
const lastWorker: { workerData?: any; transferList?: any[] } = {};

vi.mock("node:worker_threads", () => {
  class FakeWorker {
    constructor(_url: unknown, opts: { workerData?: any; transferList?: any[] }) {
      lastWorker.workerData = opts?.workerData;
      lastWorker.transferList = opts?.transferList;
    }
    unref() { /* no-op */ }
    on() { /* never emit — we only inspect construction */ return this; }
    terminate() { /* no-op */ }
  }
  return { Worker: FakeWorker };
});

// Import AFTER the mock is registered.
import { trainInBackground } from "../src/engine/acan.js";

const EMBED_DIM = 1024;

function makeSample(qFill: number, mEmbedding: Float64Array | number[]): any {
  return {
    query_embedding: Array.from({ length: EMBED_DIM }, () => qFill),
    memory_embedding: mEmbedding,
    retrieval_score: 0.5,
    was_neighbor: false,
    utilization: 0.4,
    importance: 0.5,
    access_count: 1,
    recency: 0.6,
  };
}

describe("K34: ACAN passes embeddings via transferList (zero-copy)", () => {
  beforeEach(() => { lastWorker.workerData = undefined; lastWorker.transferList = undefined; });

  it("supplies a transferList of ArrayBuffers (not plain number[] payload)", () => {
    const samples = [
      makeSample(0.1, Array.from({ length: EMBED_DIM }, () => 0.2)),
      makeSample(0.3, Array.from({ length: EMBED_DIM }, () => 0.4)),
    ];
    trainInBackground(samples, "/tmp/never-written-k34.json");

    expect(Array.isArray(lastWorker.transferList)).toBe(true);
    // 2 samples x 2 embeddings = 4 buffers transferred.
    expect(lastWorker.transferList!.length).toBe(4);
    for (const buf of lastWorker.transferList!) {
      expect(buf).toBeInstanceOf(ArrayBuffer);
    }
  });

  it("packs each embedding as its own Float32Array in the worker payload", () => {
    const samples = [makeSample(0.1, Array.from({ length: EMBED_DIM }, () => 0.2))];
    trainInBackground(samples, "/tmp/never-written-k34.json");

    const packed = lastWorker.workerData.samples;
    expect(packed).toHaveLength(1);
    expect(packed[0].query_embedding).toBeInstanceOf(Float32Array);
    expect(packed[0].memory_embedding).toBeInstanceOf(Float32Array);
    expect(packed[0].query_embedding.length).toBe(EMBED_DIM);
  });

  it("gives every sample a UNIQUE buffer even when a memory embedding instance is shared (double-detach guard)", () => {
    // embeddingMap reuses the SAME array instance across outcomes hitting the
    // same memory_id. If the fix transferred that shared instance's buffer
    // directly, the second transfer would throw "already detached". A fresh
    // Float32Array per sample guarantees uniqueness.
    const sharedMemEmb = Array.from({ length: EMBED_DIM }, () => 0.7);
    const samples = [makeSample(0.1, sharedMemEmb), makeSample(0.2, sharedMemEmb)];
    trainInBackground(samples, "/tmp/never-written-k34.json");

    const buffers = lastWorker.transferList!;
    const unique = new Set(buffers);
    expect(unique.size).toBe(buffers.length); // no duplicate buffer references
  });
});
