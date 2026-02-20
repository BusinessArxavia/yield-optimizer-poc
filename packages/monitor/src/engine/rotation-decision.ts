/**
 * Rotation Decision Engine
 *
 * Evaluates whether capital should be rotated from current positions to
 * higher-yielding pools. Respects configurable thresholds for minimum
 * yield spread, break-even days, per-chain exposure limits, and max
 * rotation size.
 */

import type {
  RotationCandidate,
  RotationConfig,
  DEFAULT_ROTATION_CONFIG,
} from "@yield-optimizer/shared";
import type { EnrichedPool } from "./yield-calculator.js";
import { estimateRotationCost } from "./rotation-cost.js";

export interface CurrentPosition {
  chainId: number;
  stablecoin: string;
  /** Amount in base units */
  amount: bigint;
  /** Decimals for the stablecoin (6 for USDC/USDT, 18 for DAI/GHO) */
  decimals: number;
  /** Current net APY (decimal) */
  currentAPY: number;
}

/**
 * Evaluate all possible rotations from current positions to better pools.
 *
 * Returns candidates sorted by net annualized benefit (descending).
 * Each candidate includes a `recommended` flag based on config thresholds.
 *
 * @param positions — Current capital positions
 * @param pools — All available pools (sorted by netAPY from yield calculator)
 * @param config — Rotation thresholds
 */
export async function evaluateRotations(
  positions: CurrentPosition[],
  pools: EnrichedPool[],
  config: RotationConfig,
): Promise<RotationCandidate[]> {
  const candidates: RotationCandidate[] = [];
  const totalCapitalUSD = calculateTotalCapitalUSD(positions);

  for (const position of positions) {
    const amountUSD = baseUnitsToUSD(position.amount, position.decimals);

    // Find pools that are better than the current position
    for (const pool of pools) {
      // Skip same chain + same stablecoin (no rotation needed)
      if (
        pool.chainId === position.chainId &&
        pool.stablecoin === position.stablecoin
      ) {
        continue;
      }

      const yieldImprovement = pool.netAPY - position.currentAPY;

      // Skip if no improvement
      if (yieldImprovement <= 0) continue;

      // Calculate rotation amount (capped by config)
      const maxRotationUSD =
        totalCapitalUSD * (config.maxRotationPct / 100);
      const rotationUSD = Math.min(amountUSD, maxRotationUSD);
      const rotationAmount = usdToBaseUnits(
        rotationUSD,
        position.decimals,
      );

      // Estimate rotation cost
      let estimatedCost: number;
      try {
        const costBreakdown = await estimateRotationCost(
          position.chainId,
          pool.chainId,
          position.stablecoin,
          rotationAmount,
        );
        estimatedCost = costBreakdown.totalCostUSD;
      } catch {
        // If cost estimation fails, skip this candidate
        continue;
      }

      // Calculate economics
      const dailyGain = (yieldImprovement * rotationUSD) / 365;
      const breakEvenDays =
        dailyGain > 0 ? estimatedCost / dailyGain : Infinity;
      const netBenefitAnnualized =
        yieldImprovement * rotationUSD - estimatedCost;

      // Check thresholds for recommendation
      const spreadBps = yieldImprovement * 10_000;
      const recommended =
        spreadBps >= config.minSpreadBps &&
        breakEvenDays <= config.maxBreakEvenDays &&
        isWithinExposureLimits(
          pool.chainId,
          rotationUSD,
          positions,
          totalCapitalUSD,
          config,
        ) &&
        hasSupplyCapHeadroom(pool, rotationAmount);

      candidates.push({
        from: {
          chainId: position.chainId,
          stablecoin: position.stablecoin,
          currentAPY: position.currentAPY,
        },
        to: {
          chainId: pool.chainId,
          stablecoin: pool.stablecoin,
          targetAPY: pool.netAPY,
        },
        yieldImprovement,
        estimatedCost,
        dailyGain,
        breakEvenDays,
        netBenefitAnnualized,
        recommended,
      });
    }
  }

  // Sort by net benefit descending
  candidates.sort((a, b) => b.netBenefitAnnualized - a.netBenefitAnnualized);

  return candidates;
}

/**
 * Get only recommended rotations (those passing all threshold checks).
 */
export function getRecommendedRotations(
  candidates: RotationCandidate[],
): RotationCandidate[] {
  return candidates.filter((c) => c.recommended);
}

// --- Internal helpers ---

function calculateTotalCapitalUSD(positions: CurrentPosition[]): number {
  return positions.reduce(
    (sum, p) => sum + baseUnitsToUSD(p.amount, p.decimals),
    0,
  );
}

function baseUnitsToUSD(amount: bigint, decimals: number): number {
  return Number(amount) / Math.pow(10, decimals);
}

function usdToBaseUnits(usd: number, decimals: number): bigint {
  return BigInt(Math.round(usd * Math.pow(10, decimals)));
}

/**
 * Check if rotating to a chain would exceed per-chain exposure limits.
 */
function isWithinExposureLimits(
  targetChainId: number,
  rotationUSD: number,
  positions: CurrentPosition[],
  totalCapitalUSD: number,
  config: RotationConfig,
): boolean {
  if (totalCapitalUSD === 0) return true;

  // Current exposure on target chain
  const currentExposureUSD = positions
    .filter((p) => p.chainId === targetChainId)
    .reduce((sum, p) => sum + baseUnitsToUSD(p.amount, p.decimals), 0);

  const newExposureUSD = currentExposureUSD + rotationUSD;
  const newExposurePct = (newExposureUSD / totalCapitalUSD) * 100;

  return newExposurePct <= config.maxPerChainPct;
}

/**
 * Check if a pool has enough supply cap headroom for the rotation amount.
 */
function hasSupplyCapHeadroom(
  pool: EnrichedPool,
  amount: bigint,
): boolean {
  // If supply cap is 0, it means unlimited
  if (pool.supplyCap === 0n) return true;
  return pool.supplyCapHeadroom >= amount;
}
