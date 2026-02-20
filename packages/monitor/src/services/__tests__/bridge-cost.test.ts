import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  estimateBridgeCost,
  clearBridgeCostCache,
} from "../bridge-cost.js";

// --- Test fixtures ---

const USDC_100K = {
  fromChainId: 8453, // Base
  toChainId: 42161, // Arbitrum
  stablecoin: "USDC",
  amount: 100_000_000_000n, // 100,000 USDC (6 decimals)
};

const USDT_CROSS_CHAIN = {
  fromChainId: 42161, // Arbitrum
  toChainId: 10, // Optimism
  stablecoin: "USDT",
  amount: 50_000_000_000n, // 50,000 USDT
};

function makeLifiQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    estimate: {
      tool: "across",
      fromAmount: "100000000000",
      toAmount: "99750000000",
      fromAmountUSD: "100000",
      toAmountUSD: "99750",
      gasCosts: [
        {
          type: "SEND",
          amountUSD: "0.05",
          amount: "50000000000000",
          token: { symbol: "ETH", decimals: 18 },
        },
      ],
      feeCosts: [
        {
          name: "Bridge Fee",
          amountUSD: "2.50",
          amount: "2500000",
          included: true,
          token: { symbol: "USDC", decimals: 6 },
        },
      ],
      executionDuration: 120,
      ...overrides,
    },
  };
}

// --- Tests ---

