import Link from "next/link";
import type { NextPage } from "next";
import { AutomationStatus } from "~~/components/vault/AutomationStatus";
import { PendingRedeems } from "~~/components/vault/PendingRedeems";
import { RewardHarvesterStatus } from "~~/components/vault/RewardHarvesterStatus";
import { StrategyAllocation } from "~~/components/vault/StrategyAllocation";
import { UserPosition } from "~~/components/vault/UserPosition";
import { VaultActions } from "~~/components/vault/VaultActions";
import { VaultStats } from "~~/components/vault/VaultStats";
import { YieldExplorer } from "~~/components/vault/YieldExplorer";

const VaultPage: NextPage = () => {
  return (
    <div className="flex flex-col gap-6 py-8 px-4 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold">Aave Yield Optimizer</h1>

      <VaultStats />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="flex flex-col gap-6">
          <UserPosition />
          <VaultActions />
          <PendingRedeems />
        </div>
        <div className="flex flex-col gap-6">
          <StrategyAllocation />
          <RewardHarvesterStatus />
          <AutomationStatus />
        </div>
      </div>

      <div className="flex items-center justify-center gap-4">
        <div className="divider flex-1">Yield Explorer & Strategy Advisor</div>
        <Link href="/vault/demo" className="btn btn-sm btn-outline btn-primary">
          Live Demo
        </Link>
        <Link href="/vault/simulator" className="btn btn-sm btn-outline btn-warning">
          Strategy Simulator
        </Link>
      </div>

      <YieldExplorer />
    </div>
  );
};

export default VaultPage;
