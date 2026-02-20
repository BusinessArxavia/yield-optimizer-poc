"use client";

import { useEffect, useMemo, useState } from "react";
import { type RotationData, RotationTracker } from "./RotationTracker";
import { decodeAbiParameters, encodeAbiParameters, formatUnits, parseAbiParameters, parseUnits } from "viem";
import { useAccount, useBlock, useBlockNumber, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTransactor } from "~~/hooks/scaffold-eth/useTransactor";
import { formatUSDC } from "~~/utils/vault/format";

// ── Constants ──────────────────────────────────────────────────────
const USDC_ADDRESS = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as const;
const LINK_ADDRESS = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410" as const;
const CCIP_BNM_ADDRESS = "0x88A2d74F47a237a62e7A51cdDa67270CE381555e" as const;
const ARB_CHAIN_SELECTOR = 3478487238524512106n;
const AAVE_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";
const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";
const ARB_SEPOLIA_EXPLORER = "https://sepolia.arbiscan.io";
const CCIP_EXPLORER = "https://ccip.chain.link";
const KEYSTONE_FORWARDER = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482";
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.5%

// ── Mainnet Cost Estimates (Base L2) ──────────────────────────────
// Gas costs on Base are extremely low (~0.01 gwei)
const COSTS = {
  // User operations (gas on Base L2)
  approveErc20: { gas: "~46k", usd: "< $0.01" },
  depositGateway: { gas: "~250k", usd: "~$0.01" },
  withdrawGateway: { gas: "~280k", usd: "~$0.01" },
  requestRedeem: { gas: "~120k", usd: "< $0.01" },
  emergencyWithdraw: { gas: "~200k", usd: "~$0.01" },
  // Keeper operations (gas on Base L2)
  supplyToAave: { gas: "~300k", usd: "~$0.02" },
  withdrawFromAave: { gas: "~320k", usd: "~$0.02" },
  harvestYield: { gas: "~180k", usd: "~$0.01" },
  // Safety operations
  circuitBreakerPause: { gas: "~50k", usd: "< $0.01" },
  heartbeat: { gas: "~30k", usd: "< $0.01" },
  // Cross-chain (CCIP)
  ccipDataOnly: { link: "~0.05 LINK", usd: "~$0.75" },
  ccipTokenTransfer: { link: "~0.3 LINK", usd: "~$4.50" },
  ccipFullRotation: { link: "~0.6 LINK", usd: "~$9.00", note: "send + supply + report back" },
  // CRE Automation
  creExecution: { link: "~0.01 LINK", usd: "~$0.15" },
  creMonthlyNoOp: { link: "~2.5 LINK", usd: "~$37", note: "288 checks/day, mostly NO_OP" },
  creMonthlyActive: { link: "~4 LINK", usd: "~$60", note: "with ~2 supply/harvest per day" },
} as const;

// Step labels for navigation
const STEP_LABELS = ["Architecture", "Get USDC", "Deposit", "Aave", "Yields", "CRE", "CCIP", "Safety", "Withdraw"];

// Inline cost badge
const CostBadge = ({ label, usd, detail }: { label: string; usd: string; detail?: string }) => (
  <div className="inline-flex items-center gap-1.5 bg-base-300/50 rounded-md px-2 py-1 text-xs">
    <span className="opacity-60">{label}:</span>
    <span className="font-mono font-semibold">{usd}</span>
    {detail && <span className="opacity-50">({detail})</span>}
  </div>
);

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" as const }],
    outputs: [{ name: "", type: "uint256" as const }],
  },
] as const;

const CONTRACTS = {
  CircuitBreaker: "0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f",
  YieldVault: "0x601F653c1F8940246fECEbCb9dEF8E6322c35570",
  StrategyController: "0x93e37393D12FB6874190b7E38D7AdE096ceBEF90",
  VaultGateway: "0xDc8a5959cB1aEB3937B819924271381A1CC9cC78",
  RewardHarvester: "0x6aa643dfD56f3dE2372671879752464E15E466C3",
  YieldKeeper: "0x5143CBB3D38227BDf6F039F9a1410DDE30fce338",
  DeadManSwitch: "0x23C088Ec7598549dFc1107f52A619f99466a4B45",
  YieldKeeperCRE: "0x9B39815964a87eF361d555BD99FfdcDEbe4753bb",
  SpokeVault: "0x99f90636e87646113480F4cfC631f02E0EE4cC22",
};

// ── Helpers ────────────────────────────────────────────────────────
const fmtUsdc = (val: bigint | undefined, dec = 6) => formatUSDC(val, dec);
const fmtLink = (val: bigint | undefined) => {
  if (val === undefined) return "...";
  return Number(formatUnits(val, 18)).toFixed(4);
};
const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
const explorerLink = (addr: string, label?: string) => (
  <a
    href={`${BASE_SEPOLIA_EXPLORER}/address/${addr}`}
    target="_blank"
    rel="noreferrer"
    className="link link-accent font-mono text-xs"
  >
    {label ?? shortAddr(addr)}
  </a>
);

// ── Inline TX History for a Step ────────────────────────────────────
const StepTxHistory = ({
  logs,
  step,
}: {
  logs: { step: number; msg: string; hash?: string; explorer?: string; url?: string }[];
  step: number;
}) => {
  const stepLogs = logs.filter(l => l.step === step && (l.hash || l.url));
  if (stepLogs.length === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      {stepLogs.map((log, i) => {
        const href = log.url ?? `${log.explorer ?? BASE_SEPOLIA_EXPLORER}/tx/${log.hash}`;
        const label = log.hash ? `${log.hash.slice(0, 10)}...${log.hash.slice(-6)}` : "View";
        return (
          <div key={i} className="flex items-center gap-2 bg-base-200 rounded-lg px-3 py-2 text-xs font-mono">
            <span className={`badge badge-xs ${log.url && !log.hash ? "badge-info" : "badge-success"}`}>
              {log.url && !log.hash ? "CCIP" : "TX"}
            </span>
            <span className="opacity-70 truncate flex-1">{log.msg}</span>
            <a href={href} target="_blank" rel="noreferrer" className="link link-accent whitespace-nowrap">
              {label}
            </a>
          </div>
        );
      })}
    </div>
  );
};

// ── Cross-Chain Tx Summary (3 tx IDs: source, CCIP, destination) ──

