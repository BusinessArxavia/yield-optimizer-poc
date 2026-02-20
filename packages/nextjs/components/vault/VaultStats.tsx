"use client";

import { formatUnits } from "viem";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { formatUSDC } from "~~/utils/vault/format";

export const VaultStats = () => {
  const { data: totalAssets } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalAssets",
  });

  const { data: totalSupply } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalSupply",
  });

  const { data: decimals } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "decimals",
  });

  const { data: performanceFeeBps } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "performanceFeeBps",
  });

  const { data: lastHarvestSharePrice } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "lastHarvestSharePrice",
  });

  const { data: isCircuitBreakerActive } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "isActive",
  });

  const { data: currentTier } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "currentTier",
  });

  const dec = decimals ?? 6;

  // Calculate share price
  let sharePrice = "1.0000";
  if (totalAssets !== undefined && totalSupply !== undefined && totalSupply > 0n) {
    const price = (totalAssets * 10n ** BigInt(dec)) / totalSupply;
    sharePrice = Number(formatUnits(price, dec)).toFixed(4);
  }

  const tierLabels = ["NONE", "WATCH", "WARN", "CRITICAL"];
  const tierColors = ["badge-success", "badge-warning", "badge-error", "badge-error"];

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Vault Overview</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
          <div>
            <p className="text-sm opacity-60">Total Value Locked</p>
            <p className="text-2xl font-bold">${formatUSDC(totalAssets, dec)}</p>
          </div>
          <div>
            <p className="text-sm opacity-60">Share Price</p>
            <p className="text-2xl font-bold">{sharePrice}</p>
          </div>
          <div>
            <p className="text-sm opacity-60">Total Shares</p>
            <p className="text-2xl font-bold">{formatUSDC(totalSupply, dec)}</p>
          </div>
          <div>
            <p className="text-sm opacity-60">Performance Fee</p>
            <p className="text-2xl font-bold">
              {performanceFeeBps !== undefined ? Number(performanceFeeBps) / 100 : "..."}%
            </p>
          </div>
        </div>

        <div className="divider my-2" />

        <div className="flex items-center gap-4">
          <div>
            <p className="text-sm opacity-60">Circuit Breaker</p>
            {isCircuitBreakerActive ? (
              <span className="badge badge-error badge-lg">ACTIVE</span>
            ) : (
              <span className="badge badge-success badge-lg">Inactive</span>
            )}
          </div>
          <div>
            <p className="text-sm opacity-60">Threat Tier</p>
            <span className={`badge badge-lg ${tierColors[Number(currentTier ?? 0)]}`}>
              {tierLabels[Number(currentTier ?? 0)]}
            </span>
          </div>
          <div>
            <p className="text-sm opacity-60">Last Harvest Price</p>
            <p className="font-mono">
              {lastHarvestSharePrice !== undefined ? Number(formatUnits(lastHarvestSharePrice, dec)).toFixed(4) : "..."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
