"use client";

import { Address } from "@scaffold-ui/components";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { formatUSDC } from "~~/utils/vault/format";

export const RewardHarvesterStatus = () => {
  const { targetNetwork } = useTargetNetwork();

  const { data: harvesterContract } = useDeployedContractInfo({ contractName: "RewardHarvester" });
  const harvesterAddress = harvesterContract?.address;

  const { data: decimals } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "decimals",
  });

  const { data: totalReinvested } = useScaffoldReadContract({
    contractName: "RewardHarvester",
    functionName: "totalReinvested",
  });

  const { data: lastHarvestTime } = useScaffoldReadContract({
    contractName: "RewardHarvester",
    functionName: "lastHarvestTime",
  });

  const { data: harvestCooldown } = useScaffoldReadContract({
    contractName: "RewardHarvester",
    functionName: "harvestCooldown",
  });

  const dec = decimals ?? 6;
  const fmt = (val: bigint | undefined) => formatUSDC(val, dec);

  const lastHarvest = lastHarvestTime ? new Date(Number(lastHarvestTime) * 1000) : null;
  const cooldownSeconds = harvestCooldown ? Number(harvestCooldown) : 0;
  const nextHarvestTime = lastHarvestTime ? new Date((Number(lastHarvestTime) + cooldownSeconds) * 1000) : null;
  const canHarvest = !nextHarvestTime || Date.now() > nextHarvestTime.getTime();

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Reward Harvester</h2>

        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm opacity-60">Contract:</span>
          {harvesterAddress && <Address address={harvesterAddress} chain={targetNetwork} />}
        </div>

        <div className="grid grid-cols-2 gap-4 mt-3">
          <div>
            <p className="text-sm opacity-60">Total Reinvested</p>
            <p className="text-xl font-bold font-mono">${fmt(totalReinvested)}</p>
          </div>
          <div>
            <p className="text-sm opacity-60">Harvest Cooldown</p>
            <p className="text-xl font-bold">{cooldownSeconds / 60} min</p>
          </div>
        </div>

        <div className="divider my-2" />

        <div className="flex justify-between text-sm">
          <span className="opacity-60">Last Harvest</span>
          <span className="font-mono">
            {lastHarvest && lastHarvestTime !== 0n
              ? `${lastHarvest.toLocaleDateString()} ${lastHarvest.toLocaleTimeString()}`
              : "Never"}
          </span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="opacity-60">Can Harvest</span>
          <span className={`badge badge-sm ${canHarvest ? "badge-success" : "badge-warning"}`}>
            {canHarvest ? "Ready" : "Cooldown"}
          </span>
        </div>
      </div>
    </div>
  );
};
