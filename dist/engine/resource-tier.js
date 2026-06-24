import { cpus, totalmem } from "node:os";
export function detectResourceProfile() {
    const override = process.env.LAQRUMCODE_RESOURCE_TIER;
    const totalRamMb = Math.round(totalmem() / (1024 * 1024));
    const cpuCount = cpus().length;
    const noGpu = process.env.LAQRUMCODE_NO_GPU === "1";
    const validTiers = ["constrained", "standard", "generous"];
    if (override && !validTiers.includes(override)) {
        console.warn(`[resource-tier] Invalid LAQRUMCODE_RESOURCE_TIER="${override}", falling back to auto-detect`);
    }
    const tier = override && validTiers.includes(override)
        ? override
        : totalRamMb <= 3072 || cpuCount <= 2
            ? "constrained"
            : totalRamMb > 8192 && cpuCount >= 8
                ? "generous"
                : "standard";
    switch (tier) {
        case "constrained":
            return {
                tier,
                totalRamMb,
                cpuCount,
                llamaMaxThreads: Math.max(1, cpuCount),
                llamaGpu: false,
                idleTimeoutMs: 300_000,
                drainIntervalMs: 15 * 60_000,
            };
        case "generous":
            return {
                tier,
                totalRamMb,
                cpuCount,
                llamaMaxThreads: Math.max(4, cpuCount - 2),
                llamaGpu: noGpu ? false : "auto",
                idleTimeoutMs: 60_000,
                drainIntervalMs: 5 * 60_000,
            };
        default:
            return {
                tier,
                totalRamMb,
                cpuCount,
                llamaMaxThreads: Math.max(2, cpuCount - 1),
                llamaGpu: noGpu ? false : "auto",
                idleTimeoutMs: 60_000,
                drainIntervalMs: 5 * 60_000,
            };
    }
}
