/**
 * DeFi Llama Yields API Integration
 *
 * Provides historical yield data and cross-protocol comparison for Aave V3.
 * Used for: validating on-chain data, historical trend analysis, detecting
 * transient yield spikes.
 *
 * API: https://yields.llama.fi/pools, https://yields.llama.fi/chart/{poolId}
 * Rate limit: no auth required, be respectful (~1 req/s).
 */

import { AAVE_CHAINS, type AaveChainConfig } from "@yield-optimizer/shared";

const YIELDS_API_BASE = "https://yields.llama.fi";
const POOLS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CHART_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 15_000;

// --- Types ---

export interface DefiLlamaPool {
  /** UUID pool identifier used for chart endpoint */
  poolId: string;
  chain: string;
  symbol: string;
  /** Total APY = apyBase + apyReward (percentage, e.g. 3.5 = 3.5%) */
  apy: number;
  /** Base supply APY (percentage) */
  apyBase: number;
  /** Reward/incentive APY (percentage), null if none */
  apyReward: number | null;
  /** Total value locked in USD */
  tvlUsd: number;
  /** Reward token addresses, null if none */
  rewardTokens: string[] | null;
  /** Underlying token addresses */
  underlyingTokens: string[] | null;
  /** APY change over 1 day (percentage points) */
  apyPct1D: number | null;
  /** APY change over 7 days (percentage points) */
  apyPct7D: number | null;
  /** APY change over 30 days (percentage points) */
  apyPct30D: number | null;
  /** Mean APY over 30 days (percentage) */
  apyMean30d: number | null;
  /** Whether this is a stablecoin pool */
  stablecoin: boolean;
  /** DeFi Llama prediction: Stable/Up, Down, etc. */
  predictedClass: string | null;
  /** Prediction confidence (1-3) */
  predictedConfidence: number | null;
}

export interface HistoricalYield {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Total APY (percentage) */
  apy: number;
  /** Base APY (percentage) */
  apyBase: number | null;
  /** Reward APY (percentage) */
  apyReward: number | null;
  /** TVL in USD */
  tvlUsd: number;
}

// --- Raw API response types ---

interface RawPoolResponse {
  status: string;
  data: RawPool[];
}

interface RawPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number;
  rewardTokens: string[] | null;
  underlyingTokens: string[] | null;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyPct30D: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
  predictions: {
    predictedClass: string | null;
    predictedProbability: number | null;
    binnedConfidence: number | null;
  } | null;
}

interface RawChartResponse {
  status: string;
  data: RawChartEntry[];
}

interface RawChartEntry {
  timestamp: string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number;
}

// --- Chain name mapping ---
// DeFi Llama uses specific chain names that may differ from ours

const CHAIN_ID_TO_DEFILLAMA_NAME: Record<number, string> = {};
for (const chain of AAVE_CHAINS) {
  // DeFi Llama uses "BSC" for BNB Chain
  if (chain.chainId === 56) {
    CHAIN_ID_TO_DEFILLAMA_NAME[56] = "BSC";
  } else {
    CHAIN_ID_TO_DEFILLAMA_NAME[chain.chainId] = chain.name;
  }
}

const DEFILLAMA_NAME_TO_CHAIN_ID: Record<string, number> = {};
for (const [id, name] of Object.entries(CHAIN_ID_TO_DEFILLAMA_NAME)) {
  DEFILLAMA_NAME_TO_CHAIN_ID[name] = Number(id);
}

// --- Cache ---

let poolsCache: { data: DefiLlamaPool[]; expiresAt: number } | null = null;
const chartCache = new Map<
  string,
  { data: HistoricalYield[]; expiresAt: number }
>();

// --- Public API ---

/**
 * Fetch all Aave V3 stablecoin pools from DeFi Llama.
 *
 * Results are cached for 15 minutes.
 * Returns empty array if the API is unreachable.
 */
