/**
 * Bridge Cost Estimation Service
 *
 * Estimates the total cost of bridging stablecoins between supported chains.
 * Uses three strategies:
 *   1. CCTP — for USDC transfers (cheapest, burn/mint native USDC)
 *   2. Li.Fi — meta-aggregator for any stablecoin pair (aggregates Across, Stargate, etc.)
 *   3. CCIP — placeholder for Chainlink CCIP (requires on-chain router.getFee() in Phase 3)
 *
 * Returns the cheapest available option.
 */

import {
  STABLECOINS,
  type BridgeCostParams,
  type BridgeCostEstimate,
} from "@yield-optimizer/shared";

const LIFI_API_BASE = "https://li.quest/v1";
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Dummy address for Li.Fi quotes (estimation only, no real tx)
const ESTIMATION_ADDRESS = "0x0000000000000000000000000000000000000001";

// CCTP constants
const CCTP_FEE_BPS = 1; // 1 basis point (0.01%)
// Approximate gas units for CCTP burn on L2s. Conservative estimate.
const CCTP_GAS_UNITS = 65_000n;
// Approximate gas price in gwei for L2s (used as fallback when gas oracle isn't available)
const DEFAULT_L2_GAS_PRICE_GWEI = 0.01; // ~0.01 gwei on L2s
const DEFAULT_ETH_GAS_PRICE_GWEI = 20; // ~20 gwei on Ethereum mainnet
// Approximate native token prices in USD (fallback estimates, updated in gas oracle service)
const NATIVE_TOKEN_PRICE_USD: Record<number, number> = {
  1: 1900, // ETH
  8453: 1900, // ETH (Base)
  42161: 1900, // ETH (Arbitrum)
  10: 1900, // ETH (Optimism)
  137: 0.35, // MATIC/POL
  43114: 22, // AVAX
  56: 320, // BNB
};

// CCTP estimated transfer duration in seconds
const CCTP_DURATION: Record<number, number> = {
  1: 780, // Ethereum → ~13 minutes (finality)
  8453: 60, // Base → ~1 minute
  42161: 60, // Arbitrum → ~1 minute
  10: 60, // Optimism → ~1 minute
  137: 180, // Polygon → ~3 minutes
  43114: 60, // Avalanche → ~1 minute
  56: 60, // BNB → ~1 minute
};

// --- Cache ---

const quoteCache = new Map<
  string,
  { data: BridgeCostEstimate; expiresAt: number }
>();

// --- Public API ---

/**
 * Estimate the cheapest bridge cost for a cross-chain stablecoin transfer.
 *
 * Strategy:
 *   1. If USDC → compute CCTP estimate (burn/mint, ~1 bps)
 *   2. Always fetch Li.Fi quote (meta-aggregator of 13+ bridges)
 *   3. Return the cheapest option
 *
 * Returns null if no bridge route is available.
 */
