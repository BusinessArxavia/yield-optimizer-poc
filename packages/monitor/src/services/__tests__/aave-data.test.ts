import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Aave SDK modules before any imports that use them
vi.mock("@aave/contract-helpers", () => ({
  UiPoolDataProvider: vi.fn(),
  UiIncentiveDataProvider: vi.fn(),
}));

vi.mock("@aave/math-utils", () => ({
  formatReservesAndIncentives: vi.fn(),
}));

// Now import our code and the mocked modules
import { UiPoolDataProvider, UiIncentiveDataProvider } from "@aave/contract-helpers";
import { formatReservesAndIncentives } from "@aave/math-utils";
import { fetchChainYields, fetchAllChainYields } from "../aave-data.js";

// --- Test fixtures ---

const MOCK_BASE_CURRENCY_DATA = {
  marketReferenceCurrencyDecimals: 8,
  marketReferenceCurrencyPriceInUsd: "100000000", // 1 USD in 8 decimals
  networkBaseTokenPriceInUsd: "250000000000", // $2500 ETH
  networkBaseTokenPriceDecimals: 8,
};

const MOCK_RESERVES_DATA = [
  {
    underlyingAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    liquidityRate: "30000000000000000000000000", // RAY format
    variableBorrowRate: "50000000000000000000000000",
    availableLiquidity: "50000000",
    supplyCap: "200000000",
    borrowCap: "180000000",
    totalScaledVariableDebt: "100000000",
    priceInMarketReferenceCurrency: "100000000",
    isActive: true,
    isFrozen: false,
    isPaused: false,
    usageAsCollateralEnabled: true,
    reserveFactor: "1000",
    baseLTVasCollateral: "7700",
    reserveLiquidationThreshold: "8000",
    reserveLiquidationBonus: "10500",
    liquidityIndex: "1000000000000000000000000000",
    variableBorrowIndex: "1000000000000000000000000000",
    lastUpdateTimestamp: 1700000000,
    aTokenAddress: "0xaToken",
    variableDebtTokenAddress: "0xvToken",
    interestRateStrategyAddress: "0xStrategy",
    priceOracle: "0xOracle",
    variableRateSlope1: "40000000000000000000000000",
    variableRateSlope2: "600000000000000000000000000",
    baseVariableBorrowRate: "0",
    optimalUsageRatio: "900000000000000000000000000",
    accruedToTreasury: "0",
    isolationModeTotalDebt: "0",
    flashLoanEnabled: true,
    debtCeiling: "0",
    debtCeilingDecimals: 2,
    borrowableInIsolation: false,
    virtualUnderlyingBalance: "150000000",
    deficit: "0",
    originalId: 4,
    id: "8453-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    borrowingEnabled: true,
    isSiloedBorrowing: false,
  },
  {
    underlyingAsset: "0x4200000000000000000000000000000000000006", // WETH (not a stablecoin)
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    liquidityRate: "10000000000000000000000000",
    variableBorrowRate: "20000000000000000000000000",
    availableLiquidity: "1000",
    supplyCap: "50000",
    borrowCap: "40000",
    totalScaledVariableDebt: "500",
    priceInMarketReferenceCurrency: "250000000000",
    isActive: true,
    isFrozen: false,
    isPaused: false,
    usageAsCollateralEnabled: true,
    reserveFactor: "1500",
    baseLTVasCollateral: "8000",
    reserveLiquidationThreshold: "8250",
    reserveLiquidationBonus: "10500",
    liquidityIndex: "1000000000000000000000000000",
    variableBorrowIndex: "1000000000000000000000000000",
    lastUpdateTimestamp: 1700000000,
    aTokenAddress: "0xaWETH",
    variableDebtTokenAddress: "0xvWETH",
    interestRateStrategyAddress: "0xStrategy2",
    priceOracle: "0xOracle2",
    variableRateSlope1: "30000000000000000000000000",
    variableRateSlope2: "800000000000000000000000000",
    baseVariableBorrowRate: "0",
    optimalUsageRatio: "800000000000000000000000000",
    accruedToTreasury: "0",
    isolationModeTotalDebt: "0",
    flashLoanEnabled: true,
    debtCeiling: "0",
    debtCeilingDecimals: 2,
    borrowableInIsolation: false,
    virtualUnderlyingBalance: "1000",
    deficit: "0",
    originalId: 0,
    id: "8453-0x4200000000000000000000000000000000000006",
    borrowingEnabled: true,
    isSiloedBorrowing: false,
  },
];

const MOCK_INCENTIVES_DATA = [
  {
    id: "8453-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    underlyingAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    aIncentiveData: {
      tokenAddress: "0xaToken",
      incentiveControllerAddress: "0xController",
      rewardsTokenInformation: [],
    },
    vIncentiveData: {
      tokenAddress: "0xvToken",
      incentiveControllerAddress: "0xController",
      rewardsTokenInformation: [],
    },
  },
];

