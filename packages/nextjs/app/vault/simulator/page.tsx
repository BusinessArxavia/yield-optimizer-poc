import Link from "next/link";
import type { NextPage } from "next";
import { StrategySimulator } from "~~/components/simulator/StrategySimulator";

const SimulatorPage: NextPage = () => {
  return (
    <div className="flex flex-col gap-6 py-8 px-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-4">
        <Link href="/vault" className="btn btn-sm btn-ghost">
          &larr; Vault
        </Link>
        <h1 className="text-3xl font-bold">Strategy Simulator</h1>
        <span className="badge badge-warning badge-lg">Admin</span>
      </div>
      <p className="text-sm opacity-60 -mt-2">
        Simulate yield scenarios, test the decision engine, and execute real on-chain operations. Connect with the
        deployer wallet (KEEPER/ADMIN role) to execute operations.
      </p>
      <StrategySimulator />
    </div>
  );
};

export default SimulatorPage;
