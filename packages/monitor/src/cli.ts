#!/usr/bin/env node

/**
 * CLI Monitor — Aave Yield Optimizer
 *
 * Fetches live yield data across all Aave V3 chains, enriches with Merkl
 * incentives, and displays a ranked yield table with rotation recommendations.
 *
 * Run with: yarn monitor
 */

import "dotenv/config";

import { AAVE_CHAINS, DEFAULT_ROTATION_CONFIG } from "@yield-optimizer/shared";
import type { PoolYieldData, RotationCandidate } from "@yield-optimizer/shared";

import { fetchAllChainYields } from "./services/aave-data.js";
import { fetchMerklIncentives } from "./services/incentive-data.js";
import {
  calculateYields,
  evaluateRotations,
  getRecommendedRotations,
  computeOptimalAllocation,
} from "./engine/index.js";
import type {
  EnrichedPool,
  CurrentPosition,
  OptimalAllocation,
} from "./engine/index.js";

// ─── Formatting helpers ────────────────────────────────────────────

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function bigintToUSD(value: bigint, decimals: number): string {
  const num = Number(value) / Math.pow(10, decimals);
  return usd(num);
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : " ".repeat(len - str.length) + str;
}

function getChainName(chainId: number): string {
  return AAVE_CHAINS.find((c) => c.chainId === chainId)?.name ?? `Chain ${chainId}`;
}

function getStablecoinDecimals(stablecoin: string): number {
  return stablecoin === "DAI" || stablecoin === "GHO" ? 18 : 6;
}

// ─── Table rendering ───────────────────────────────────────────────

function printYieldTable(pools: EnrichedPool[]): void {
  const headers = ["#", "Chain", "Coin", "Supply APY", "Incentive", "Merkl", "Net APY", "TVL", "Cap Headroom"];
  const widths = [4, 12, 6, 11, 11, 9, 9, 12, 14];

  // Header
  const headerLine = headers.map((h, i) => padRight(h, widths[i])).join(" │ ");
  const divider = widths.map((w) => "─".repeat(w)).join("─┼─");

  console.log(`\n  ${headerLine}`);
  console.log(`  ${divider}`);

  // Rows
  for (const pool of pools) {
    const decimals = getStablecoinDecimals(pool.stablecoin);
    const row = [
      padLeft(String(pool.rank), widths[0]),
      padRight(pool.chainName, widths[1]),
      padRight(pool.stablecoin, widths[2]),
      padLeft(pct(pool.supplyAPY), widths[3]),
      padLeft(pct(pool.incentiveAPY), widths[4]),
      padLeft(pool.merklAPY > 0 ? pct(pool.merklAPY) : "—", widths[5]),
      padLeft(pct(pool.netAPY), widths[6]),
      padLeft(bigintToUSD(pool.totalSupplied, decimals), widths[7]),
      padLeft(
        pool.supplyCap === 0n ? "unlimited" : bigintToUSD(pool.supplyCapHeadroom, decimals),
        widths[8],
      ),
    ];
    console.log(`  ${row.join(" │ ")}`);
  }

  console.log();
}

function printOptimalAllocation(allocation: OptimalAllocation): void {
  console.log("── Optimal Allocation (mock $100k) ──────────────────────────────\n");

  if (allocation.targets.length === 0) {
    console.log("  No allocation targets (no pools with positive APY).\n");
    return;
  }

  const headers = ["Chain", "Coin", "Allocation", "Pct", "Net APY"];
  const widths = [12, 6, 12, 6, 9];

  const headerLine = headers.map((h, i) => padRight(h, widths[i])).join(" │ ");
  const divider = widths.map((w) => "─".repeat(w)).join("─┼─");

  console.log(`  ${headerLine}`);
  console.log(`  ${divider}`);

  for (const target of allocation.targets) {
    const row = [
      padRight(target.chainName, widths[0]),
      padRight(target.stablecoin, widths[1]),
      padLeft(usd(target.allocationUSD), widths[2]),
      padLeft(`${target.allocationPct.toFixed(0)}%`, widths[3]),
      padLeft(pct(target.netAPY), widths[4]),
    ];
    console.log(`  ${row.join(" │ ")}`);
  }

  console.log();
  console.log(`  Weighted APY: ${pct(allocation.weightedAPY)}`);
  console.log();
}

