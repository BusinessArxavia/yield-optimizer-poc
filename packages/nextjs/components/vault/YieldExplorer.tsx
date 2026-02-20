"use client";

import { useCallback, useEffect, useState } from "react";

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
  predictedClass: string | null;
};

type Recommendation = {
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

type YieldData = {
  pools: Pool[];
  currentPosition: { chain: string; symbol: string; apy: number; tvlUsd: number; apyMean30d: number | null };
  recommendations: Recommendation[];
  config: { minSpreadBps: number; maxBreakEvenDays: number; estimatedRotationCostUsd: number };
  fetchedAt: string;
};

const CHAIN_COLORS: Record<string, string> = {
  Base: "bg-blue-500",
  Arbitrum: "bg-sky-400",
  Optimism: "bg-red-500",
  Polygon: "bg-purple-500",
  Ethereum: "bg-indigo-600",
  Avalanche: "bg-red-600",
  "BNB Chain": "bg-yellow-500",
};

const trendBadge = (val: number | null) => {
  if (val === null || val === undefined) return null;
  const positive = val >= 0;
  return (
    <span className={`text-xs font-mono ${positive ? "text-success" : "text-error"}`}>
      {positive ? "+" : ""}
      {val.toFixed(2)}%
    </span>
  );
};

export const YieldExplorer = () => {
  const [data, setData] = useState<YieldData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterChain, setFilterChain] = useState<string>("all");
  const [filterStable, setFilterStable] = useState<string>("all");
  const [showOnlyRecommended, setShowOnlyRecommended] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/yields?currentChain=Base&capitalUsd=10000");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body items-center">
          <span className="loading loading-spinner loading-lg text-primary" />
          <p className="text-sm opacity-60 mt-2">Loading yields from DeFi Llama...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-error">Error Loading Yields</h2>
          <p>{error}</p>
          <button className="btn btn-sm btn-primary" onClick={fetchData}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { pools, currentPosition, recommendations, config } = data;

  // Unique chains and stablecoins for filters
  const chains = [...new Set(pools.map(p => p.chain))].sort();
  const stables = [...new Set(pools.map(p => p.symbol))].sort();

  // Filtered pools
  const filteredPools = pools.filter(p => {
    if (filterChain !== "all" && p.chain !== filterChain) return false;
    if (filterStable !== "all" && p.symbol !== filterStable) return false;
    return true;
  });

  const filteredRecs = showOnlyRecommended ? recommendations.filter(r => r.recommended) : recommendations;

  const recommendedCount = recommendations.filter(r => r.recommended).length;
  const bestRec = recommendations.find(r => r.recommended);

  return (
    <div className="space-y-6">
      {/* Current Position */}
      <div className="card bg-gradient-to-r from-primary/10 to-primary/5 shadow-xl border border-primary/20">
        <div className="card-body">
          <h2 className="card-title text-primary">Current Position</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
            <div>
              <p className="text-sm opacity-60">Chain</p>
              <p className="text-xl font-bold flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full ${CHAIN_COLORS[currentPosition.chain] || "bg-gray-400"}`} />
                {currentPosition.chain}
              </p>
            </div>
            <div>
              <p className="text-sm opacity-60">Asset</p>
              <p className="text-xl font-bold">{currentPosition.symbol}</p>
            </div>
            <div>
              <p className="text-sm opacity-60">Current APY</p>
              <p className="text-2xl font-bold text-primary">{currentPosition.apy.toFixed(2)}%</p>
            </div>
            <div>
              <p className="text-sm opacity-60">30d Mean APY</p>
              <p className="text-xl font-bold">
                {currentPosition.apyMean30d !== null ? `${currentPosition.apyMean30d.toFixed(2)}%` : "N/A"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Strategy Recommendation Summary */}
      <div className={`card shadow-xl ${bestRec ? "bg-success/10 border border-success/30" : "bg-base-100"}`}>
        <div className="card-body">
          <h2 className="card-title">
            Strategy Advisor
            {recommendedCount > 0 && (
              <span className="badge badge-success">
                {recommendedCount} rotation{recommendedCount > 1 ? "s" : ""} recommended
              </span>
            )}
          </h2>

          {bestRec ? (
            <div className="mt-2">
              <div className="alert alert-success">
                <div>
                  <p className="font-bold">
                    Rotate {currentPosition.symbol} from {bestRec.from.chain} to {bestRec.to.symbol} on{" "}
                    {bestRec.to.chain}
                  </p>
                  <p className="text-sm">{bestRec.reason}</p>
                  <div className="flex gap-4 mt-2 text-sm">
                    <span>
                      APY: {bestRec.from.apy.toFixed(2)}% → {bestRec.to.apy.toFixed(2)}%
                    </span>
                    <span>Cost: ~${bestRec.estimatedCostUsd.toFixed(2)}</span>
                    <span>Break-even: {bestRec.breakEvenDays.toFixed(1)}d</span>
                    <span>Annual gain: ${bestRec.netBenefitAnnualizedUsd.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="alert">
              <div>
                <p className="font-bold">Stay on {currentPosition.chain}</p>
                <p className="text-sm">
                  No rotation currently justified. Current APY ({currentPosition.apy.toFixed(2)}%) is competitive. Min
                  spread required: {config.minSpreadBps} bps, max break-even: {config.maxBreakEvenDays} days.
                </p>
              </div>
            </div>
          )}

          <div className="text-xs opacity-40 mt-2">
            Decision config: min spread {config.minSpreadBps}bps, max break-even {config.maxBreakEvenDays}d, est.
            rotation cost ${config.estimatedRotationCostUsd}
          </div>
        </div>
      </div>

      {/* All Pools Table */}
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="card-title">All Aave V3 Pools ({filteredPools.length})</h2>
            <div className="flex gap-2 flex-wrap">
              <select
                className="select select-sm select-bordered"
                value={filterChain}
                onChange={e => setFilterChain(e.target.value)}
              >
                <option value="all">All Chains</option>
                {chains.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                className="select select-sm select-bordered"
                value={filterStable}
                onChange={e => setFilterStable(e.target.value)}
              >
                <option value="all">All Stablecoins</option>
                {stables.map(s => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm btn-ghost" onClick={fetchData}>
                Refresh
              </button>
            </div>
          </div>

          <div className="overflow-x-auto mt-2">
            <table className="table table-sm table-zebra">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Chain</th>
                  <th>Asset</th>
                  <th className="text-right">APY</th>
                  <th className="text-right">Base</th>
                  <th className="text-right">Reward</th>
                  <th className="text-right">TVL</th>
                  <th className="text-right">1D</th>
                  <th className="text-right">7D</th>
                  <th className="text-right">30D Avg</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {filteredPools.map((pool, i) => {
                  const isCurrent = pool.chain === currentPosition.chain && pool.symbol.toUpperCase().includes("USDC");
                  return (
                    <tr key={pool.poolId} className={isCurrent ? "bg-primary/10 font-semibold" : ""}>
                      <td className="text-xs opacity-50">{i + 1}</td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2.5 h-2.5 rounded-full ${CHAIN_COLORS[pool.chain] || "bg-gray-400"}`} />
                          <span className="text-sm">{pool.chain}</span>
                        </div>
                      </td>
                      <td className="text-sm">
                        {pool.symbol}
                        {isCurrent && <span className="badge badge-primary badge-xs ml-1">YOU</span>}
                      </td>
                      <td className="text-right font-mono font-bold">{pool.apy.toFixed(2)}%</td>
                      <td className="text-right font-mono text-sm opacity-70">{pool.apyBase.toFixed(2)}%</td>
                      <td className="text-right font-mono text-sm opacity-70">
                        {pool.apyReward !== null ? `${pool.apyReward.toFixed(2)}%` : "-"}
                      </td>
                      <td className="text-right font-mono text-sm">
                        $
                        {pool.tvlUsd >= 1_000_000
                          ? `${(pool.tvlUsd / 1_000_000).toFixed(1)}M`
                          : pool.tvlUsd >= 1_000
                            ? `${(pool.tvlUsd / 1_000).toFixed(0)}K`
                            : pool.tvlUsd.toFixed(0)}
                      </td>
                      <td className="text-right">{trendBadge(pool.apyPct1D)}</td>
                      <td className="text-right">{trendBadge(pool.apyPct7D)}</td>
                      <td className="text-right font-mono text-sm">
                        {pool.apyMean30d !== null ? `${pool.apyMean30d.toFixed(2)}%` : "-"}
                      </td>
                      <td>
                        {pool.predictedClass && (
                          <span
                            className={`badge badge-xs ${
                              pool.predictedClass.includes("Up") || pool.predictedClass.includes("Stable")
                                ? "badge-success"
                                : "badge-warning"
                            }`}
                          >
                            {pool.predictedClass}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Rotation Candidates */}
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <div className="flex items-center justify-between">
            <h2 className="card-title">Rotation Candidates</h2>
            <label className="label cursor-pointer gap-2">
              <span className="label-text text-sm">Show only recommended</span>
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-success"
                checked={showOnlyRecommended}
                onChange={e => setShowOnlyRecommended(e.target.checked)}
              />
            </label>
          </div>

          <div className="overflow-x-auto mt-2">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>To</th>
                  <th className="text-right">Target APY</th>
                  <th className="text-right">Spread</th>
                  <th className="text-right">Break-even</th>
                  <th className="text-right">Annual Gain</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecs.slice(0, 20).map((rec, i) => (
                  <tr key={i} className={rec.recommended ? "bg-success/5" : ""}>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2.5 h-2.5 rounded-full ${CHAIN_COLORS[rec.to.chain] || "bg-gray-400"}`} />
                        <span className="text-sm font-medium">{rec.to.chain}</span>
                        <span className="text-xs opacity-60">{rec.to.symbol}</span>
                      </div>
                    </td>
                    <td className="text-right font-mono font-bold">{rec.to.apy.toFixed(2)}%</td>
                    <td className="text-right">
                      <span
                        className={`font-mono text-sm ${rec.yieldImprovementBps > 0 ? "text-success" : "text-error"}`}
                      >
                        {rec.yieldImprovementBps > 0 ? "+" : ""}
                        {rec.yieldImprovementBps} bps
                      </span>
                    </td>
                    <td className="text-right font-mono text-sm">
                      {rec.breakEvenDays < 9999 ? `${rec.breakEvenDays.toFixed(1)}d` : "-"}
                    </td>
                    <td className="text-right font-mono text-sm">
                      <span className={rec.netBenefitAnnualizedUsd > 0 ? "text-success" : "text-error"}>
                        {rec.netBenefitAnnualizedUsd >= 0 ? "+" : ""}${rec.netBenefitAnnualizedUsd.toFixed(2)}
                      </span>
                    </td>
                    <td>
                      {rec.recommended ? (
                        <span className="badge badge-success badge-sm">GO</span>
                      ) : (
                        <span className="badge badge-ghost badge-sm">HOLD</span>
                      )}
                    </td>
                    <td className="text-xs max-w-xs truncate opacity-70">{rec.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredRecs.length > 20 && (
            <p className="text-xs opacity-40 mt-2">Showing top 20 of {filteredRecs.length} candidates</p>
          )}
        </div>
      </div>

      <p className="text-xs opacity-30 text-center">
        Data from DeFi Llama &middot; Updated {new Date(data.fetchedAt).toLocaleTimeString()}
      </p>
    </div>
  );
};
