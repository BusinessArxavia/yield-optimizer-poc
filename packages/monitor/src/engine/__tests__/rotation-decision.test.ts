import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock rotation-cost
vi.mock("../rotation-cost.js", () => ({
  estimateRotationCost: vi.fn(),
}));

import { estimateRotationCost } from "../rotation-cost.js";
import {
  evaluateRotations,
  getRecommendedRotations,
  type CurrentPosition,
} from "../rotation-decision.js";
import type { EnrichedPool } from "../yield-calculator.js";
import type { RotationConfig } from "@yield-optimizer/shared";

// --- Test fixtures ---

const CONFIG: RotationConfig = {
  minSpreadBps: 25, // 0.25%
  maxBreakEvenDays: 7,
  maxInFlightPct: 15,
  maxPerChainPct: 40,
  maxRotationPct: 20,
  checkIntervalMs: 6 * 60 * 60 * 1000,
};

function makeEnrichedPool(
  overrides: Partial<EnrichedPool> = {},
): EnrichedPool {
  return {
    chainId: 42161,
    chainName: "Arbitrum",
    stablecoin: "USDC",
    tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    supplyAPY: 0.05,
    incentiveAPY: 0.01,
    merklAPY: 0,
    netAPY: 0.06,
    totalSupplied: 100_000_000_000_000n,
    supplyCap: 200_000_000_000_000n,
    supplyCapHeadroom: 100_000_000_000_000n, // 100M USDC
    utilizationRate: 0.5,
    timestamp: Date.now(),
    rank: 1,
    ...overrides,
  };
}

const CURRENT_POSITION: CurrentPosition = {
  chainId: 8453, // Base
  stablecoin: "USDC",
  amount: 100_000_000_000n, // 100k USDC
  decimals: 6,
  currentAPY: 0.035, // 3.5%
};

// --- Tests ---

