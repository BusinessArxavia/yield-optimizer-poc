import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock viem before imports
vi.mock("viem", () => ({
  createPublicClient: vi.fn(),
  http: vi.fn(),
}));

import { createPublicClient } from "viem";
import {
  getOperationCostUSD,
  getRotationGasCostUSD,
  getGasPrice,
  getNativeTokenPrice,
  clearGasOracleCache,
  OPERATION_GAS_UNITS,
} from "../gas-oracle.js";

// --- Test fixtures ---

const MOCK_PRICE_RESPONSE = {
  coins: {
    "coingecko:ethereum": { price: 2000, symbol: "ETH" },
    "coingecko:matic-network": { price: 0.5, symbol: "MATIC" },
    "coingecko:avalanche-2": { price: 20, symbol: "AVAX" },
    "coingecko:binancecoin": { price: 300, symbol: "BNB" },
  },
};

// 10 gwei in wei
const MOCK_GAS_PRICE_ETH = 10_000_000_000n;
// 0.01 gwei (typical L2)
const MOCK_GAS_PRICE_L2 = 10_000_000n;

function setupMocks(gasPrice: bigint = MOCK_GAS_PRICE_L2) {
  // Mock viem createPublicClient
  (createPublicClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    getGasPrice: vi.fn().mockResolvedValue(gasPrice),
  });

  // Mock fetch for DeFi Llama prices — create fresh Response per call
  // to avoid "Body already read" errors with parallel fetches
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(MOCK_PRICE_RESPONSE), { status: 200 }),
    ),
  );
}

// --- Tests ---