/** What formatReservesAndIncentives would return for our USDC reserve */
const MOCK_FORMATTED_USDC = {
  ...MOCK_RESERVES_DATA[0],
  supplyAPY: "0.0315", // 3.15%
  variableBorrowAPY: "0.055",
  supplyAPR: "0.031",
  variableBorrowAPR: "0.0535",
  totalLiquidity: "150000000", // 150M USDC (whole tokens)
  totalLiquidityUSD: "150000000",
  totalDebt: "100000000",
  totalDebtUSD: "100000000",
  totalVariableDebt: "100000000",
  totalVariableDebtUSD: "100000000",
  borrowUsageRatio: "0.666",
  supplyUsageRatio: "0.75",
  formattedAvailableLiquidity: "50000000",
  availableLiquidityUSD: "50000000",
  borrowCapUSD: "180000000",
  supplyCapUSD: "200000000",
  priceInUSD: "1",
  formattedPriceInMarketReferenceCurrency: "1",
  unborrowedLiquidity: "50000000",
  formattedBaseLTVasCollateral: "0.77",
  formattedReserveLiquidationThreshold: "0.80",
  formattedReserveLiquidationBonus: "1.05",
  isIsolated: false,
  isolationModeTotalDebtUSD: "0",
  availableDebtCeilingUSD: "0",
  debtCeilingUSD: "0",
  eModes: [],
  // Incentive fields
  aIncentivesData: [
    {
      incentiveAPR: "0.005", // 0.5% supply incentive
      rewardTokenAddress: "0xReward",
      rewardTokenSymbol: "AAVE",
    },
  ],
  vIncentivesData: [],
};

const MOCK_FORMATTED_WETH = {
  ...MOCK_RESERVES_DATA[1],
  supplyAPY: "0.01",
  variableBorrowAPY: "0.025",
  supplyAPR: "0.0099",
  variableBorrowAPR: "0.0247",
  totalLiquidity: "1500",
  totalLiquidityUSD: "3750000",
  totalDebt: "500",
  totalDebtUSD: "1250000",
  totalVariableDebt: "500",
  totalVariableDebtUSD: "1250000",
  borrowUsageRatio: "0.333",
  supplyUsageRatio: "0.03",
  formattedAvailableLiquidity: "1000",
  availableLiquidityUSD: "2500000",
  borrowCapUSD: "100000000",
  supplyCapUSD: "125000000",
  priceInUSD: "2500",
  formattedPriceInMarketReferenceCurrency: "2500",
  unborrowedLiquidity: "1000",
  formattedBaseLTVasCollateral: "0.80",
  formattedReserveLiquidationThreshold: "0.825",
  formattedReserveLiquidationBonus: "1.05",
  isIsolated: false,
  isolationModeTotalDebtUSD: "0",
  availableDebtCeilingUSD: "0",
  debtCeilingUSD: "0",
  eModes: [],
  aIncentivesData: [],
  vIncentivesData: [],
};

// --- Tests ---