describe("rotation-decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rotation costs $5
    (estimateRotationCost as ReturnType<typeof vi.fn>).mockResolvedValue({
      gasCostUSD: 0.50,
      bridgeCostUSD: 4.50,
      totalCostUSD: 5.00,
      bridgeProvider: "cctp",
      bridgeDurationSeconds: 60,
    });
  });

  describe("evaluateRotations", () => {
    it("generates rotation candidates from positions to better pools", async () => {
      const pools = [
        makeEnrichedPool({ netAPY: 0.06 }), // 6% on Arb
      ];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0].from.chainId).toBe(8453);
      expect(candidates[0].to.chainId).toBe(42161);
      expect(candidates[0].yieldImprovement).toBeCloseTo(0.025, 4); // 6% - 3.5%
    });

    it("calculates economics correctly", async () => {
      const pools = [makeEnrichedPool({ netAPY: 0.06 })];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      const c = candidates[0];
      // maxRotationPct=20% caps rotation to 20k USDC (20% of 100k total)
      // Yield improvement: 2.5% on 20k USDC
      // Daily gain: 0.025 * 20,000 / 365 = $1.370
      expect(c.dailyGain).toBeCloseTo(1.370, 1);
      // Break-even: $5 / $1.370 = 3.65 days
      expect(c.breakEvenDays).toBeCloseTo(3.65, 1);
      // Net benefit annualized: 0.025 * 20,000 - 5 = $495
      expect(c.netBenefitAnnualized).toBeCloseTo(495, 0);
    });

    it("marks candidates as recommended when thresholds pass", async () => {
      const pools = [makeEnrichedPool({ netAPY: 0.06 })];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      // 2.5% spread > 0.25% min, 0.73 days < 7 max
      expect(candidates[0].recommended).toBe(true);
    });

    it("rejects when spread below minimum", async () => {
      // Only 0.1% improvement (10 bps < 25 bps min)
      const pools = [makeEnrichedPool({ netAPY: 0.036 })];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates[0].recommended).toBe(false);
    });

    it("rejects when break-even exceeds maximum", async () => {
      // Small improvement + expensive rotation
      (estimateRotationCost as ReturnType<typeof vi.fn>).mockResolvedValue({
        gasCostUSD: 10,
        bridgeCostUSD: 500,
        totalCostUSD: 510,
        bridgeProvider: "lifi",
        bridgeDurationSeconds: 1800,
      });

      const pools = [makeEnrichedPool({ netAPY: 0.04 })];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      // 0.5% on 100k = $500/yr, $1.37/day. Cost $510. Break-even ~372 days > 7
      expect(candidates[0].recommended).toBe(false);
      expect(candidates[0].breakEvenDays).toBeGreaterThan(7);
    });

    it("rejects when target chain exceeds per-chain limit", async () => {
      // Position already has 35% on Arbitrum
      const positions: CurrentPosition[] = [
        CURRENT_POSITION,
        {
          chainId: 42161,
          stablecoin: "USDT",
          amount: 53_846_153_846n, // ~53.8k USDT (35% of 153.8k total + 100k)
          decimals: 6,
          currentAPY: 0.03,
        },
      ];

      const pools = [makeEnrichedPool({ netAPY: 0.06 })];

      const candidates = await evaluateRotations(
        positions,
        pools,
        CONFIG, // maxPerChainPct: 40%
      );

      // Current Arb exposure: 53.8k. Adding ~20% of ~153.8k = ~30.7k would put Arb at ~55%.
      // That exceeds 40% limit.
      const arbCandidate = candidates.find((c) => c.to.chainId === 42161);
      if (arbCandidate) {
        expect(arbCandidate.recommended).toBe(false);
      }
    });

    it("rejects when target pool has insufficient supply cap headroom", async () => {
      const pools = [
        makeEnrichedPool({
          netAPY: 0.06,
          supplyCapHeadroom: 1_000_000n, // Only 1 USDC headroom
        }),
      ];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates[0].recommended).toBe(false);
    });

    it("skips same-chain same-stablecoin pools", async () => {
      const pools = [
        makeEnrichedPool({
          chainId: 8453,
          stablecoin: "USDC",
          netAPY: 0.10,
        }),
      ];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates).toHaveLength(0);
    });

    it("skips pools with lower yield than current position", async () => {
      const pools = [makeEnrichedPool({ netAPY: 0.02 })]; // 2% < 3.5%

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates).toHaveLength(0);
    });

    it("sorts candidates by net benefit descending", async () => {
      const pools = [
        makeEnrichedPool({
          chainId: 42161,
          netAPY: 0.06,
          rank: 1,
        }),
        makeEnrichedPool({
          chainId: 10,
          chainName: "Optimism",
          tokenAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
          netAPY: 0.08,
          rank: 2,
        }),
      ];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates.length).toBe(2);
      expect(candidates[0].to.chainId).toBe(10); // 8% is better
      expect(candidates[1].to.chainId).toBe(42161);
    });

    it("caps rotation amount by maxRotationPct", async () => {
      // 200k total capital, maxRotationPct=20 → max 40k per rotation
      const positions: CurrentPosition[] = [
        { ...CURRENT_POSITION, amount: 200_000_000_000n }, // 200k
      ];

      const pools = [makeEnrichedPool({ netAPY: 0.06 })];

      const candidates = await evaluateRotations(positions, pools, CONFIG);

      // Daily gain should be based on 40k (20% of 200k), not 200k
      // 0.025 * 40,000 / 365 ≈ $2.74
      expect(candidates[0].dailyGain).toBeCloseTo(2.74, 1);
    });

    it("skips candidates when cost estimation fails", async () => {
      (estimateRotationCost as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("RPC down"),
      );

      const pools = [makeEnrichedPool({ netAPY: 0.06 })];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );

      expect(candidates).toHaveLength(0);
    });
  });

  describe("getRecommendedRotations", () => {
    it("filters to only recommended candidates", async () => {
      const pools = [
        makeEnrichedPool({ netAPY: 0.06 }), // good
        makeEnrichedPool({
          chainId: 10,
          chainName: "Optimism",
          tokenAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
          netAPY: 0.036, // only 0.1% improvement — below threshold
        }),
      ];

      const candidates = await evaluateRotations(
        [CURRENT_POSITION],
        pools,
        CONFIG,
      );
      const recommended = getRecommendedRotations(candidates);

      expect(candidates.length).toBe(2);
      expect(recommended.length).toBe(1);
      expect(recommended[0].to.chainId).toBe(42161);
    });
  });
});
