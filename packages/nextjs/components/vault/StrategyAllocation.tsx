"use client";

import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { bigintPct, formatUSDC } from "~~/utils/vault/format";

// Arb Sepolia CCIP chain selector
const ARB_CHAIN_SELECTOR = 3478487238524512106n;

const CHAIN_LABELS: Record<string, string> = {
  "3478487238524512106": "Aave V3 (Arb Sepolia)",
};

export const StrategyAllocation = () => {
  const { data: vaultContract } = useDeployedContractInfo({ contractName: "YieldVault" });
  const vaultAddress = vaultContract?.address;

  const { data: totalAssets } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalAssets",
  });

  const { data: decimals } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "decimals",
  });

  // Idle USDC in vault = USDC.balanceOf(vault)
  const { data: idleBalance } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "balanceOf",
    args: [vaultAddress],
  });

  const { data: totalInFlight } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalInFlight",
  });

  // Per-chain remote balance (Arb Sepolia)
  const { data: remoteBalanceArb } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "remoteBalances",
    args: [ARB_CHAIN_SELECTOR],
  });

  // Stale indicator — available after Task 6.5 deploys (returns undefined until then)

  const { data: isArbStaleRaw } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "isRemoteBalanceStale" as any,
    args: [ARB_CHAIN_SELECTOR] as any,
  } as any);
  const isArbStale = isArbStaleRaw as boolean | undefined;

  const dec = decimals ?? 6;

  const idle = idleBalance ?? 0n;
  const inFlight = totalInFlight ?? 0n;
  const total = totalAssets ?? 0n;
  const remoteArb = remoteBalanceArb ?? 0n;
  // totalAssets includes remote + in-flight, so subtract them for local Aave supply
  const supplied = total > idle + remoteArb + inFlight ? total - idle - remoteArb - inFlight : 0n;

  const pct = (val: bigint) => bigintPct(val, total);
  const fmt = (val: bigint) => formatUSDC(val, dec);

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Strategy Allocation</h2>

        <div className="space-y-3 mt-2">
          {/* Aave Supply (Home Chain) */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Aave V3 (Base Sepolia)</span>
              <span className="font-mono">
                ${fmt(supplied)} ({pct(supplied)}%)
              </span>
            </div>
            <progress className="progress progress-primary w-full" value={Number(pct(supplied))} max="100" />
          </div>

          {/* Remote Chain: Arb Sepolia */}
          {remoteArb > 0n && (
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="flex items-center gap-2">
                  {CHAIN_LABELS[ARB_CHAIN_SELECTOR.toString()] ?? "Remote Chain"}
                  {isArbStale === true && (
                    <span
                      className="badge badge-warning badge-sm"
                      title="No balance report received from this chain recently"
                    >
                      Stale
                    </span>
                  )}
                </span>
                <span className="font-mono">
                  ${fmt(remoteArb)} ({pct(remoteArb)}%)
                </span>
              </div>
              <progress className="progress progress-accent w-full" value={Number(pct(remoteArb))} max="100" />
              {isArbStale === true && <p className="text-xs text-warning mt-1">No balance report received recently</p>}
            </div>
          )}

          {/* Idle */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Idle (Vault Buffer)</span>
              <span className="font-mono">
                ${fmt(idle)} ({pct(idle)}%)
              </span>
            </div>
            <progress className="progress progress-warning w-full" value={Number(pct(idle))} max="100" />
          </div>

          {/* In-Flight */}
          {inFlight > 0n && (
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>In-Flight (CCIP)</span>
                <span className="font-mono">
                  ${fmt(inFlight)} ({pct(inFlight)}%)
                </span>
              </div>
              <progress className="progress progress-info w-full" value={Number(pct(inFlight))} max="100" />
            </div>
          )}
        </div>

        <div className="divider my-2" />
        <div className="flex justify-between font-bold">
          <span>Total</span>
          <span className="font-mono">${fmt(total)}</span>
        </div>
      </div>
    </div>
  );
};
