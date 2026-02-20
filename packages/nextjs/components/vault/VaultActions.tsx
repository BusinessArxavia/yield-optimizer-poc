"use client";

import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";
import { formatUSDC } from "~~/utils/vault/format";

const DEFAULT_SLIPPAGE_BPS = 50n; // 0.5%

export const VaultActions = () => {
  const { address } = useAccount();
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw" | "request">("deposit");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState("50");

  const { data: vaultContract } = useDeployedContractInfo({ contractName: "YieldVault" });
  const vaultAddress = vaultContract?.address;

  const { data: gatewayContract } = useDeployedContractInfo({ contractName: "VaultGateway" });
  const gatewayAddress = gatewayContract?.address;

  const { data: decimals } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "decimals",
  });

  const { data: usdcBalance } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "balanceOf",
    args: [address],
  });

  // Allowance for Gateway (deposits go through gateway now)
  const { data: usdcAllowanceGateway } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "allowance",
    args: [address, gatewayAddress],
  });

  const { data: shareBalance } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "balanceOf",
    args: [address],
  });

  // Share allowance for Gateway (redeem goes through gateway)
  const { data: shareAllowanceGateway } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "allowance",
    args: [address, gatewayAddress],
  });

  const { data: maxWithdrawable } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "maxWithdraw",
    args: [address],
  });

  const { data: maxRedeemable } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "maxRedeem",
    args: [address],
  });

  const dec = decimals ?? 6;

  const parsedAmount = (() => {
    if (!amount) return 0n;
    try {
      return parseUnits(amount, dec);
    } catch {
      return 0n;
    }
  })();

  // Parse slippage
  const slippage = (() => {
    try {
      const val = BigInt(slippageBps);
      return val > 0n && val <= 10000n ? val : DEFAULT_SLIPPAGE_BPS;
    } catch {
      return DEFAULT_SLIPPAGE_BPS;
    }
  })();

  const { data: previewDepositResult } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "previewDeposit",
    args: [parsedAmount],
  });

  // Preview with slippage from Gateway
  const { data: previewDepositSlippage } = useScaffoldReadContract({
    contractName: "VaultGateway",
    functionName: "previewDepositWithSlippage",
    args: [vaultAddress, parsedAmount, slippage],
  });

  const { data: previewWithdrawResult } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "previewWithdraw",
    args: [parsedAmount],
  });

  // For request redeem: convert shares to expected assets
  const { data: convertToAssets } = useScaffoldReadContract({
    contractName: "YieldVault",
    functionName: "convertToAssets",
    args: [parsedAmount],
  });

  const { data: isCircuitBreakerActive } = useScaffoldReadContract({
    contractName: "CircuitBreaker",
    functionName: "isCritical",
  });

  const { writeContractAsync: writeUSDC, isPending: isApprovePending } = useScaffoldWriteContract({
    contractName: "USDC",
  });

  const { writeContractAsync: writeVault, isPending: isVaultPending } = useScaffoldWriteContract({
    contractName: "YieldVault",
  });

  const { writeContractAsync: writeGateway, isPending: isGatewayPending } = useScaffoldWriteContract({
    contractName: "VaultGateway",
  });

  const isPending = isVaultPending || isGatewayPending;

  // Deposit: approve gateway, not vault directly
  const needsApproval = activeTab === "deposit" && parsedAmount > 0n && (usdcAllowanceGateway ?? 0n) < parsedAmount;

  // Redeem via gateway: approve gateway to spend shares
  const needsShareApproval =
    activeTab === "withdraw" &&
    parsedAmount > 0n &&
    previewWithdrawResult !== undefined &&
    (shareAllowanceGateway ?? 0n) < previewWithdrawResult;
  const withdrawPreviewLoading = activeTab === "withdraw" && parsedAmount > 0n && previewWithdrawResult === undefined;

  const fmt = (val: bigint | undefined) => formatUSDC(val, dec);

  const handleApproveUSDC = async () => {
    if (!gatewayAddress) return;
    try {
      await writeUSDC({
        functionName: "approve",
        args: [gatewayAddress, parsedAmount],
      });
      notification.success("USDC approval successful!");
    } catch (e) {
      notification.error("Approval failed: " + (e as Error).message);
    }
  };

  const handleApproveShares = async () => {
    if (!gatewayAddress || !previewWithdrawResult) return;
    try {
      await writeVault({
        functionName: "approve",
        args: [gatewayAddress, previewWithdrawResult],
      });
      notification.success("Share approval successful!");
    } catch (e) {
      notification.error("Share approval failed: " + (e as Error).message);
    }
  };

  const handleDeposit = async () => {
    if (!address || !vaultAddress) return;
    const minShares = previewDepositSlippage ? previewDepositSlippage[1] : 0n;
    try {
      await writeGateway({
        functionName: "deposit",
        args: [vaultAddress, parsedAmount, address, minShares],
      });
      setAmount("");
      notification.success("Deposit successful!");
    } catch (e) {
      notification.error("Deposit failed: " + (e as Error).message);
    }
  };

  const handleWithdraw = async () => {
    if (!address || !vaultAddress) return;
    // Withdraw via gateway with slippage protection
    const sharesToBurn = previewWithdrawResult ?? 0n;
    // minAssetsOut = amount * (1 - slippage)
    const minAssets = (parsedAmount * (10000n - slippage)) / 10000n;
    try {
      await writeGateway({
        functionName: "redeem",
        args: [vaultAddress, sharesToBurn, address, minAssets],
      });
      setAmount("");
      notification.success("Withdrawal successful!");
    } catch (e) {
      notification.error("Withdrawal failed: " + (e as Error).message);
    }
  };

  const handleRequestRedeem = async () => {
    if (!address) return;
    // parsedAmount = shares to redeem
    // minAssetsOut based on current conversion with slippage tolerance
    const expectedAssets = convertToAssets ?? 0n;
    const minAssets = (expectedAssets * (10000n - slippage)) / 10000n;
    try {
      await writeVault({
        functionName: "requestRedeem",
        args: [parsedAmount, address, minAssets],
      });
      setAmount("");
      notification.success("Redeem request queued successfully!");
    } catch (e) {
      notification.error("Redeem request failed: " + (e as Error).message);
    }
  };

  const handleMaxClick = () => {
    if (activeTab === "deposit" && usdcBalance !== undefined) {
      setAmount(formatUnits(usdcBalance, dec));
    } else if (activeTab === "withdraw" && maxWithdrawable !== undefined) {
      setAmount(formatUnits(maxWithdrawable, dec));
    } else if (activeTab === "request" && maxRedeemable !== undefined) {
      setAmount(formatUnits(maxRedeemable, dec));
    }
  };

  if (!address) {
    return (
      <div className="card bg-base-100 shadow-xl">
        <div className="card-body items-center text-center">
          <h2 className="card-title">Deposit / Withdraw</h2>
          <p className="opacity-60">Connect your wallet to interact with the vault</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Deposit / Withdraw</h2>

        {/* Tabs */}
        <div role="tablist" className="tabs tabs-boxed mt-2">
          <button
            role="tab"
            className={`tab ${activeTab === "deposit" ? "tab-active" : ""}`}
            onClick={() => {
              setActiveTab("deposit");
              setAmount("");
            }}
          >
            Deposit
          </button>
          <button
            role="tab"
            className={`tab ${activeTab === "withdraw" ? "tab-active" : ""}`}
            onClick={() => {
              setActiveTab("withdraw");
              setAmount("");
            }}
          >
            Withdraw
          </button>
          <button
            role="tab"
            className={`tab ${activeTab === "request" ? "tab-active" : ""}`}
            onClick={() => {
              setActiveTab("request");
              setAmount("");
            }}
          >
            Request Redeem
          </button>
        </div>

        {/* Deposit blocked warning */}
        {activeTab === "deposit" && isCircuitBreakerActive && (
          <div className="alert alert-error mt-3">
            <span>Deposits are blocked - Circuit Breaker is in CRITICAL state</span>
          </div>
        )}

        {/* Request redeem info */}
        {activeTab === "request" && (
          <div className="alert alert-info mt-3 text-sm">
            <span>
              Use Request Redeem when instant withdrawal exceeds available liquidity. Your shares are queued and
              fulfilled when funds are available.
            </span>
          </div>
        )}

        {/* Balance display */}
        <div className="flex justify-between text-sm mt-3">
          <span className="opacity-60">
            {activeTab === "deposit"
              ? "Wallet USDC"
              : activeTab === "withdraw"
                ? "Max Withdrawable"
                : "Redeemable Shares"}
          </span>
          <span className="font-mono">
            {activeTab === "deposit"
              ? fmt(usdcBalance)
              : activeTab === "withdraw"
                ? fmt(maxWithdrawable)
                : fmt(maxRedeemable)}
          </span>
        </div>

        {/* Slippage setting */}
        <div className="flex items-center justify-between text-sm mt-1">
          <span className="opacity-60">Slippage Tolerance</span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              className="input input-bordered input-xs w-16 font-mono text-right"
              value={slippageBps}
              onChange={e => setSlippageBps(e.target.value)}
              min="1"
              max="1000"
            />
            <span className="text-xs opacity-60">bps</span>
          </div>
        </div>

        {/* Amount input */}
        <div className="form-control mt-1">
          <label className="input-group">
            <input
              type="number"
              placeholder={activeTab === "request" ? "Shares" : "0.00"}
              className="input input-bordered w-full font-mono"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              min="0"
              step="any"
            />
            <button className="btn btn-ghost btn-sm" onClick={handleMaxClick}>
              MAX
            </button>
          </label>
        </div>

        {/* Preview */}
        {parsedAmount > 0n && (
          <div className="text-sm opacity-60 mt-1">
            {activeTab === "deposit" ? (
              <div>
                <span>Expected: ~{fmt(previewDepositResult)} yUSDC</span>
                {previewDepositSlippage && (
                  <span className="block text-xs">Min: {fmt(previewDepositSlippage[1])} yUSDC (with slippage)</span>
                )}
              </div>
            ) : activeTab === "withdraw" ? (
              <span>You will burn ~{fmt(previewWithdrawResult)} yUSDC shares</span>
            ) : (
              <div>
                <span>
                  Expected: ~{fmt(convertToAssets)} USDC for {fmt(parsedAmount)} shares
                </span>
                <span className="block text-xs">
                  Min: {fmt(((convertToAssets ?? 0n) * (10000n - slippage)) / 10000n)} USDC (with slippage)
                </span>
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-4">
          {activeTab === "deposit" ? (
            needsApproval ? (
              <button
                className="btn btn-primary w-full"
                onClick={handleApproveUSDC}
                disabled={isApprovePending || parsedAmount === 0n}
              >
                {isApprovePending ? <span className="loading loading-spinner" /> : "Approve USDC"}
              </button>
            ) : (
              <button
                className="btn btn-primary w-full"
                onClick={handleDeposit}
                disabled={
                  isPending ||
                  parsedAmount === 0n ||
                  parsedAmount > (usdcBalance ?? 0n) ||
                  isCircuitBreakerActive === true
                }
              >
                {isPending ? <span className="loading loading-spinner" /> : "Deposit via Gateway"}
              </button>
            )
          ) : activeTab === "withdraw" ? (
            withdrawPreviewLoading ? (
              <button className="btn btn-primary w-full" disabled>
                <span className="loading loading-spinner" />
              </button>
            ) : needsShareApproval ? (
              <button
                className="btn btn-primary w-full"
                onClick={handleApproveShares}
                disabled={isApprovePending || isPending || parsedAmount === 0n}
              >
                {isApprovePending || isPending ? <span className="loading loading-spinner" /> : "Approve Shares"}
              </button>
            ) : (
              <button
                className="btn btn-primary w-full"
                onClick={handleWithdraw}
                disabled={isPending || parsedAmount === 0n || parsedAmount > (maxWithdrawable ?? 0n)}
              >
                {isPending ? <span className="loading loading-spinner" /> : "Withdraw via Gateway"}
              </button>
            )
          ) : (
            <button
              className="btn btn-warning w-full"
              onClick={handleRequestRedeem}
              disabled={isPending || parsedAmount === 0n || parsedAmount > (shareBalance ?? 0n)}
            >
              {isPending ? <span className="loading loading-spinner" /> : "Queue Redeem Request"}
            </button>
          )}
        </div>

        {/* Emergency withdraw */}
        {shareBalance !== undefined && shareBalance > 0n && (
          <div className="mt-3">
            <div className="collapse collapse-arrow bg-base-200">
              <input type="checkbox" />
              <div className="collapse-title text-sm font-medium">Emergency Withdraw</div>
              <div className="collapse-content">
                <p className="text-sm opacity-60 mb-2">
                  Burns all your shares and returns a pro-rata share of home-chain assets only. Use this if the vault is
                  in an emergency state.
                </p>
                <button
                  className="btn btn-error btn-sm w-full"
                  onClick={async () => {
                    try {
                      await writeVault({ functionName: "emergencyWithdraw" });
                      notification.success("Emergency withdrawal complete!");
                    } catch (e) {
                      notification.error("Emergency withdraw failed: " + (e as Error).message);
                    }
                  }}
                  disabled={isVaultPending}
                >
                  Emergency Withdraw All
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
