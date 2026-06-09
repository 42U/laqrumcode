/**
 * Optional GPU/CPU selection for the kongcode daemon's node-llama-cpp backend.
 *
 * node-llama-cpp's `getLlama({ gpu })` selects the BACKEND (cuda/vulkan/metal),
 * never a device, so on a multi-GPU CUDA box it grabs ALL GPUs by default. This
 * lets an operator pin ONLY the kongcode daemon to specific GPU(s) — or force it
 * onto CPU entirely — without affecting other CUDA processes.
 *
 * Strictly OPT-IN: with nothing configured, `applyGpuPin` is a no-op and the
 * daemon behaves exactly as before (node-llama-cpp 'auto'). Single-GPU,
 * CPU-only, and Apple-Metal users are unaffected.
 *
 * One knob (env or file), resolved in this order:
 *   1. CUDA_VISIBLE_DEVICES already set → leave it (operator pinned explicitly).
 *   2. KONGCODE_NO_GPU=1 already set     → already CPU-only; leave it.
 *   3. KONGCODE_CUDA_VISIBLE_DEVICES env → daemon-scoped knob.
 *   4. ~/.kongcode/cuda-visible-devices  → one line; lets a running daemon be
 *      (re)pinned without changing how the mcp-client launched it.
 *
 * The value is either:
 *   - a DEVICE pin (GPU UUID — preferred — or a numeric index list) → sets
 *     CUDA_VISIBLE_DEVICES + defaults CUDA_DEVICE_ORDER=PCI_BUS_ID; OR
 *   - a CPU sentinel ('cpu' / 'none' / 'off' / 'false' / '-1') → sets
 *     KONGCODE_NO_GPU=1 so resource-tier picks gpu:false → genuine CPU-only
 *     (NOT a CUDA-hide, which can fall through to Vulkan on the same NVIDIA GPU).
 *
 * MUST be called at daemon module-load, BEFORE detectResourceProfile() (which
 * reads KONGCODE_NO_GPU) and before getSharedLlama() inits CUDA.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
/** Values (case-insensitive) that mean "force CPU-only". */
const CPU_SENTINELS = new Set(["cpu", "none", "off", "false", "-1"]);
/** Path to the optional file knob (default: ~/.kongcode/cuda-visible-devices). */
export function gpuPinFilePath(home = homedir()) {
    return join(home, ".kongcode", "cuda-visible-devices");
}
function classify(raw) {
    const v = raw.trim();
    if (CPU_SENTINELS.has(v.toLowerCase()))
        return { mode: "cpu" };
    return { mode: "gpu", value: v };
}
/**
 * Resolve the configured selection WITHOUT mutating anything (pure → testable).
 * `applied` is always false here; `applyGpuPin` is what mutates `env`.
 */
export function resolveGpuPin(env = process.env, home = homedir()) {
    if (env.CUDA_VISIBLE_DEVICES) {
        return { applied: false, mode: "gpu", value: env.CUDA_VISIBLE_DEVICES, source: "env:CUDA_VISIBLE_DEVICES" };
    }
    if (env.KONGCODE_NO_GPU === "1") {
        return { applied: false, mode: "cpu", source: "env:KONGCODE_NO_GPU" };
    }
    const fromEnv = env.KONGCODE_CUDA_VISIBLE_DEVICES?.trim();
    if (fromEnv)
        return { applied: false, ...classify(fromEnv), source: "env:KONGCODE_CUDA_VISIBLE_DEVICES" };
    try {
        const f = gpuPinFilePath(home);
        if (existsSync(f)) {
            const v = readFileSync(f, "utf8").trim();
            if (v)
                return { applied: false, ...classify(v), source: "file" };
        }
    }
    catch { /* unreadable file → treated as "not configured" */ }
    return { applied: false };
}
/**
 * Apply the resolved selection to `env` (default process.env). No-op when
 * nothing is configured, or when the operator already set CUDA_VISIBLE_DEVICES /
 * KONGCODE_NO_GPU. Returns what it did, for logging.
 */
export function applyGpuPin(env = process.env, home = homedir()) {
    const r = resolveGpuPin(env, home);
    // Operator already pinned via a first-class env var → leave it untouched.
    if (r.source === "env:CUDA_VISIBLE_DEVICES" || r.source === "env:KONGCODE_NO_GPU") {
        return { applied: false, mode: r.mode };
    }
    if (r.mode === "cpu") {
        env.KONGCODE_NO_GPU = "1";
        return { applied: true, mode: "cpu", source: r.source };
    }
    if (r.mode === "gpu" && r.value) {
        env.CUDA_VISIBLE_DEVICES = r.value;
        if (!env.CUDA_DEVICE_ORDER)
            env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
        return { applied: true, mode: "gpu", value: r.value, source: r.source };
    }
    return { applied: false };
}
