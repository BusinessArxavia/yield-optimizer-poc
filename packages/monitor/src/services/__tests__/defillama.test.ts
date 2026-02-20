import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchDefiLlamaYields,
  fetchPoolHistory,
  findPoolId,
  clearDefiLlamaCache,
} from "../defillama.js";

// --- Test fixtures ---

function makeRawPool(overrides: Record<string, unknown> = {}) {
  return {
    pool: "aa70268e-4b52-42bf-a116-608b370f9501",
    chain: "Base",
    project: "aave-v3",
    symbol: "USDC",
    apy: 3.5,
    apyBase: 3.2,
    apyReward: 0.3,
    tvlUsd: 150_000_000,
    rewardTokens: ["0xReward"],
    underlyingTokens: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    apyPct1D: 0.05,
    apyPct7D: -0.1,
    apyPct30D: -0.5,
    apyMean30d: 3.8,
    stablecoin: true,
    ilRisk: "no",
    exposure: "single",
    predictions: {
      predictedClass: "Stable/Up",
      predictedProbability: 80,
      binnedConfidence: 3,
    },
    ...overrides,
  };
}

const MOCK_POOLS_RESPONSE = {
  status: "success",
  data: [
    // Base USDC — should be included
    makeRawPool(),
    // Arbitrum USDT — should be included
    makeRawPool({
      pool: "bb-arb-usdt",
      chain: "Arbitrum",
      symbol: "USDT",
      apy: 2.1,
      apyBase: 2.1,
      apyReward: null,
      rewardTokens: null,
    }),
    // Ethereum DAI — should be included
    makeRawPool({
      pool: "cc-eth-dai",
      chain: "Ethereum",
      symbol: "DAI",
      apy: 4.0,
      apyBase: 3.5,
      apyReward: 0.5,
    }),
    // Non-Aave pool — should be filtered out
    makeRawPool({
      pool: "dd-compound",
      project: "compound-v3",
      chain: "Base",
      symbol: "USDC",
    }),
    // Non-stablecoin — should be filtered out
    makeRawPool({
      pool: "ee-weth",
      chain: "Base",
      symbol: "WETH",
      stablecoin: false,
    }),
    // Unsupported chain — should be filtered out
    makeRawPool({
      pool: "ff-scroll",
      chain: "Scroll",
      symbol: "USDC",
    }),
  ],
};

function makeChartEntry(daysAgo: number, apy: number) {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    timestamp: date.toISOString(),
    apy,
    apyBase: apy * 0.9,
    apyReward: apy * 0.1,
    tvlUsd: 150_000_000,
  };
}

const MOCK_CHART_RESPONSE = {
  status: "success",
  data: [
    makeChartEntry(60, 3.0), // 60 days ago — outside 30-day window
    makeChartEntry(45, 3.2), // 45 days ago — outside 30-day window
    makeChartEntry(25, 3.5), // 25 days ago — inside
    makeChartEntry(10, 3.8), // 10 days ago — inside
    makeChartEntry(1, 3.6), // yesterday — inside
    makeChartEntry(0, 3.5), // today — inside
  ],
};

// --- Tests ---

