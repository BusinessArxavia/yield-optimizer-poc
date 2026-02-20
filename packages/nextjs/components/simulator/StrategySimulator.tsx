"use client";

import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useReadContract } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

// Testnet constants
const ARB_CHAIN_SELECTOR = 3478487238524512106n;
const USDC_ADDRESS = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as const;
const LINK_ADDRESS = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410" as const;
const LINK_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" as const }],
    outputs: [{ name: "", type: "uint256" as const }],
  },
] as const;

const fmtUsdc = (val: bigint | undefined, dec = 6) => {
  if (val === undefined) return "...";
  return Number(formatUnits(val, dec)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtLink = (val: bigint | undefined) => {
  if (val === undefined) return "...";
  return Number(formatUnits(val, 18)).toFixed(4);
};

export const StrategySimulator = () => {
  // ═══ State ═══
  const [baseApy, setBaseApy] = useState(2.5);
  const [arbApy, setArbApy] = useState(5.0);
  const [rotateAmount, setRotateAmount] = useState("100");
  const [supplyAmount, setSupplyAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [costBpsInput, setCostBpsInput] = useState("10");
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (msg: string) =>
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));

  // ═══ Contract Info ═══
  const { data: scInfo } = useDeployedContractInfo({ contractName: "StrategyController" });
  const scAddress = scInfo?.address;

  // ═══ Vault Reads ═══
  const { data: totalAssets } = useScaffoldReadContract({ contractName: "YieldVault", functionName: "totalAssets" });
  const { data: decimals } = useScaffoldReadContract({ contractName: "YieldVault", functionName: "decimals" });
  const { data: vaultInfo } = useDeployedContractInfo({ contractName: "YieldVault" });
  const { data: idleBalance } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "balanceOf",
    args: [vaultInfo?.address],
  });
  const { data: totalInFlight } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalInFlight",
  });
  const { data: remoteBalanceArb } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "remoteBalances",
    args: [ARB_CHAIN_SELECTOR],
  });
  const { data: inFlightArb } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "inFlightAmounts",
    args: [ARB_CHAIN_SELECTOR],
  });

  // ═══ Strategy Controller Reads ═══
  const { data: minSpreadBps } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "minSpreadBps",
  });
  const { data: maxCostBps } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "maxCostBps",
  });
  const { data: rotationCooldown } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "rotationCooldown",
  });
  const { data: lastRotationTimeArb } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "lastRotationTime",
    args: [ARB_CHAIN_SELECTOR],
  });
  const { data: spokeArb } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "spokes",
    args: [ARB_CHAIN_SELECTOR],
  });

  // ═══ Circuit Breaker Reads ═══
  const { data: currentTier } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "currentTier",
  });
  const { data: isActive } = useScaffoldReadContract({ contractName: "CircuitBreaker", functionName: "isActive" });
  const { data: emergencyPaused } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "emergencyPaused",
  });

  // ═══ Dead Man Switch Reads ═══
  const { data: dmsExpired } = useScaffoldReadContract({ contractName: "DeadManSwitch", functionName: "isExpired" });
  const { data: dmsTimeRemaining } = useScaffoldReadContract({
    contractName: "DeadManSwitch",
    functionName: "timeRemaining",
  });
  const { data: dmsTimeout } = useScaffoldReadContract({ contractName: "DeadManSwitch", functionName: "timeout" });

  // ═══ LINK Balance (raw wagmi read) ═══
  const { data: linkBalance } = useReadContract({
    address: LINK_ADDRESS,
    abi: LINK_ABI,
    functionName: "balanceOf",
    args: scAddress ? [scAddress] : undefined,
    query: { enabled: !!scAddress },
  });

  // ═══ Contract Writes ═══
  const { writeContractAsync: writeStrategy } = useScaffoldWriteContract({ contractName: "StrategyController" });
  const { writeContractAsync: writeCB } = useScaffoldWriteContract({ contractName: "CircuitBreaker" });
  const { writeContractAsync: writeDMS } = useScaffoldWriteContract({ contractName: "DeadManSwitch" });

  // ═══ Computed Values ═══
  const dec = decimals ?? 6;
  const idle = idleBalance ?? 0n;
  const total = totalAssets ?? 0n;
  const inFlight = totalInFlight ?? 0n;
  const remoteArb = remoteBalanceArb ?? 0n;
  const aaveBase = total > idle + remoteArb ? total - idle - remoteArb + inFlight : 0n;
  const capitalUsd = Number(formatUnits(total, dec));

  // Decision engine
  const spreadBps = Math.round((arbApy - baseApy) * 100);
  const costBps = Number(costBpsInput) || 10;
  const estimatedCostUsd = (costBps / 10000) * Number(rotateAmount || "0");
  const dailyGainUsd = capitalUsd > 0 ? ((spreadBps / 10000) * capitalUsd) / 365 : 0;
  const breakEvenDays = dailyGainUsd > 0 ? estimatedCostUsd / dailyGainUsd : Infinity;
  const netBenefitAnnual = (spreadBps / 10000) * capitalUsd - estimatedCostUsd;

  const now = Math.floor(Date.now() / 1000);
  const lastRot = Number(lastRotationTimeArb ?? 0n);
  const cooldown = Number(rotationCooldown ?? 0n);
  const cooldownElapsed = now - lastRot;
  const cooldownOk = cooldownElapsed >= cooldown;

  const minSpread = Number(minSpreadBps ?? 0n);
  const maxCost = Number(maxCostBps ?? 0n);
  const spokeRegistered = spokeArb && spokeArb !== "0x0000000000000000000000000000000000000000";

  const checks = [
    { label: "Spread", pass: spreadBps >= minSpread && spreadBps > 0, detail: `${spreadBps} bps (min: ${minSpread})` },
    { label: "Cost", pass: costBps <= maxCost, detail: `${costBps} bps (max: ${maxCost})` },
    {
      label: "Cooldown",
      pass: cooldownOk,
      detail: cooldownOk ? "Elapsed" : `${cooldown - cooldownElapsed}s remaining`,
    },
    {
      label: "Spoke",
      pass: !!spokeRegistered,
      detail: spokeRegistered ? `${String(spokeArb).slice(0, 10)}...` : "Not registered",
    },
    { label: "CB", pass: !isActive, detail: isActive ? "BLOCKED" : "OK" },
    { label: "LINK", pass: (linkBalance ?? 0n) > 0n, detail: `${fmtLink(linkBalance)} LINK in Controller` },
  ];
  const allPass = checks.every(c => c.pass);

  // ═══ Handlers ═══
  const handleSupply = async () => {
    const amt = parseUnits(supplyAmount || "0", dec);
    if (amt <= 0n) return;
    addLog(`Supplying ${supplyAmount} USDC to Aave...`);
    try {
      await writeStrategy({ functionName: "executeLocalSupply", args: [USDC_ADDRESS, amt] });
      addLog(`Supplied ${supplyAmount} USDC to Aave`);
    } catch (e: unknown) {
      addLog(`Supply failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleWithdraw = async () => {
    const amt = parseUnits(withdrawAmount || "0", dec);
    if (amt <= 0n) return;
    addLog(`Withdrawing ${withdrawAmount} USDC from Aave...`);
    try {
      await writeStrategy({ functionName: "executeLocalWithdraw", args: [USDC_ADDRESS, amt] });
      addLog(`Withdrew ${withdrawAmount} USDC from Aave`);
    } catch (e: unknown) {
      addLog(`Withdraw failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleHarvest = async () => {
    addLog("Harvesting yield...");
    try {
      await writeStrategy({ functionName: "executeHarvestYield" });
      addLog("Yield harvested");
    } catch (e: unknown) {
      addLog(`Harvest failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleRotate = async () => {
    const amt = parseUnits(rotateAmount || "0", dec);
    if (amt <= 0n) return;
    addLog(`Initiating rotation: ${rotateAmount} USDC → Arbitrum (yieldBps=${spreadBps}, costBps=${costBps})...`);
    try {
      await writeStrategy({
        functionName: "initiateCrossChainRotation",
        args: [ARB_CHAIN_SELECTOR, USDC_ADDRESS, amt, BigInt(spreadBps), BigInt(costBps)],
      });
      addLog(`Rotation initiated! ${rotateAmount} USDC in-flight to Arbitrum via CCIP`);
    } catch (e: unknown) {
      addLog(`Rotation failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handlePause = async () => {
    addLog("Activating emergency pause...");
    try {
      await writeCB({ functionName: "activateEmergencyPause" });
      addLog("Emergency pause ACTIVATED — deposits blocked");
    } catch (e: unknown) {
      addLog(`Pause failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleUnpause = async () => {
    addLog("Deactivating emergency pause...");
    try {
      await writeCB({ functionName: "deactivateEmergencyPause" });
      addLog("Emergency pause deactivated — back to NORMAL");
    } catch (e: unknown) {
      addLog(`Unpause failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleCheckTier = async () => {
    addLog("Re-evaluating circuit breaker tier...");
    try {
      await writeCB({ functionName: "checkAndUpdateTier" });
      addLog("Tier re-evaluated");
    } catch (e: unknown) {
      addLog(`Check tier failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleHeartbeat = async () => {
    addLog("Sending dead man switch heartbeat...");
    try {
      await writeDMS({ functionName: "heartbeat" });
      addLog("Heartbeat sent — timer reset");
    } catch (e: unknown) {
      addLog(`Heartbeat failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const handleFallbackHarvest = async () => {
    addLog("Triggering fallback harvest via Dead Man Switch...");
    try {
      await writeDMS({ functionName: "triggerFallbackHarvest" });
      addLog("Fallback harvest triggered");
    } catch (e: unknown) {
      addLog(`Fallback harvest failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const tierLabels = ["NORMAL", "WATCH", "WARN", "CRITICAL"];
  const tierColors = ["badge-success", "badge-warning", "badge-error", "badge-error"];
  const tierNum = Number(currentTier ?? 0);

  const dmsRemaining = Number(dmsTimeRemaining ?? 0n);
  const dmsHours = Math.floor(dmsRemaining / 3600);
  const dmsMins = Math.floor((dmsRemaining % 3600) / 60);

  return (
    <div className="space-y-6">
      {/* ══════════════ Section 1: Capital State ══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">Capital Allocation</h2>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div className="stat bg-base-200 rounded-lg p-3">
                <div className="stat-title text-xs">Aave V3 (Base)</div>
                <div className="stat-value text-lg font-mono">${fmtUsdc(aaveBase, dec)}</div>
              </div>
              <div className="stat bg-base-200 rounded-lg p-3">
                <div className="stat-title text-xs">Idle (Vault)</div>
                <div className="stat-value text-lg font-mono">${fmtUsdc(idle, dec)}</div>
              </div>
              <div className="stat bg-base-200 rounded-lg p-3">
                <div className="stat-title text-xs">Arbitrum (Remote)</div>
                <div className="stat-value text-lg font-mono">${fmtUsdc(remoteArb, dec)}</div>
              </div>
              <div className="stat bg-base-200 rounded-lg p-3">
                <div className="stat-title text-xs">In-Flight → Arb</div>
                <div className="stat-value text-lg font-mono">${fmtUsdc(inFlightArb ?? inFlight, dec)}</div>
              </div>
            </div>
            <div className="divider my-1" />
            <div className="flex justify-between font-bold">
              <span>Total Assets</span>
              <span className="font-mono">${fmtUsdc(total, dec)}</span>
            </div>
          </div>
        </div>

        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">System Status</h2>
            <div className="space-y-3 mt-2">
              <div className="flex justify-between items-center">
                <span className="text-sm">Circuit Breaker</span>
                <div className="flex gap-2">
                  <span className={`badge ${tierColors[tierNum]}`}>{tierLabels[tierNum]}</span>
                  {emergencyPaused && <span className="badge badge-error">PAUSED</span>}
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Dead Man Switch</span>
                <div className="flex gap-2 items-center">
                  {dmsExpired ? (
                    <span className="badge badge-error">EXPIRED</span>
                  ) : (
                    <span className="badge badge-success">
                      {dmsHours}h {dmsMins}m remaining
                    </span>
                  )}
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Spoke (Arbitrum)</span>
                {spokeRegistered ? (
                  <span className="badge badge-success">Registered</span>
                ) : (
                  <span className="badge badge-error">Not Registered</span>
                )}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">LINK (for CCIP)</span>
                <span className={`font-mono text-sm ${(linkBalance ?? 0n) > 0n ? "text-success" : "text-error"}`}>
                  {fmtLink(linkBalance)} LINK
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Rotation Cooldown</span>
                <span className="font-mono text-sm">
                  {cooldownOk ? (
                    <span className="text-success">Ready</span>
                  ) : (
                    <span className="text-warning">{cooldown - cooldownElapsed}s left</span>
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════ Section 2: Yield Simulator ══════════════ */}
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body">
          <h2 className="card-title">Yield Simulator</h2>
          <p className="text-xs opacity-50">
            Adjust simulated APYs to test the decision engine. These values drive the rotation recommendation below.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
            {/* APY Inputs */}
            <div className="space-y-4">
              <div>
                <label className="label">
                  <span className="label-text font-semibold">Base USDC APY (%)</span>
                  <span className="label-text-alt font-mono text-primary">{baseApy.toFixed(2)}%</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="15"
                  step="0.1"
                  value={baseApy}
                  onChange={e => setBaseApy(Number(e.target.value))}
                  className="range range-primary range-sm"
                />
                <div className="flex justify-between text-xs opacity-40 px-1">
                  <span>0%</span>
                  <span>5%</span>
                  <span>10%</span>
                  <span>15%</span>
                </div>
              </div>

              <div>
                <label className="label">
                  <span className="label-text font-semibold">Arbitrum USDC APY (%)</span>
                  <span className="label-text-alt font-mono text-secondary">{arbApy.toFixed(2)}%</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="15"
                  step="0.1"
                  value={arbApy}
                  onChange={e => setArbApy(Number(e.target.value))}
                  className="range range-secondary range-sm"
                />
                <div className="flex justify-between text-xs opacity-40 px-1">
                  <span>0%</span>
                  <span>5%</span>
                  <span>10%</span>
                  <span>15%</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="opacity-60">Strategy min spread:</span>
                  <span className="font-mono ml-1">{minSpread} bps</span>
                </div>
                <div>
                  <span className="opacity-60">Max cost:</span>
                  <span className="font-mono ml-1">{maxCost} bps</span>
                </div>
                <div>
                  <span className="opacity-60">Cooldown:</span>
                  <span className="font-mono ml-1">{cooldown}s</span>
                </div>
                <div>
                  <span className="opacity-60">Capital:</span>
                  <span className="font-mono ml-1">${capitalUsd.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Decision Output */}
            <div>
              <div
                className={`rounded-xl p-4 border-2 ${
                  allPass ? "bg-success/10 border-success/30" : "bg-base-200 border-base-300"
                }`}
              >
                <h3 className="font-bold text-lg mb-3">
                  {allPass ? "ROTATE TO ARBITRUM" : spreadBps > 0 ? "HOLD — Checks Failed" : "HOLD — No Improvement"}
                </h3>

                <div className="space-y-1.5">
                  {checks.map(c => (
                    <div key={c.label} className="flex items-center gap-2 text-sm">
                      <span className={c.pass ? "text-success" : "text-error"}>{c.pass ? "\u2713" : "\u2717"}</span>
                      <span className="font-medium w-20">{c.label}</span>
                      <span className="font-mono opacity-70">{c.detail}</span>
                    </div>
                  ))}
                </div>

                {spreadBps > 0 && (
                  <div className="mt-3 pt-3 border-t border-base-300 grid grid-cols-2 gap-1 text-xs">
                    <span>
                      Daily gain: <b className="font-mono">${dailyGainUsd.toFixed(4)}</b>
                    </span>
                    <span>
                      Break-even:{" "}
                      <b className="font-mono">{breakEvenDays < 9999 ? `${breakEvenDays.toFixed(1)}d` : "-"}</b>
                    </span>
                    <span>
                      Annual benefit: <b className="font-mono">${netBenefitAnnual.toFixed(2)}</b>
                    </span>
                    <span>
                      Est. cost: <b className="font-mono">${estimatedCostUsd.toFixed(4)}</b>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════ Section 3: Operations ══════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Local Ops */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body p-4">
            <h3 className="font-bold text-sm">Local Operations</h3>
            <div className="form-control">
              <label className="label py-0.5">
                <span className="label-text text-xs">Amount (USDC)</span>
              </label>
              <input
                type="number"
                placeholder="100"
                className="input input-sm input-bordered font-mono"
                value={supplyAmount}
                onChange={e => {
                  setSupplyAmount(e.target.value);
                  setWithdrawAmount(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5 mt-2">
              <button className="btn btn-sm btn-primary" onClick={handleSupply} disabled={!supplyAmount}>
                Supply to Aave
              </button>
              <button className="btn btn-sm btn-warning" onClick={handleWithdraw} disabled={!withdrawAmount}>
                Withdraw from Aave
              </button>
              <button className="btn btn-sm btn-accent" onClick={handleHarvest}>
                Harvest Yield
              </button>
            </div>
          </div>
        </div>

        {/* Cross-Chain Rotation */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body p-4">
            <h3 className="font-bold text-sm">Cross-Chain Rotation</h3>
            <div className="form-control">
              <label className="label py-0.5">
                <span className="label-text text-xs">Amount (USDC)</span>
              </label>
              <input
                type="number"
                placeholder="80"
                className="input input-sm input-bordered font-mono"
                value={rotateAmount}
                onChange={e => setRotateAmount(e.target.value)}
              />
            </div>
            <div className="form-control">
              <label className="label py-0.5">
                <span className="label-text text-xs">Cost (bps)</span>
              </label>
              <input
                type="number"
                placeholder="10"
                className="input input-sm input-bordered font-mono"
                value={costBpsInput}
                onChange={e => setCostBpsInput(e.target.value)}
              />
            </div>
            <div className="text-xs opacity-50 mt-1">
              Yield: {spreadBps} bps | Cost: {costBps} bps
            </div>
            <button
              className={`btn btn-sm mt-1 ${allPass ? "btn-success" : "btn-disabled"}`}
              onClick={handleRotate}
              disabled={!allPass}
            >
              Rotate to Arbitrum
            </button>
          </div>
        </div>

        {/* Safety */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body p-4">
            <h3 className="font-bold text-sm">Circuit Breaker</h3>
            <div className="flex flex-col gap-1.5 mt-2">
              <button className="btn btn-sm btn-error" onClick={handlePause} disabled={!!emergencyPaused}>
                Emergency Pause
              </button>
              <button className="btn btn-sm btn-success" onClick={handleUnpause} disabled={!emergencyPaused}>
                Deactivate Pause
              </button>
              <button className="btn btn-sm btn-ghost" onClick={handleCheckTier}>
                Re-evaluate Tier
              </button>
            </div>
            <div className="text-xs opacity-50 mt-1">
              Current: {tierLabels[tierNum]} {emergencyPaused ? "(PAUSED)" : ""}
            </div>
          </div>
        </div>

        {/* Dead Man Switch */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body p-4">
            <h3 className="font-bold text-sm">Dead Man Switch</h3>
            <div className="text-xs opacity-50 mb-2">
              Timeout: {Number(dmsTimeout ?? 0n) / 3600}h | {dmsExpired ? "EXPIRED" : `${dmsHours}h ${dmsMins}m left`}
            </div>
            <div className="flex flex-col gap-1.5">
              <button className="btn btn-sm btn-primary" onClick={handleHeartbeat}>
                Send Heartbeat
              </button>
              <button className="btn btn-sm btn-warning" onClick={handleFallbackHarvest} disabled={!dmsExpired}>
                Fallback Harvest
              </button>
            </div>
            {!dmsExpired && <div className="text-xs text-success mt-1">Keeper is alive</div>}
            {dmsExpired && <div className="text-xs text-error mt-1">Keeper offline — fallback available</div>}
          </div>
        </div>
      </div>

      {/* ══════════════ Section 4: Activity Log ══════════════ */}
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body p-4">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-sm">Activity Log</h3>
            <button className="btn btn-xs btn-ghost" onClick={() => setLogs([])}>
              Clear
            </button>
          </div>
          <div className="bg-base-200 rounded-lg p-3 h-40 overflow-y-auto font-mono text-xs space-y-0.5">
            {logs.length === 0 && <span className="opacity-30">No activity yet. Execute an operation above.</span>}
            {logs.map((log, i) => (
              <div key={i} className="opacity-80">
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
