/**
 * Rotation Cost Calculator
 *
 * Combines gas oracle costs (withdraw + approve + supply) with bridge cost
 * to compute the total USD cost of a capital rotation.
 */

import type { BridgeCostEstimate } from "@yield-optimizer/shared";
import { getRotationGasCostUSD } from "../services/gas-oracle.js";
import { estimateBridgeCost } from "../services/bridge-cost.js";

export interface RotationCostBreakdown {
  /** Gas cost: withdraw on source + approve + supply on destination */
  gasCostUSD: number;
  /** Bridge cost (CCTP/Li.Fi/CCIP fee + bridge gas) */
  bridgeCostUSD: number;
  /** Total cost = gas + bridge */
  totalCostUSD: number;
  /** Bridge provider used */
  bridgeProvider: BridgeCostEstimate["provider"] | null;
  /** Estimated bridge duration in seconds */
  bridgeDurationSeconds: number;
}

/**
 * Estimate the total cost of rotating capital from one chain to another.
 *
 * @param fromChainId — Source chain
 * @param toChainId — Destination chain
 * @param stablecoin — Token symbol (e.g. "USDC")
 * @param amount — Amount in base units (e.g. 100_000_000_000n for 100k USDC)
 */
export async function estimateRotationCost(
  fromChainId: number,
  toChainId: number,
  stablecoin: string,
  amount: bigint,
): Promise<RotationCostBreakdown> {
  // Fetch gas costs and bridge costs in parallel
  const [gasCostUSD, bridgeEstimate] = await Promise.all([
    getRotationGasCostUSD(fromChainId, toChainId),
    estimateBridgeCost({ fromChainId, toChainId, stablecoin, amount }),
  ]);

  const bridgeCostUSD = bridgeEstimate?.totalUSD ?? 0;

  return {
    gasCostUSD,
    bridgeCostUSD,
    totalCostUSD: gasCostUSD + bridgeCostUSD,
    bridgeProvider: bridgeEstimate?.provider ?? null,
    bridgeDurationSeconds:
      bridgeEstimate?.estimatedDurationSeconds ?? 0,
  };
}