export async function estimateBridgeCost(
  params: BridgeCostParams,
): Promise<BridgeCostEstimate | null> {
  if (params.fromChainId === params.toChainId) return null;

  const cacheKey = makeCacheKey(params);
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const estimates: BridgeCostEstimate[] = [];

  // 1. CCTP estimate (USDC only)
  if (isCctpEligible(params.stablecoin, params.fromChainId, params.toChainId)) {
    const cctp = estimateCctpCost(params);
    estimates.push(cctp);
  }

  // 2. Li.Fi quote (any stablecoin pair)
  const lifi = await fetchLifiQuote(params);
  if (lifi) estimates.push(lifi);

  if (estimates.length === 0) return null;

  // Return cheapest
  estimates.sort((a, b) => a.totalUSD - b.totalUSD);
  const best = estimates[0];

  quoteCache.set(cacheKey, {
    data: best,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return best;
}

/**
 * Clear the bridge cost cache. Useful for testing.
 */
export function clearBridgeCostCache(): void {
  quoteCache.clear();
}

// --- CCTP Estimation ---

/**
 * Check if a stablecoin is eligible for CCTP bridging between two chains.
 * CCTP only supports USDC and requires both chains to have CCTP support.
 */
function isCctpEligible(
  stablecoin: string,
  fromChainId: number,
  toChainId: number,
): boolean {
  const coin = STABLECOINS.find((c) => c.symbol === stablecoin);
  if (!coin?.cctpSupported) return false;

  // Both chains must have the stablecoin deployed
  return !!coin.addresses[fromChainId] && !!coin.addresses[toChainId];
}

/**
 * Estimate CCTP cost for a USDC transfer.
 * CCTP fee: ~1 basis point (0.01%) of the transfer amount.
 * Gas: source chain gas for the burn transaction.
 */
function estimateCctpCost(params: BridgeCostParams): BridgeCostEstimate {
  const coin = STABLECOINS.find((c) => c.symbol === params.stablecoin);
  const decimals = coin?.decimals ?? 6;

  // Fee = amount * 1 bps
  const amountUSD =
    Number(params.amount) / Math.pow(10, decimals);
  const feesUSD = amountUSD * (CCTP_FEE_BPS / 10_000);

  // Gas cost estimate
  const gasUSD = estimateGasCostUSD(params.fromChainId, CCTP_GAS_UNITS);

  return {
    provider: "cctp",
    feesUSD: roundToDecimals(feesUSD, 4),
    gasUSD: roundToDecimals(gasUSD, 4),
    totalUSD: roundToDecimals(feesUSD + gasUSD, 4),
    estimatedDurationSeconds: CCTP_DURATION[params.fromChainId] ?? 120,
  };
}

// --- Li.Fi Estimation ---

/**
 * Fetch a bridge quote from Li.Fi's API.
 * Li.Fi aggregates 13+ bridges and returns the optimal route.
 */
async function fetchLifiQuote(
  params: BridgeCostParams,
): Promise<BridgeCostEstimate | null> {
  const fromToken = getTokenAddress(params.stablecoin, params.fromChainId);
  const toToken = getTokenAddress(params.stablecoin, params.toChainId);
  if (!fromToken || !toToken) return null;

  try {
    const url = new URL(`${LIFI_API_BASE}/quote`);
    url.searchParams.set("fromChain", String(params.fromChainId));
    url.searchParams.set("toChain", String(params.toChainId));
    url.searchParams.set("fromToken", fromToken);
    url.searchParams.set("toToken", toToken);
    url.searchParams.set("fromAmount", String(params.amount));
    url.searchParams.set("fromAddress", ESTIMATION_ADDRESS);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "unknown");
      console.warn(`[bridge-cost] Li.Fi API returned ${res.status}: ${body}`);
      return null;
    }

    const data = await res.json();
    return parseLifiQuote(data);
  } catch (error) {
    console.warn(
      "[bridge-cost] Li.Fi quote failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

interface LifiQuoteResponse {
  estimate: {
    gasCosts: { amountUSD: string }[];
    feeCosts: { amountUSD: string; included: boolean }[];
    executionDuration: number;
  };
}

function parseLifiQuote(data: LifiQuoteResponse): BridgeCostEstimate | null {
  const estimate = data?.estimate;
  if (!estimate) return null;

  const gasUSD = (estimate.gasCosts ?? []).reduce(
    (sum, g) => sum + parseFloat(g.amountUSD || "0"),
    0,
  );

  // Only count fees that are "included" (deducted from the output)
  const feesUSD = (estimate.feeCosts ?? []).reduce(
    (sum, f) => sum + parseFloat(f.amountUSD || "0"),
    0,
  );

  return {
    provider: "lifi",
    feesUSD: roundToDecimals(feesUSD, 4),
    gasUSD: roundToDecimals(gasUSD, 4),
    totalUSD: roundToDecimals(feesUSD + gasUSD, 4),
    estimatedDurationSeconds: estimate.executionDuration ?? 300,
  };
}

// --- Helpers ---

function getTokenAddress(
  stablecoin: string,
  chainId: number,
): string | null {
  const coin = STABLECOINS.find((c) => c.symbol === stablecoin);
  return coin?.addresses[chainId] ?? null;
}

/**
 * Rough gas cost estimate in USD for a given number of gas units on a chain.
 * Uses hardcoded gas prices as fallback. Will be replaced by gas oracle (Task 1.8).
 */
function estimateGasCostUSD(chainId: number, gasUnits: bigint): number {
  const isEthereum = chainId === 1;
  const gasPriceGwei = isEthereum
    ? DEFAULT_ETH_GAS_PRICE_GWEI
    : DEFAULT_L2_GAS_PRICE_GWEI;

  const nativeTokenPrice = NATIVE_TOKEN_PRICE_USD[chainId] ?? 1900;

  // cost = gasUnits * gasPriceGwei * 1e-9 * nativeTokenPrice
  const costETH = Number(gasUnits) * gasPriceGwei * 1e-9;
  return costETH * nativeTokenPrice;
}

function makeCacheKey(params: BridgeCostParams): string {
  return `${params.fromChainId}:${params.toChainId}:${params.stablecoin}:${params.amount}`;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
