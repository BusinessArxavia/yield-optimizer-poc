import { providers } from "ethers";
import {
  UiPoolDataProvider,
  UiIncentiveDataProvider,
} from "@aave/contract-helpers";
import { formatReservesAndIncentives } from "@aave/math-utils";
import {
  AAVE_CHAINS,
  STABLECOINS,
  type AaveChainConfig,
  type PoolYieldData,
} from "@yield-optimizer/shared";

/**
 * Convert a humanized decimal string (e.g., "1234567.890123") to
 * base-unit bigint for a given number of decimals.
 */
function toBigIntBaseUnits(value: string, decimals: number): bigint {
  if (!value || value === "0") return 0n;
  const [whole = "0", fraction = ""] = value.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

/**
 * Build a set of lowercase stablecoin addresses for a given chain,
 * used for fast membership checks.
 */
function getStablecoinAddresses(chainId: number): Set<string> {
  const addrs = new Set<string>();
  for (const coin of STABLECOINS) {
    const addr = coin.addresses[chainId];
    if (addr) addrs.add(addr.toLowerCase());
  }
  return addrs;
}

/**
 * Look up the stablecoin symbol for a given address on a chain.
 */
function getStablecoinSymbol(
  chainId: number,
  address: string,
): string | undefined {
  const lower = address.toLowerCase();
  for (const coin of STABLECOINS) {
    const addr = coin.addresses[chainId];
    if (addr && addr.toLowerCase() === lower) return coin.symbol;
  }
  return undefined;
}

/**
 * Create an ethers v5 JsonRpcProvider for a given chain config.
 * Reads the RPC URL from the process environment.
 */
function createProvider(chain: AaveChainConfig): providers.JsonRpcProvider {
  const rpcUrl = process.env[chain.rpcEnvKey];
  if (!rpcUrl) {
    throw new Error(
      `Missing RPC URL: set ${chain.rpcEnvKey} in your environment`,
    );
  }
  return new providers.JsonRpcProvider(rpcUrl, chain.chainId);
}

/**
 * Fetch yield data for a single Aave V3 chain.
 *
 * 1. Instantiates UiPoolDataProvider + UiIncentiveDataProvider
 * 2. Fetches reserves & incentives in parallel
 * 3. Formats via @aave/math-utils
 * 4. Filters for stablecoins
 * 5. Maps to PoolYieldData[]
 */
export async function fetchChainYields(
  chainId: number,
): Promise<PoolYieldData[]> {
  const chainConfig = AAVE_CHAINS.find(
    (c: AaveChainConfig) => c.chainId === chainId,
  );
  if (!chainConfig) {
    throw new Error(`Chain ${chainId} not found in AAVE_CHAINS`);
  }
  return fetchChainYieldsFromConfig(chainConfig);
}

/**
 * Internal: fetch yields for a chain given its config.
 * Exported for testing / direct use when you already have the config.
 */
export async function fetchChainYieldsFromConfig(
  chainConfig: AaveChainConfig,
): Promise<PoolYieldData[]> {
  const provider = createProvider(chainConfig);

  const poolDataProvider = new UiPoolDataProvider({
    uiPoolDataProviderAddress: chainConfig.aave.uiPoolDataProvider,
    provider,
    chainId: chainConfig.chainId,
  });

  const incentiveDataProvider = new UiIncentiveDataProvider({
    uiIncentiveDataProviderAddress: chainConfig.aave.uiIncentiveDataProvider,
    provider,
    chainId: chainConfig.chainId,
  });

  // Fetch reserves and incentives in parallel
  const [reservesRaw, reserveIncentives] = await Promise.all([
    poolDataProvider.getReservesHumanized({
      lendingPoolAddressProvider: chainConfig.aave.poolAddressesProvider,
    }),
    incentiveDataProvider.getReservesIncentivesDataHumanized({
      lendingPoolAddressProvider: chainConfig.aave.poolAddressesProvider,
    }),
  ]);

  const { reservesData, baseCurrencyData } = reservesRaw;

  // Format reserves with incentives
  const formattedReserves = formatReservesAndIncentives({
    reserves: reservesData,
    currentTimestamp: Math.floor(Date.now() / 1000),
    marketReferencePriceInUsd:
      baseCurrencyData.marketReferenceCurrencyPriceInUsd,
    marketReferenceCurrencyDecimals:
      baseCurrencyData.marketReferenceCurrencyDecimals,
    reserveIncentives,
  });

  // Filter for stablecoins
  const stablecoinAddrs = getStablecoinAddresses(chainConfig.chainId);

  const results: PoolYieldData[] = [];

  for (const reserve of formattedReserves) {
    if (!stablecoinAddrs.has(reserve.underlyingAsset.toLowerCase())) continue;
    if (!reserve.isActive || reserve.isFrozen || reserve.isPaused) continue;

    const symbol = getStablecoinSymbol(
      chainConfig.chainId,
      reserve.underlyingAsset,
    );
    if (!symbol) continue;

    // Supply APY from math-utils is a decimal string (e.g., "0.0315" = 3.15%)
    const supplyAPY = parseFloat(reserve.supplyAPY);

    // Sum all supply-side (aToken) incentive APRs
    const incentiveAPY = (reserve.aIncentivesData ?? []).reduce(
      (sum: number, inc: { incentiveAPR: string }) =>
        sum + parseFloat(inc.incentiveAPR),
      0,
    );

    // merklAPY will be added in Task 1.5 (Merkl service)
    const merklAPY = 0;
    const netAPY = supplyAPY + incentiveAPY + merklAPY;

    // Supply cap and total supplied — supplyCap from humanized data is in
    // whole-token units (e.g., "200000000" = 200M tokens). totalLiquidity
    // from formatReserves is also in whole-token units with decimals.
    const totalSupplied = toBigIntBaseUnits(
      reserve.totalLiquidity,
      reserve.decimals,
    );
    const supplyCap = toBigIntBaseUnits(reserve.supplyCap, reserve.decimals);
    const supplyCapHeadroom =
      supplyCap > totalSupplied ? supplyCap - totalSupplied : 0n;

    // Utilization = total borrows / total supply
    const utilizationRate = parseFloat(reserve.borrowUsageRatio);

    results.push({
      chainId: chainConfig.chainId,
      chainName: chainConfig.name,
      stablecoin: symbol,
      tokenAddress: reserve.underlyingAsset as `0x${string}`,
      supplyAPY,
      incentiveAPY,
      merklAPY,
      netAPY,
      totalSupplied,
      supplyCap,
      supplyCapHeadroom,
      utilizationRate,
      timestamp: Date.now(),
    });
  }

  return results;
}

/**
 * Fetch yield data for ALL configured Aave V3 chains in parallel.
 *
 * If an individual chain fails, a warning is logged and it is skipped.
 * At least one chain must succeed, otherwise an error is thrown.
 */
export async function fetchAllChainYields(): Promise<PoolYieldData[]> {
  const results = await Promise.allSettled(
    AAVE_CHAINS.map(async (chain: AaveChainConfig) => {
      try {
        return await fetchChainYieldsFromConfig(chain);
      } catch (error) {
        console.warn(
          `[aave-data] Failed to fetch ${chain.name} (${chain.chainId}):`,
          error instanceof Error ? error.message : error,
        );
        throw error;
      }
    }),
  );

  const allYields: PoolYieldData[] = [];
  let successCount = 0;

  for (const result of results) {
    if (result.status === "fulfilled") {
      allYields.push(...result.value);
      successCount++;
    }
  }

  if (successCount === 0) {
    throw new Error(
      "[aave-data] All chains failed — check RPC URLs and network connectivity",
    );
  }

  console.log(
    `[aave-data] Fetched yields from ${successCount}/${AAVE_CHAINS.length} chains, ${allYields.length} pools`,
  );

  return allYields;
}