const CrossChainTxSummary = ({
  title,
  variant,
  baseTxHash,
  ccipMessageId,
}: {
  title: string;
  variant: "info" | "success";
  baseTxHash: string;
  ccipMessageId: string;
}) => {
  const [arbTxHash, setArbTxHash] = useState<string | null>(null);

  // Poll CCIP explorer API for destination tx hash
  useEffect(() => {
    if (!ccipMessageId || arbTxHash) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/ccip-status?messageId=${ccipMessageId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.destTxHash) setArbTxHash(data.destTxHash);
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, [ccipMessageId, arbTxHash]);

  const badgeClass = variant === "info" ? "badge-info" : "badge-success";
  const linkClass = "link-warning underline";
  const borderClass = variant === "info" ? "border-info/30 bg-info/10" : "border-success/30 bg-success/10";
  const titleClass = variant === "info" ? "text-info" : "text-success";

  return (
    <div className={`${borderClass} border rounded-lg p-4 mt-3`}>
      <div className={`font-bold text-sm ${titleClass} mb-3`}>{title} — Cross-Chain Transaction</div>
      <div className="flex flex-col gap-2">
        {/* 1. Source chain tx */}
        <div className="flex items-center gap-3 text-xs">
          <span className={`badge badge-sm ${badgeClass} font-bold`}>1</span>
          <span className="w-28 opacity-60 font-semibold">Base Sepolia</span>
          <a
            href={`${BASE_SEPOLIA_EXPLORER}/tx/${baseTxHash}`}
            target="_blank"
            rel="noreferrer"
            className={`link ${linkClass} font-mono`}
          >
            {baseTxHash.slice(0, 10)}...{baseTxHash.slice(-8)}
          </a>
        </div>
        {/* 2. CCIP message */}
        <div className="flex items-center gap-3 text-xs">
          <span className={`badge badge-sm ${badgeClass} font-bold`}>2</span>
          <span className="w-28 opacity-60 font-semibold">CCIP Bridge</span>
          <a
            href={`${CCIP_EXPLORER}/msg/${ccipMessageId}`}
            target="_blank"
            rel="noreferrer"
            className={`link ${linkClass} font-mono`}
          >
            {ccipMessageId.slice(0, 10)}...{ccipMessageId.slice(-8)}
          </a>
        </div>
        {/* 3. Destination chain tx */}
        <div className="flex items-center gap-3 text-xs">
          <span className={`badge badge-sm ${badgeClass} font-bold`}>3</span>
          <span className="w-28 opacity-60 font-semibold">Arb Sepolia</span>
          {arbTxHash ? (
            <a
              href={`${ARB_SEPOLIA_EXPLORER}/tx/${arbTxHash}`}
              target="_blank"
              rel="noreferrer"
              className={`link ${linkClass} font-mono`}
            >
              {arbTxHash.slice(0, 10)}...{arbTxHash.slice(-8)}
            </a>
          ) : (
            <span className="opacity-50 italic">
              Pending CCIP delivery... <span className="loading loading-dots loading-xs" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Step Wrapper ───────────────────────────────────────────────────
const DemoStep = ({
  step,
  title,
  subtitle,
  active,
  completed,
  onToggle,
  children,
}: {
  step: number;
  title: string;
  subtitle: string;
  active: boolean;
  completed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) => (
  <div className={`card shadow-xl transition-all ${active ? "bg-base-100 ring-2 ring-primary" : "bg-base-100"}`}>
    <div className="card-body p-5">
      <button className="flex items-center gap-4 w-full text-left" onClick={onToggle}>
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0 ${
            completed ? "bg-success text-success-content" : active ? "bg-primary text-primary-content" : "bg-base-300"
          }`}
        >
          {completed ? "\u2713" : step}
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-lg">{title}</h3>
          <p className="text-sm opacity-60">{subtitle}</p>
        </div>
        <span className={`transition-transform ${active ? "rotate-180" : ""}`}>&#9660;</span>
      </button>
      {active && <div className="mt-4 border-t border-base-300 pt-4">{children}</div>}
    </div>
  </div>
);

// ── Architecture Diagram ───────────────────────────────────────────
const ArchitectureDiagram = () => (
  <div className="bg-base-200 rounded-xl p-6 overflow-x-auto">
    <div className="min-w-[700px]">
      {/* Row 1: User flow */}
      <div className="flex items-center justify-center gap-2 mb-6">
        <div className="badge badge-lg badge-neutral px-4 py-3">User Wallet</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-primary px-4 py-3">VaultGateway</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-secondary px-4 py-3">YieldVault (ERC-4626)</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-accent px-4 py-3">Aave V3 (Base)</div>
      </div>

      {/* Row 2: Cross-chain */}
      <div className="flex items-center justify-center gap-2 mb-6">
        <div className="badge badge-lg badge-secondary px-4 py-3">StrategyController</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-warning px-4 py-3">CCIP Router</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-info px-4 py-3">SpokeVault (Arb)</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-accent px-4 py-3">Aave V3 (Arb)</div>
      </div>

      {/* Row 3: Automation */}
      <div className="flex items-center justify-center gap-2 mb-4">
        <div className="border-2 border-dashed border-success rounded-lg px-4 py-2">
          <div className="text-xs font-bold text-success mb-1">CRE Workflow (off-chain)</div>
          <div className="text-xs opacity-70">Read rates + Decide + Write report</div>
        </div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-success px-4 py-3">YieldKeeperCRE</div>
        <span className="text-xl">&#8594;</span>
        <div className="badge badge-lg badge-secondary px-4 py-3">StrategyController</div>
      </div>

      {/* Row 4: Safety */}
      <div className="flex items-center justify-center gap-4">
        <div className="badge badge-lg badge-error px-4 py-3">CircuitBreaker</div>
        <div className="badge badge-lg badge-warning px-4 py-3">DeadManSwitch</div>
        <div className="badge badge-lg badge-info px-4 py-3">RewardHarvester</div>
      </div>
    </div>
  </div>
);

// ── Main Component ─────────────────────────────────────────────────
// CrossChainRotationInitiated(uint64 indexed destChain, address token, uint256 amount, bytes32 messageId)
const ROTATION_EVENT_TOPIC = "0xcc9ef79327a06591ee438a58da632c836cf7d8e096712784c6f0b3945e177c03" as const;
// TestnetRotationInitiated(uint64 indexed destChain, address token, uint256 amount, bytes32 messageId)
const TESTNET_ROTATION_EVENT_TOPIC = "0xeb3428e05066181e38673e681e83770a434d81f112491e5e37df47eb9ecc0a11" as const;

export const DemoWalkthrough = () => {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [activeStep, setActiveStep] = useState<number | null>(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [depositAmount, setDepositAmount] = useState("10");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [txLog, setTxLog] = useState<{ step: number; msg: string; hash?: string; explorer?: string; url?: string }[]>(
    [],
  );
  const [rotationData, setRotationData] = useState<RotationData | null>(null);
  const [recallData, setRecallData] = useState<RotationData | null>(null);
  const [isRecalling, setIsRecalling] = useState(false);

  const addTxLog = (step: number, msg: string, hash?: string, explorer?: string, url?: string) =>
    setTxLog(prev => [{ step, msg, hash, explorer: explorer ?? BASE_SEPOLIA_EXPLORER, url }, ...prev].slice(0, 30));

  const markComplete = (step: number) => setCompletedSteps(prev => new Set(prev).add(step));

  const toggle = (step: number) => setActiveStep(prev => (prev === step ? null : step));

  // ── Contract reads ──
  const { data: vaultInfo } = useDeployedContractInfo({ contractName: "YieldVault" });
  const { data: gatewayInfo } = useDeployedContractInfo({ contractName: "VaultGateway" });
  const { data: scInfo } = useDeployedContractInfo({ contractName: "StrategyController" });
  const { data: decimals } = useScaffoldReadContract({ contractName: "YieldVault", functionName: "decimals" });
  const dec = decimals ?? 6;

  // Parse amounts early so hooks below can use stable values
  const parsedDeposit = useMemo(() => {
    try {
      return parseUnits(depositAmount || "0", dec);
    } catch {
      return 0n;
    }
  }, [depositAmount, dec]);
  const parsedWithdraw = useMemo(() => {
    try {
      return parseUnits(withdrawAmount || "0", dec);
    } catch {
      return 0n;
    }
  }, [withdrawAmount, dec]);

  // Block numbers (latest vs finalized — CRE reads from finalized)
  const { data: latestBlock } = useBlockNumber({ watch: true });
  const { data: finalizedBlockData } = useBlock({ blockTag: "finalized", query: { refetchInterval: 10_000 } });
  const finalizedBlock = finalizedBlockData?.number;

  // Vault state
  const { data: totalAssets } = useScaffoldReadContract({ contractName: "YieldVault", functionName: "totalAssets" });
  const { data: totalSupply } = useScaffoldReadContract({ contractName: "YieldVault", functionName: "totalSupply" });
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
  // User balances
  const { data: usdcBalance } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "balanceOf",
    args: [address],
  });
  const { data: shareBalance } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "balanceOf",
    args: [address],
  });
  const { data: usdcAllowanceGateway } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "allowance",
    args: [address, gatewayInfo?.address],
  });
  const { data: shareAllowanceGateway } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "allowance",
    args: [address, gatewayInfo?.address],
  });
  const { data: maxWithdrawable } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "maxWithdraw",
    args: [address],
  });
  const { data: previewDeposit } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "previewDeposit",
    args: [parsedDeposit],
  });
  const { data: previewWithdrawShares } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "previewWithdraw",
    args: [parsedWithdraw],
  });
  const { data: pendingRedeemCount } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "pendingRedeemCount",
  });
  const { data: totalPendingAssets } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "totalPendingAssets",
  });

  // Safety
  const { data: currentTier } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "currentTier",
  });
  const { data: emergencyPaused } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "emergencyPaused",
  });
  const { data: dmsExpired } = useScaffoldReadContract({ contractName: "DeadManSwitch", functionName: "isExpired" });
  const { data: dmsTimeRemaining } = useScaffoldReadContract({
    contractName: "DeadManSwitch",
    functionName: "timeRemaining",
  });

  // Spoke & rotation params
  const { data: spokeArb } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "spokes",
    args: [ARB_CHAIN_SELECTOR],
  });
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

  // CRE consumer params
  const { data: idleTargetBps } = useScaffoldReadContract({
    contractName: "YieldKeeperCRE",
    functionName: "idleTargetBps",
  });
  const { data: minIdleSupplyAmount } = useScaffoldReadContract({
    contractName: "YieldKeeperCRE",
    functionName: "minIdleSupplyAmount",
  });
  const { data: harvestMinYieldBps } = useScaffoldReadContract({
    contractName: "YieldKeeperCRE",
    functionName: "harvestMinYieldBps",
  });
  const { data: lastHarvestSharePrice } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "lastHarvestSharePrice",
  });

  // LINK
  const { data: linkBalance } = useReadContract({
    address: LINK_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: scInfo?.address ? [scInfo.address] : undefined,
    query: { enabled: !!scInfo?.address },
  });
  // CCIP-BnM
  const { data: bnmBalance } = useReadContract({
    address: CCIP_BNM_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: scInfo?.address ? [scInfo.address] : undefined,
    query: { enabled: !!scInfo?.address },
  });

  // Admin role check (for recall / emergency withdraw)
  const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775" as const;
  const { data: isAdmin } = useScaffoldReadContract({
    contractName: "StrategyController",
    functionName: "hasRole",
    args: [ADMIN_ROLE, address],
  });

  // Yield data from API
  const [yieldData, setYieldData] = useState<{
    currentPosition?: { apy: number; chain: string; symbol: string };
    recommendations?: {
      to: { chain: string; symbol: string; apy: number };
      yieldImprovementBps: number;
      breakEvenDays: number;
      estimatedCostUsd: number;
      recommended: boolean;
      reason: string;
    }[];
    config?: {
      estimatedRotationCostUsd: number;
      linkPriceUsd: number;
      rotationLinkCost: number;
      rotationGasCostUsd: number;
      rotationAmountBps: number;
      minSpreadBps: number;
      maxBreakEvenDays: number;
    };
    capitalUsd?: number;
  } | null>(null);

  // Convert vault totalAssets to USD (USDC = 1:1), rounded to avoid refetch churn
  const capitalUsdRounded = totalAssets !== undefined ? Math.round(Number(formatUnits(totalAssets, dec))) : 0;

  useEffect(() => {
    const controller = new AbortController();
    const cap = capitalUsdRounded > 0 ? capitalUsdRounded : 1000;
    fetch(`/api/yields?currentChain=Base&capitalUsd=${cap}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`API returned ${r.status}`);
        return r.json();
      })
      .then(setYieldData)
      .catch(e => {
        if (e.name !== "AbortError") console.error("Failed to fetch yield data:", e);
      });
    return () => controller.abort();
  }, [capitalUsdRounded]);

  // ── Writes ──
  const { writeContractAsync: writeUSDC, isPending: isApprovePending } = useScaffoldWriteContract({
    contractName: "USDC",
  });
  const { writeContractAsync: writeGateway, isPending: isGatewayPending } = useScaffoldWriteContract({
    contractName: "VaultGateway",
  });
  const { writeContractAsync: writeVault, isPending: isVaultPending } = useScaffoldWriteContract({
    contractName: "YieldVault",
  });
  const { writeContractAsync: writeStrategy } = useScaffoldWriteContract({ contractName: "StrategyController" });
  const { writeContractAsync: writeKeeperCRE } = useScaffoldWriteContract({ contractName: "YieldKeeperCRE" });
  const { writeContractAsync: writeCB } = useScaffoldWriteContract({ contractName: "CircuitBreaker" });
  const { writeContractAsync: writeDMS } = useScaffoldWriteContract({ contractName: "DeadManSwitch" });
  const { writeContractAsync: writeFaucet, isPending: isMintPending } = useWriteContract();
  const transactor = useTransactor();

  // ── Computed ──
  const idle = idleBalance ?? 0n;
  const total = totalAssets ?? 0n;
  const remoteArb = remoteBalanceArb ?? 0n;
  const inFlight = totalInFlight ?? 0n;
  // totalAssets includes in-flight, so subtract both remote and in-flight
  const aaveBase = total > idle + remoteArb + inFlight ? total - idle - remoteArb - inFlight : 0n;

  const currentSharePriceBn =
    totalAssets !== undefined && totalSupply !== undefined && totalSupply > 0n
      ? (totalAssets * 10n ** BigInt(dec)) / totalSupply
      : 10n ** BigInt(dec);
  const sharePrice = Number(formatUnits(currentSharePriceBn, dec)).toFixed(6);

  const needsApproval = parsedDeposit > 0n && (usdcAllowanceGateway ?? 0n) < parsedDeposit;
  const needsShareApproval =
    parsedWithdraw > 0n && previewWithdrawShares !== undefined && (shareAllowanceGateway ?? 0n) < previewWithdrawShares;

  const tierLabels = ["NORMAL", "WATCH", "WARN", "CRITICAL"];
  const tierColors = ["text-success", "text-warning", "text-error", "text-error"];
  const tierNum = Number(currentTier ?? 0);

  const dmsRemaining = Number(dmsTimeRemaining ?? 0n);
  const dmsHours = Math.floor(dmsRemaining / 3600);
  const dmsMins = Math.floor((dmsRemaining % 3600) / 60);

  const spokeRegistered = spokeArb && spokeArb !== "0x0000000000000000000000000000000000000000";

  // CRE decision logic (mirrors what the workflow does)
  const idleTarget = total > 0n ? (total * (idleTargetBps ?? 500n)) / 10000n : 0n;
  const idleAboveTarget = idle > idleTarget;
  const supplyAmount = idle > idleTarget ? idle - idleTarget : 0n;
  const supplyMeetsMin = supplyAmount >= (minIdleSupplyAmount ?? 0n);
  const creWouldSupply = idleAboveTarget && supplyMeetsMin && !emergencyPaused;

  // Live LINK-priced cost estimates
  const linkPrice = yieldData?.config?.linkPriceUsd ?? 15;
  const rotationLinkCost = yieldData?.config?.rotationLinkCost ?? 0.66;
  const rotationGasCostUsd = yieldData?.config?.rotationGasCostUsd ?? 0.06;
  const rotationAmountBps = yieldData?.config?.rotationAmountBps ?? 2000;
  const rotationPct = rotationAmountBps / 10000; // 0.20
  const liveCosts = useMemo(() => {
    const dataMsg = 0.05 * linkPrice;
    const tokenTransfer = 0.3 * linkPrice;
    const creExecution = 0.01 * linkPrice;
    // Full rotation = 3 CCIP msgs (0.65 LINK) + CRE trigger (0.01 LINK) + gas on both chains
    const fullRotation = rotationLinkCost * linkPrice + rotationGasCostUsd;
    const creMonthlyNoOp = 2.5 * linkPrice;
    const creMonthlyActive = 4 * linkPrice;
    const monthlyFixed = creMonthlyActive; // dominated by CRE subscription
    const monthlyFixedHigh = creMonthlyActive * 1.5; // upper bound: more frequent rotations + harvests
    // Break-even TVL: only the rotated portion (20%) earns the spread
    // TVL needed so that rotatedAmount * spread covers rotation cost in 1 year
    const spreadBps = yieldData?.config?.minSpreadBps ?? 25;
    const spreadFraction = spreadBps / 10000; // 25 bps = 0.0025
    const breakEvenTvl = (fullRotation * 365) / (spreadFraction * rotationPct);
    return {
      dataMsg,
      tokenTransfer,
      creExecution,
      fullRotation,
      creMonthlyNoOp,
      creMonthlyActive,
      monthlyFixed,
      monthlyFixedHigh,
      breakEvenTvl,
    };
  }, [linkPrice, rotationLinkCost, rotationGasCostUsd, rotationPct, yieldData?.config?.minSpreadBps]);
  const lastHarvest = lastHarvestSharePrice ?? 10n ** BigInt(dec);
  const yieldGainBps = lastHarvest > 0n ? ((currentSharePriceBn - lastHarvest) * 10000n) / lastHarvest : 0n;
  const harvestMeetsYield = yieldGainBps >= (harvestMinYieldBps ?? 0n);
  const creWouldHarvest = !creWouldSupply && harvestMeetsYield;

  // Rotation checks
  const now = Math.floor(Date.now() / 1000);
  const lastRot = Number(lastRotationTimeArb ?? 0n);
  const cooldown = Number(rotationCooldown ?? 0n);
  const cooldownOk = now - lastRot >= cooldown;
  const minSpread = Number(minSpreadBps ?? 0n);
  const maxCost = Number(maxCostBps ?? 0n);

  // Priority 3: Rotation (if no supply or harvest needed, and yield data shows opportunity)
  const creWouldRotate = !creWouldSupply && !creWouldHarvest && spokeRegistered && cooldownOk && total > 0n;
  const creDecision = creWouldSupply
    ? "SUPPLY_IDLE"
    : creWouldHarvest
      ? "HARVEST_YIELD"
      : creWouldRotate
        ? "ROTATE"
        : "NO_OP";

  // ── Handlers ──
  const handleApprove = async () => {
    if (!gatewayInfo?.address) return;
    try {
      const hash = await writeUSDC({ functionName: "approve", args: [gatewayInfo.address, parsedDeposit] });
      addTxLog(2, `Approved ${depositAmount} USDC for VaultGateway`, hash);
    } catch (e) {
      addTxLog(2, `Approve failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleDeposit = async () => {
    if (!address || !vaultInfo?.address) return;
    try {
      const hash = await writeGateway({
        functionName: "deposit",
        args: [vaultInfo.address, parsedDeposit, address, 0n],
      });
      addTxLog(2, `Deposited ${depositAmount} USDC via VaultGateway`, hash);
      markComplete(2);
    } catch (e) {
      addTxLog(2, `Deposit failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleSupplyToAave = async () => {
    try {
      const hash = await writeStrategy({ functionName: "executeLocalSupply", args: [USDC_ADDRESS, idle] });
      addTxLog(3, `Supplied ${fmtUsdc(idle, dec)} USDC to Aave V3`, hash);
      markComplete(3);
    } catch (e) {
      addTxLog(3, `Supply failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleHeartbeat = async () => {
    try {
      const hash = await writeDMS({ functionName: "heartbeat" });
      addTxLog(7, "Heartbeat sent -- DeadManSwitch timer reset", hash);
    } catch (e) {
      addTxLog(7, `Heartbeat failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handlePause = async () => {
    try {
      const hash = await writeCB({ functionName: "activateEmergencyPause" });
      addTxLog(7, "Emergency pause ACTIVATED", hash);
    } catch (e) {
      addTxLog(7, `Pause failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleUnpause = async () => {
    try {
      const hash = await writeCB({ functionName: "deactivateEmergencyPause" });
      addTxLog(7, "Emergency pause deactivated", hash);
    } catch (e) {
      addTxLog(7, `Unpause failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleApproveShares = async () => {
    if (!gatewayInfo?.address || !previewWithdrawShares) return;
    try {
      const hash = await writeVault({ functionName: "approve", args: [gatewayInfo.address, previewWithdrawShares] });
      addTxLog(8, `Approved shares for VaultGateway`, hash);
    } catch (e) {
      addTxLog(8, `Approve failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleWithdraw = async () => {
    if (!address || !vaultInfo?.address) return;
    const sharesToBurn = previewWithdrawShares ?? 0n;
    const minAssets = (parsedWithdraw * (10000n - DEFAULT_SLIPPAGE_BPS)) / 10000n;
    try {
      const hash = await writeGateway({
        functionName: "redeem",
        args: [vaultInfo.address, sharesToBurn, address, minAssets],
      });
      addTxLog(8, `Withdrew ${withdrawAmount} USDC via VaultGateway`, hash);
      markComplete(8);
    } catch (e) {
      addTxLog(8, `Withdraw failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleRequestRedeem = async () => {
    if (!address || !vaultInfo?.address || !previewWithdrawShares) return;
    const minAssets = (parsedWithdraw * (10000n - DEFAULT_SLIPPAGE_BPS)) / 10000n;
    try {
      const hash = await writeVault({
        functionName: "requestRedeem",
        args: [previewWithdrawShares, address, minAssets],
      });
      addTxLog(8, `Requested redeem for ${withdrawAmount} USDC (queued for CCIP recall)`, hash);
    } catch (e) {
      addTxLog(8, `Request redeem failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  // EmergencyWithdrawTriggered(uint64 indexed chainSelector, bytes32 messageId)
  const EMERGENCY_WITHDRAW_TOPIC = "0xb49976eef265582735318d5ed1a436f775de2715332ffa6e0912dc5c37982493" as const;

  const handleRecallFunds = async () => {
    if (!publicClient) {
      addTxLog(8, "No wallet connection detected");
      return;
    }
    setIsRecalling(true);
    addTxLog(8, "Recalling funds from Arbitrum Sepolia...");
    try {
      const hash = await writeStrategy({
        functionName: "triggerRemoteEmergencyWithdraw",
        args: [ARB_CHAIN_SELECTOR],
      });
      addTxLog(8, "Recall initiated — CCIP message sent to SpokeVault", hash);

      // Extract CCIP messageId from EmergencyWithdrawTriggered event
      if (hash) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const ewLog = receipt.logs.find(l => l.topics[0] === EMERGENCY_WITHDRAW_TOPIC);
        if (ewLog) {
          const [messageId] = decodeAbiParameters([{ name: "messageId", type: "bytes32" }], ewLog.data);
          setRecallData({ homeTxHash: hash, ccipMessageId: messageId });
        } else {
          addTxLog(8, "Warning: Could not extract CCIP message ID from receipt");
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      addTxLog(8, `Recall failed: ${msg.slice(0, 120)}`);
    } finally {
      setIsRecalling(false);
    }
  };

  const [rotateAmount, setRotateAmount] = useState("1");
  const [rotateYieldBps, setRotateYieldBps] = useState("500");
  const [rotateCostBps, setRotateCostBps] = useState("100");

  const handleRotation = async () => {
    const amt = parseUnits(rotateAmount || "0", dec);
    if (amt <= 0n) return;
    addTxLog(6, `Initiating cross-chain rotation: ${rotateAmount} USDC → Arbitrum...`);
    try {
      const hash = await writeStrategy({
        functionName: "initiateCrossChainRotation",
        args: [ARB_CHAIN_SELECTOR, USDC_ADDRESS, amt, BigInt(rotateYieldBps), BigInt(rotateCostBps)],
      });
      addTxLog(6, `Rotation sent via CCIP! ${rotateAmount} USDC in-flight to Arbitrum`, hash);
      markComplete(6);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      addTxLog(6, `Rotation reverted: ${msg.slice(0, 120)}`);
    }
  };

  // Build CRE metadata (dummy — real metadata comes from KeystoneForwarder)
  const creMetadata = ("0x" + "00".repeat(62)) as `0x${string}`;

  const handleCreSupply = async () => {
    if (supplyAmount <= 0n) return;
    addTxLog(5, `CRE action: SUPPLY_IDLE -- calling onReport(SUPPLY_IDLE)...`);
    try {
      const report = encodeAbiParameters(parseAbiParameters("uint8"), [0]);
      const hash = await writeKeeperCRE({ functionName: "onReport", args: [creMetadata, report] });
      addTxLog(5, `CRE SUPPLY_IDLE executed via onReport -- ${fmtUsdc(supplyAmount, dec)} USDC deployed to Aave`, hash);
      markComplete(5);
    } catch (e) {
      addTxLog(5, `CRE supply failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleCreHarvest = async () => {
    addTxLog(5, "CRE action: HARVEST_YIELD -- calling onReport(HARVEST_YIELD)...");
    try {
      const report = encodeAbiParameters(parseAbiParameters("uint8"), [1]);
      const hash = await writeKeeperCRE({ functionName: "onReport", args: [creMetadata, report] });
      addTxLog(5, "CRE HARVEST_YIELD executed via onReport -- share price updated, fee shares minted", hash);
      markComplete(5);
    } catch (e) {
      addTxLog(5, `CRE harvest failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };

  const handleCreRotate = async () => {
    const amt = parseUnits(rotateAmount || "0", dec);
    if (amt <= 0n) return;
    addTxLog(5, `CRE action: ROTATE -- calling onReport(ROTATE) for ${rotateAmount} USDC → Arbitrum...`);
    try {
      const report = encodeAbiParameters(parseAbiParameters("uint8, uint64, uint256, uint256, uint256"), [
        2,
        ARB_CHAIN_SELECTOR,
        amt,
        BigInt(rotateYieldBps),
        BigInt(rotateCostBps),
      ]);
      const hash = await writeKeeperCRE({ functionName: "onReport", args: [creMetadata, report] });
      addTxLog(5, `CRE ROTATE executed via onReport -- ${rotateAmount} USDC in-flight to Arbitrum`, hash);
      markComplete(5);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      addTxLog(5, `CRE rotate failed: ${msg.slice(0, 120)}`);
    }
  };

  const [bridgeAmount, setBridgeAmount] = useState("0.1");

  // CRE simulation state
  const [creSimulating, setCreSimulating] = useState(false);
  const [creSimResult, setCreSimResult] = useState<{
    success: boolean;
    broadcast: boolean;
    innerResult: string | null;
    workflowAction: string | null;
    txHash: string | null;
    revertReason: string | null;
    stdout: string;
    stderr: string;
    exitCode: number;
  } | null>(null);

  const handleCreSimulate = async (broadcast: boolean) => {
    setCreSimulating(true);
    setCreSimResult(null);
    addTxLog(5, `CRE workflow simulate ${broadcast ? "--broadcast" : "(dry run)"}...`);
    try {
      const res = await fetch("/api/cre-simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broadcast, triggerIndex: 0 }),
      });
      const data = await res.json();
      setCreSimResult(data);
      const innerOk = data.innerResult !== "reverted";
      const isRotation = data.workflowAction === "ROTATE" || data.workflowAction === "TESTNET_ROTATE";
      if (data.success && innerOk) {
        const actionLabel =
          data.workflowAction === "none"
            ? "no action needed (vault idle)"
            : `${data.workflowAction} ${data.innerResult ?? ""}`;
        addTxLog(
          5,
          `CRE ${broadcast ? "broadcast" : "dry run"} completed — ${actionLabel}`,
          broadcast && data.txHash ? data.txHash : undefined,
        );
        // For rotation actions, activate the cross-chain rotation tracker
        if (broadcast && isRotation && data.txHash && data.ccipMessageId) {
          setRotationData({ homeTxHash: data.txHash, ccipMessageId: data.ccipMessageId });
        }
        if (broadcast && data.workflowAction !== "none") markComplete(5);
      } else if (data.success && !innerOk) {
        addTxLog(
          5,
          `CRE ${broadcast ? "broadcast" : "simulation"}: ${data.workflowAction ?? "action"} executed but onReport() REVERTED on-chain`,
          data.txHash ?? undefined,
        );
      } else {
        addTxLog(5, `CRE simulation failed (exit code ${data.exitCode})`);
      }
    } catch (e) {
      addTxLog(5, `CRE simulation error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setCreSimulating(false);
    }
  };

  const handleCreTestnetRotate = async () => {
    const amt = parseUnits(rotateAmount || "0", dec);
    const bnmAmt = parseUnits(bridgeAmount || "0", 18); // CCIP-BnM is 18 decimals
    if (amt <= 0n) return;
    addTxLog(
      5,
      `Testnet rotation: ${rotateAmount} USDC (Aave withdraw) + ${bridgeAmount} CCIP-BnM (bridged) → Arbitrum...`,
    );
    try {
      const report = encodeAbiParameters(
        parseAbiParameters("uint8, uint64, uint256, address, uint256, uint256, uint256"),
        [3, ARB_CHAIN_SELECTOR, amt, CCIP_BNM_ADDRESS, bnmAmt, BigInt(rotateYieldBps), BigInt(rotateCostBps)],
      );
      const hash = await writeKeeperCRE({ functionName: "onReport", args: [creMetadata, report] });
      addTxLog(5, `TESTNET_ROTATE executed! Aave withdraw + CCIP-BnM bridge to Arbitrum`, hash);
      // Extract CCIP messageId from receipt to link the cross-chain message
      if (hash && publicClient) {
        try {
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          const rotationLog = receipt.logs.find(
            log => log.topics[0] === ROTATION_EVENT_TOPIC || log.topics[0] === TESTNET_ROTATION_EVENT_TOPIC,
          );
          if (rotationLog) {
            const [, , messageId] = decodeAbiParameters(
              [
                { name: "token", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "messageId", type: "bytes32" },
              ],
              rotationLog.data,
            );
            setRotationData({ homeTxHash: hash, ccipMessageId: messageId });
          }
        } catch {
          // Non-critical — tx already logged above
        }
      }
      markComplete(5);
      markComplete(6); // Also marks CCIP step as complete
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      addTxLog(5, `Testnet rotation failed: ${msg.slice(0, 120)}`);
    }
  };

  const handleCreTestnetRecall = async () => {
    if (!remoteArb || remoteArb <= 0n) return;
    const ARB_BNM = "0xA8C0c11bf64AF62CDCA6f93D3769B88BdD7cb93D" as `0x${string}`;
    try {
      const report = encodeAbiParameters(parseAbiParameters("uint8, uint64, uint256, address"), [
        6,
        ARB_CHAIN_SELECTOR,
        remoteArb,
        ARB_BNM,
      ]);
      const hash = await writeKeeperCRE({ functionName: "onReport", args: [creMetadata, report] });
      if (hash && publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const RECALL_EVENT_TOPIC = "0x65bf61f8ff42492db65b696beacf62395f85993417be2d43acb077b068fca042";
        const recallLog = receipt.logs.find(log => log.topics[0] === RECALL_EVENT_TOPIC);
        if (recallLog) {
          const [, messageId] = decodeAbiParameters(
            [
              { name: "amount", type: "uint256" },
              { name: "messageId", type: "bytes32" },
            ],
            recallLog.data,
          );
          setRecallData({ homeTxHash: hash, ccipMessageId: messageId });
        }
      }
      markComplete(6);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      addTxLog(6, `Testnet recall failed: ${msg.slice(0, 120)}`);
    }
  };

  // ── Render ──
  return (
    <div className="space-y-4">
      {/* Wallet check */}
      {!address && (
        <div className="alert alert-warning">
          <span>Connect your wallet (Base Sepolia) to interact with the demo steps.</span>
        </div>
      )}

      {/* Step Navigation */}
      <div className="flex flex-wrap items-center gap-1 bg-base-200 rounded-xl p-3">
        {STEP_LABELS.map((label, i) => (
          <button
            key={i}
            className={`btn btn-xs ${
              activeStep === i ? "btn-primary" : completedSteps.has(i) ? "btn-success" : "btn-ghost"
            }`}
            onClick={() => toggle(i)}
          >
            {i}. {label}
          </button>
        ))}
      </div>

      {/* STEP 0: Architecture */}
      <DemoStep
        step={0}
        title="System Architecture"
        subtitle="10 contracts, 2 chains, automated yield optimization"
        active={activeStep === 0}
        completed={completedSteps.has(0)}
        onToggle={() => toggle(0)}
      >
        <ArchitectureDiagram />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
          {Object.entries(CONTRACTS).map(([name, addr]) => (
            <div key={name} className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{name}:</span>
              {explorerLink(addr)}
            </div>
          ))}
        </div>
        <div className="mt-4 text-sm opacity-70">
          <b>10 verified contracts</b> on Base Sepolia + 1 SpokeVault on Arbitrum Sepolia. 339 tests (216 Solidity + 123
          monitor).
        </div>
        <button
          className="btn btn-sm btn-primary mt-3"
          onClick={() => {
            markComplete(0);
            setActiveStep(1);
          }}
        >
          Next: Get Testnet USDC &#8594;
        </button>
      </DemoStep>

      {/* STEP 1: Get USDC */}
      <DemoStep
        step={1}
        title="Get Testnet USDC"
        subtitle="Claim USDC from the Aave faucet on Base Sepolia"
        active={activeStep === 1}
        completed={completedSteps.has(1)}
        onToggle={() => toggle(1)}
      >
        <div className="space-y-3">
          <p className="text-sm">
            The vault accepts <b>USDC</b> on Base Sepolia. Mint 10,000 USDC from the Aave testnet faucet directly:
          </p>
          <div className="flex items-center gap-3">
            <button
              className="btn btn-sm btn-primary"
              disabled={isMintPending || !address}
              onClick={async () => {
                try {
                  const hash = await transactor(() =>
                    writeFaucet({
                      address: AAVE_FAUCET as `0x${string}`,
                      abi: [
                        {
                          name: "mint",
                          type: "function",
                          stateMutability: "nonpayable",
                          inputs: [
                            { name: "token", type: "address" },
                            { name: "to", type: "address" },
                            { name: "amount", type: "uint256" },
                          ],
                          outputs: [],
                        },
                      ] as const,
                      functionName: "mint",
                      args: [USDC_ADDRESS, address!, parseUnits("10000", 6)],
                    }),
                  );
                  if (hash) addTxLog(1, "Minted 10,000 USDC from Aave faucet", hash);
                } catch (e: unknown) {
                  addTxLog(1, `Mint failed: ${e instanceof Error ? e.message : "error"}`);
                }
              }}
            >
              {isMintPending ? "Minting..." : "Mint 10,000 USDC"}
            </button>
          </div>
          <div className="stat bg-base-200 rounded-lg p-3 inline-block">
            <div className="stat-title text-xs">Your USDC Balance</div>
            <div className="stat-value text-lg font-mono">{fmtUsdc(usdcBalance, dec)} USDC</div>
          </div>
          {(usdcBalance ?? 0n) > 0n && (
            <button
              className="btn btn-sm btn-primary ml-3"
              onClick={() => {
                markComplete(1);
                setActiveStep(2);
              }}
            >
              Next: Deposit &#8594;
            </button>
          )}
        </div>
        <StepTxHistory logs={txLog} step={1} />
      </DemoStep>

      {/* STEP 2: Deposit */}
      <DemoStep
        step={2}
        title="Deposit USDC into the Vault"
        subtitle="User -> VaultGateway (slippage protection) -> YieldVault -> mints yUSDC shares"
        active={activeStep === 2}
        completed={completedSteps.has(2)}
        onToggle={() => toggle(2)}
      >
        <div className="space-y-4">
          <div className="text-sm space-y-1">
            <p>
              The deposit flow goes through the <b>VaultGateway</b> which adds slippage protection.
            </p>
            <p>
              The vault mints <b>yUSDC shares</b> proportional to your deposit, then deploys funds to Aave V3.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs bg-base-200 rounded-lg p-3">
            <span className="badge badge-neutral">1. Approve</span>
            <span>&#8594;</span>
            <span className="badge badge-primary">2. Deposit</span>
            <span>&#8594;</span>
            <span className="badge badge-secondary">3. Get yUSDC</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <CostBadge label="Approve" usd={COSTS.approveErc20.usd} detail={COSTS.approveErc20.gas} />
            <CostBadge label="Deposit" usd={COSTS.depositGateway.usd} detail={COSTS.depositGateway.gas} />
            <span className="text-xs opacity-50 self-center">Total: ~$0.02 on Base L2</span>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="number"
              placeholder="10"
              className="input input-bordered input-sm w-32 font-mono"
              value={depositAmount}
              onChange={e => setDepositAmount(e.target.value)}
            />
            <span className="text-sm">USDC</span>
            {previewDeposit !== undefined && parsedDeposit > 0n && (
              <span className="text-xs opacity-60">&#8594; ~{fmtUsdc(previewDeposit, dec)} yUSDC</span>
            )}
          </div>

          <div className="flex gap-2">
            {needsApproval ? (
              <button
                className="btn btn-sm btn-warning"
                onClick={handleApprove}
                disabled={isApprovePending || parsedDeposit === 0n}
              >
                {isApprovePending ? <span className="loading loading-spinner loading-sm" /> : "1. Approve USDC"}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                onClick={handleDeposit}
                disabled={isGatewayPending || parsedDeposit === 0n || parsedDeposit > (usdcBalance ?? 0n)}
              >
                {isGatewayPending ? <span className="loading loading-spinner loading-sm" /> : "2. Deposit via Gateway"}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Your yUSDC Shares</div>
              <div className="stat-value text-lg font-mono">{fmtUsdc(shareBalance, dec)}</div>
            </div>
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Share Price</div>
              <div className="stat-value text-lg font-mono">{sharePrice}</div>
            </div>
          </div>

          {completedSteps.has(2) && (
            <button className="btn btn-sm btn-primary" onClick={() => setActiveStep(3)}>
              Next: See Funds in Aave &#8594;
            </button>
          )}
        </div>
        <StepTxHistory logs={txLog} step={2} />
      </DemoStep>

      {/* STEP 3: Aave Deployment */}
      <DemoStep
        step={3}
        title="Capital Deployed to Aave V3"
        subtitle="Idle USDC is auto-supplied to Aave to earn yield"
        active={activeStep === 3}
        completed={completedSteps.has(3)}
        onToggle={() => toggle(3)}
      >
        <div className="space-y-4">
          <p className="text-sm">
            Funds in the vault are automatically supplied to <b>Aave V3 on Base Sepolia</b>. The StrategyController
            manages all Aave interactions.
            {idle > 0n && " There is currently idle USDC that can be supplied."}
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Aave V3 (Base)</div>
              <div className="stat-value text-lg font-mono">${fmtUsdc(aaveBase, dec)}</div>
            </div>
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Idle (Vault)</div>
              <div className="stat-value text-lg font-mono">${fmtUsdc(idle, dec)}</div>
            </div>
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Arbitrum (Spoke)</div>
              <div className="stat-value text-lg font-mono">${fmtUsdc(remoteArb, dec)}</div>
            </div>
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">In-Flight (CCIP)</div>
              <div className="stat-value text-lg font-mono">${fmtUsdc(inFlight, dec)}</div>
            </div>
          </div>

          <div className="flex justify-between font-bold text-sm bg-base-200 rounded-lg p-3">
            <span>Total Value Locked</span>
            <span className="font-mono">${fmtUsdc(total, dec)}</span>
          </div>

          <CostBadge label="Supply to Aave" usd={COSTS.supplyToAave.usd} detail={COSTS.supplyToAave.gas} />

          {idle > 0n && (
            <button className="btn btn-sm btn-accent" onClick={handleSupplyToAave}>
              Supply {fmtUsdc(idle, dec)} USDC to Aave
            </button>
          )}

          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              markComplete(3);
              setActiveStep(4);
            }}
          >
            Next: Decision Engine &#8594;
          </button>
        </div>
        <StepTxHistory logs={txLog} step={3} />
      </DemoStep>

      {/* STEP 4: Decision Engine */}
      <DemoStep
        step={4}
        title="Decision Engine &mdash; Yield Comparison"
        subtitle="Fetches 200+ Aave pools from DeFiLlama, recommends optimal rotations"
        active={activeStep === 4}
        completed={completedSteps.has(4)}
        onToggle={() => toggle(4)}
      >
        <div className="space-y-4">
          <p className="text-sm">
            The decision engine continuously compares Aave V3 yield rates across <b>7 chains</b> and{" "}
            <b>11 stablecoins</b>. It applies thresholds (min spread {yieldData?.config?.minSpreadBps ?? 25} bps, max
            break-even {yieldData?.config?.maxBreakEvenDays ?? 30}d) to recommend profitable rotations. Each rotation
            moves {rotationAmountBps / 100}% of TVL.
            {yieldData?.capitalUsd != null && (
              <span className="opacity-60"> (calculated for ${yieldData.capitalUsd.toLocaleString()} TVL)</span>
            )}
          </p>

          {yieldData ? (
            <>
              <div className="stat bg-base-200 rounded-lg p-3 inline-block">
                <div className="stat-title text-xs">Current Position</div>
                <div className="stat-value text-lg">
                  {yieldData.currentPosition?.chain} {yieldData.currentPosition?.symbol} @{" "}
                  {yieldData.currentPosition?.apy?.toFixed(2)}% APY
                </div>
              </div>

              {yieldData.recommendations && yieldData.recommendations.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table table-sm table-zebra">
                    <thead>
                      <tr>
                        <th>Target</th>
                        <th>APY</th>
                        <th>Spread</th>
                        <th>Break-even</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yieldData.recommendations.slice(0, 5).map((r, i) => (
                        <tr key={i} className={r.recommended ? "bg-success/10" : ""}>
                          <td className="font-mono text-xs">
                            {r.to.chain} / {r.to.symbol}
                          </td>
                          <td className="font-mono">{r.to.apy?.toFixed(2)}%</td>
                          <td className="font-mono">{r.yieldImprovementBps} bps</td>
                          <td className="font-mono">
                            {r.breakEvenDays < 9999 ? `${r.breakEvenDays.toFixed(1)}d` : "-"}
                          </td>
                          <td>
                            {r.recommended ? (
                              <span className="badge badge-success badge-sm">ROTATE</span>
                            ) : (
                              <span className="badge badge-ghost badge-sm">HOLD</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="loading loading-spinner loading-sm" />
              <span className="text-sm opacity-60">Loading yield data from DeFiLlama...</span>
            </div>
          )}

          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              markComplete(4);
              setActiveStep(5);
            }}
          >
            Next: CRE Automation &#8594;
          </button>
        </div>
      </DemoStep>

      {/* STEP 5: CRE Workflow -- Interactive */}
      <DemoStep
        step={5}
        title="CRE Automation &mdash; Live Execution"
        subtitle="Run the actual CRE workflow or execute individual actions on-chain"
        active={activeStep === 5}
        completed={completedSteps.has(5)}
        onToggle={() => toggle(5)}
      >
        <div className="space-y-4">
          {/* Testnet vs Mainnet Explainer (collapsible) */}
          <details className="bg-warning/10 border-2 border-warning/40 rounded-xl">
            <summary className="font-bold text-sm p-4 cursor-pointer select-none">
              Testnet vs Mainnet &mdash; What&apos;s Different and Why
            </summary>
            <div className="text-xs space-y-3 px-4 pb-4">
              <div>
                <b className="text-warning">Status:</b> Accepted into Chainlink CRE Early Access program (pending
                account enablement). Once enabled, the workflow can be deployed to Chainlink&apos;s DON for fully
                autonomous execution. The CRE CLI provides a <code className="mx-1">simulate</code> mode that runs the{" "}
                <b>exact same workflow code</b> locally on your machine, reading live on-chain state and optionally
                broadcasting real transactions.
              </div>
              <div className="overflow-x-auto">
                <table className="table table-xs table-zebra">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Mainnet (Production)</th>
                      <th>Testnet (This Demo)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="font-semibold">Where it runs</td>
                      <td>Chainlink DON -- distributed across multiple nodes with consensus</td>
                      <td>
                        Locally via <code>cre workflow simulate</code> -- single node, no consensus. DON deployment now
                        available (CRE Early Access approved).
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">Trigger</td>
                      <td>Automated cron (every 5 min) + on-chain event triggers</td>
                      <td>Manual button click -- triggers the cron handler immediately</td>
                    </tr>
                    <tr>
                      <td className="font-semibold">On-chain reads</td>
                      <td className="text-success font-semibold">Live chain state (vault, Aave, circuit breaker)</td>
                      <td className="text-success font-semibold">Same -- reads live Base Sepolia state</td>
                    </tr>
                    <tr>
                      <td className="font-semibold">Decision logic</td>
                      <td className="text-success font-semibold">TypeScript workflow compiled to WASM</td>
                      <td className="text-success font-semibold">
                        Same -- identical code, compiled and executed locally
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">Transaction signing</td>
                      <td>DON signs via KeystoneForwarder (cryptographic multi-sig)</td>
                      <td>
                        Local wallet signs directly (forwarder set to <code>address(0)</code> to bypass DON signature
                        check)
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">On-chain execution</td>
                      <td>
                        <code>KeystoneForwarder</code> calls <code>onReport()</code> with DON signatures
                      </td>
                      <td>
                        <code>simulate --broadcast</code> calls <code>onReport()</code> directly from local wallet
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">What it proves</td>
                      <td>Full decentralized automation</td>
                      <td>
                        Workflow logic, on-chain reads, decision engine, and transaction execution are all correct. The{" "}
                        <i>only</i> gap is DON consensus + KeystoneForwarder signature verification.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <b>Two ways to test below:</b> (A) Run the actual CRE workflow via <code>simulate</code> /
                <code>simulate --broadcast</code>, or (B) call <code>onReport()</code> directly with manually encoded
                action parameters. Both call the same contract entry point.
              </div>
            </div>
          </details>

          {/* ── Option A: CRE Workflow Simulation ── */}
          <div className="border-2 border-success/40 rounded-xl p-4 bg-success/5">
            <div className="flex items-center gap-2 mb-3">
              <span className="badge badge-success badge-sm">A</span>
              <span className="font-bold text-sm">Run CRE Workflow (simulate)</span>
            </div>
            <p className="text-xs opacity-70 mb-3">
              Executes the full <code>main.ts</code> workflow via the CRE CLI. The workflow reads vault state from Base
              Sepolia, runs the priority-based decision engine (supply &gt; harvest &gt; rotate), and either dry-runs or
              broadcasts the resulting <code>onReport()</code> transaction.
            </p>
            {/* Finalized block caveat + live display */}
            <div className="bg-base-200 rounded-lg p-3 mb-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono">
                <span>
                  Latest block: <b className="text-success">{latestBlock?.toString() ?? "..."}</b>
                </span>
                <span>
                  Finalized block: <b className="text-warning">{finalizedBlock?.toString() ?? "..."}</b>
                </span>
                {latestBlock && finalizedBlock && latestBlock > finalizedBlock && (
                  <span className="text-warning">({(latestBlock - finalizedBlock).toString()} blocks behind)</span>
                )}
              </div>
              <p className="mt-1 opacity-70">
                The CRE workflow reads from the <b>finalized</b> block for safety. If you just sent a transaction, the
                workflow may not see it yet. The on-chain contract will reject stale actions (revert with{" "}
                <code>NoActionNeeded</code>), which is the expected safety behavior.
              </p>
              <p className="mt-1 opacity-70">
                On testnet, rotation uses <code>TESTNET_ROTATE</code>: withdraws USDC from Aave (real) + bridges 0.1
                CCIP-BnM tokens via CCIP (since faucet USDC is not in CCIP pools). On mainnet, <code>ROTATE</code>{" "}
                bridges real USDC. The StrategyController must hold CCIP-BnM + LINK for this to work.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                className="btn btn-sm btn-outline btn-success"
                onClick={() => handleCreSimulate(false)}
                disabled={creSimulating}
              >
                {creSimulating ? <span className="loading loading-spinner loading-sm" /> : null}
                Simulate (Dry Run)
              </button>
              <button
                className="btn btn-sm btn-success"
                onClick={() => handleCreSimulate(true)}
                disabled={creSimulating}
              >
                {creSimulating ? <span className="loading loading-spinner loading-sm" /> : null}
                Simulate + Broadcast
              </button>
              <span className="text-xs opacity-50 self-center">
                Dry run shows what would happen. Broadcast sends the tx on-chain.
              </span>
            </div>

            {creSimResult &&
              (() => {
                const innerOk = creSimResult.innerResult !== "reverted";
                const isNoAction = creSimResult.success && creSimResult.workflowAction === "none";
                const isOk = creSimResult.success && innerOk;
                return (
                  <div
                    className={`rounded-lg p-3 text-xs font-mono ${isOk ? (isNoAction ? "bg-info/10" : "bg-success/10") : "bg-error/10"}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={`badge badge-sm ${isOk ? (isNoAction ? "badge-info" : "badge-success") : "badge-error"}`}
                      >
                        {!creSimResult.success
                          ? `EXIT ${creSimResult.exitCode}`
                          : creSimResult.innerResult === "reverted"
                            ? "REVERTED"
                            : isNoAction
                              ? "IDLE"
                              : creSimResult.innerResult === "success"
                                ? "SUCCESS"
                                : "OK"}
                      </span>
                      <span className="opacity-60">{creSimResult.broadcast ? "broadcast mode" : "dry run"}</span>
                      {creSimResult.workflowAction && !isNoAction && (
                        <span className="badge badge-sm badge-outline">{creSimResult.workflowAction}</span>
                      )}
                      {isNoAction && <span className="opacity-60">No action needed — vault is idle or empty</span>}
                      {creSimResult.innerResult === "reverted" && creSimResult.broadcast && (
                        <span className="text-error">onReport() reverted on-chain</span>
                      )}
                    </div>
                    {creSimResult.innerResult === "reverted" && creSimResult.revertReason && (
                      <div className="bg-error/20 border border-error/30 rounded p-2 mb-2">
                        <span className="font-bold text-error">Revert reason: </span>
                        <span className="text-error/90 break-all">{creSimResult.revertReason}</span>
                      </div>
                    )}
                    {creSimResult.txHash && (
                      <div className="mb-2 opacity-70">
                        <span>Tx: </span>
                        <a
                          href={`${BASE_SEPOLIA_EXPLORER}/tx/${creSimResult.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link link-accent break-all"
                        >
                          {creSimResult.txHash}
                        </a>
                      </div>
                    )}
                    <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all opacity-80">
                      {creSimResult.stdout || creSimResult.stderr || "No output"}
                    </div>
                  </div>
                );
              })()}
          </div>

          {/* ── Option B: Manual onReport() Execution ── */}
          <div className="border border-base-300 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="badge badge-ghost badge-sm">B</span>
              <span className="font-bold text-sm">Manual Execution via onReport()</span>
            </div>
            <p className="text-xs opacity-60 mb-3">
              Call <code>YieldKeeperCRE.onReport(metadata, report)</code> directly from your wallet with manually chosen
              action parameters. This is the same contract function the CRE workflow calls, but you control which action
              fires. Forwarder is set to <code>address(0)</code> so any wallet can call it.
            </p>

            {/* Phase 1: Read State */}
            <div className="bg-base-200 rounded-lg p-4 mb-3">
              <div className="font-bold text-xs mb-2">Live On-Chain State</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-xs">
                <span className="opacity-60">Total Assets:</span>
                <span className="font-mono">{fmtUsdc(total, dec)} USDC</span>
                <span />
                <span className="opacity-60">Idle Balance:</span>
                <span className="font-mono">{fmtUsdc(idle, dec)} USDC</span>
                <span className={idleAboveTarget ? "text-warning font-bold" : "text-success"}>
                  {idleAboveTarget ? "Above target" : "At/below target"}
                </span>
                <span className="opacity-60">Idle Target ({Number(idleTargetBps ?? 500n) / 100}%):</span>
                <span className="font-mono">{fmtUsdc(idleTarget, dec)} USDC</span>
                <span />
                <span className="opacity-60">Current Share Price:</span>
                <span className="font-mono">{sharePrice}</span>
                <span />
                <span className="opacity-60">Last Harvest Price:</span>
                <span className="font-mono">{Number(formatUnits(lastHarvest, dec)).toFixed(6)}</span>
                <span />
                <span className="opacity-60">Yield Since Harvest:</span>
                <span className="font-mono">{Number(yieldGainBps)} bps</span>
                <span className={harvestMeetsYield ? "text-success font-bold" : "opacity-50"}>
                  {harvestMeetsYield
                    ? `>= ${Number(harvestMinYieldBps ?? 0)} bps threshold`
                    : `< ${Number(harvestMinYieldBps ?? 0)} bps threshold`}
                </span>
                <span className="opacity-60">Circuit Breaker:</span>
                <span className={emergencyPaused ? "text-error font-bold" : "text-success font-mono"}>
                  {emergencyPaused ? "PAUSED" : "OK"}
                </span>
                <span />
              </div>
            </div>

            {/* Phase 2: Decision */}
            <div
              className={`rounded-lg p-3 mb-3 border ${
                creDecision !== "NO_OP" ? "bg-success/10 border-success/30" : "bg-base-200 border-base-300"
              }`}
            >
              <div className="font-bold text-xs mb-1">Decision Engine Output</div>
              <div className="flex items-center gap-3">
                <span
                  className={`badge badge-sm ${
                    creDecision === "SUPPLY_IDLE"
                      ? "badge-success"
                      : creDecision === "HARVEST_YIELD"
                        ? "badge-accent"
                        : creDecision === "ROTATE"
                          ? "badge-warning"
                          : "badge-ghost"
                  }`}
                >
                  {creDecision}
                </span>
                <span className="text-xs">
                  {creDecision === "SUPPLY_IDLE" && `Supply ${fmtUsdc(supplyAmount, dec)} USDC to Aave`}
                  {creDecision === "HARVEST_YIELD" && `Harvest ${Number(yieldGainBps)} bps of accrued yield`}
                  {creDecision === "ROTATE" && "Rotate capital to higher-yielding chain"}
                  {creDecision === "NO_OP" && "No action needed"}
                </span>
              </div>
            </div>

            {/* Phase 3: Execute */}
            <div className="flex flex-wrap gap-2">
              <button
                className={`btn btn-sm ${creDecision === "SUPPLY_IDLE" ? "btn-success" : "btn-outline"}`}
                onClick={handleCreSupply}
                disabled={supplyAmount <= 0n}
              >
                onReport(SUPPLY_IDLE)
              </button>
              <button
                className={`btn btn-sm ${creDecision === "HARVEST_YIELD" ? "btn-accent" : "btn-outline"}`}
                onClick={handleCreHarvest}
              >
                onReport(HARVEST_YIELD)
              </button>
              <button
                className={`btn btn-sm ${creDecision === "ROTATE" ? "btn-warning" : "btn-outline"}`}
                onClick={handleCreRotate}
                disabled={!spokeRegistered}
              >
                onReport(ROTATE)
              </button>
              <button
                className={`btn btn-sm ${creDecision === "ROTATE" ? "btn-warning" : "btn-outline"}`}
                onClick={handleCreTestnetRotate}
                disabled={!spokeRegistered}
              >
                onReport(TESTNET_ROTATE)
              </button>
              <button
                className="btn btn-sm btn-info"
                onClick={handleCreTestnetRecall}
                disabled={!spokeRegistered || !remoteArb || remoteArb <= 0n}
              >
                onReport(TESTNET_RECALL)
              </button>
            </div>
            {creDecision !== "NO_OP" && (
              <div className="mt-2 text-xs text-success">
                The highlighted button is what CRE would execute right now. On testnet, use TESTNET_ROTATE (bridges
                CCIP-BnM instead of USDC).
              </div>
            )}
            {creDecision === "ROTATE" && (
              <div className="mt-2 flex flex-wrap gap-2 items-center text-xs">
                <span className="opacity-60">Rotate amount:</span>
                <input
                  type="text"
                  className="input input-xs input-bordered w-20"
                  value={rotateAmount}
                  onChange={e => setRotateAmount(e.target.value)}
                />
                <span className="opacity-60">USDC, yield:</span>
                <input
                  type="text"
                  className="input input-xs input-bordered w-16"
                  value={rotateYieldBps}
                  onChange={e => setRotateYieldBps(e.target.value)}
                />
                <span className="opacity-60">bps, cost:</span>
                <input
                  type="text"
                  className="input input-xs input-bordered w-16"
                  value={rotateCostBps}
                  onChange={e => setRotateCostBps(e.target.value)}
                />
                <span className="opacity-60">bps, BnM:</span>
                <input
                  type="text"
                  className="input input-xs input-bordered w-16"
                  value={bridgeAmount}
                  onChange={e => setBridgeAmount(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* CRE Contract Info */}
          <div className="bg-base-200 rounded-lg p-4 text-sm">
            <div className="font-bold mb-2">CRE Infrastructure</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <span className="opacity-60">YieldKeeperCRE:</span>
              {explorerLink(CONTRACTS.YieldKeeperCRE)}
              <span className="opacity-60">KeystoneForwarder:</span>
              {explorerLink(KEYSTONE_FORWARDER)}
              <span className="opacity-60">Proven on-chain tx (manual):</span>
              <a
                href={`${BASE_SEPOLIA_EXPLORER}/tx/0x31e6bef1c01c7d8a2e2e91424be30dbd9beb19c89dc8a1c05f46d54c2ee5b4d5`}
                target="_blank"
                rel="noreferrer"
                className="link link-accent text-xs font-mono"
              >
                0x31e6bef1... (HARVEST via direct onReport)
              </a>
              <span className="opacity-60">Proven on-chain tx (CRE simulate):</span>
              <a
                href={`${BASE_SEPOLIA_EXPLORER}/tx/0xaa74ff31c3f2c8a481e37e6ee9a695ea4916b88b3cdd75617f0f6e970208ce93`}
                target="_blank"
                rel="noreferrer"
                className="link link-accent text-xs font-mono"
              >
                0xaa74ff31... (HARVEST via simulate --broadcast)
              </a>
              <span className="opacity-60">DON deployment:</span>
              <span className="badge badge-warning badge-sm">Accepted, Pending Enablement</span>
            </div>
          </div>

          {/* Costs */}
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              markComplete(5);
              setActiveStep(6);
            }}
          >
            Next: Cross-Chain (CCIP) &#8594;
          </button>
        </div>
        <StepTxHistory logs={txLog} step={5} />
        {rotationData && <RotationTracker data={rotationData} />}
      </DemoStep>

      {/* STEP 6: Cross-Chain -- Interactive */}
      <DemoStep
        step={6}
        title="Cross-Chain Rotation via CCIP &mdash; Live Test"
        subtitle="Validate checks, attempt real CCIP rotation to Arbitrum"
        active={activeStep === 6}
        completed={completedSteps.has(6)}
        onToggle={() => toggle(6)}
      >
        <div className="space-y-4">
          <p className="text-sm">
            When yields are higher on another chain, the StrategyController withdraws from local Aave, sends USDC +
            instruction via <b>Chainlink CCIP</b>, and the SpokeVault deploys to Aave on destination.
          </p>

          {/* Testnet vs Mainnet Explainer (collapsible) */}
          <details className="bg-warning/10 border-2 border-warning/40 rounded-xl">
            <summary className="font-bold text-sm p-4 cursor-pointer select-none">
              Testnet vs Mainnet &mdash; What&apos;s Different and Why
            </summary>
            <div className="text-xs space-y-3 px-4 pb-4">
              <div>
                <b className="text-warning">The limitation:</b> Aave&apos;s testnet faucet mints its own USDC (
                <code className="font-mono">0xba50...D5f</code>), which is <b>not the same USDC</b> registered in
                Chainlink&apos;s CCIP token pools (or Circle&apos;s CCTP). This means we cannot bridge Aave faucet USDC
                cross-chain on testnet -- both CCIP and CCTP reject it because their contracts only accept tokens they
                have registered. This is a testnet-only problem: on mainnet, real USDC is supported by both protocols.
              </div>
              <div className="overflow-x-auto">
                <table className="table table-xs table-zebra">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Mainnet (Production)</th>
                      <th>Testnet (This Demo)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="font-semibold">Trigger</td>
                      <td>CRE workflow on Chainlink DON (automated, every 5 min)</td>
                      <td>
                        Manual <code>onReport()</code> call (same contract entry point)
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">Aave withdraw</td>
                      <td>Withdraw real USDC from Aave V3</td>
                      <td className="text-success font-semibold">Same -- withdraws faucet USDC from Aave V3</td>
                    </tr>
                    <tr>
                      <td className="font-semibold">CCIP bridge</td>
                      <td>Bridge the withdrawn USDC via CCIP to destination chain</td>
                      <td>
                        Bridge <b>CCIP-BnM</b> test tokens instead (Chainlink&apos;s burn-and-mint tokens that{" "}
                        <i>are</i> registered in CCIP pools)
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">Destination</td>
                      <td>SpokeVault receives USDC, supplies to Aave on destination</td>
                      <td className="text-success font-semibold">
                        SpokeVault receives CCIP message, supplies USDC to Aave on Arbitrum Sepolia
                      </td>
                    </tr>
                    <tr>
                      <td className="font-semibold">What it proves</td>
                      <td>Full end-to-end capital rotation</td>
                      <td className="text-success font-semibold">
                        Full end-to-end: Aave withdraw + CCIP bridge + Aave supply on destination. Confirmed working
                        with SpokeVault v4.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <b>Why CCIP-BnM?</b> These are Chainlink&apos;s official test tokens with built-in burn-and-mint
                support. They are pre-registered in CCIP token pools on all testnets, making them the only tokens we can
                actually bridge cross-chain in a testnet environment. The CCIP message structure, fee calculation, and
                routing are all identical to a real USDC bridge -- only the token address differs.
              </div>
            </div>
          </details>

          {/* Chain Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-base-200 rounded-lg p-3">
              <div className="font-bold text-sm mb-2">Base Sepolia (Home)</div>
              <div className="text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="opacity-60">StrategyController:</span>
                  {explorerLink(CONTRACTS.StrategyController)}
                </div>
                <div className="flex justify-between">
                  <span className="opacity-60">LINK Balance:</span>
                  <span className={`font-mono ${(linkBalance ?? 0n) > 0n ? "text-success" : "text-error"}`}>
                    {fmtLink(linkBalance)} LINK
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-60">CCIP-BnM Balance:</span>
                  <span className={`font-mono ${(bnmBalance ?? 0n) > 0n ? "text-success" : "text-error"}`}>
                    {fmtLink(bnmBalance)} BnM
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-60">Aave Deployed:</span>
                  <span className="font-mono">{fmtUsdc(aaveBase, dec)} USDC</span>
                </div>
              </div>
            </div>
            <div className="bg-base-200 rounded-lg p-3">
              <div className="font-bold text-sm mb-2">Arbitrum Sepolia (Spoke)</div>
              <div className="text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="opacity-60">SpokeVault:</span>
                  <a
                    href={`${ARB_SEPOLIA_EXPLORER}/address/${CONTRACTS.SpokeVault}`}
                    target="_blank"
                    rel="noreferrer"
                    className="link link-accent font-mono text-xs"
                  >
                    {shortAddr(CONTRACTS.SpokeVault)}
                  </a>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-60">Remote Balance:</span>
                  <span className="font-mono">{fmtUsdc(remoteArb, dec)} USDC</span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-60">In-Flight:</span>
                  <span className="font-mono">{fmtUsdc(inFlight, dec)} USDC</span>
                </div>
              </div>
            </div>
          </div>

          {/* Rotation Pre-flight Checks */}
          <div className="bg-base-200 rounded-lg p-4">
            <div className="font-bold text-sm mb-2">Rotation Pre-Flight Checks</div>
            <div className="space-y-1.5">
              {[
                {
                  label: "Spoke Registered",
                  pass: !!spokeRegistered,
                  detail: spokeRegistered
                    ? shortAddr(String(spokeArb))
                    : "Not registered (requires timelock queue + execute)",
                },
                {
                  label: "LINK for fees",
                  pass: (linkBalance ?? 0n) > 0n,
                  detail: `${fmtLink(linkBalance)} LINK in Controller`,
                },
                {
                  label: "CCIP-BnM for testnet",
                  pass: (bnmBalance ?? 0n) > 0n,
                  detail: `${fmtLink(bnmBalance)} BnM in Controller`,
                },
                {
                  label: "Cooldown elapsed",
                  pass: cooldownOk,
                  detail: cooldownOk ? "Ready" : `${cooldown - (now - lastRot)}s remaining`,
                },
                { label: "Circuit Breaker", pass: !emergencyPaused, detail: emergencyPaused ? "PAUSED" : "OK" },
                {
                  label: `Min Spread (${minSpread} bps)`,
                  pass: Number(rotateYieldBps) >= minSpread,
                  detail: `Input: ${rotateYieldBps} bps`,
                },
                {
                  label: `Max Cost (${maxCost} bps)`,
                  pass: Number(rotateCostBps) <= maxCost,
                  detail: `Input: ${rotateCostBps} bps`,
                },
              ].map(c => (
                <div key={c.label} className="flex items-center gap-2 text-xs">
                  <span className={c.pass ? "text-success" : "text-error"}>{c.pass ? "\u2713" : "\u2717"}</span>
                  <span className="font-medium w-40">{c.label}</span>
                  <span className="font-mono opacity-70">{c.detail}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Rotation Controls */}
          <div className="bg-base-200 rounded-lg p-4">
            <div className="font-bold text-sm mb-2">Cross-Chain Rotation</div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div>
                <label className="label py-0">
                  <span className="label-text text-xs">Amount (USDC)</span>
                </label>
                <input
                  type="number"
                  className="input input-sm input-bordered w-full font-mono"
                  value={rotateAmount}
                  onChange={e => setRotateAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="label py-0">
                  <span className="label-text text-xs">Yield (bps)</span>
                </label>
                <input
                  type="number"
                  className="input input-sm input-bordered w-full font-mono"
                  value={rotateYieldBps}
                  onChange={e => setRotateYieldBps(e.target.value)}
                />
              </div>
              <div>
                <label className="label py-0">
                  <span className="label-text text-xs">Cost (bps)</span>
                </label>
                <input
                  type="number"
                  className="input input-sm input-bordered w-full font-mono"
                  value={rotateCostBps}
                  onChange={e => setRotateCostBps(e.target.value)}
                />
              </div>
            </div>

            {/* Option A: Testnet Rotation (CCIP-BnM) */}
            <div className="border-2 border-success/40 rounded-lg p-3 mb-3 bg-success/5">
              <div className="flex items-center gap-2 mb-2">
                <span className="badge badge-success badge-sm">RECOMMENDED</span>
                <span className="font-bold text-xs text-success">Testnet Rotation (Aave + CCIP-BnM)</span>
              </div>
              <p className="text-xs opacity-70 mb-2">
                <b>Step 1:</b> Withdraws {rotateAmount} USDC from Aave V3 on Base (real Aave interaction, identical to
                mainnet). <b>Step 2:</b> Bridges {bridgeAmount} CCIP-BnM tokens to Arbitrum via CCIP (real cross-chain
                message, identical routing/fees to mainnet -- only the token address differs). This is the closest we
                can get to a full rotation on testnet.
              </p>
              <div className="flex items-center gap-2 mb-2">
                <label className="text-xs opacity-60">BnM amount:</label>
                <input
                  type="number"
                  className="input input-xs input-bordered w-20 font-mono"
                  value={bridgeAmount}
                  onChange={e => setBridgeAmount(e.target.value)}
                />
                <span className="text-xs font-mono opacity-50">Available: {fmtLink(bnmBalance)} BnM</span>
              </div>
              <div className="flex items-center gap-3">
                <button className="btn btn-sm btn-success" onClick={handleCreTestnetRotate}>
                  Testnet Rotate (Aave + CCIP-BnM)
                </button>
                <span className="text-xs opacity-50">
                  via <code>onReport(TESTNET_ROTATE)</code>
                </span>
              </div>
            </div>

            {/* Option B: Production Rotation (USDC) */}
            <div className="border border-base-300 rounded-lg p-3 opacity-70">
              <div className="flex items-center gap-2 mb-2">
                <span className="badge badge-warning badge-sm badge-outline">MAINNET ONLY</span>
                <span className="font-bold text-xs">Production Rotation (USDC via CCIP)</span>
              </div>
              <p className="text-xs opacity-60 mb-2">
                The mainnet flow: withdraw USDC from Aave + bridge the same USDC via CCIP to the destination chain. On
                testnet this <b>will revert</b> at the CCIP router because Aave&apos;s faucet USDC is not registered in
                CCIP token pools. You can click to see the exact revert point in the transaction log.
              </p>
              <div className="flex items-center gap-3">
                <button className="btn btn-sm btn-warning btn-outline" onClick={handleRotation}>
                  Production Rotate (USDC)
                </button>
                <span className="text-xs opacity-50">
                  via <code>initiateCrossChainRotation()</code>
                </span>
              </div>
            </div>
          </div>

          {/* Rotation Flow Diagram */}
          <div className="bg-base-200 rounded-lg p-4">
            <div className="font-bold text-sm mb-2">Rotation Flow (3 CCIP Messages)</div>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="badge badge-sm badge-primary">1</span>
                <span className="font-mono">Base: Aave withdraw</span>
                <span>&#8594;</span>
                <span className="font-mono">CCIP send (USDC + SUPPLY instruction)</span>
                <span>&#8594;</span>
                <span className="font-mono">Arb: SpokeVault supplies to Aave</span>
                <CostBadge label="" usd={`~$${liveCosts.tokenTransfer.toFixed(2)}`} detail="~0.3 LINK" />
              </div>
              <div className="flex items-center gap-2">
                <span className="badge badge-sm badge-secondary">2</span>
                <span className="font-mono">Arb: SpokeVault.reportBalance()</span>
                <span>&#8594;</span>
                <span className="font-mono">CCIP data msg</span>
                <span>&#8594;</span>
                <span className="font-mono">Base: Vault updates remoteBalances</span>
                <CostBadge label="" usd={`~$${liveCosts.dataMsg.toFixed(2)}`} detail="~0.05 LINK" />
              </div>
              <div className="flex items-center gap-2">
                <span className="badge badge-sm badge-accent">3</span>
                <span className="font-mono">Return: WITHDRAW_AND_RETURN instruction</span>
                <span>&#8594;</span>
                <span className="font-mono">Arb withdraws + CCIP sends USDC back</span>
                <CostBadge label="" usd={`~$${liveCosts.tokenTransfer.toFixed(2)}`} detail="~0.3 LINK" />
              </div>
            </div>
            <div className="mt-2 text-xs opacity-50">
              Total rotation cost: ~${liveCosts.fullRotation.toFixed(2)} ({rotationLinkCost} LINK @ $
              {linkPrice.toFixed(2)} + ~${rotationGasCostUsd} gas) -- only executes when yield gain exceeds this.
            </div>
          </div>

          {/* Proven Cross-Chain Tx */}
          <div className="bg-success/10 border border-success/30 rounded-lg p-3">
            <div className="font-bold text-xs text-success mb-1">Confirmed Cross-Chain Rotation (SpokeVault v4)</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className="opacity-60">TESTNET_ROTATE tx (Base Sepolia):</span>
              <a
                href={`${BASE_SEPOLIA_EXPLORER}/tx/0xdcb51a1a8ac906dcd3edf3129c3b048bcc85c3c2b380bdebe5785694373e6ec4`}
                target="_blank"
                rel="noreferrer"
                className="link link-accent font-mono text-xs"
              >
                0xdcb51a1a...
              </a>
              <span className="opacity-60">Result:</span>
              <span className="text-success font-semibold">CCIP delivered, 1 USDC supplied to Aave on Arb Sepolia</span>
              <a
                href={`${CCIP_EXPLORER}/msg/0xdcb51a1a8ac906dcd3edf3129c3b048bcc85c3c2b380bdebe5785694373e6ec4`}
                target="_blank"
                rel="noreferrer"
                className="link link-accent font-mono text-xs"
              >
                CCIP Explorer
              </a>
            </div>
          </div>

          {/* Dynamic Recall Result — exactly 3 tx IDs */}
          {recallData && (
            <CrossChainTxSummary
              title="TESTNET_RECALL"
              variant="info"
              baseTxHash={recallData.homeTxHash}
              ccipMessageId={recallData.ccipMessageId}
            />
          )}

          {/* Dynamic Rotation Result — exactly 3 tx IDs */}
          {rotationData && (
            <CrossChainTxSummary
              title="TESTNET_ROTATE"
              variant="success"
              baseTxHash={rotationData.homeTxHash}
              ccipMessageId={rotationData.ccipMessageId}
            />
          )}

          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              markComplete(6);
              setActiveStep(7);
            }}
          >
            Next: Safety Systems &#8594;
          </button>
        </div>
        <StepTxHistory logs={txLog} step={6} />
      </DemoStep>

      {/* STEP 7: Safety Systems */}
      <DemoStep
        step={7}
        title="Safety Systems"
        subtitle="CircuitBreaker (4-tier) + DeadManSwitch (24h fallback) + slippage gateway"
        active={activeStep === 7}
        completed={completedSteps.has(7)}
        onToggle={() => toggle(7)}
      >
        <div className="space-y-4">
          <p className="text-sm">Multiple safety layers protect user funds:</p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Circuit Breaker */}
            <div className="bg-base-200 rounded-lg p-4">
              <h4 className="font-bold text-sm mb-2">Circuit Breaker</h4>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="opacity-60">Tier:</span>
                  <span className={`font-bold ${tierColors[tierNum]}`}>{tierLabels[tierNum]}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="opacity-60">Emergency:</span>
                  <span className={emergencyPaused ? "text-error font-bold" : "text-success"}>
                    {emergencyPaused ? "PAUSED" : "Normal"}
                  </span>
                </div>
                <p className="text-xs opacity-50 mt-2">
                  Monitors USDC depeg, TVL drops, and share price anomalies. CRITICAL tier blocks all deposits.
                </p>
                <div className="mt-1">
                  <CostBadge
                    label="Pause/Unpause"
                    usd={COSTS.circuitBreakerPause.usd}
                    detail={COSTS.circuitBreakerPause.gas}
                  />
                </div>
                <div className="flex gap-1 mt-2">
                  <button className="btn btn-xs btn-error" onClick={handlePause} disabled={!!emergencyPaused}>
                    Pause
                  </button>
                  <button className="btn btn-xs btn-success" onClick={handleUnpause} disabled={!emergencyPaused}>
                    Unpause
                  </button>
                </div>
              </div>
            </div>

            {/* Dead Man Switch */}
            <div className="bg-base-200 rounded-lg p-4">
              <h4 className="font-bold text-sm mb-2">Dead Man Switch</h4>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="opacity-60">Status:</span>
                  <span className={dmsExpired ? "text-error font-bold" : "text-success"}>
                    {dmsExpired ? "EXPIRED" : `${dmsHours}h ${dmsMins}m left`}
                  </span>
                </div>
                <p className="text-xs opacity-50 mt-2">
                  If the primary keeper (CRE/Chainlink) goes silent for 24h, anyone can trigger a fallback harvest to
                  protect yield.
                </p>
                {dmsExpired && (
                  <p className="text-xs text-warning mt-1">
                    Expected on idle testnet &mdash; keeper heartbeats only run in production.
                  </p>
                )}
                <div className="mt-1">
                  <CostBadge label="Heartbeat" usd={COSTS.heartbeat.usd} detail={COSTS.heartbeat.gas} />
                </div>
                <button className="btn btn-xs btn-primary mt-2" onClick={handleHeartbeat}>
                  Send Heartbeat
                </button>
              </div>
            </div>

            {/* VaultGateway */}
            <div className="bg-base-200 rounded-lg p-4">
              <h4 className="font-bold text-sm mb-2">VaultGateway</h4>
              <div className="space-y-2">
                <p className="text-xs opacity-50">
                  All deposits and withdrawals go through the Gateway which enforces slippage protection. Users set a
                  max tolerance (default 0.5%), and the tx reverts if share price moves beyond it.
                </p>
                <div className="text-xs">
                  <span className="opacity-60">Contract: </span>
                  {explorerLink(CONTRACTS.VaultGateway)}
                </div>
              </div>
            </div>
          </div>

          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              markComplete(7);
              setActiveStep(8);
            }}
          >
            Next: Withdraw &#8594;
          </button>
        </div>
        <StepTxHistory logs={txLog} step={7} />
      </DemoStep>

      {/* STEP 8: Withdraw */}
      <DemoStep
        step={8}
        title="Withdraw &mdash; Get Your USDC Back"
        subtitle="Burn yUSDC shares, receive USDC with accrued yield"
        active={activeStep === 8}
        completed={completedSteps.has(8)}
        onToggle={() => toggle(8)}
      >
        <div className="space-y-4">
          <p className="text-sm">
            Withdraw burns your yUSDC shares and returns USDC. If the share price increased (yield accrued), you get
            back <b>more than you deposited</b>.
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Your Shares</div>
              <div className="stat-value text-lg font-mono">{fmtUsdc(shareBalance, dec)}</div>
            </div>
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Share Price</div>
              <div className="stat-value text-lg font-mono">{sharePrice}</div>
            </div>
            <div className="stat bg-base-200 rounded-lg p-3">
              <div className="stat-title text-xs">Max Withdrawable</div>
              <div className="stat-value text-lg font-mono">{fmtUsdc(maxWithdrawable, dec)} USDC</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="number"
              placeholder="10"
              className="input input-bordered input-sm w-32 font-mono"
              value={withdrawAmount}
              onChange={e => setWithdrawAmount(e.target.value)}
            />
            <span className="text-sm">USDC</span>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => setWithdrawAmount(maxWithdrawable !== undefined ? formatUnits(maxWithdrawable, dec) : "")}
            >
              MAX
            </button>
          </div>

          {parsedWithdraw > 0n && previewWithdrawShares !== undefined && (
            <div className="text-xs opacity-60">Will burn ~{fmtUsdc(previewWithdrawShares, dec)} yUSDC shares</div>
          )}

          <div className="flex gap-2">
            {needsShareApproval ? (
              <button
                className="btn btn-sm btn-warning"
                onClick={handleApproveShares}
                disabled={isApprovePending || isVaultPending}
              >
                {isApprovePending || isVaultPending ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  "1. Approve Shares"
                )}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                onClick={handleWithdraw}
                disabled={isGatewayPending || parsedWithdraw === 0n || parsedWithdraw > (maxWithdrawable ?? 0n)}
              >
                {isGatewayPending ? <span className="loading loading-spinner loading-sm" /> : "2. Withdraw via Gateway"}
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mt-1">
            <CostBadge label="Approve" usd={COSTS.approveErc20.usd} detail={COSTS.approveErc20.gas} />
            <CostBadge label="Withdraw" usd={COSTS.withdrawGateway.usd} detail={COSTS.withdrawGateway.gas} />
          </div>

          {/* Request Redeem (async queue) */}
          {parsedWithdraw > 0n && parsedWithdraw > (maxWithdrawable ?? 0n) && remoteArb > 0n && (
            <div className="mt-2 border-2 border-warning/30 rounded-xl p-4 bg-warning/5">
              <div className="font-bold text-sm mb-1">Exceeds instant liquidity</div>
              <p className="text-xs opacity-70 mb-3">
                Only <b className="font-mono">{fmtUsdc(maxWithdrawable, dec)} USDC</b> is available instantly. Use{" "}
                <b>Request Redeem</b> to queue this withdrawal. The CRE automation will recall{" "}
                <b className="font-mono">{fmtUsdc(parsedWithdraw - (maxWithdrawable ?? 0n), dec)} USDC</b> from Arbitrum
                via CCIP and fulfill your request automatically (~10-20 min).
              </p>
              <button
                className="btn btn-sm btn-warning"
                onClick={handleRequestRedeem}
                disabled={isVaultPending || !previewWithdrawShares}
              >
                {isVaultPending ? <span className="loading loading-spinner loading-sm" /> : "Request Redeem (Queue)"}
              </button>
              <CostBadge label="Queue" usd={COSTS.requestRedeem.usd} detail={COSTS.requestRedeem.gas} />
            </div>
          )}

          {/* Pending Redemption Queue Status */}
          {(pendingRedeemCount ?? 0n) > 0n && (
            <div className="mt-3 border-2 border-accent/30 rounded-xl p-4 bg-accent/5">
              <div className="font-bold text-sm mb-1">Redemption Queue</div>
              <div className="flex gap-4 text-xs">
                <span>
                  Pending: <b className="font-mono">{(pendingRedeemCount ?? 0n).toString()}</b> requests
                </span>
                <span>
                  Total queued: <b className="font-mono">{fmtUsdc(totalPendingAssets ?? 0n, dec)} USDC</b>
                </span>
              </div>
              <p className="text-xs opacity-60 mt-1">
                CRE automation will recall remote funds and fulfill these automatically every 5 min.
              </p>
            </div>
          )}

          {/* Admin: Emergency Recall */}
          {remoteArb > 0n && isAdmin && (
            <details className="mt-4 border border-base-300 rounded-xl">
              <summary className="cursor-pointer p-3 text-xs font-semibold opacity-60">
                Admin: Emergency Recall (manual)
              </summary>
              <div className="p-4 pt-2">
                <p className="text-xs opacity-70 mb-3">
                  Recall <b>all</b> <span className="font-mono">{fmtUsdc(remoteArb, dec)} USDC</span> from Arbitrum
                  SpokeVault. This is an admin-only emergency action. Normal recalls are handled by the CRE automation.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    className="btn btn-sm btn-info"
                    onClick={handleRecallFunds}
                    disabled={isRecalling || !!recallData}
                  >
                    {isRecalling ? (
                      <span className="loading loading-spinner loading-sm" />
                    ) : recallData ? (
                      "Recall in Progress"
                    ) : (
                      "Recall All Remote Funds"
                    )}
                  </button>
                  <CostBadge
                    label="CCIP"
                    usd={`~$${((yieldData?.config?.linkPriceUsd ?? 15) * 0.35).toFixed(2)}`}
                    detail="~0.35 LINK"
                  />
                </div>
                {recallData && <RotationTracker data={recallData} mode="recall" />}
              </div>
            </details>
          )}
        </div>
        <StepTxHistory logs={txLog} step={8} />
      </DemoStep>

      {/* Transaction Log */}
      {txLog.length > 0 && (
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body p-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm">Demo Transaction Log</h3>
              <button className="btn btn-xs btn-ghost" onClick={() => setTxLog([])}>
                Clear
              </button>
            </div>
            <div className="bg-base-200 rounded-lg p-3 max-h-40 overflow-y-auto font-mono text-xs space-y-1">
              {txLog.map((log, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="badge badge-xs badge-primary">Step {log.step}</span>
                  <span className="opacity-80">{log.msg}</span>
                  {log.hash && (
                    <a
                      href={`${log.explorer ?? BASE_SEPOLIA_EXPLORER}/tx/${log.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="link link-accent"
                    >
                      tx
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Cost Breakdown */}
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body p-4">
          <h3 className="font-bold text-sm">Operational Cost Breakdown (Base Mainnet Estimates)</h3>
          <p className="text-xs opacity-50">
            All gas costs assume Base L2 mainnet pricing (~0.01 gwei). LINK price:{" "}
            {yieldData?.config?.linkPriceUsd ? `$${yieldData.config.linkPriceUsd.toFixed(2)} (live)` : "$15 (fallback)"}
            .
          </p>
          <div className="overflow-x-auto mt-2">
            <table className="table table-sm table-zebra">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Type</th>
                  <th>Gas</th>
                  <th>Cost (USD)</th>
                  <th>Frequency</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-semibold">Deposit (user)</td>
                  <td>Approve + Gateway deposit</td>
                  <td className="font-mono">~296k</td>
                  <td className="font-mono">~$0.02</td>
                  <td>Per deposit</td>
                </tr>
                <tr>
                  <td className="font-semibold">Withdraw (user)</td>
                  <td>Approve + Gateway redeem</td>
                  <td className="font-mono">~326k</td>
                  <td className="font-mono">~$0.02</td>
                  <td>Per withdrawal</td>
                </tr>
                <tr>
                  <td className="font-semibold">Supply to Aave</td>
                  <td>Keeper tx (gas)</td>
                  <td className="font-mono">{COSTS.supplyToAave.gas}</td>
                  <td className="font-mono">{COSTS.supplyToAave.usd}</td>
                  <td>After deposits</td>
                </tr>
                <tr>
                  <td className="font-semibold">Harvest Yield</td>
                  <td>Keeper tx (gas)</td>
                  <td className="font-mono">{COSTS.harvestYield.gas}</td>
                  <td className="font-mono">{COSTS.harvestYield.usd}</td>
                  <td>~1-2x / day</td>
                </tr>
                <tr className="bg-warning/10">
                  <td className="font-semibold">CCIP Data Message</td>
                  <td>LINK fee</td>
                  <td className="font-mono">-</td>
                  <td className="font-mono">~${liveCosts.dataMsg.toFixed(2)}</td>
                  <td>Per balance report</td>
                </tr>
                <tr className="bg-warning/10">
                  <td className="font-semibold">CCIP Token Transfer</td>
                  <td>LINK fee</td>
                  <td className="font-mono">-</td>
                  <td className="font-mono">~${liveCosts.tokenTransfer.toFixed(2)}</td>
                  <td>Per bridge tx</td>
                </tr>
                <tr className="bg-warning/10">
                  <td className="font-semibold">CRE Trigger</td>
                  <td>LINK fee</td>
                  <td className="font-mono">-</td>
                  <td className="font-mono">~${liveCosts.creExecution.toFixed(2)}</td>
                  <td>Per action</td>
                </tr>
                <tr className="bg-warning/10 font-bold">
                  <td className="font-semibold">Full Cross-Chain Rotation</td>
                  <td>CCIP + CRE + gas</td>
                  <td className="font-mono">-</td>
                  <td className="font-mono">~${liveCosts.fullRotation.toFixed(2)}</td>
                  <td>Only when profitable</td>
                </tr>
                <tr className="bg-success/10">
                  <td className="font-semibold">CRE Monitoring</td>
                  <td>LINK subscription</td>
                  <td className="font-mono">-</td>
                  <td className="font-mono">~${liveCosts.creMonthlyNoOp.toFixed(0)}/mo</td>
                  <td>288 checks/day</td>
                </tr>
                <tr className="bg-success/10">
                  <td className="font-semibold">CRE Active Ops</td>
                  <td>LINK sub + gas</td>
                  <td className="font-mono">-</td>
                  <td className="font-mono">~${liveCosts.creMonthlyActive.toFixed(0)}/mo</td>
                  <td>With ~2 actions/day</td>
                </tr>
                <tr>
                  <td className="font-semibold">Safety (heartbeat)</td>
                  <td>Gas</td>
                  <td className="font-mono">{COSTS.heartbeat.gas}</td>
                  <td className="font-mono">{COSTS.heartbeat.usd}</td>
                  <td>1x / day</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <div className="bg-base-200 rounded-lg p-3 text-center">
              <div className="text-xs opacity-60">Monthly Fixed Costs</div>
              <div className="text-lg font-bold font-mono">
                ~${liveCosts.monthlyFixed.toFixed(0)}-{liveCosts.monthlyFixedHigh.toFixed(0)}
              </div>
              <div className="text-xs opacity-50">CRE + heartbeat + harvests</div>
            </div>
            <div className="bg-base-200 rounded-lg p-3 text-center">
              <div className="text-xs opacity-60">Per Rotation Cost</div>
              <div className="text-lg font-bold font-mono">~${liveCosts.fullRotation.toFixed(2)}</div>
              <div className="text-xs opacity-50">
                {rotationLinkCost} LINK @ ${linkPrice.toFixed(2)} + ~${rotationGasCostUsd} gas
              </div>
            </div>
            <div className="bg-base-200 rounded-lg p-3 text-center">
              <div className="text-xs opacity-60">Break-Even TVL</div>
              <div className="text-lg font-bold font-mono">
                ~$
                {!isFinite(liveCosts.breakEvenTvl)
                  ? "N/A"
                  : liveCosts.breakEvenTvl >= 1000
                    ? `${(liveCosts.breakEvenTvl / 1000).toFixed(0)}k`
                    : liveCosts.breakEvenTvl.toFixed(0)}
              </div>
              <div className="text-xs opacity-50">At {yieldData?.config?.minSpreadBps ?? 25} bps yield spread</div>
            </div>
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body p-4">
          <h3 className="font-bold text-sm">System Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
            <div className="text-center">
              <div className="text-2xl font-bold">10</div>
              <div className="text-xs opacity-60">Contracts Deployed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">2</div>
              <div className="text-xs opacity-60">Chains (Base + Arb)</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">339</div>
              <div className="text-xs opacity-60">Tests Passing</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold font-mono">${fmtUsdc(total, dec)}</div>
              <div className="text-xs opacity-60">Total Value Locked</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
