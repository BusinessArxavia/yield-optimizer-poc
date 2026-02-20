/**
 * Merkl Incentive Data Service
 *
 * Fetches additional incentive APY from Merkl campaigns on top of base Aave yields.
 * Returns a map of `${chainId}:${tokenAddress}` → incentive APR (decimal).
 *
 * API: https://api.merkl.xyz/v4/opportunities
 * Rate limit: 10 req/s (no auth required)
 */

const MERKL_API_BASE = "https://api.merkl.xyz/v4";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// --- Types for Merkl API response ---

interface MerklOpportunity {
  chainId: number;
  name: string;
  status: "LIVE" | "PAST";
  action: string;
  apr: number; // top-level APR as percentage (e.g., 4.52 = 4.52%)
  tvl: number;
  depositUrl: string;
  tokens: MerklToken[];
  aprRecord: {
    cumulated: number; // total incentive APR as percentage
    breakdowns: { value: number; identifier: string }[];
  };
}

interface MerklToken {
  symbol: string;
  address: string;
  chainId: number;
  decimals: number;
  verified: boolean;
}

// --- Cache ---

let cache: { data: Map<string, number>; expiresAt: number } | null = null;

/**
 * Extract the underlying token address from a Merkl opportunity.
 *
 * Strategy (in order of reliability):
 * 1. Parse `underlyingAsset` from the `depositUrl` query string
 * 2. Fall back to the first token in the `tokens` array that isn't
 *    an aToken or debt token (heuristic based on symbol prefix)
 */
function extractUnderlyingAsset(opp: MerklOpportunity): string | null {
  // 1. Parse depositUrl
  try {
    const url = new URL(opp.depositUrl);
    const asset = url.searchParams.get("underlyingAsset");
    if (asset && asset.startsWith("0x")) return asset.toLowerCase();
  } catch {
    // URL parsing failed — try fallback
  }

  // 2. Heuristic: find token that isn't an aToken or debt token
  for (const token of opp.tokens) {
    const s = token.symbol.toLowerCase();
    if (
      !s.startsWith("a") ||
      // Allow tokens like "AAVE", "ARB" — only skip aToken prefixes
      (!s.startsWith("aeth") &&
        !s.startsWith("aman") &&
        !s.startsWith("abase") &&
        !s.startsWith("aopt") &&
        !s.startsWith("apol") &&
        !s.startsWith("aavax"))
    ) {
      if (!s.startsWith("variabledebt")) {
        return token.address.toLowerCase();
      }
    }
  }

  // 3. Last resort: first token
  if (opp.tokens.length > 0) {
    return opp.tokens[0].address.toLowerCase();
  }

  return null;
}

/**
 * Fetch all LIVE Aave lending incentives from Merkl.
 *
 * Returns a Map of `${chainId}:${tokenAddress}` → incentive APR as decimal
 * (e.g., 0.0452 = 4.52%).
 *
 * Results are cached for 30 minutes.
 * Returns an empty map if the API is unreachable.
 */
export async function fetchMerklIncentives(): Promise<Map<string, number>> {
  // Check cache
  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const incentives = new Map<string, number>();

  try {
    const opportunities = await fetchOpportunities();

    for (const opp of opportunities) {
      // Skip non-LIVE or non-LEND
      if (opp.status !== "LIVE" || opp.action !== "LEND") continue;

      // Skip opportunities with negligible APR
      const aprPercent = opp.aprRecord?.cumulated ?? opp.apr ?? 0;
      if (aprPercent <= 0) continue;

      const tokenAddress = extractUnderlyingAsset(opp);
      if (!tokenAddress) continue;

      const key = `${opp.chainId}:${tokenAddress}`;
      const aprDecimal = aprPercent / 100; // 4.52% → 0.0452

      // If multiple campaigns for same token on same chain, take the highest
      const existing = incentives.get(key) ?? 0;
      if (aprDecimal > existing) {
        incentives.set(key, aprDecimal);
      }
    }

    // Update cache
    cache = { data: incentives, expiresAt: Date.now() + CACHE_TTL_MS };

    console.log(
      `[merkl] Fetched ${incentives.size} incentive entries from ${opportunities.length} opportunities`,
    );
  } catch (error) {
    console.warn(
      "[merkl] Failed to fetch incentives, returning empty map:",
      error instanceof Error ? error.message : error,
    );
    // Return empty map — don't crash the pipeline
  }

  return incentives;
}

/**
 * Fetch opportunities from the Merkl API with pagination.
 * Currently ~16 LIVE Aave lending opportunities, so one page suffices.
 */
async function fetchOpportunities(): Promise<MerklOpportunity[]> {
  const all: MerklOpportunity[] = [];
  let page = 0;
  const pageSize = 20;

  while (true) {
    const url = new URL(`${MERKL_API_BASE}/opportunities`);
    url.searchParams.set("mainProtocolId", "aave");
    url.searchParams.set("action", "LEND");
    url.searchParams.set("status", "LIVE");
    url.searchParams.set("items", String(pageSize));
    url.searchParams.set("page", String(page));

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(
        `Merkl API returned ${res.status}: ${await res.text().catch(() => "unknown")}`,
      );
    }

    const data: MerklOpportunity[] = await res.json();
    all.push(...data);

    // No pagination metadata — if fewer than pageSize, we're done
    if (data.length < pageSize) break;
    page++;

    // Safety valve — never fetch more than 5 pages
    if (page >= 5) break;
  }

  return all;
}

/**
 * Clear the incentive cache. Useful for testing.
 */
export function clearMerklCache(): void {
  cache = null;
}