describe("aave-data", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set RPC URLs for all chains
    process.env.RPC_BASE = "https://mock-base-rpc.test";
    process.env.RPC_ARBITRUM = "https://mock-arb-rpc.test";
    process.env.RPC_OPTIMISM = "https://mock-op-rpc.test";
    process.env.RPC_POLYGON = "https://mock-poly-rpc.test";
    process.env.RPC_AVALANCHE = "https://mock-avax-rpc.test";
    process.env.RPC_ETHEREUM = "https://mock-eth-rpc.test";
    process.env.RPC_BNB = "https://mock-bnb-rpc.test";

    // Mock UiPoolDataProvider
    (UiPoolDataProvider as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getReservesHumanized: vi.fn().mockResolvedValue({
        reservesData: MOCK_RESERVES_DATA,
        baseCurrencyData: MOCK_BASE_CURRENCY_DATA,
      }),
    }));

    // Mock UiIncentiveDataProvider
    (UiIncentiveDataProvider as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getReservesIncentivesDataHumanized: vi.fn().mockResolvedValue(MOCK_INCENTIVES_DATA),
    }));

    // Mock formatReservesAndIncentives
    (formatReservesAndIncentives as ReturnType<typeof vi.fn>).mockReturnValue([
      MOCK_FORMATTED_USDC,
      MOCK_FORMATTED_WETH,
    ]);
  });

  describe("fetchChainYields", () => {
    it("returns only stablecoin pools", async () => {
      const yields = await fetchChainYields(8453); // Base

      // Should only return USDC, not WETH
      expect(yields).toHaveLength(1);
      expect(yields[0].stablecoin).toBe("USDC");
    });

    it("correctly extracts supply APY", async () => {
      const yields = await fetchChainYields(8453);

      expect(yields[0].supplyAPY).toBeCloseTo(0.0315, 4);
    });

    it("correctly extracts incentive APY", async () => {
      const yields = await fetchChainYields(8453);

      expect(yields[0].incentiveAPY).toBeCloseTo(0.005, 4);
    });

    it("computes net APY = supply + incentive + merkl", async () => {
      const yields = await fetchChainYields(8453);

      // 0.0315 + 0.005 + 0 (merkl not implemented yet)
      expect(yields[0].netAPY).toBeCloseTo(0.0365, 4);
    });

    it("computes supply cap headroom", async () => {
      const yields = await fetchChainYields(8453);

      // supplyCap = 200M USDC = 200_000_000 * 10^6 = 200_000_000_000_000n
      // totalSupplied = 150M USDC = 150_000_000 * 10^6 = 150_000_000_000_000n
      // headroom = 50M USDC = 50_000_000_000_000n
      expect(yields[0].supplyCap).toBe(200_000_000_000_000n);
      expect(yields[0].totalSupplied).toBe(150_000_000_000_000n);
      expect(yields[0].supplyCapHeadroom).toBe(50_000_000_000_000n);
    });

    it("extracts utilization rate", async () => {
      const yields = await fetchChainYields(8453);

      expect(yields[0].utilizationRate).toBeCloseTo(0.666, 2);
    });

    it("populates chain info correctly", async () => {
      const yields = await fetchChainYields(8453);

      expect(yields[0].chainId).toBe(8453);
      expect(yields[0].chainName).toBe("Base");
      expect(yields[0].tokenAddress).toBe(
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      );
    });

    it("throws for unknown chain ID", async () => {
      await expect(fetchChainYields(999999)).rejects.toThrow(
        "Chain 999999 not found",
      );
    });

    it("throws when RPC URL is missing", async () => {
      delete process.env.RPC_BASE;

      await expect(fetchChainYields(8453)).rejects.toThrow("Missing RPC URL");
    });

    it("filters out frozen reserves", async () => {
      (formatReservesAndIncentives as ReturnType<typeof vi.fn>).mockReturnValue([
        { ...MOCK_FORMATTED_USDC, isFrozen: true },
      ]);

      const yields = await fetchChainYields(8453);
      expect(yields).toHaveLength(0);
    });

    it("filters out paused reserves", async () => {
      (formatReservesAndIncentives as ReturnType<typeof vi.fn>).mockReturnValue([
        { ...MOCK_FORMATTED_USDC, isPaused: true },
      ]);

      const yields = await fetchChainYields(8453);
      expect(yields).toHaveLength(0);
    });

    it("filters out inactive reserves", async () => {
      (formatReservesAndIncentives as ReturnType<typeof vi.fn>).mockReturnValue([
        { ...MOCK_FORMATTED_USDC, isActive: false },
      ]);

      const yields = await fetchChainYields(8453);
      expect(yields).toHaveLength(0);
    });

    it("handles reserves with no incentives", async () => {
      (formatReservesAndIncentives as ReturnType<typeof vi.fn>).mockReturnValue([
        { ...MOCK_FORMATTED_USDC, aIncentivesData: [] },
      ]);

      const yields = await fetchChainYields(8453);
      expect(yields[0].incentiveAPY).toBe(0);
      expect(yields[0].netAPY).toBeCloseTo(0.0315, 4);
    });

    it("handles reserves with undefined aIncentivesData", async () => {
      (formatReservesAndIncentives as ReturnType<typeof vi.fn>).mockReturnValue([
        { ...MOCK_FORMATTED_USDC, aIncentivesData: undefined },
      ]);

      const yields = await fetchChainYields(8453);
      expect(yields[0].incentiveAPY).toBe(0);
    });
  });

  describe("fetchAllChainYields", () => {
    it("fetches from all chains in parallel", async () => {
      const yields = await fetchAllChainYields();

      // Each chain returns 1 stablecoin (USDC), 7 chains total
      expect(yields.length).toBeGreaterThanOrEqual(1);
      expect(UiPoolDataProvider).toHaveBeenCalledTimes(7);
    });

    it("continues when some chains fail", async () => {
      let callCount = 0;
      (UiPoolDataProvider as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        getReservesHumanized: vi.fn().mockImplementation(() => {
          callCount++;
          // Fail on the 2nd and 3rd chain
          if (callCount === 2 || callCount === 3) {
            return Promise.reject(new Error("RPC timeout"));
          }
          return Promise.resolve({
            reservesData: MOCK_RESERVES_DATA,
            baseCurrencyData: MOCK_BASE_CURRENCY_DATA,
          });
        }),
      }));

      const yields = await fetchAllChainYields();

      // 5 out of 7 chains succeed, but mock data has Base USDC address
      // which only matches on Base — so only 1 pool is returned.
      // The important thing is that it doesn't throw.
      expect(yields.length).toBe(1);
    });

    it("throws when ALL chains fail", async () => {
      (UiPoolDataProvider as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        getReservesHumanized: vi.fn().mockRejectedValue(new Error("RPC down")),
      }));

      await expect(fetchAllChainYields()).rejects.toThrow("All chains failed");
    });
  });
});
