"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, decodeAbiParameters, http } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

// ── Config ────────────────────────────────────────────────────────
const BASE_SEPOLIA_RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "";
const ARB_SEPOLIA_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";
const ARB_SEPOLIA_EXPLORER = "https://sepolia.arbiscan.io";
const CCIP_EXPLORER = "https://ccip.chain.link";

const SPOKE_VAULT_ARB = "0x99f90636e87646113480F4cfC631f02E0EE4cC22" as const;
const STRATEGY_CONTROLLER_BASE = "0x93e37393D12FB6874190b7E38D7AdE096ceBEF90" as const;

const POLL_INTERVAL_MS = 15_000;
const ARB_LOOKBACK_BLOCKS = 5000n;
const BASE_LOOKBACK_BLOCKS = 600n;

// Topic hash for BalanceReported(uint256,bytes32) — raw receipt log matching
const BALANCE_REPORTED_TOPIC = "0x190b55d26e1a06db3510ee77f94029a81023ec0b825b802830814eaa74a7e5d1" as const;

// ABI event definitions for typed getLogs
const supplyExecutedEvent = {
  type: "event",
  name: "SupplyExecuted",
  inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

const withdrawAndReturnEvent = {
  type: "event",
  name: "WithdrawAndReturnExecuted",
  inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "messageId", type: "bytes32", indexed: false },
  ],
} as const;

const balanceReportReceivedEvent = {
  type: "event",
  name: "BalanceReportReceived",
  inputs: [
    { name: "sourceChain", type: "uint64", indexed: true },
    { name: "balance", type: "uint256", indexed: false },
  ],
} as const;

// ── Types ─────────────────────────────────────────────────────────
export type RotationData = {
  homeTxHash: string;
  ccipMessageId: string;
};

export type TrackerMode = "rotation" | "recall";

type Phase = {
  label: string;
  chain: string;
  status: "complete" | "pending" | "waiting";
  txHash?: string;
  explorer: string;
  url?: string;
  detail?: string;
  badge: string;
};

// ── Clients (created once) ────────────────────────────────────────
const arbClient = createPublicClient({ chain: arbitrumSepolia, transport: http(ARB_SEPOLIA_RPC) });
const baseClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });

const ARB_CHAIN_SELECTOR = 3478487238524512106n;

