import { describe, it, expect } from "vitest";
import {
  calculateYields,
  getTopPools,
  getBestPoolForStablecoin,
} from "../yield-calculator.js";
import type { PoolYieldData } from "@yield-optimizer/shared";

// --- Test fixtures ---

function makePool(overrides: Partial<PoolYieldData> = {}): PoolYieldData {
  return {
    chainId: 8453,
    chainName: "Base",
    stablecoin: "USDC",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    supplyAPY: 0.03, // 3%
    incentiveAPY: 0.005, // 0.5%
    merklAPY: 0,
    netAPY: 0.035, // will be recomputed
    totalSupplied: 150_000_000_000_000n,
    supplyCap: 200_000_000_000_000n,
    supplyCapHeadroom: 50_000_000_000_000n,
    utilizationRate: 0.75,
    timestamp: Date.now(),
    ...overrides,
  };
}

const POOLS: PoolYieldData[] = [
  makePool(), // Base USDC: 3% + 0.5% = 3.5%
  makePool({
    chainId: 42161,
    chainName: "Arbitrum",
    tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    supplyAPY: 0.04,
    incentiveAPY: 0.01,
    netAPY: 0.05,
  }), // Arb USDC: 4% + 1% = 5%
  makePool({
    chainId: 10,
    chainName: "Optimism",
    tokenAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    supplyAPY: 0.025,
    incentiveAPY: 0,
    netAPY: 0.025,
  }), // Op USDC: 2.5% + 0% = 2.5%
  makePool({
    chainId: 42161,
    chainName: "Arbitrum",
    stablecoin: "USDT",
    tokenAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    supplyAPY: 0.035,
    incentiveAPY: 0.003,
    netAPY: 0.038,
  }), // Arb USDT: 3.5% + 0.3% = 3.8%
];

const MERKL_INCENTIVES = new Map<string, number>([
  // Base USDC gets 2% merkl APY
  ["8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 0.02],
  // Optimism USDC gets 1.5% merkl APY
  ["10:0x0b2c639c533813f4aa9d7837caf62653d097ff85", 0.015],
]);

// --- Tests ---

describe("yield-calculator", () => {
  describe("calculateYields", () => {
    it("enriches pools with Merkl APY", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);

      const baseUSDC = enriched.find(
        (p) => p.chainId === 8453 && p.stablecoin === "USDC",
      );
      expect(baseUSDC!.merklAPY).toBeCloseTo(0.02, 4);
    });

    it("recomputes netAPY including Merkl", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);

      // Base USDC: 3% + 0.5% + 2% = 5.5%
      const baseUSDC = enriched.find(
        (p) => p.chainId === 8453 && p.stablecoin === "USDC",
      );
      expect(baseUSDC!.netAPY).toBeCloseTo(0.055, 4);
    });

    it("sorts pools by netAPY descending", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);

      for (let i = 1; i < enriched.length; i++) {
        expect(enriched[i].netAPY).toBeLessThanOrEqual(
          enriched[i - 1].netAPY,
        );
      }
    });

    it("assigns correct ranks", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);

      expect(enriched[0].rank).toBe(1);
      expect(enriched[1].rank).toBe(2);
      expect(enriched[2].rank).toBe(3);
      expect(enriched[3].rank).toBe(4);
    });

    it("handles empty Merkl incentives", () => {
      const enriched = calculateYields(POOLS, new Map());

      // Net APY should just be supplyAPY + incentiveAPY
      const arbUSDC = enriched.find(
        (p) => p.chainId === 42161 && p.stablecoin === "USDC",
      );
      expect(arbUSDC!.merklAPY).toBe(0);
      expect(arbUSDC!.netAPY).toBeCloseTo(0.05, 4);
    });

    it("handles empty pools", () => {
      const enriched = calculateYields([], MERKL_INCENTIVES);
      expect(enriched).toHaveLength(0);
    });

    it("correctly ranks with Merkl changing the order", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);

      // Without Merkl: Arb USDC (5%) > Arb USDT (3.8%) > Base USDC (3.5%) > Op USDC (2.5%)
      // With Merkl: Base USDC (5.5%) > Arb USDC (5%) > Op USDC (4%) > Arb USDT (3.8%)
      expect(enriched[0].chainId).toBe(8453); // Base USDC now #1
      expect(enriched[0].stablecoin).toBe("USDC");
    });
  });

  describe("getTopPools", () => {
    it("returns top N pools", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);
      const top2 = getTopPools(enriched, 2);

      expect(top2).toHaveLength(2);
      expect(top2[0].rank).toBe(1);
      expect(top2[1].rank).toBe(2);
    });

    it("returns all pools when N exceeds pool count", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);
      const top10 = getTopPools(enriched, 10);

      expect(top10).toHaveLength(4);
    });
  });

  describe("getBestPoolForStablecoin", () => {
    it("returns highest-yield pool for a stablecoin", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);
      const bestUSDC = getBestPoolForStablecoin(enriched, "USDC");

      expect(bestUSDC).toBeDefined();
      // Base USDC (5.5%) should beat Arb USDC (5%) and Op USDC (4%)
      expect(bestUSDC!.chainId).toBe(8453);
    });

    it("returns undefined for unavailable stablecoin", () => {
      const enriched = calculateYields(POOLS, MERKL_INCENTIVES);
      const bestGHO = getBestPoolForStablecoin(enriched, "GHO");

      expect(bestGHO).toBeUndefined();
    });
  });
});
