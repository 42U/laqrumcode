export type GpuPinSource = "env:CUDA_VISIBLE_DEVICES" | "env:KONGCODE_NO_GPU" | "env:KONGCODE_CUDA_VISIBLE_DEVICES" | "file";
export type GpuPinMode = "gpu" | "cpu";
export interface GpuPinResult {
    /** True only when this call mutated the environment. */
    applied: boolean;
    mode?: GpuPinMode;
    value?: string;
    source?: GpuPinSource;
}
/** Path to the optional file knob (default: ~/.kongcode/cuda-visible-devices). */
export declare function gpuPinFilePath(home?: string): string;
/**
 * Resolve the configured selection WITHOUT mutating anything (pure → testable).
 * `applied` is always false here; `applyGpuPin` is what mutates `env`.
 */
export declare function resolveGpuPin(env?: NodeJS.ProcessEnv, home?: string): GpuPinResult;
/**
 * Apply the resolved selection to `env` (default process.env). No-op when
 * nothing is configured, or when the operator already set CUDA_VISIBLE_DEVICES /
 * KONGCODE_NO_GPU. Returns what it did, for logging.
 */
export declare function applyGpuPin(env?: NodeJS.ProcessEnv, home?: string): GpuPinResult;