// ── Component ─────────────────────────────────────────────────────
export const RotationTracker = ({ data, mode = "rotation" }: { data: RotationData; mode?: TrackerMode }) => {
  const [destTxHash, setDestTxHash] = useState<string | null>(null);
  const [destDetail, setDestDetail] = useState<string | null>(null);
  const [returnCcipMessageId, setReturnCcipMessageId] = useState<string | null>(null);
  const [balanceReportTxHash, setBalanceReportTxHash] = useState<string | null>(null);
  const [balanceReportDetail, setBalanceReportDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startBlocksRef = useRef<{ arb: bigint; base: bigint } | null>(null);
  const isRecall = mode === "recall";
  const allDone = !!destTxHash && !!balanceReportTxHash;

  useEffect(() => {
    (async () => {
      try {
        const [arbBlock, baseBlock] = await Promise.all([arbClient.getBlockNumber(), baseClient.getBlockNumber()]);
        startBlocksRef.current = {
          arb: arbBlock > ARB_LOOKBACK_BLOCKS ? arbBlock - ARB_LOOKBACK_BLOCKS : 0n,
          base: baseBlock > BASE_LOOKBACK_BLOCKS ? baseBlock - BASE_LOOKBACK_BLOCKS : 0n,
        };
      } catch {
        setError("Failed to fetch block numbers for polling");
      }
    })();
  }, []);

  // Poll Arb Sepolia for SpokeVault events
  const pollDestination = useCallback(async () => {
    if (destTxHash || !startBlocksRef.current) return;
    try {
      if (isRecall) {
        // Recall mode: look for WithdrawAndReturnExecuted
        const logs = await arbClient.getLogs({
          address: SPOKE_VAULT_ARB,
          event: withdrawAndReturnEvent,
          fromBlock: startBlocksRef.current.arb,
          toBlock: "latest",
        });
        if (logs.length === 0) return;

        const log = logs[logs.length - 1];
        setDestTxHash(log.transactionHash);

        const amountUsdc = Number(log.args.amount ?? 0n) / 1e6;
        setDestDetail(`Withdrew ${amountUsdc.toLocaleString()} USDC from Aave + bridging back`);

        // WithdrawAndReturnExecuted has messageId as the 3rd non-indexed param
        if (log.args.messageId) {
          setReturnCcipMessageId(log.args.messageId);
        }
      } else {
        // Rotation mode: look for SupplyExecuted
        const logs = await arbClient.getLogs({
          address: SPOKE_VAULT_ARB,
          event: supplyExecutedEvent,
          fromBlock: startBlocksRef.current.arb,
          toBlock: "latest",
        });
        if (logs.length === 0) return;

        const log = logs[logs.length - 1];
        setDestTxHash(log.transactionHash);

        const amountUsdc = Number(log.args.amount ?? 0n) / 1e6;
        setDestDetail(`Supplied ${amountUsdc.toLocaleString()} USDC to Aave`);

        // Get BalanceReported from same tx for return CCIP messageId
        const receipt = await arbClient.getTransactionReceipt({ hash: log.transactionHash });
        const brLog = receipt.logs.find(l => l.topics[0] === BALANCE_REPORTED_TOPIC);
        if (brLog) {
          try {
            const [, messageId] = decodeAbiParameters(
              [
                { name: "balance", type: "uint256" },
                { name: "messageId", type: "bytes32" },
              ],
              brLog.data,
            );
            setReturnCcipMessageId(messageId);
          } catch {
            // Non-critical
          }
        }
      }
    } catch {
      // Transient RPC error — will retry on next poll
    }
  }, [destTxHash, isRecall]);

  // Poll Base Sepolia for BalanceReportReceived from StrategyController
  const pollBalanceReport = useCallback(async () => {
    if (balanceReportTxHash || !startBlocksRef.current) return;
    try {
      const logs = await baseClient.getLogs({
        address: STRATEGY_CONTROLLER_BASE,
        event: balanceReportReceivedEvent,
        args: { sourceChain: ARB_CHAIN_SELECTOR },
        fromBlock: startBlocksRef.current.base,
        toBlock: "latest",
      });
      if (logs.length === 0) return;

      const reportLog = logs[logs.length - 1];
      setBalanceReportTxHash(reportLog.transactionHash);

      const balUsdc = Number(reportLog.args.balance ?? 0n) / 1e6;
      if (isRecall) {
        setBalanceReportDetail(`Funds received! Remaining remote: ${balUsdc.toLocaleString()} USDC`);
      } else {
        setBalanceReportDetail(`Remote balance: ${balUsdc.toLocaleString()} USDC, in-flight cleared`);
      }
    } catch {
      // Transient RPC error — will retry
    }
  }, [balanceReportTxHash, isRecall]);

  useEffect(() => {
    if (allDone) return;

    const poll = () => {
      if (!startBlocksRef.current) return;
      pollDestination();
      pollBalanceReport();
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [allDone, pollDestination, pollBalanceReport]);

  // ── Build phases ────────────────────────────────────────────────
  const homeDetail = isRecall
    ? "Sent recall instruction to SpokeVault via CCIP"
    : "Withdrew USDC from Aave + sent CCIP message";
  const ccipOutDetail = isRecall ? "Recall instruction to Arbitrum Sepolia" : "Token transfer to Arbitrum Sepolia";
  const destLabel = isRecall ? "SpokeVault Withdrawal" : "Destination Chain Execution";
  const destDefaultDetail = isRecall
    ? "SpokeVault withdraws from Aave + bridges USDC back"
    : "SpokeVault supplies to Aave + sends balance report";
  const returnLabel = isRecall ? "CCIP Return (USDC + Balance Report)" : "CCIP Return (Balance Report)";
  const returnDetail = isRecall
    ? "USDC tokens + balance report to Base Sepolia"
    : "Balance report sent back to Base Sepolia";
  const finalDetail = isRecall
    ? (balanceReportDetail ?? "USDC received in vault, ready for withdrawal")
    : (balanceReportDetail ?? "In-flight cleared, remote balance updated");

  const phases: Phase[] = [
    {
      label: "Home Chain Transaction",
      chain: "Base Sepolia",
      status: "complete",
      txHash: data.homeTxHash,
      explorer: BASE_SEPOLIA_EXPLORER,
      detail: homeDetail,
      badge: "TX",
    },
    {
      label: "CCIP Outbound",
      chain: "CCIP Network",
      status: "complete",
      explorer: CCIP_EXPLORER,
      url: `${CCIP_EXPLORER}/msg/${data.ccipMessageId}`,
      detail: ccipOutDetail,
      badge: "CCIP",
    },
    {
      label: destLabel,
      chain: "Arb Sepolia",
      status: destTxHash ? "complete" : "pending",
      txHash: destTxHash ?? undefined,
      explorer: ARB_SEPOLIA_EXPLORER,
      detail: destDetail ?? destDefaultDetail,
      badge: "TX",
    },
    ...(returnCcipMessageId
      ? [
          {
            label: returnLabel,
            chain: "CCIP Network",
            status: "complete" as const,
            explorer: CCIP_EXPLORER,
            url: `${CCIP_EXPLORER}/msg/${returnCcipMessageId}`,
            detail: returnDetail,
            badge: "CCIP",
          },
        ]
      : destTxHash
        ? [
            {
              label: returnLabel,
              chain: "CCIP Network",
              status: "pending" as const,
              explorer: CCIP_EXPLORER,
              detail: `${isRecall ? "USDC + balance report" : "Balance report"} in-flight to Base Sepolia`,
              badge: "CCIP",
            },
          ]
        : []),
    {
      label: isRecall ? "Funds Received" : "Balance Report Delivery",
      chain: "Base Sepolia",
      status: balanceReportTxHash ? "complete" : destTxHash ? "pending" : "waiting",
      txHash: balanceReportTxHash ?? undefined,
      explorer: BASE_SEPOLIA_EXPLORER,
      detail: finalDetail,
      badge: "TX",
    },
  ];

  if (error) {
    return <div className="alert alert-warning text-xs mt-3">{error}</div>;
  }

  const title = isRecall ? "Cross-Chain Recall Tracker" : "Cross-Chain Rotation Tracker";

  return (
    <div className="mt-4 bg-base-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-bold text-sm">{title}</span>
        {!allDone && <span className="loading loading-dots loading-xs text-primary" />}
        {allDone && <span className="badge badge-success badge-sm">Complete</span>}
      </div>

      <div className="space-y-2">
        {phases.map((phase, i) => (
          <div key={phase.label} className="flex items-start gap-3">
            <div className="flex flex-col items-center mt-1">
              {phase.status === "complete" ? (
                <span className="text-success text-lg">&#10003;</span>
              ) : phase.status === "pending" ? (
                <span className="loading loading-spinner loading-xs text-primary" />
              ) : (
                <span className="text-base-content/30 text-lg">&#9675;</span>
              )}
              {i < phases.length - 1 && (
                <div className={`w-0.5 h-6 ${phase.status === "complete" ? "bg-success/40" : "bg-base-content/10"}`} />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-xs">{phase.label}</span>
                <span className="badge badge-xs badge-outline">{phase.chain}</span>
              </div>
              <div className="text-xs opacity-60 mt-0.5">{phase.detail}</div>
              {phase.status === "complete" && (phase.txHash || phase.url) && (
                <div className="mt-1">
                  <a
                    href={phase.url ?? `${phase.explorer}/tx/${phase.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs link link-accent font-mono"
                  >
                    <span className={`badge badge-xs ${phase.badge === "CCIP" ? "badge-info" : "badge-success"}`}>
                      {phase.badge}
                    </span>
                    {phase.txHash
                      ? `${phase.txHash.slice(0, 10)}...${phase.txHash.slice(-6)}`
                      : "View on CCIP Explorer"}
                  </a>
                </div>
              )}
              {phase.status === "pending" && !phase.txHash && !phase.url && (
                <div className="text-xs text-primary mt-0.5">Polling every 15s...</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {allDone && isRecall && (
        <div className="mt-3 text-xs text-success font-semibold">
          Funds have been recalled to the vault. You can now withdraw the full amount.
        </div>
      )}
    </div>
  );
};