export async function fetchDefiLlamaYields(): Promise<DefiLlamaPool[]> {
  if (poolsCache && Date.now() < poolsCache.expiresAt) {
    return poolsCache.data;
  }

  try {
    const res = await fetch(`${YIELDS_API_BASE}/pools`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(
        `DeFi Llama API returned ${res.status}: ${await res.text().catch(() => "unknown")}`,
      );
    }

    const raw: RawPoolResponse = await res.json();
    const pools = parsePoolsResponse(raw);

    poolsCache = { data: pools, expiresAt: Date.now() + POOLS_CACHE_TTL_MS };

    console.log(
      `[defillama] Fetched ${pools.length} Aave V3 stablecoin pools`,
    );

    return pools;
  } catch (error) {
    console.warn(
      "[defillama] Failed to fetch pools, returning empty array:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Fetch historical APY/TVL data for a specific pool.
 *
 * @param poolId — DeFi Llama pool UUID (from `DefiLlamaPool.poolId`)
 * @param days — Number of recent days to return (default: 30)
 *
 * Results are cached for 1 hour per poolId.
 * Returns empty array if the API is unreachable.
 */
export async function fetchPoolHistory(
  poolId: string,
  days = 30,
): Promise<HistoricalYield[]> {
  const cacheKey = `${poolId}:${days}`;
  const cached = chartCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    const res = await fetch(`${YIELDS_API_BASE}/chart/${poolId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(
        `DeFi Llama chart API returned ${res.status}: ${await res.text().catch(() => "unknown")}`,
      );
    }

    const raw: RawChartResponse = await res.json();
    const history = parseChartResponse(raw, days);

    chartCache.set(cacheKey, {
      data: history,
      expiresAt: Date.now() + CHART_CACHE_TTL_MS,
    });

    return history;
  } catch (error) {
    console.warn(
      `[defillama] Failed to fetch chart for ${poolId}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Find the DeFi Llama pool ID for a given chain + stablecoin.
 *
 * Useful for bridging between on-chain data (chainId + symbol) and
 * DeFi Llama's UUID-based pool identifiers.
 */
export async function findPoolId(
  chainId: number,
  symbol: string,
): Promise<string | null> {
  const pools = await fetchDefiLlamaYields();
  const chainName = CHAIN_ID_TO_DEFILLAMA_NAME[chainId];
  if (!chainName) return null;

  const match = pools.find(
    (p) =>
      p.chain === chainName &&
      p.symbol.toUpperCase() === symbol.toUpperCase(),
  );

  return match?.poolId ?? null;
}

/**
 * Clear all DeFi Llama caches. Useful for testing.
 */
export function clearDefiLlamaCache(): void {
  poolsCache = null;
  chartCache.clear();
}

// --- Internal helpers ---

function parsePoolsResponse(raw: RawPoolResponse): DefiLlamaPool[] {
  if (!raw.data || !Array.isArray(raw.data)) return [];

  // Filter: Aave V3, stablecoin, on our supported chains
  const supportedChainNames = new Set(
    Object.values(CHAIN_ID_TO_DEFILLAMA_NAME),
  );

  return raw.data
    .filter(
      (p) =>
        p.project === "aave-v3" &&
        p.stablecoin &&
        supportedChainNames.has(p.chain),
    )
    .map((p) => ({
      poolId: p.pool,
      chain: p.chain,
      symbol: p.symbol,
      apy: p.apy ?? 0,
      apyBase: p.apyBase ?? 0,
      apyReward: p.apyReward,
      tvlUsd: p.tvlUsd ?? 0,
      rewardTokens: p.rewardTokens,
      underlyingTokens: p.underlyingTokens,
      apyPct1D: p.apyPct1D,
      apyPct7D: p.apyPct7D,
      apyPct30D: p.apyPct30D,
      apyMean30d: p.apyMean30d,
      stablecoin: p.stablecoin,
      predictedClass: p.predictions?.predictedClass ?? null,
      predictedConfidence: p.predictions?.binnedConfidence ?? null,
    }));
}

function parseChartResponse(
  raw: RawChartResponse,
  days: number,
): HistoricalYield[] {
  if (!raw.data || !Array.isArray(raw.data)) return [];

  // Return only the most recent `days` entries
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return raw.data
    .filter((entry) => new Date(entry.timestamp).getTime() >= cutoff)
    .map((entry) => ({
      timestamp: entry.timestamp,
      apy: entry.apy ?? 0,
      apyBase: entry.apyBase,
      apyReward: entry.apyReward,
      tvlUsd: entry.tvlUsd ?? 0,
    }));
}