describe("bridge-cost", () => {
  beforeEach(() => {
    clearBridgeCostCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearBridgeCostCache();
  });

  describe("CCTP estimation (USDC)", () => {
    it("returns CCTP estimate for USDC transfers", async () => {
      // Mock Li.Fi to fail so only CCTP is available
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Li.Fi unavailable"),
      );

      const result = await estimateBridgeCost(USDC_100K);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe("cctp");
      // Fee: 100,000 * 0.0001 = $10
      expect(result!.feesUSD).toBeCloseTo(10, 0);
      // Gas should be very small on L2
      expect(result!.gasUSD).toBeLessThan(1);
      expect(result!.totalUSD).toBeGreaterThan(0);
      expect(result!.estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it("computes CCTP fee as 1 basis point", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Li.Fi unavailable"),
      );

      // 1,000 USDC
      const result = await estimateBridgeCost({
        ...USDC_100K,
        amount: 1_000_000_000n, // 1000 USDC
      });

      // Fee: 1000 * 0.0001 = $0.10
      expect(result!.feesUSD).toBeCloseTo(0.1, 2);
    });

    it("uses higher gas estimate for Ethereum source", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Li.Fi unavailable"),
      );

      const fromL2 = await estimateBridgeCost({
        ...USDC_100K,
        fromChainId: 8453, // Base (L2)
      });

      clearBridgeCostCache();
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Li.Fi unavailable"),
      );

      const fromEth = await estimateBridgeCost({
        ...USDC_100K,
        fromChainId: 1, // Ethereum
      });

      // Ethereum gas should be much more expensive than L2
      expect(fromEth!.gasUSD).toBeGreaterThan(fromL2!.gasUSD);
    });
  });

  describe("Li.Fi estimation", () => {
    it("fetches Li.Fi quote and parses costs", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(makeLifiQuoteResponse()), { status: 200 }),
      );

      // Use USDT to avoid CCTP estimate
      const result = await estimateBridgeCost(USDT_CROSS_CHAIN);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe("lifi");
      expect(result!.gasUSD).toBeCloseTo(0.05, 2);
      expect(result!.feesUSD).toBeCloseTo(2.5, 1);
      expect(result!.totalUSD).toBeCloseTo(2.55, 1);
      expect(result!.estimatedDurationSeconds).toBe(120);
    });

    it("calls Li.Fi with correct query params", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(makeLifiQuoteResponse()), { status: 200 }),
      );

      await estimateBridgeCost(USDT_CROSS_CHAIN);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(fetchSpy.mock.calls[0][0] as string);
      expect(calledUrl.pathname).toBe("/v1/quote");
      expect(calledUrl.searchParams.get("fromChain")).toBe("42161");
      expect(calledUrl.searchParams.get("toChain")).toBe("10");
      expect(calledUrl.searchParams.get("fromAmount")).toBe("50000000000");
    });

    it("returns null when Li.Fi returns non-200 and no CCTP available", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 }),
      );

      const result = await estimateBridgeCost(USDT_CROSS_CHAIN);
      expect(result).toBeNull();
    });
  });

  describe("cheapest-wins logic", () => {
    it("picks CCTP over Li.Fi when CCTP is cheaper (USDC)", async () => {
      // Li.Fi returns a quote with higher cost
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            makeLifiQuoteResponse({
              gasCosts: [{ amountUSD: "0.50" }],
              feeCosts: [{ amountUSD: "250.00", included: true }],
              executionDuration: 60,
            }),
          ),
          { status: 200 },
        ),
      );

      const result = await estimateBridgeCost(USDC_100K);

      // CCTP: ~$10 fee + tiny gas ≈ $10
      // Li.Fi: $250.50
      // CCTP should win
      expect(result!.provider).toBe("cctp");
    });

    it("picks Li.Fi when it's cheaper than CCTP", async () => {
      // Li.Fi returns a very cheap quote
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            makeLifiQuoteResponse({
              gasCosts: [{ amountUSD: "0.01" }],
              feeCosts: [{ amountUSD: "0.05", included: true }],
              executionDuration: 30,
            }),
          ),
          { status: 200 },
        ),
      );

      // Small amount where CCTP 1bps fee ≈ $0.10, Li.Fi ≈ $0.06
      const result = await estimateBridgeCost({
        ...USDC_100K,
        amount: 1_000_000_000n, // 1000 USDC → CCTP fee ≈ $0.10
      });

      expect(result!.provider).toBe("lifi");
      expect(result!.totalUSD).toBeLessThan(0.1);
    });

    it("falls back to CCTP when Li.Fi fails for USDC", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await estimateBridgeCost(USDC_100K);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe("cctp");
    });
  });

  describe("edge cases", () => {
    it("returns null for same-chain transfers", async () => {
      const result = await estimateBridgeCost({
        ...USDC_100K,
        toChainId: 8453, // same as fromChainId
      });

      expect(result).toBeNull();
    });

    it("returns null for unsupported stablecoin with no Li.Fi route", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("No route found", { status: 400 }),
      );

      const result = await estimateBridgeCost({
        fromChainId: 8453,
        toChainId: 42161,
        stablecoin: "UNKNOWN",
        amount: 1_000_000n,
      });

      expect(result).toBeNull();
    });

    it("does not use CCTP for non-USDC stablecoins", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(makeLifiQuoteResponse()), { status: 200 }),
      );

      const result = await estimateBridgeCost(USDT_CROSS_CHAIN);

      // USDT is not CCTP-supported, so only Li.Fi
      expect(result!.provider).toBe("lifi");
    });

    it("does not use CCTP when destination chain lacks USDC", async () => {
      // GHO only on Ethereum + Arbitrum
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(makeLifiQuoteResponse()), { status: 200 }),
      );

      const result = await estimateBridgeCost({
        fromChainId: 1,
        toChainId: 42161,
        stablecoin: "GHO",
        amount: 1_000_000_000_000_000_000_000n, // 1000 GHO (18 decimals)
      });

      expect(result!.provider).toBe("lifi");
    });
  });

  describe("caching", () => {
    it("caches results for same params", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(makeLifiQuoteResponse()), { status: 200 }),
      );

      await estimateBridgeCost(USDT_CROSS_CHAIN);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await estimateBridgeCost(USDT_CROSS_CHAIN);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // cached
    });

    it("re-fetches after cache clear", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify(makeLifiQuoteResponse()), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(makeLifiQuoteResponse()), {
            status: 200,
          }),
        );

      await estimateBridgeCost(USDT_CROSS_CHAIN);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      clearBridgeCostCache();

      await estimateBridgeCost(USDT_CROSS_CHAIN);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does not share cache between different params", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify(makeLifiQuoteResponse()), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(makeLifiQuoteResponse()), {
            status: 200,
          }),
        );

      await estimateBridgeCost(USDT_CROSS_CHAIN);
      await estimateBridgeCost({
        ...USDT_CROSS_CHAIN,
        amount: 10_000_000_000n, // different amount
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
