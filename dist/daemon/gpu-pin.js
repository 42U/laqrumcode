/**
 * Optional GPU pinning for the kongcode daemon's node-llama-cpp CUDA context.
 *
 * node-llama-cpp's `getLlama({ gpu })` only selects the BACKEND (cuda/vulkan/
 * metal), never a device — so on a multi-GPU CUDA box it grabs ALL GPUs by
 * default. This lets an operator pin ONLY the kongcode daemon to specific
 * GPU(s) without forcing every other CUDA process onto them.
 *
 * It is strictly OPT-IN: with nothing configured, `applyGpuPin` is a no-op and
 * the daemon behaves exactly as before — so single-GPU, CPU-only, and non-CUDA
 * (Apple Metal) users are entirely unaffected.
 *
 * Configuration resolution order:
 *   1. CUDA_VISIBLE_DEVICES already set in the env  → leave it (operator pinned
 *      the whole process tree explicitly; we don't override).
 *   2. KONGCODE_CUDA_VISIBLE_DEVICES env             → daemon-scoped knob.
 *   3. ~/.kongcode/cuda-visible-devices file         → one line; lets a running
 *      daemon be (re)pinned without changing how the mcp-client launched it.
 *
 * The value is whatever CUDA accepts for CUDA_VISIBLE_DEVICES — prefer a GPU
 * UUID ("GPU-xxxx…") over a numeric index, since indices depend on
 * CUDA_DEVICE_ORDER (which we default to PCI_BUS_ID for nvidia-smi parity).
 *
 * MUST be called before getSharedLlama()/embeddings init creates the CUDA
 * context (CUDA reads CUDA_VISIBLE_DEVICES at first cuInit).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
/** Path to the optional file knob (default: ~/.kongcode/cuda-visible-devices). */
export function gpuPinFilePath(home = homedir()) {
    return join(home, ".kongcode", "cuda-visible-devices");
}
/**
 * Resolve the configured pin WITHOUT mutating anything (pure → testable).
 * Returns `applied:false` (no value) when nothing is configured.
 */
export function resolveGpuPin(env = process.env, home = homedir()) {
    if (env.CUDA_VISIBLE_DEVICES) {
        return { applied: false, value: env.CUDA_VISIBLE_DEVICES, source: "env:CUDA_VISIBLE_DEVICES" };
    }
    const fromEnv = env.KONGCODE_CUDA_VISIBLE_DEVICES?.trim();
    if (fromEnv)
        return { applied: false, value: fromEnv, source: "env:KONGCODE_CUDA_VISIBLE_DEVICES" };
    try {
        const f = gpuPinFilePath(home);
        if (existsSync(f)) {
            const v = readFileSync(f, "utf8").trim();
            if (v)
                return { applied: false, value: v, source: "file" };
        }
    }
    catch { /* ignore — unreadable file is treated as "not configured" */ }
    return { applied: false };
}
/**
 * Apply the resolved pin to `env` (default process.env) before CUDA init.
 * No-op when nothing is configured, or when CUDA_VISIBLE_DEVICES is already set
 * (operator wins). Returns what it did, for logging.
 */
export function applyGpuPin(env = process.env, home = homedir()) {
    const r = resolveGpuPin(env, home);
    // Only the KONGCODE_ env and the file are ours to apply; a pre-set
    // CUDA_VISIBLE_DEVICES is left untouched, and "nothing configured" is a no-op.
    if (!r.value || r.source === "env:CUDA_VISIBLE_DEVICES")
        return { applied: false };
    env.CUDA_VISIBLE_DEVICES = r.value;
    if (!env.CUDA_DEVICE_ORDER)
        env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
    return { applied: true, value: r.value, source: r.source };
}
