/**
 * CRE Yield Check Workflow
 *
 * Periodically fetches yield data from all chains, runs the rotation decision
 * engine, and triggers cross-chain rotations via the StrategyController when
 * a profitable rotation is found.
 *
 * In production, this runs as a Chainlink CRE workflow on the DON.
 * For testnet/development, it runs as a standalone Node.js script.
 */

import {
  type PublicClient,
  type WalletClient,
  type Address,
  formatUnits,
} from "viem";
import type { RotationCandidate, RotationConfig } from "@yield-optimizer/shared";
import { DEFAULT_ROTATION_CONFIG } from "@yield-optimizer/shared";
import { strategyControllerAbi, yieldVaultAbi } from "../abis.js";

export interface YieldCheckConfig {
  /** Home chain public client (for reading vault state) */
  publicClient: PublicClient;
  /** Wallet client with KEEPER_ROLE for executing rotations */
  walletClient: WalletClient;
  /** StrategyController address on home chain */
  strategyController: Address;
  /** YieldVault address on home chain */
  yieldVault: Address;
  /** Asset token address (e.g., USDC) */
  asset: Address;
  /** Rotation configuration thresholds */
  rotationConfig?: RotationConfig;
  /** Mapping of chainId → CCIP chain selector */
  chainSelectorMap: Record<number, bigint>;
}

export interface WorkflowResult {
  timestamp: number;
  rotationsEvaluated: number;
  rotationExecuted: boolean;
  executedRotation?: {
    destChainSelector: bigint;
    amount: bigint;
    yieldBps: bigint;
    costBps: bigint;
    txHash: string;
  };
  error?: string;
}

/**
 * Run a single yield check cycle.
 *
 * 1. Fetch current yield data from the monitor engine
 * 2. Evaluate rotation candidates
 * 3. Validate against on-chain constraints (StrategyController.validateRotation)
 * 4. Execute the best rotation if profitable
 */
export async function runYieldCheck(
  config: YieldCheckConfig,
  candidates: RotationCandidate[],
): Promise<WorkflowResult> {
  const {
    publicClient,
    walletClient,
    strategyController,
    yieldVault,
    asset,
    chainSelectorMap,
  } = config;

  const result: WorkflowResult = {
    timestamp: Date.now(),
    rotationsEvaluated: candidates.length,
    rotationExecuted: false,
  };

  // Filter to recommended candidates
  const recommended = candidates.filter((c) => c.recommended);
  if (recommended.length === 0) {
    return result;
  }

  // Sort by net annualized benefit (highest first)
  recommended.sort((a, b) => b.netBenefitAnnualized - a.netBenefitAnnualized);

  // Read vault state
  const totalAssets = await publicClient.readContract({
    address: yieldVault,
    abi: yieldVaultAbi,
    functionName: "totalAssets",
  });

  if (totalAssets === 0n) {
    return result;
  }

  // Try each candidate until one passes on-chain validation
  for (const candidate of recommended) {
    const destSelector = chainSelectorMap[candidate.to.chainId];
    if (!destSelector) continue;

    // Calculate rotation amount (percentage of total assets)
    const rotationConfig = config.rotationConfig ?? DEFAULT_ROTATION_CONFIG;
    const maxAmount =
      (totalAssets * BigInt(rotationConfig.maxRotationPct)) / 100n;
    const amount = maxAmount < totalAssets ? maxAmount : totalAssets;

    // Convert yield spread and cost to basis points
    const yieldBps = BigInt(
      Math.round(candidate.yieldImprovement * 10_000),
    );
    const costBps = BigInt(
      Math.round((candidate.estimatedCost / Number(formatUnits(amount, 6))) * 10_000),
    );

    // Validate on-chain
    const isValid = await publicClient.readContract({
      address: strategyController,
      abi: strategyControllerAbi,
      functionName: "validateRotation",
      args: [destSelector, amount, yieldBps, costBps],
    });

    if (!isValid) continue;

    // Execute the rotation
    const account = walletClient.account;
    if (!account) {
      result.error = "No account configured on wallet client";
      return result;
    }

    const txHash = await walletClient.writeContract({
      address: strategyController,
      abi: strategyControllerAbi,
      functionName: "initiateCrossChainRotation",
      args: [destSelector, asset, amount, yieldBps, costBps],
      account,
      chain: walletClient.chain,
    });

    result.rotationExecuted = true;
    result.executedRotation = {
      destChainSelector: destSelector,
      amount,
      yieldBps,
      costBps,
      txHash,
    };

    return result;
  }

  return result;
}

/**
 * Start the yield check workflow loop.
 * Runs the check at the configured interval.
 */
export function startYieldCheckLoop(
  config: YieldCheckConfig,
  fetchCandidates: () => Promise<RotationCandidate[]>,
  intervalMs?: number,
): { stop: () => void } {
  const interval = intervalMs ?? config.rotationConfig?.checkIntervalMs ?? DEFAULT_ROTATION_CONFIG.checkIntervalMs;
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const candidates = await fetchCandidates();
        const result = await runYieldCheck(config, candidates);

        if (result.rotationExecuted && result.executedRotation) {
          console.log(
            `[YieldCheck] Rotation executed: chain=${result.executedRotation.destChainSelector}, ` +
              `amount=${result.executedRotation.amount}, tx=${result.executedRotation.txHash}`,
          );
        } else {
          console.log(
            `[YieldCheck] No profitable rotation found (${result.rotationsEvaluated} evaluated)`,
          );
        }
      } catch (err) {
        console.error("[YieldCheck] Error:", err);
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}
