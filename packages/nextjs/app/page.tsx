import Link from "next/link";
import type { NextPage } from "next";
import { BanknotesIcon, BugAntIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";

const Home: NextPage = () => {
  return (
    <div className="flex items-center flex-col grow pt-10">
      <div className="px-5">
        <h1 className="text-center">
          <span className="block text-2xl mb-2">Welcome to</span>
          <span className="block text-4xl font-bold">Aave Yield Optimizer</span>
        </h1>
        <p className="text-center text-lg mt-4 max-w-xl mx-auto">
          Cross-chain ERC-4626 vault that automatically allocates USDC across Aave V3 deployments for optimal yield.
          Powered by Chainlink Automation and CCIP.
        </p>
      </div>

      <div className="grow bg-base-300 w-full mt-16 px-8 py-12">
        <div className="flex justify-center items-center gap-12 flex-col md:flex-row">
          <div className="flex flex-col bg-base-100 px-10 py-10 text-center items-center max-w-xs rounded-3xl">
            <BanknotesIcon className="h-8 w-8 fill-secondary" />
            <p>
              Deposit USDC and earn optimized yield in the{" "}
              <Link href="/vault" passHref className="link">
                Vault Dashboard
              </Link>
              .
            </p>
          </div>
          <div className="flex flex-col bg-base-100 px-10 py-10 text-center items-center max-w-xs rounded-3xl">
            <ShieldCheckIcon className="h-8 w-8 fill-secondary" />
            <p>Protected by a multi-tier circuit breaker with depeg detection, TVL monitoring, and emergency pause.</p>
          </div>
          <div className="flex flex-col bg-base-100 px-10 py-10 text-center items-center max-w-xs rounded-3xl">
            <BugAntIcon className="h-8 w-8 fill-secondary" />
            <p>
              Inspect contract state with the{" "}
              <Link href="/debug" passHref className="link">
                Debug Contracts
              </Link>{" "}
              tab.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