describe("gas-oracle", () => {
  beforeEach(() => {
    clearGasOracleCache();
    vi.restoreAllMocks();

    // Set RPC URLs
    process.env.RPC_BASE = "https://mock-base-rpc.test";
    process.env.RPC_ARBITRUM = "https://mock-arb-rpc.test";
    process.env.RPC_OPTIMISM = "https://mock-op-rpc.test";
    process.env.RPC_POLYGON = "https://mock-poly-rpc.test";
    process.env.RPC_AVALANCHE = "https://mock-avax-rpc.test";
    process.env.RPC_ETHEREUM = "https://mock-eth-rpc.test";
    process.env.RPC_BNB = "https://mock-bnb-rpc.test";
  });

  afterEach(() => {
    clearGasOracleCache();
  });

  describe("getGasPrice", () => {
    it("fetches gas price from viem client", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      const price = await getGasPrice(8453); // Base

      expect(price).toBe(MOCK_GAS_PRICE_L2);
      expect(createPublicClient).toHaveBeenCalledTimes(1);
    });

    it("caches gas price for 5 minutes", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      await getGasPrice(8453);
      await getGasPrice(8453);

      // Only one client created (second call uses cache)
      expect(createPublicClient).toHaveBeenCalledTimes(1);
    });

    it("throws for unknown chain", async () => {
      await expect(getGasPrice(999999)).rejects.toThrow(
        "Chain 999999 not found",
      );
    });

    it("throws when RPC URL is missing", async () => {
      delete process.env.RPC_BASE;

      await expect(getGasPrice(8453)).rejects.toThrow("Missing RPC URL");
    });
  });

  describe("getNativeTokenPrice", () => {
    it("fetches ETH price for Base chain", async () => {
      setupMocks();

      const price = await getNativeTokenPrice(8453);

      expect(price).toBe(2000);
    });

    it("fetches MATIC price for Polygon", async () => {
      setupMocks();

      const price = await getNativeTokenPrice(137);

      expect(price).toBe(0.5);
    });

    it("fetches AVAX price for Avalanche", async () => {
      setupMocks();

      const price = await getNativeTokenPrice(43114);

      expect(price).toBe(20);
    });

    it("fetches BNB price for BNB Chain", async () => {
      setupMocks();

      const price = await getNativeTokenPrice(56);

      expect(price).toBe(300);
    });

    it("caches prices across calls", async () => {
      setupMocks();

      await getNativeTokenPrice(8453); // fetches from API
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await getNativeTokenPrice(42161); // should use cache (same ETH price)

      // fetch was already called once during setup, no new calls
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("shares ETH price across ETH-based chains", async () => {
      setupMocks();

      const basePrice = await getNativeTokenPrice(8453);
      const arbPrice = await getNativeTokenPrice(42161);
      const opPrice = await getNativeTokenPrice(10);

      expect(basePrice).toBe(2000);
      expect(arbPrice).toBe(2000);
      expect(opPrice).toBe(2000);
    });

    it("throws when DeFi Llama API fails", async () => {
      (createPublicClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        getGasPrice: vi.fn().mockResolvedValue(MOCK_GAS_PRICE_L2),
      });
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Network error"),
      );

      await expect(getNativeTokenPrice(8453)).rejects.toThrow();
    });
  });

  describe("getOperationCostUSD", () => {
    it("computes supply cost on L2", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      const cost = await getOperationCostUSD(8453, "supply");

      // cost = 200,000 * 10,000,000 wei * 1e-18 * $2000
      // = 200,000 * 0.00000001 ETH * $2000
      // = 0.002 ETH * $2000
      // = $0.004
      expect(cost).toBeCloseTo(0.004, 4);
    });

    it("computes withdraw cost on L2", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      const cost = await getOperationCostUSD(8453, "withdraw");

      // 250,000 * 10,000,000 * 1e-18 * 2000 = $0.005
      expect(cost).toBeCloseTo(0.005, 4);
    });

    it("computes approve cost on L2", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      const cost = await getOperationCostUSD(8453, "approve");

      // 46,000 * 10,000,000 * 1e-18 * 2000 = $0.00092
      expect(cost).toBeCloseTo(0.00092, 5);
    });

    it("computes much higher cost on Ethereum mainnet", async () => {
      setupMocks(MOCK_GAS_PRICE_ETH); // 10 gwei

      const l1Cost = await getOperationCostUSD(1, "supply");

      // 200,000 * 10,000,000,000 * 1e-18 * 2000 = $4.00
      expect(l1Cost).toBeCloseTo(4.0, 1);
    });

    it("uses different native token price per chain", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      const baseCost = await getOperationCostUSD(8453, "supply"); // ETH @ $2000
      clearGasOracleCache();
      setupMocks(MOCK_GAS_PRICE_L2);
      const polygonCost = await getOperationCostUSD(137, "supply"); // MATIC @ $0.50

      // Polygon should be much cheaper because MATIC is worth much less than ETH
      expect(polygonCost).toBeLessThan(baseCost);
      // Polygon: 200,000 * 10,000,000 * 1e-18 * 0.5 = $0.000001
      expect(polygonCost).toBeCloseTo(0.000001, 6);
    });
  });

  describe("getRotationGasCostUSD", () => {
    it("computes total rotation gas cost (withdraw + approve + supply)", async () => {
      setupMocks(MOCK_GAS_PRICE_L2);

      const cost = await getRotationGasCostUSD(8453, 42161);

      // withdraw on Base: 250,000 * 0.01 gwei * $2000/ETH
      // approve on Arb:   46,000 * 0.01 gwei * $2000/ETH
      // supply on Arb:    200,000 * 0.01 gwei * $2000/ETH
      // Total gas units = 496,000 * 10,000,000 * 1e-18 * $2000 = $0.00992
      expect(cost).toBeCloseTo(0.00992, 4);
    });

    it("handles cross-ecosystem rotation (ETH chain → Polygon)", async () => {
      // For this test, we need different gas prices per chain
      let callCount = 0;
      (createPublicClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        getGasPrice: vi.fn().mockImplementation(() => {
          callCount++;
          // First call: Base (withdraw), second: Polygon (approve), third: Polygon (supply)
          return callCount === 1
            ? Promise.resolve(MOCK_GAS_PRICE_L2)
            : Promise.resolve(50_000_000_000n); // 50 gwei on Polygon
        }),
      }));
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(MOCK_PRICE_RESPONSE), { status: 200 }),
        ),
      );

      const cost = await getRotationGasCostUSD(8453, 137);

      // withdraw on Base: 250,000 * 10,000,000 * 1e-18 * $2000 = $0.005
      // approve on Polygon: 46,000 * 50,000,000,000 * 1e-18 * $0.50 = $0.00115
      // supply on Polygon: 200,000 * 50,000,000,000 * 1e-18 * $0.50 = $0.005
      // Total ≈ $0.01115
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe("OPERATION_GAS_UNITS", () => {
    it("has correct gas estimates", () => {
      expect(OPERATION_GAS_UNITS.supply).toBe(200_000n);
      expect(OPERATION_GAS_UNITS.withdraw).toBe(250_000n);
      expect(OPERATION_GAS_UNITS.approve).toBe(46_000n);
    });
  });
});