function printRotationRecommendations(candidates: RotationCandidate[]): void {
  console.log("── Rotation Recommendations ─────────────────────────────────────\n");

  const recommended = getRecommendedRotations(candidates);

  if (recommended.length === 0) {
    console.log("  No rotations recommended at current yield spreads.\n");

    if (candidates.length > 0) {
      console.log(`  (${candidates.length} candidate(s) evaluated but failed thresholds)\n`);
    }
    return;
  }

  for (const r of recommended) {
    const fromChain = getChainName(r.from.chainId);
    const toChain = getChainName(r.to.chainId);
    const improvement = pct(r.yieldImprovement);
    const cost = usd(r.estimatedCost);
    const breakEven = r.breakEvenDays.toFixed(1);
    const benefit = usd(r.netBenefitAnnualized);

    console.log(
      `  ✓ ${fromChain} ${r.from.stablecoin} → ${toChain} ${r.to.stablecoin}`,
    );
    console.log(
      `    Gain: +${improvement}/yr | Cost: ${cost} | Break-even: ${breakEven}d | Net benefit: ${benefit}/yr`,
    );
    console.log();
  }

  // Summary of non-recommended candidates
  const rejected = candidates.length - recommended.length;
  if (rejected > 0) {
    console.log(`  (${rejected} additional candidate(s) below thresholds)\n`);
  }
}

// ─── Mock positions for rotation analysis ──────────────────────────

function createMockPositions(pools: EnrichedPool[]): CurrentPosition[] {
  // Simulate: $100k spread across the bottom-ranked pools to test rotation
  // recommendations (shows what rotations would be suggested)
  if (pools.length === 0) return [];

  // Pick the lowest-yielding pool as the "current position"
  const worst = pools[pools.length - 1];
  const decimals = getStablecoinDecimals(worst.stablecoin);

  return [
    {
      chainId: worst.chainId,
      stablecoin: worst.stablecoin,
      amount: BigInt(100_000) * BigInt(Math.pow(10, decimals)),
      decimals,
      currentAPY: worst.netAPY,
    },
  ];
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          Aave Yield Optimizer — Monitor CLI                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // Check for RPC URLs
  const configuredChains = AAVE_CHAINS.filter(
    (c) => process.env[c.rpcEnvKey] && !process.env[c.rpcEnvKey]!.includes("YOUR_KEY"),
  );
  console.log(
    `[config] ${configuredChains.length}/${AAVE_CHAINS.length} chains have RPC URLs configured`,
  );

  if (configuredChains.length === 0) {
    console.error(
      "\n✗ No RPC URLs configured. Copy .env.example to .env and add your Alchemy/Infura keys.\n",
    );
    process.exit(1);
  }

  // Step 1: Fetch Aave yields + Merkl incentives in parallel
  console.log("\n[1/4] Fetching Aave yields + Merkl incentives...\n");

  const [rawPools, merklIncentives] = await Promise.all([
    fetchAllChainYields(),
    fetchMerklIncentives(),
  ]);

  console.log(
    `[merkl] ${merklIncentives.size} incentive entries loaded`,
  );

  // Step 2: Enrich with Merkl APY and rank
  console.log("[2/4] Calculating yields...\n");

  const enrichedPools = calculateYields(rawPools, merklIncentives);

  // Summary by chain
  const chainCounts = new Map<string, number>();
  for (const pool of enrichedPools) {
    chainCounts.set(pool.chainName, (chainCounts.get(pool.chainName) ?? 0) + 1);
  }
  console.log(
    `[yields] ${enrichedPools.length} pools across ${chainCounts.size} chains: ${[...chainCounts.entries()]
      .map(([name, count]) => `${name}(${count})`)
      .join(", ")}`,
  );

  // Step 3: Display yield table
  console.log("\n── Yield Table (ranked by Net APY) ──────────────────────────────");
  printYieldTable(enrichedPools);

  // Step 4: Optimal allocation + rotation recommendations
  console.log("[3/4] Computing optimal allocation...\n");

  const mockPositions = createMockPositions(enrichedPools);
  const config = DEFAULT_ROTATION_CONFIG;

  const allocation = computeOptimalAllocation(
    100_000,
    enrichedPools,
    config,
    mockPositions,
  );
  printOptimalAllocation(allocation);

  console.log("[4/4] Evaluating rotation candidates...\n");

  try {
    const candidates = await evaluateRotations(
      mockPositions,
      enrichedPools,
      config,
    );
    printRotationRecommendations(candidates);
  } catch (error) {
    console.warn(
      "[rotation] Failed to evaluate rotations (bridge/gas APIs may be unavailable):",
      error instanceof Error ? error.message : error,
    );
    console.log();
  }

  // Done
  const topPool = enrichedPools[0];
  if (topPool) {
    console.log(
      `★ Best yield: ${topPool.chainName} ${topPool.stablecoin} at ${pct(topPool.netAPY)} net APY`,
    );
  }
  console.log(`\nDone. ${enrichedPools.length} pools analyzed at ${new Date().toISOString()}\n`);
}

main().catch((error) => {
  console.error("\n✗ Monitor failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
