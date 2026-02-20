/**
 * Yield Calculator
 *
 * Takes raw PoolYieldData[] + Merkl incentive map, enriches each pool
 * with Merkl APY, recomputes netAPY, and returns pools sorted by net APY
 * (descending).
 */

import type { PoolYieldData } from "@yield-optimizer/shared";

export interface EnrichedPool extends PoolYieldData {
  /** Rank by net APY (1 = highest) */
  rank: number;
}

/**
 * Enrich pool yield data with Merkl incentives and sort by net APY.
 *
 * @param pools — Raw pool data from Aave data service
 * @param merklIncentives — Map of `${chainId}:${tokenAddress}` → incentive APR (decimal)
 * @returns Pools sorted by netAPY descending, with rank assigned
 */
export function calculateYields(
  pools: PoolYieldData[],
  merklIncentives: Map<string, number>,
): EnrichedPool[] {
  const enriched = pools.map((pool) => {
    const merklKey = `${pool.chainId}:${pool.tokenAddress.toLowerCase()}`;
    const merklAPY = merklIncentives.get(merklKey) ?? 0;

    const netAPY = pool.supplyAPY + pool.incentiveAPY + merklAPY;

    return {
      ...pool,
      merklAPY,
      netAPY,
      rank: 0, // assigned after sorting
    };
  });

  // Sort by net APY descending
  enriched.sort((a, b) => b.netAPY - a.netAPY);

  // Assign ranks
  for (let i = 0; i < enriched.length; i++) {
    enriched[i].rank = i + 1;
  }

  return enriched;
}

/**
 * Get the top N pools by net APY.
 */
export function getTopPools(
  pools: EnrichedPool[],
  n: number,
): EnrichedPool[] {
  return pools.slice(0, n);
}

/**
 * Find the best pool for a specific stablecoin across all chains.
 */
export function getBestPoolForStablecoin(
  pools: EnrichedPool[],
  stablecoin: string,
): EnrichedPool | undefined {
  return pools.find((p) => p.stablecoin === stablecoin);
}
