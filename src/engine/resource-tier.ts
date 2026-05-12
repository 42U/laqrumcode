import { cpus, totalmem } from "node:os";

export type ResourceTier = "constrained" | "standard" | "generous";

export interface ResourceProfile {
  tier: ResourceTier;
  totalRamMb: number;
  cpuCount: number;
  llamaMaxThreads: number;
  llamaGpu: false | "auto";
  idleTimeoutMs: number;
  drainIntervalMs: number;
}

export function detectResourceProfile(): ResourceProfile {
  const override = process.env.KONGCODE_RESOURCE_TIER as ResourceTier | undefined;
  const totalRamMb = Math.round(totalmem() / (1024 * 1024));
  const cpuCount = cpus().length;
  const noGpu = process.env.KONGCODE_NO_GPU === "1";

  const validTiers = ["constrained", "standard", "generous"];
  if (override && !validTiers.includes(override)) {
    console.warn(`[resource-tier] Invalid KONGCODE_RESOURCE_TIER="${override}", falling back to auto-detect`);
  }
  const tier: ResourceTier =
    override && validTiers.includes(override)
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
