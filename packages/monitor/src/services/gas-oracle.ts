/**
 * Gas Oracle Service
 *
 * Fetches current gas prices on each chain and converts gas units → USD cost
 * for common Aave operations. Used by the rotation decision engine to estimate
 * total rotation costs (withdraw + bridge + supply).
 *
 * Native token prices from DeFi Llama `coins.llama.fi/prices/current/`.
 * Gas prices from viem `publicClient.getGasPrice()`.
 *
 * Caches gas prices for 5 minutes and token prices for 15 minutes.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { AAVE_CHAINS, type AaveChainConfig } from "@yield-optimizer/shared";

const DEFILLAMA_COINS_API = "https://coins.llama.fi/prices/current";
const REQUEST_TIMEOUT_MS = 10_000;
const GAS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PRICE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// --- Operation gas estimates ---

/** Approximate gas units for common Aave V3 operations */
export const OPERATION_GAS_UNITS: Record<AaveOperation, bigint> = {
  supply: 200_000n,
  withdraw: 250_000n,
  approve: 46_000n,
};

export type AaveOperation = "supply" | "withdraw" | "approve";

// --- DeFi Llama coin identifiers for native tokens ---

const CHAIN_ID_TO_COIN_ID: Record<number, string> = {
  1: "coingecko:ethereum",
  8453: "coingecko:ethereum", // Base uses ETH
  42161: "coingecko:ethereum", // Arbitrum uses ETH
  10: "coingecko:ethereum", // Optimism uses ETH
  137: "coingecko:matic-network", // Polygon uses MATIC/POL
  43114: "coingecko:avalanche-2", // Avalanche uses AVAX
  56: "coingecko:binancecoin", // BNB Chain uses BNB
};

// --- Caches ---

const gasPriceCache = new Map<
  number,
  { gasPriceWei: bigint; expiresAt: number }
>();

let nativePriceCache: {
  prices: Map<number, number>;
  expiresAt: number;
} | null = null;

// --- Public API ---

/**
 * Get the estimated USD cost of an Aave operation on a given chain.
 *
 * @param chainId — The chain to estimate gas for
 * @param operation — "supply", "withdraw", or "approve"
 * @returns USD cost estimate
 */
export async function getOperationCostUSD(
  chainId: number,
  operation: AaveOperation,
): Promise<number> {
  const [gasPrice, nativePrice] = await Promise.all([
    getGasPrice(chainId),
    getNativeTokenPrice(chainId),
  ]);

  const gasUnits = OPERATION_GAS_UNITS[operation];
  // cost = gasUnits * gasPriceWei * 1e-18 * nativePriceUSD
  const costInNative = Number(gasUnits * gasPrice) * 1e-18;
  return costInNative * nativePrice;
}

/**
 * Get the total gas cost for a full rotation:
 * withdraw on source chain + approve on destination + supply on destination.
 */
export async function getRotationGasCostUSD(
  fromChainId: number,
  toChainId: number,
): Promise<number> {
  const [withdrawCost, approveCost, supplyCost] = await Promise.all([
    getOperationCostUSD(fromChainId, "withdraw"),
    getOperationCostUSD(toChainId, "approve"),
    getOperationCostUSD(toChainId, "supply"),
  ]);

  return withdrawCost + approveCost + supplyCost;
}

/**
 * Get the current gas price in wei for a chain.
 * Cached for 5 minutes.
 */
export async function getGasPrice(chainId: number): Promise<bigint> {
  const cached = gasPriceCache.get(chainId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.gasPriceWei;
  }

  const chain = AAVE_CHAINS.find(
    (c: AaveChainConfig) => c.chainId === chainId,
  );
  if (!chain) {
    throw new Error(`Chain ${chainId} not found in AAVE_CHAINS`);
  }

  const rpcUrl = process.env[chain.rpcEnvKey];
  if (!rpcUrl) {
    throw new Error(
      `Missing RPC URL: set ${chain.rpcEnvKey} in your environment`,
    );
  }

  const client: PublicClient = createPublicClient({
    chain: chain.chain,
    transport: http(rpcUrl),
  });

  const gasPrice = await client.getGasPrice();

  gasPriceCache.set(chainId, {
    gasPriceWei: gasPrice,
    expiresAt: Date.now() + GAS_CACHE_TTL_MS,
  });

  return gasPrice;
}

/**
 * Get the current USD price of a chain's native token.
 * Uses DeFi Llama coins API. Cached for 15 minutes.
 */
export async function getNativeTokenPrice(chainId: number): Promise<number> {
  if (nativePriceCache && Date.now() < nativePriceCache.expiresAt) {
    const price = nativePriceCache.prices.get(chainId);
    if (price !== undefined) return price;
  }

  // Fetch all native token prices at once
  await refreshNativeTokenPrices();

  const price = nativePriceCache?.prices.get(chainId);
  if (price === undefined) {
    throw new Error(
      `No price data for chain ${chainId} native token`,
    );
  }

  return price;
}

/**
 * Clear all caches. Useful for testing.
 */
export function clearGasOracleCache(): void {
  gasPriceCache.clear();
  nativePriceCache = null;
}

// --- Internal helpers ---

/**
 * Fetch native token prices for all supported chains from DeFi Llama.
 * Groups chains that share the same native token to minimize API calls.
 */
async function refreshNativeTokenPrices(): Promise<void> {
  // Deduplicate coin IDs (multiple chains share ETH)
  const uniqueCoinIds = [...new Set(Object.values(CHAIN_ID_TO_COIN_ID))];
  const coinList = uniqueCoinIds.join(",");

  try {
    const res = await fetch(`${DEFILLAMA_COINS_API}/${coinList}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`DeFi Llama coins API returned ${res.status}`);
    }

    const data: {
      coins: Record<string, { price: number; symbol: string }>;
    } = await res.json();

    const prices = new Map<number, number>();

    for (const [chainId, coinId] of Object.entries(CHAIN_ID_TO_COIN_ID)) {
      const coinData = data.coins[coinId];
      if (coinData) {
        prices.set(Number(chainId), coinData.price);
      }
    }

    nativePriceCache = {
      prices,
      expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
    };

    console.log(
      `[gas-oracle] Fetched native token prices for ${prices.size} chains`,
    );
  } catch (error) {
    console.warn(
      "[gas-oracle] Failed to fetch native token prices:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}
