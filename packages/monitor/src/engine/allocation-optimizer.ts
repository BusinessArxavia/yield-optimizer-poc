/**
 * Allocation Optimizer
 *
 * Given total capital and all pool yields, computes the theoretical optimal
 * allocation using a greedy algorithm. Respects per-chain limits and
 * supply cap headroom.
 *
 * Compares theoretical optimal vs current allocation to produce a delta
 * showing what needs to move and where.
 */

import type { RotationConfig } from "@yield-optimizer/shared";
import type { EnrichedPool } from "./yield-calculator.js";
import type { CurrentPosition } from "./rotation-decision.js";

export interface AllocationTarget {
  chainId: number;
  chainName: string;
  stablecoin: string;
  tokenAddress: `0x${string}`;
  /** Net APY of this pool */
  netAPY: number;
  /** Optimal USD allocation */
  allocationUSD: number;
  /** Percentage of total capital */
  allocationPct: number;
}

export interface AllocationDelta {
  chainId: number;
  stablecoin: string;
  /** Current USD allocation */
  currentUSD: number;
  /** Optimal USD allocation */
  targetUSD: number;
  /** Delta: positive = add, negative = remove */
  deltaUSD: number;
  /** Net APY at this pool */
  netAPY: number;
}

export interface OptimalAllocation {
  /** Theoretical best allocation */
  targets: AllocationTarget[];
  /** Differences from current allocation */
  deltas: AllocationDelta[];
  /** Weighted average APY of the optimal allocation */
  weightedAPY: number;
  /** Current weighted average APY */
  currentWeightedAPY: number;
  /** Theoretical improvement in APY */
  apyImprovement: number;
}

/**
 * Compute the theoretical optimal allocation using a greedy algorithm.
 *
 * Strategy: Allocate to the highest net APY pool first, up to the lesser of:
 *   - Per-chain limit (maxPerChainPct of total capital)
 *   - Supply cap headroom
 * Then move to the next-best pool, and so on.
 *
 * @param totalCapitalUSD — Total capital to allocate
 * @param pools — Available pools sorted by netAPY (from yield calculator)
 * @param config — Rotation config with per-chain limits
 * @param currentPositions — Current allocation (for delta calculation)
 * @param stablecoinDecimals — Decimals for stablecoins (default 6 for USDC)
 */
export function computeOptimalAllocation(
  totalCapitalUSD: number,
  pools: EnrichedPool[],
  config: RotationConfig,
  currentPositions: CurrentPosition[] = [],
  stablecoinDecimals = 6,
): OptimalAllocation {
  const targets: AllocationTarget[] = [];
  let remaining = totalCapitalUSD;
  const chainAllocation = new Map<number, number>(); // chainId → USD allocated
  const maxPerChainUSD = totalCapitalUSD * (config.maxPerChainPct / 100);

  for (const pool of pools) {
    if (remaining <= 0) break;
    if (pool.netAPY <= 0) break; // Skip zero/negative yield pools

    // Per-chain limit
    const currentChainAlloc = chainAllocation.get(pool.chainId) ?? 0;
    const chainHeadroom = maxPerChainUSD - currentChainAlloc;
    if (chainHeadroom <= 0) continue;

    // Supply cap headroom (convert from base units to USD)
    const capHeadroomUSD =
      pool.supplyCap === 0n
        ? Infinity
        : Number(pool.supplyCapHeadroom) / Math.pow(10, stablecoinDecimals);

    // Allocate the minimum of: remaining capital, chain headroom, supply cap headroom
    const allocation = Math.min(remaining, chainHeadroom, capHeadroomUSD);

    if (allocation <= 0) continue;

    targets.push({
      chainId: pool.chainId,
      chainName: pool.chainName,
      stablecoin: pool.stablecoin,
      tokenAddress: pool.tokenAddress,
      netAPY: pool.netAPY,
      allocationUSD: allocation,
      allocationPct:
        totalCapitalUSD > 0 ? (allocation / totalCapitalUSD) * 100 : 0,
    });

    remaining -= allocation;
    chainAllocation.set(pool.chainId, currentChainAlloc + allocation);
  }

  // Calculate weighted APY for optimal allocation
  const weightedAPY = calculateWeightedAPY(targets, totalCapitalUSD);

  // Calculate current weighted APY
  const currentWeightedAPY = calculateCurrentWeightedAPY(
    currentPositions,
    totalCapitalUSD,
  );

  // Calculate deltas
  const deltas = calculateDeltas(targets, currentPositions);

  return {
    targets,
    deltas,
    weightedAPY,
    currentWeightedAPY,
    apyImprovement: weightedAPY - currentWeightedAPY,
  };
}

// --- Internal helpers ---

function calculateWeightedAPY(
  targets: AllocationTarget[],
  totalCapitalUSD: number,
): number {
  if (totalCapitalUSD === 0) return 0;

  const weightedSum = targets.reduce(
    (sum, t) => sum + t.netAPY * t.allocationUSD,
    0,
  );
  return weightedSum / totalCapitalUSD;
}

function calculateCurrentWeightedAPY(
  positions: CurrentPosition[],
  totalCapitalUSD: number,
): number {
  if (totalCapitalUSD === 0 || positions.length === 0) return 0;

  const weightedSum = positions.reduce((sum, p) => {
    const usd = Number(p.amount) / Math.pow(10, p.decimals);
    return sum + p.currentAPY * usd;
  }, 0);

  return weightedSum / totalCapitalUSD;
}

function calculateDeltas(
  targets: AllocationTarget[],
  currentPositions: CurrentPosition[],
): AllocationDelta[] {
  // Build a map of all chain+stablecoin pairs
  const keys = new Set<string>();
  const currentMap = new Map<string, { usd: number; apy: number }>();
  const targetMap = new Map<
    string,
    { usd: number; apy: number; chainId: number; stablecoin: string }
  >();

  for (const pos of currentPositions) {
    const key = `${pos.chainId}:${pos.stablecoin}`;
    keys.add(key);
    currentMap.set(key, {
      usd: Number(pos.amount) / Math.pow(10, pos.decimals),
      apy: pos.currentAPY,
    });
  }

  for (const target of targets) {
    const key = `${target.chainId}:${target.stablecoin}`;
    keys.add(key);
    targetMap.set(key, {
      usd: target.allocationUSD,
      apy: target.netAPY,
      chainId: target.chainId,
      stablecoin: target.stablecoin,
    });
  }

  const deltas: AllocationDelta[] = [];

  for (const key of keys) {
    const [chainIdStr, stablecoin] = key.split(":");
    const chainId = Number(chainIdStr);
    const current = currentMap.get(key);
    const target = targetMap.get(key);

    const currentUSD = current?.usd ?? 0;
    const targetUSD = target?.usd ?? 0;
    const deltaUSD = targetUSD - currentUSD;

    // Skip deltas that are effectively zero
    if (Math.abs(deltaUSD) < 0.01) continue;

    deltas.push({
      chainId,
      stablecoin,
      currentUSD,
      targetUSD,
      deltaUSD,
      netAPY: target?.apy ?? current?.apy ?? 0,
    });
  }

  // Sort: positive deltas first (add), then negative (remove), by magnitude
  deltas.sort((a, b) => Math.abs(b.deltaUSD) - Math.abs(a.deltaUSD));

  return deltas;
}