describe("defillama", () => {
  beforeEach(() => {
    clearDefiLlamaCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearDefiLlamaCache();
  });

  describe("fetchDefiLlamaYields", () => {
    it("fetches and filters Aave V3 stablecoin pools", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const pools = await fetchDefiLlamaYields();

      // Should include Base USDC, Arbitrum USDT, Ethereum DAI
      // Should exclude: Compound (wrong project), WETH (not stablecoin), Scroll (unsupported chain)
      expect(pools).toHaveLength(3);
    });

    it("maps pool fields correctly", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const pools = await fetchDefiLlamaYields();
      const baseUSDC = pools.find(
        (p) => p.chain === "Base" && p.symbol === "USDC",
      );

      expect(baseUSDC).toBeDefined();
      expect(baseUSDC!.poolId).toBe("aa70268e-4b52-42bf-a116-608b370f9501");
      expect(baseUSDC!.apy).toBe(3.5);
      expect(baseUSDC!.apyBase).toBe(3.2);
      expect(baseUSDC!.apyReward).toBe(0.3);
      expect(baseUSDC!.tvlUsd).toBe(150_000_000);
      expect(baseUSDC!.stablecoin).toBe(true);
      expect(baseUSDC!.predictedClass).toBe("Stable/Up");
      expect(baseUSDC!.predictedConfidence).toBe(3);
    });

    it("handles null apyReward", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const pools = await fetchDefiLlamaYields();
      const arbUSDT = pools.find(
        (p) => p.chain === "Arbitrum" && p.symbol === "USDT",
      );

      expect(arbUSDT).toBeDefined();
      expect(arbUSDT!.apyReward).toBeNull();
      expect(arbUSDT!.rewardTokens).toBeNull();
    });

    it("includes BNB Chain pools mapped from BSC", async () => {
      const response = {
        status: "success",
        data: [
          makeRawPool({
            pool: "bnb-usdc",
            chain: "BSC",
            symbol: "USDC",
            apy: 2.5,
          }),
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(response), { status: 200 }),
      );

      const pools = await fetchDefiLlamaYields();

      expect(pools).toHaveLength(1);
      expect(pools[0].chain).toBe("BSC");
    });

    it("caches results for 15 minutes", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      await fetchDefiLlamaYields();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await fetchDefiLlamaYields();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // cached
    });

    it("re-fetches after cache clear", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
        );

      await fetchDefiLlamaYields();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      clearDefiLlamaCache();

      await fetchDefiLlamaYields();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("returns empty array on API failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network error"),
      );

      const pools = await fetchDefiLlamaYields();
      expect(pools).toHaveLength(0);
    });

    it("returns empty array on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const pools = await fetchDefiLlamaYields();
      expect(pools).toHaveLength(0);
    });

    it("handles missing predictions gracefully", async () => {
      const response = {
        status: "success",
        data: [makeRawPool({ predictions: null })],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(response), { status: 200 }),
      );

      const pools = await fetchDefiLlamaYields();

      expect(pools).toHaveLength(1);
      expect(pools[0].predictedClass).toBeNull();
      expect(pools[0].predictedConfidence).toBeNull();
    });
  });

  describe("fetchPoolHistory", () => {
    it("fetches and parses historical data", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_CHART_RESPONSE), { status: 200 }),
      );

      const history = await fetchPoolHistory("test-pool-id", 30);

      // Only entries within last 30 days: 25d, 10d, 1d, 0d
      expect(history).toHaveLength(4);
    });

    it("maps historical fields correctly", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_CHART_RESPONSE), { status: 200 }),
      );

      const history = await fetchPoolHistory("test-pool-id", 30);
      const latest = history[history.length - 1];

      expect(latest.apy).toBeCloseTo(3.5, 1);
      expect(latest.tvlUsd).toBe(150_000_000);
      expect(latest.timestamp).toBeDefined();
    });

    it("respects days parameter", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_CHART_RESPONSE), { status: 200 }),
      );

      // Only last 5 days
      const history = await fetchPoolHistory("test-pool-id", 5);

      // Only entries within last 5 days: 1d, 0d
      expect(history).toHaveLength(2);
    });

    it("caches results per poolId+days", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CHART_RESPONSE), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CHART_RESPONSE), { status: 200 }),
        );

      await fetchPoolHistory("pool-1", 30);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Same poolId+days — cached
      await fetchPoolHistory("pool-1", 30);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Different days — new fetch
      await fetchPoolHistory("pool-1", 7);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("returns empty array on failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("timeout"),
      );

      const history = await fetchPoolHistory("bad-pool", 30);
      expect(history).toHaveLength(0);
    });

    it("calls correct URL with poolId", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "success", data: [] }),
          { status: 200 },
        ),
      );

      await fetchPoolHistory("my-pool-uuid", 30);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe(
        "https://yields.llama.fi/chart/my-pool-uuid",
      );
    });
  });

  describe("findPoolId", () => {
    it("finds pool by chainId and symbol", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const poolId = await findPoolId(8453, "USDC");

      expect(poolId).toBe("aa70268e-4b52-42bf-a116-608b370f9501");
    });

    it("returns null for unsupported chain", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const poolId = await findPoolId(999999, "USDC");
      expect(poolId).toBeNull();
    });

    it("returns null when no matching pool exists", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const poolId = await findPoolId(8453, "GHO"); // GHO not on Base in mock data
      expect(poolId).toBeNull();
    });

    it("is case-insensitive for symbol", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_POOLS_RESPONSE), { status: 200 }),
      );

      const poolId = await findPoolId(8453, "usdc");
      expect(poolId).toBe("aa70268e-4b52-42bf-a116-608b370f9501");
    });

    it("maps BNB Chain chainId (56) to BSC", async () => {
      const response = {
        status: "success",
        data: [
          makeRawPool({
            pool: "bnb-usdc-pool",
            chain: "BSC",
            symbol: "USDC",
          }),
        ],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(response), { status: 200 }),
      );

      const poolId = await findPoolId(56, "USDC");
      expect(poolId).toBe("bnb-usdc-pool");
    });
  });
});
