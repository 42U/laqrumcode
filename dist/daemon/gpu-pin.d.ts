export type GpuPinSource = "env:CUDA_VISIBLE_DEVICES" | "env:KONGCODE_CUDA_VISIBLE_DEVICES" | "file";
export interface GpuPinResult {
    /** True only when this call mutated CUDA_VISIBLE_DEVICES. */
    applied: boolean;
    value?: string;
    source?: GpuPinSource;
}
/** Path to the optional file knob (default: ~/.kongcode/cuda-visible-devices). */
export declare function gpuPinFilePath(home?: string): string;
/**
 * Resolve the configured pin WITHOUT mutating anything (pure → testable).
 * Returns `applied:false` (no value) when nothing is configured.
 */
export declare function resolveGpuPin(env?: NodeJS.ProcessEnv, home?: string): GpuPinResult;
/**
 * Apply the resolved pin to `env` (default process.env) before CUDA init.
 * No-op when nothing is configured, or when CUDA_VISIBLE_DEVICES is already set
 * (operator wins). Returns what it did, for logging.
 */
export declare function applyGpuPin(env?: NodeJS.ProcessEnv, home?: string): GpuPinResult;
