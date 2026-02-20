"use client";

import { Address } from "@scaffold-ui/components";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

const KEYSTONE_FORWARDER = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482";

export const AutomationStatus = () => {
  const { targetNetwork } = useTargetNetwork();

  const { data: keeperContract } = useDeployedContractInfo({ contractName: "YieldKeeper" });
  const { data: dmsContract } = useDeployedContractInfo({ contractName: "DeadManSwitch" });
  const { data: controllerContract } = useDeployedContractInfo({ contractName: "StrategyController" });
  const { data: gatewayContract } = useDeployedContractInfo({ contractName: "VaultGateway" });
  const { data: creContract } = useDeployedContractInfo({ contractName: "YieldKeeperCRE" });

  // CRE DON status reads
  const { data: creForwarder } = useScaffoldReadContract({
    contractName: "YieldKeeperCRE",
    functionName: "forwarder",
  });
  const { data: creLastPerform } = useScaffoldReadContract({
    contractName: "YieldKeeperCRE",
    functionName: "lastPerformTime",
  });
  const { data: creWorkflowId } = useScaffoldReadContract({
    contractName: "YieldKeeperCRE",
    functionName: "expectedWorkflowId",
  });

  const isForwarderLocked = creForwarder && creForwarder !== "0x0000000000000000000000000000000000000000";
  const isForwarderProduction = creForwarder?.toLowerCase() === KEYSTONE_FORWARDER.toLowerCase();
  const hasWorkflowId =
    creWorkflowId && creWorkflowId !== "0x0000000000000000000000000000000000000000000000000000000000000000";
  const lastPerformAgo =
    creLastPerform && creLastPerform > 0n ? Math.floor(Date.now() / 1000) - Number(creLastPerform) : null;
  const creDonActive = lastPerformAgo !== null && lastPerformAgo < 600; // active if within 10 min

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Automation & Infrastructure</h2>

        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Component</th>
                <th>Address</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div className="font-medium">YieldKeeper</div>
                  <div className="text-xs opacity-60">Chainlink Automation</div>
                </td>
                <td>{keeperContract?.address && <Address address={keeperContract.address} chain={targetNetwork} />}</td>
                <td>
                  <span className={`badge badge-sm ${keeperContract?.address ? "badge-success" : "badge-error"}`}>
                    {keeperContract?.address ? "Deployed" : "Not Found"}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <div className="font-medium">DeadManSwitch</div>
                  <div className="text-xs opacity-60">Fallback guardian</div>
                </td>
                <td>{dmsContract?.address && <Address address={dmsContract.address} chain={targetNetwork} />}</td>
                <td>
                  <span className={`badge badge-sm ${dmsContract?.address ? "badge-success" : "badge-error"}`}>
                    {dmsContract?.address ? "Deployed" : "Not Found"}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <div className="font-medium">StrategyController</div>
                  <div className="text-xs opacity-60">Manages rotations</div>
                </td>
                <td>
                  {controllerContract?.address && (
                    <Address address={controllerContract.address} chain={targetNetwork} />
                  )}
                </td>
                <td>
                  <span className={`badge badge-sm ${controllerContract?.address ? "badge-success" : "badge-error"}`}>
                    {controllerContract?.address ? "Deployed" : "Not Found"}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <div className="font-medium">VaultGateway</div>
                  <div className="text-xs opacity-60">Slippage protection</div>
                </td>
                <td>
                  {gatewayContract?.address && <Address address={gatewayContract.address} chain={targetNetwork} />}
                </td>
                <td>
                  <span className={`badge badge-sm ${gatewayContract?.address ? "badge-success" : "badge-error"}`}>
                    {gatewayContract?.address ? "Deployed" : "Not Found"}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <div className="font-medium">YieldKeeperCRE</div>
                  <div className="text-xs opacity-60">CRE Workflow (DON)</div>
                </td>
                <td>{creContract?.address && <Address address={creContract.address} chain={targetNetwork} />}</td>
                <td>
                  <div className="flex flex-col gap-1">
                    <span className={`badge badge-sm ${creContract?.address ? "badge-success" : "badge-error"}`}>
                      {creContract?.address ? "Deployed" : "Not Found"}
                    </span>
                    {creContract?.address && (
                      <>
                        <span
                          className={`badge badge-xs ${isForwarderProduction ? "badge-success" : isForwarderLocked ? "badge-warning" : "badge-ghost"}`}
                        >
                          {isForwarderProduction
                            ? "DON Forwarder"
                            : isForwarderLocked
                              ? "Custom Forwarder"
                              : "Open (Simulation)"}
                        </span>
                        {hasWorkflowId && <span className="badge badge-xs badge-info">Workflow ID Set</span>}
                        {lastPerformAgo !== null && (
                          <span className={`badge badge-xs ${creDonActive ? "badge-success" : "badge-warning"}`}>
                            {creDonActive
                              ? `Active (${Math.floor(lastPerformAgo / 60)}m ago)`
                              : `Stale (${Math.floor(lastPerformAgo / 3600)}h ago)`}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
