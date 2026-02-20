"use client";

import { useAccount } from "wagmi";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { bigintPct, formatUSDC } from "~~/utils/vault/format";

export const UserPosition = () => {
  const { address } = useAccount();

  const { data: decimals } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "decimals",
  });

  const { data: shareBalance } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "balanceOf",
    args: [address],
  });

  const { data: assetValue } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "convertToAssets",
    args: [shareBalance ?? 0n],
  });

  const { data: totalSupply } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalSupply",
  });

  const dec = decimals ?? 6;
  const shares = shareBalance ?? 0n;
  const value = assetValue ?? 0n;

  const vaultShare = totalSupply && totalSupply > 0n ? bigintPct(shares, totalSupply) : "0.0";

  const fmt = (val: bigint) => formatUSDC(val, dec);

  if (!address) {
    return (
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body items-center text-center">
          <h2 className="card-title">Your Position</h2>
          <p className="opacity-60">Connect your wallet to view your position</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Your Position</h2>
        <div className="grid grid-cols-3 gap-4 mt-2">
          <div>
            <p className="text-sm opacity-60">yUSDC Shares</p>
            <p className="text-xl font-bold font-mono">{fmt(shares)}</p>
          </div>
          <div>
            <p className="text-sm opacity-60">USDC Value</p>
            <p className="text-xl font-bold font-mono">${fmt(value)}</p>
          </div>
          <div>
            <p className="text-sm opacity-60">Vault Share</p>
            <p className="text-xl font-bold">{vaultShare}%</p>
          </div>
        </div>
      </div>
    </div>
  );
};
