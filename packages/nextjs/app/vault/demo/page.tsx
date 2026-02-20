import Link from "next/link";
import type { Metadata, NextPage } from "next";
import { DemoWalkthrough } from "~~/components/demo/DemoWalkthrough";

export const metadata: Metadata = {
  title: "Aave Yield Optimizer — Live Demo",
};

const DemoPage: NextPage = () => {
  return (
    <div className="flex flex-col gap-6 py-8 px-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-4">
        <Link href="/vault" className="btn btn-sm btn-ghost">
          &larr; Vault
        </Link>
        <h1 className="text-3xl font-bold">Live Demo</h1>
        <span className="badge badge-primary badge-lg">Interactive</span>
      </div>
      <p className="text-sm opacity-60 -mt-2">
        End-to-end walkthrough of the Aave Yield Optimizer. Follow each step to see deposits, automation, cross-chain
        rotation, yield accrual, and safety systems in action on Base Sepolia.
      </p>
      <DemoWalkthrough />
    </div>
  );
};

export default DemoPage;
