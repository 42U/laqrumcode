/**
 * Unit tests for the opt-in GPU pin (src/daemon/gpu-pin.ts).
 * Pure — passes a fake env object + temp home dir, so no process.env mutation
 * and no SurrealDB; runs anywhere (incl. CI with no GPU).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGpuPin, resolveGpuPin, gpuPinFilePath } from "../src/daemon/gpu-pin.js";

const UUID = "GPU-7f5df344-636c-0882-c48b-1934a99636db";

let homeWithFile: string; // fake home with .laqrumcode/cuda-visible-devices
let homeEmpty: string;    // fake home with no file

beforeAll(async () => {
  homeWithFile = await mkdtemp(join(tmpdir(), "kc-gpupin-with-"));
  homeEmpty = await mkdtemp(join(tmpdir(), "kc-gpupin-none-"));
  await mkdir(join(homeWithFile, ".laqrumcode"), { recursive: true });
  await writeFile(gpuPinFilePath(homeWithFile), `${UUID}\n`, "utf8");
});
afterAll(async () => {
  await rm(homeWithFile, { recursive: true, force: true }).catch(() => {});
  await rm(homeEmpty, { recursive: true, force: true }).catch(() => {});
});

describe("gpu-pin (opt-in, no-op by default)", () => {
  it("is a no-op when nothing is configured — single-GPU / CPU-only users unaffected", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyGpuPin(env, homeEmpty);
    expect(r.applied).toBe(false);
    expect(env.CUDA_VISIBLE_DEVICES).toBeUndefined();
    expect(env.CUDA_DEVICE_ORDER).toBeUndefined();
  });

  it("applies LAQRUMCODE_CUDA_VISIBLE_DEVICES and defaults CUDA_DEVICE_ORDER=PCI_BUS_ID", () => {
    const env: NodeJS.ProcessEnv = { LAQRUMCODE_CUDA_VISIBLE_DEVICES: UUID };
    const r = applyGpuPin(env, homeEmpty);
    expect(r).toMatchObject({ applied: true, value: UUID, source: "env:LAQRUMCODE_CUDA_VISIBLE_DEVICES" });
    expect(env.CUDA_VISIBLE_DEVICES).toBe(UUID);
    expect(env.CUDA_DEVICE_ORDER).toBe("PCI_BUS_ID");
  });

  it("leaves an operator-set CUDA_VISIBLE_DEVICES untouched (no override)", () => {
    const env: NodeJS.ProcessEnv = { CUDA_VISIBLE_DEVICES: "0", LAQRUMCODE_CUDA_VISIBLE_DEVICES: UUID };
    const r = applyGpuPin(env, homeWithFile);
    expect(r.applied).toBe(false);
    expect(env.CUDA_VISIBLE_DEVICES).toBe("0");
  });

  it("applies the ~/.laqrumcode/cuda-visible-devices file", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyGpuPin(env, homeWithFile);
    expect(r).toMatchObject({ applied: true, value: UUID, source: "file" });
    expect(env.CUDA_VISIBLE_DEVICES).toBe(UUID);
  });

  it("env knob beats the file", () => {
    const env: NodeJS.ProcessEnv = { LAQRUMCODE_CUDA_VISIBLE_DEVICES: "GPU-other" };
    const r = applyGpuPin(env, homeWithFile);
    expect(r.source).toBe("env:LAQRUMCODE_CUDA_VISIBLE_DEVICES");
    expect(env.CUDA_VISIBLE_DEVICES).toBe("GPU-other");
  });

  it("keeps a pre-set CUDA_DEVICE_ORDER", () => {
    const env: NodeJS.ProcessEnv = { LAQRUMCODE_CUDA_VISIBLE_DEVICES: UUID, CUDA_DEVICE_ORDER: "FASTEST_FIRST" };
    applyGpuPin(env, homeEmpty);
    expect(env.CUDA_DEVICE_ORDER).toBe("FASTEST_FIRST");
  });

  it("resolveGpuPin is pure — it does not mutate env", () => {
    const env: NodeJS.ProcessEnv = { LAQRUMCODE_CUDA_VISIBLE_DEVICES: UUID };
    const r = resolveGpuPin(env, homeEmpty);
    expect(r.value).toBe(UUID);
    expect(env.CUDA_VISIBLE_DEVICES).toBeUndefined();
  });
});
