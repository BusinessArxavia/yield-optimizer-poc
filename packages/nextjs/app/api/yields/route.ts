import { NextResponse } from "next/server";

// Force dynamic so Next.js doesn't cache the response across different capitalUsd values
export const dynamic = "force-dynamic";

/**
 * API route that fetches Aave V3 stablecoin yields from DeFi Llama
 * and computes rotation recommendations based on the current position.
 *
 * Query params:
 *  - currentChain: chain name where we're currently invested (default: "Base")
 *  - capitalUsd: total capital in USD (default: 1000)
 */

const YIELDS_API = "https://yields.llama.fi/pools";
const COINGECKO_LINK_API = "https://api.coingecko.com/api/v3/simple/price?ids=chainlink&vs_currencies=usd";
const SUPPORTED_CHAINS = ["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "BSC"];
const STABLECOINS = ["USDC", "USDT", "DAI", "GHO", "USDC.E", "USDT.E", "LUSD", "FRAX", "PYUSD", "CRVUSD", "USDbC"];

// Rotation decision config (mirrors shared/types.ts defaults)
const MIN_SPREAD_BPS = 25; // 0.25% minimum yield improvement
const MAX_BREAK_EVEN_DAYS = 30; // on the rotated portion (20% of TVL)
const MAX_PER_CHAIN_PCT = 40;
// Full rotation cost breakdown (in LINK):
//   CCIP msgs: 0.3 (token+supply) + 0.05 (report) + 0.3 (return) = 0.65 LINK
//   CRE execution trigger: ~0.01 LINK
//   Total LINK: ~0.66
// Plus gas on both chains (~$0.06 total on L2s)
const ROTATION_LINK_COST = 0.66; // CCIP (0.65) + CRE trigger (0.01)
const ROTATION_GAS_COST_USD = 0.06; // withdraw + approve + supply + report gas on L2s
const ROTATION_AMOUNT_BPS = 2000; // 20% of TVL rotated per action (matches workflow default)
const FALLBACK_LINK_PRICE_USD = 15; // fallback if CoinGecko is unavailable

async function fetchLinkPriceUsd(): Promise<number> {
  try {
    const res = await fetch(COINGECKO_LINK_API, {
      signal: AbortSignal.timeout(5_000),
      next: { revalidate: 300 },
    });
    if (!res.ok) return FALLBACK_LINK_PRICE_USD;
    const data = await res.json();
    return data?.chainlink?.usd ?? FALLBACK_LINK_PRICE_USD;
  } catch {
    return FALLBACK_LINK_PRICE_USD;
  }
}

type Pool = {
  poolId: string;
  chain: string;
  symbol: string;
  apy: number;
  apyBase: number;
  apyReward: number | null;
  tvlUsd: number;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyPct30D: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
  predictedClass: string | null;
  predictedConfidence: number | null;
  underlyingTokens: string[] | null;
};

type RotationRecommendation = {
  from: { chain: string; symbol: string; apy: number };
  to: { chain: string; symbol: string; apy: number };
  yieldImprovementBps: number;
  estimatedCostUsd: number;
  dailyGainUsd: number;
  breakEvenDays: number;
  netBenefitAnnualizedUsd: number;
  recommended: boolean;
  reason: string;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const currentChain = searchParams.get("currentChain") || "Base";
  const rawCapital = Number(searchParams.get("capitalUsd") || "1000");
  const capitalUsd = Number.isFinite(rawCapital) && rawCapital > 0 ? rawCapital : 1000;

  try {
    const linkPriceUsd = await fetchLinkPriceUsd();
    const estimatedRotationCostUsd = ROTATION_LINK_COST * linkPriceUsd + ROTATION_GAS_COST_USD;

    const res = await fetch(YIELDS_API, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 300 }, // cache 5 min
    });

    if (!res.ok) {
      return NextResponse.json({ error: `DeFi Llama returned ${res.status}` }, { status: 502 });
    }

    const raw = await res.json();
    const allPools: Pool[] = (raw.data || [])
      .filter(
        (p: Record<string, unknown>) =>
          p.project === "aave-v3" && p.stablecoin === true && SUPPORTED_CHAINS.includes(p.chain as string),
      )
      .map((p: Record<string, unknown>) => ({
        poolId: p.pool,
        chain: p.chain === "BSC" ? "BNB Chain" : p.chain,
        symbol: p.symbol,
        apy: p.apy ?? 0,
        apyBase: (p.apyBase as number) ?? 0,
        apyReward: p.apyReward ?? null,
        tvlUsd: p.tvlUsd ?? 0,
        apyPct1D: p.apyPct1D ?? null,
        apyPct7D: p.apyPct7D ?? null,
        apyPct30D: p.apyPct30D ?? null,
        apyMean30d: p.apyMean30d ?? null,
        stablecoin: true,
        predictedClass: (p.predictions as Record<string, unknown> | null)?.predictedClass ?? null,
        predictedConfidence: (p.predictions as Record<string, unknown> | null)?.binnedConfidence ?? null,
        underlyingTokens: p.underlyingTokens ?? null,
      }))
      .filter((p: Pool) => {
        const sym = p.symbol.toUpperCase();
        return STABLECOINS.some(s => sym.includes(s));
      })
      .sort((a: Pool, b: Pool) => b.apy - a.apy);

    // Find our current position (USDC on currentChain)
    const currentPool = allPools.find((p: Pool) => p.chain === currentChain && p.symbol.toUpperCase().includes("USDC"));
    const currentApy = currentPool?.apy ?? 0;

    // Generate rotation recommendations
    const recommendations: RotationRecommendation[] = [];
    const seenChainSymbol = new Set<string>();

    for (const pool of allPools) {
      const key = `${pool.chain}:${pool.symbol}`;
      if (seenChainSymbol.has(key)) continue;
      seenChainSymbol.add(key);

      // Skip if it's our current position
      if (pool.chain === currentChain && pool.symbol.toUpperCase().includes("USDC")) continue;

      const yieldImprovementPct = pool.apy - currentApy;
      const yieldImprovementBps = Math.round(yieldImprovementPct * 100);
      // Only the rotated portion (default 20%) earns the spread, not the full TVL
      const rotatedUsd = capitalUsd * (ROTATION_AMOUNT_BPS / 10000);
      const dailyGainUsd = ((yieldImprovementPct / 100) * rotatedUsd) / 365;
      const breakEvenDays = dailyGainUsd > 0 ? estimatedRotationCostUsd / dailyGainUsd : Infinity;
      const netBenefitAnnualizedUsd = (yieldImprovementPct / 100) * rotatedUsd - estimatedRotationCostUsd;

      // Determine recommendation
      const passesSpread = yieldImprovementBps >= MIN_SPREAD_BPS;
      const passesBreakEven = breakEvenDays <= MAX_BREAK_EVEN_DAYS;
      const passesMinImprovement = yieldImprovementPct > 0;
      const recommended = passesSpread && passesBreakEven && passesMinImprovement;

      let reason = "";
      if (recommended) {
        reason = `+${yieldImprovementPct.toFixed(2)}% APY improvement, breaks even in ${breakEvenDays.toFixed(1)} days`;
      } else if (!passesMinImprovement) {
        reason = `Lower APY than current position (${pool.apy.toFixed(2)}% vs ${currentApy.toFixed(2)}%)`;
      } else if (!passesSpread) {
        reason = `Spread too small (${yieldImprovementBps} bps < ${MIN_SPREAD_BPS} bps minimum)`;
      } else if (!passesBreakEven) {
        reason = `Break-even too long (${breakEvenDays.toFixed(0)} days > ${MAX_BREAK_EVEN_DAYS} max)`;
      }

      recommendations.push({
        from: { chain: currentChain, symbol: "USDC", apy: currentApy },
        to: { chain: pool.chain, symbol: pool.symbol, apy: pool.apy },
        yieldImprovementBps,
        estimatedCostUsd: estimatedRotationCostUsd,
        dailyGainUsd,
        breakEvenDays: Math.min(breakEvenDays, 9999),
        netBenefitAnnualizedUsd,
        recommended,
        reason,
      });
    }

    // Sort: recommended first, then by net benefit
    recommendations.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return b.netBenefitAnnualizedUsd - a.netBenefitAnnualizedUsd;
    });

    return NextResponse.json({
      pools: allPools,
      currentPosition: {
        chain: currentChain,
        symbol: "USDC",
        apy: currentApy,
        tvlUsd: currentPool?.tvlUsd ?? 0,
        apyMean30d: currentPool?.apyMean30d ?? null,
      },
      recommendations,
      config: {
        minSpreadBps: MIN_SPREAD_BPS,
        maxBreakEvenDays: MAX_BREAK_EVEN_DAYS,
        maxPerChainPct: MAX_PER_CHAIN_PCT,
        estimatedRotationCostUsd: Math.round(estimatedRotationCostUsd * 100) / 100,
        linkPriceUsd: Math.round(linkPriceUsd * 100) / 100,
        rotationLinkCost: ROTATION_LINK_COST,
        rotationGasCostUsd: ROTATION_GAS_COST_USD,
        rotationAmountBps: ROTATION_AMOUNT_BPS,
      },
      capitalUsd,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch yields" },
      { status: 500 },
    );
  }
}
