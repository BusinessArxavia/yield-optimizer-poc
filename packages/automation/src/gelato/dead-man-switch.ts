/**
 * Gelato Dead Man Switch — Web3 Function
 *
 * Monitors the last Chainlink Automation execution timestamp.
 * If no action for `timeout` seconds AND the vault has actionable state
 * (idle assets to supply or yield to harvest), triggers fallback execution.
 *
 * Designed to run as a Gelato Web3 Function that polls periodically.
 */

import {
  type PublicClient,
  type WalletClient,
  type Address,
} from "viem";
import { deadManSwitchAbi, yieldKeeperAbi, yieldVaultAbi } from "../abis.js";

export interface DeadManSwitchConfig {
  publicClient: PublicClient;
  walletClient: WalletClient;
  deadManSwitch: Address;
  yieldKeeper: Address;
  yieldVault: Address;
  strategyController: Address;
  asset: Address;
}

export interface SwitchStatus {
  isExpired: boolean;
  timeRemaining: bigint;
  upkeepNeeded: boolean;
}

/**
 * Check the current status of the dead man switch.
 */
export async function checkSwitchStatus(
  config: DeadManSwitchConfig,
): Promise<SwitchStatus> {
  const { publicClient, deadManSwitch, yieldKeeper } = config;

  const [isExpired, timeRemaining] = await Promise.all([
    publicClient.readContract({
      address: deadManSwitch,
      abi: deadManSwitchAbi,
      functionName: "isExpired",
    }),
    publicClient.readContract({
      address: deadManSwitch,
      abi: deadManSwitchAbi,
      functionName: "timeRemaining",
    }),
  ]);

  // Check if the keeper would have work to do
  const [upkeepNeeded] = await publicClient.readContract({
    address: yieldKeeper,
    abi: yieldKeeperAbi,
    functionName: "checkUpkeep",
    args: ["0x"],
  });

  return { isExpired, timeRemaining, upkeepNeeded };
}

/**
 * Send a heartbeat to the dead man switch to reset the timer.
 * Should be called by the primary keeper after each successful action.
 */
export async function sendHeartbeat(
  config: DeadManSwitchConfig,
): Promise<`0x${string}`> {
  const { walletClient, deadManSwitch } = config;

  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: deadManSwitch,
    abi: deadManSwitchAbi,
    functionName: "heartbeat",
    account,
    chain: walletClient.chain,
  });
}

/**
 * Execute the fallback action if the switch has expired.
 * Tries harvest first, then supply if idle assets are available.
 */
export async function executeFallback(
  config: DeadManSwitchConfig,
): Promise<{ action: string; txHash: `0x${string}` } | null> {
  const { publicClient, walletClient, deadManSwitch, yieldVault, asset } =
    config;

  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  // Check if expired
  const isExpired = await publicClient.readContract({
    address: deadManSwitch,
    abi: deadManSwitchAbi,
    functionName: "isExpired",
  });

  if (!isExpired) return null;

  // Try harvest first
  try {
    const txHash = await walletClient.writeContract({
      address: deadManSwitch,
      abi: deadManSwitchAbi,
      functionName: "triggerFallbackHarvest",
      account,
      chain: walletClient.chain,
    });
    return { action: "harvest", txHash };
  } catch {
    // Harvest may fail if no yield — try supply instead
  }

  // Check for idle assets to supply
  const totalAssets = await publicClient.readContract({
    address: yieldVault,
    abi: yieldVaultAbi,
    functionName: "totalAssets",
  });

  if (totalAssets > 0n) {
    // Supply a conservative amount (50% of idle)
    const homeAssets = await publicClient.readContract({
      address: yieldVault,
      abi: yieldVaultAbi,
      functionName: "homeChainAssets",
    });

    // Only supply if there's significant idle
    const supplyAmount = homeAssets / 2n;
    if (supplyAmount > 0n) {
      try {
        const txHash = await walletClient.writeContract({
          address: deadManSwitch,
          abi: deadManSwitchAbi,
          functionName: "triggerFallbackSupply",
          args: [asset, supplyAmount],
          account,
          chain: walletClient.chain,
        });
        return { action: "supply", txHash };
      } catch {
        // Supply may fail if circuit breaker is active
      }
    }
  }

  return null;
}

/**
 * Run the dead man switch check loop.
 * Designed to be called by a Gelato Web3 Function or standalone cron.
 */
export function startDeadManSwitchLoop(
  config: DeadManSwitchConfig,
  intervalMs = 60_000,
): { stop: () => void } {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const status = await checkSwitchStatus(config);

        if (status.isExpired && status.upkeepNeeded) {
          console.log("[DeadManSwitch] Keeper offline and work needed — triggering fallback");
          const result = await executeFallback(config);
          if (result) {
            console.log(
              `[DeadManSwitch] Fallback ${result.action} executed: ${result.txHash}`,
            );
          }
        } else if (status.isExpired) {
          console.log("[DeadManSwitch] Keeper offline but no work needed");
        } else {
          const remaining = Number(status.timeRemaining) / 3600;
          console.log(
            `[DeadManSwitch] Keeper alive (${remaining.toFixed(1)}h remaining)`,
          );
        }
      } catch (err) {
        console.error("[DeadManSwitch] Error:", err);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}
