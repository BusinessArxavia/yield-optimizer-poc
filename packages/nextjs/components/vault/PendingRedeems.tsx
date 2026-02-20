"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { formatUSDC } from "~~/utils/vault/format";

export const PendingRedeems = () => {
  const { address } = useAccount();

  const { data: decimals } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "decimals",
  });

  const { data: nextRedeemId } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "nextRedeemId",
  });

  const { data: totalPendingShares } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalPendingShares",
  });

  const dec = decimals ?? 18;
  const fmt = (val: bigint | undefined) => formatUSDC(val, dec);

  // Read up to the last 10 redeem requests to find the user's pending ones
  // This is a simplified approach — in production, use events or an indexer
  const redeemIds = (() => {
    const ids: bigint[] = [];
    const next = Number(nextRedeemId ?? 0n);
    const start = Math.max(0, next - 20);
    for (let i = start; i < next; i++) {
      ids.push(BigInt(i));
    }
    return ids;
  })();

  if (!address) {
    return null;
  }

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Redemption Queue</h2>

        <div className="flex justify-between text-sm mt-2">
          <span className="opacity-60">Total Pending Shares</span>
          <span className="font-mono">{fmt(totalPendingShares)}</span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="opacity-60">Next Redeem ID</span>
          <span className="font-mono">{nextRedeemId?.toString() ?? "0"}</span>
        </div>

        {redeemIds.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-medium mb-2">Recent Requests</p>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {redeemIds.map(id => (
                <RedeemRow key={id.toString()} redeemId={id} userAddress={address} decimals={dec} />
              ))}
            </div>
          </div>
        )}

        {redeemIds.length === 0 && <p className="text-sm opacity-60 mt-3">No pending redemptions</p>}
      </div>
    </div>
  );
};

const RedeemRow = ({
  redeemId,
  userAddress,
  decimals,
}: {
  redeemId: bigint;
  userAddress: string;
  decimals: number;
}) => {
  const [cancelling, setCancelling] = useState(false);

  const { data: pendingRedeem } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "pendingRedeems",
    args: [redeemId],
  });

  const { writeContractAsync } = useScaffoldWriteContract({
    contractName: "YieldVault",
  });

  // pendingRedeems returns a tuple: (owner, receiver, shares, minAssetsOut, requestTime)
  if (!pendingRedeem) return null;

  const [owner, , shares, minAssetsOut, requestTime] = pendingRedeem;

  // Skip zeroed-out (fulfilled/cancelled) entries
  if (shares === 0n) return null;

  const isOwner = owner.toLowerCase() === userAddress.toLowerCase();
  const fmt = (val: bigint) => formatUSDC(val, decimals);
  const requestDate = new Date(Number(requestTime) * 1000);
  const expiryDate = new Date((Number(requestTime) + 7 * 24 * 60 * 60) * 1000);
  const isExpired = Date.now() > expiryDate.getTime();

  const handleCancel = async () => {
    if (!isOwner) return;
    setCancelling(true);
    try {
      await writeContractAsync({
        functionName: "cancelRedeem",
        args: [redeemId],
      });
    } catch (e) {
      console.error("Cancel failed:", e);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className={`flex items-center justify-between p-2 rounded-lg ${isOwner ? "bg-base-200" : "bg-base-200/50"}`}>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono opacity-60">#{redeemId.toString()}</span>
          {isOwner && <span className="badge badge-primary badge-xs">yours</span>}
          {isExpired && <span className="badge badge-error badge-xs">expired</span>}
        </div>
        <div className="text-sm">
          <span className="font-mono">{fmt(shares)}</span> shares
          <span className="opacity-60 text-xs ml-1">(min {fmt(minAssetsOut)} USDC)</span>
        </div>
        <div className="text-xs opacity-50">
          {requestDate.toLocaleDateString()} {requestDate.toLocaleTimeString()}
        </div>
      </div>
      {isOwner && (
        <button className="btn btn-error btn-xs" onClick={handleCancel} disabled={cancelling}>
          {cancelling ? <span className="loading loading-spinner loading-xs" /> : "Cancel"}
        </button>
      )}
    </div>
  );
};
