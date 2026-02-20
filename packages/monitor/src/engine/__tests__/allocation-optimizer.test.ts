import { describe, it, expect } from "vitest";
import { computeOptimalAllocation } from "../allocation-optimizer.js";
import type { EnrichedPool } from "../yield-calculator.js";
import type { CurrentPosition } from "../rotation-decision.js";
import type { RotationConfig } from "@yield-optimizer/shared";

// --- Test fixtures ---

const CONFIG: RotationConfig = {
  minSpreadBps: 25,
  maxBreakEvenDays: 7,
  maxInFlightPct: 15,
  maxPerChainPct: 40,
  maxRotationPct: 20,
  checkIntervalMs: 6 * 60 * 60 * 1000,
};

function makePool(overrides: Partial<EnrichedPool> = {}): EnrichedPool {
  return {
    chainId: 8453,
    chainName: "Base",
    stablecoin: "USDC",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    supplyAPY: 0.03,
    incentiveAPY: 0.005,
    merklAPY: 0.02,
    netAPY: 0.055,
    totalSupplied: 100_000_000_000_000n,
    supplyCap: 200_000_000_000_000n,
    supplyCapHeadroom: 100_000_000_000_000n, // 100M USDC headroom
    utilizationRate: 0.5,
    timestamp: Date.now(),
    rank: 1,
    ...overrides,
  };
}

const POOLS: EnrichedPool[] = [
  makePool({ netAPY: 0.06, rank: 1 }), // Base USDC 6%
  makePool({
    chainId: 42161,
    chainName: "Arbitrum",
    tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    netAPY: 0.05,
    rank: 2,
  }), // Arb USDC 5%
  makePool({
    chainId: 10,
    chainName: "Optimism",
    tokenAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    netAPY: 0.04,
    rank: 3,
  }), // Op USDC 4%
  makePool({
    chainId: 137,
    chainName: "Polygon",
    tokenAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    netAPY: 0.03,
    rank: 4,
  }), // Poly USDC 3%
];

// --- Tests ---

describe("allocation-optimizer", () => {
  describe("computeOptimalAllocation", () => {
    it("allocates greedily to highest APY first", () => {
      const result = computeOptimalAllocation(100_000, POOLS, CONFIG);

      // maxPerChainPct=40, so first 40k goes to Base (6%), next 40k to Arb (5%)
      // remaining 20k to Op (4%)
      expect(result.targets).toHaveLength(3);
      expect(result.targets[0].chainId).toBe(8453);
      expect(result.targets[0].allocationUSD).toBe(40_000);
      expect(result.targets[1].chainId).toBe(42161);
      expect(result.targets[1].allocationUSD).toBe(40_000);
      expect(result.targets[2].chainId).toBe(10);
      expect(result.targets[2].allocationUSD).toBe(20_000);
    });

    it("respects per-chain limit", () => {
      const result = computeOptimalAllocation(100_000, POOLS, CONFIG);

      for (const target of result.targets) {
        expect(target.allocationPct).toBeLessThanOrEqual(40);
      }
    });

    it("computes weighted APY correctly", () => {
      const result = computeOptimalAllocation(100_000, POOLS, CONFIG);

      // 40k * 6% + 40k * 5% + 20k * 4% = 2400 + 2000 + 800 = 5200
      // Weighted APY = 5200 / 100000 = 5.2%
      expect(result.weightedAPY).toBeCloseTo(0.052, 3);
    });

    it("respects supply cap headroom", () => {
      const smallCapPools = [
        makePool({
          netAPY: 0.06,
          supplyCapHeadroom: 10_000_000_000n, // Only 10k USDC
        }),
        makePool({
          chainId: 42161,
          chainName: "Arbitrum",
          tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          netAPY: 0.05,
          rank: 2,
        }),
      ];

      const result = computeOptimalAllocation(
        100_000,
        smallCapPools,
        CONFIG,
      );

      // Base: min(40k limit, 10k cap) = 10k
      expect(result.targets[0].allocationUSD).toBe(10_000);
      // Arb gets the rest up to 40k limit
      expect(result.targets[1].allocationUSD).toBe(40_000);
    });

    it("handles unlimited supply cap (0n)", () => {
      const unlimitedCapPools = [
        makePool({
          netAPY: 0.06,
          supplyCap: 0n,
          supplyCapHeadroom: 0n,
        }),
      ];

      const result = computeOptimalAllocation(
        100_000,
        unlimitedCapPools,
        CONFIG,
      );

      // Should allocate up to per-chain limit (40k)
      expect(result.targets[0].allocationUSD).toBe(40_000);
    });

    it("calculates deltas from current positions", () => {
      const currentPositions: CurrentPosition[] = [
        {
          chainId: 8453,
          stablecoin: "USDC",
          amount: 60_000_000_000n, // 60k on Base
          decimals: 6,
          currentAPY: 0.06,
        },
        {
          chainId: 137,
          stablecoin: "USDC",
          amount: 40_000_000_000n, // 40k on Polygon
          decimals: 6,
          currentAPY: 0.03,
        },
      ];

      const result = computeOptimalAllocation(
        100_000,
        POOLS,
        CONFIG,
        currentPositions,
      );

      // Optimal: 40k Base, 40k Arb, 20k Op
      // Current: 60k Base, 40k Polygon
      // Deltas:
      //   Base: 40k - 60k = -20k (reduce)
      //   Arb: 40k - 0 = +40k (add)
      //   Op: 20k - 0 = +20k (add)
      //   Poly: 0 - 40k = -40k (remove)
      expect(result.deltas.length).toBe(4);

      const arbDelta = result.deltas.find((d) => d.chainId === 42161);
      expect(arbDelta!.deltaUSD).toBeCloseTo(40_000, 0);

      const polyDelta = result.deltas.find((d) => d.chainId === 137);
      expect(polyDelta!.deltaUSD).toBeCloseTo(-40_000, 0);
    });

    it("computes APY improvement", () => {
      const currentPositions: CurrentPosition[] = [
        {
          chainId: 137,
          stablecoin: "USDC",
          amount: 100_000_000_000n, // all on Polygon
          decimals: 6,
          currentAPY: 0.03, // 3%
        },
      ];

      const result = computeOptimalAllocation(
        100_000,
        POOLS,
        CONFIG,
        currentPositions,
      );

      expect(result.currentWeightedAPY).toBeCloseTo(0.03, 3);
      expect(result.weightedAPY).toBeCloseTo(0.052, 3);
      expect(result.apyImprovement).toBeCloseTo(0.022, 3); // 2.2% improvement
    });

    it("handles zero capital", () => {
      const result = computeOptimalAllocation(0, POOLS, CONFIG);

      expect(result.targets).toHaveLength(0);
      expect(result.weightedAPY).toBe(0);
    });

    it("handles empty pools", () => {
      const result = computeOptimalAllocation(100_000, [], CONFIG);

      expect(result.targets).toHaveLength(0);
      expect(result.weightedAPY).toBe(0);
    });

    it("skips zero-APY pools", () => {
      const poolsWithZero = [
        makePool({ netAPY: 0.05 }),
        makePool({
          chainId: 42161,
          chainName: "Arbitrum",
          tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          netAPY: 0,
        }),
      ];

      const result = computeOptimalAllocation(
        100_000,
        poolsWithZero,
        CONFIG,
      );

      // Should only allocate to the 5% pool (40k), skip 0% pool
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].allocationUSD).toBe(40_000);
    });

    it("aggregates per-chain limits across multiple pools on same chain", () => {
      const sameChainPools = [
        makePool({ stablecoin: "USDC", netAPY: 0.06, rank: 1 }),
        makePool({ stablecoin: "USDT", netAPY: 0.055, rank: 2,
          tokenAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }),
        makePool({
          chainId: 42161,
          chainName: "Arbitrum",
          tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
          netAPY: 0.05,
          rank: 3,
        }),
      ];

      const result = computeOptimalAllocation(
        100_000,
        sameChainPools,
        CONFIG,
      );

      // Base USDC: 40k (hits chain limit)
      // Base USDT: 0 (chain limit already reached)
      // Arb USDC: 40k
      const baseAlloc = result.targets
        .filter((t) => t.chainId === 8453)
        .reduce((sum, t) => sum + t.allocationUSD, 0);
      expect(baseAlloc).toBe(40_000);
    });

    it("returns allocation percentages that sum to <= 100", () => {
      const result = computeOptimalAllocation(100_000, POOLS, CONFIG);

      const totalPct = result.targets.reduce(
        (sum, t) => sum + t.allocationPct,
        0,
      );
      expect(totalPct).toBeLessThanOrEqual(100.01); // small floating point tolerance
    });
  });
});
