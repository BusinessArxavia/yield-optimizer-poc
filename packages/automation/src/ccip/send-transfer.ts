/**
 * CCIP Transfer Module
 *
 * Wraps Chainlink CCIP programmable token transfers in a reusable module.
 * Supports fee estimation and message construction for cross-chain rotations.
 */

import {
  type PublicClient,
  type WalletClient,
  type Address,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { ccipRouterAbi } from "../abis.js";

/** CCIP chain selectors for supported networks */
export const CCIP_CHAIN_SELECTORS: Record<number, bigint> = {
  1: 5009297550715157269n, // Ethereum
  8453: 15971525489660198786n, // Base
  42161: 4949039107694359620n, // Arbitrum
  10: 3734403246176062136n, // Optimism
  137: 4051577828743386545n, // Polygon
  43114: 6433500567565415381n, // Avalanche
  // Testnets
  84532: 10344971235874465080n, // Base Sepolia
  421614: 3478487238524512106n, // Arbitrum Sepolia
};

export interface CcipTransferParams {
  /** CCIP Router address on the source chain */
  router: Address;
  /** Destination CCIP chain selector */
  destChainSelector: bigint;
  /** Receiver address on destination chain */
  receiver: Address;
  /** Token to transfer (zero address for data-only) */
  token?: Address;
  /** Amount to transfer (0 for data-only) */
  amount?: bigint;
  /** Encoded message data */
  data?: `0x${string}`;
  /** Fee token (LINK address, or zero for native) */
  feeToken: Address;
  /** Gas limit for destination chain execution */
  gasLimit?: bigint;
}

export interface CcipFeeEstimate {
  fee: bigint;
  feeToken: Address;
}

export interface CcipTransferResult {
  messageId: `0x${string}`;
  txHash: `0x${string}`;
  fee: bigint;
}

/** Build EVMExtraArgsV1 bytes (CCIP gas limit encoding) */
function buildExtraArgs(gasLimit: bigint): `0x${string}` {
  // EVMExtraArgsV1 tag = 0x97a657c9 (4 bytes) + abi.encode(gasLimit)
  const tag = "97a657c9";
  const encoded = encodeAbiParameters(parseAbiParameters("uint256"), [
    gasLimit,
  ]);
  return `0x${tag}${encoded.slice(2)}` as `0x${string}`;
}

/** Build the CCIP EVM2AnyMessage struct */
function buildMessage(params: CcipTransferParams) {
  const receiver = encodeAbiParameters(parseAbiParameters("address"), [
    params.receiver,
  ]);

  const tokenAmounts =
    params.token && params.amount && params.amount > 0n
      ? [{ token: params.token, amount: params.amount }]
      : [];

  return {
    receiver,
    data: params.data ?? ("0x" as `0x${string}`),
    tokenAmounts,
    feeToken: params.feeToken,
    extraArgs: buildExtraArgs(params.gasLimit ?? 200_000n),
  };
}

/**
 * Estimate the CCIP fee for a transfer.
 */
export async function estimateCcipFee(
  publicClient: PublicClient,
  params: CcipTransferParams,
): Promise<CcipFeeEstimate> {
  const message = buildMessage(params);

  const fee = await publicClient.readContract({
    address: params.router,
    abi: ccipRouterAbi,
    functionName: "getFee",
    args: [params.destChainSelector, message],
  });

  return { fee, feeToken: params.feeToken };
}

/**
 * Check if a destination chain is supported by the CCIP router.
 */
export async function isChainSupported(
  publicClient: PublicClient,
  router: Address,
  chainSelector: bigint,
): Promise<boolean> {
  return publicClient.readContract({
    address: router,
    abi: ccipRouterAbi,
    functionName: "isChainSupported",
    args: [chainSelector],
  });
}

/**
 * Send a CCIP transfer (token + data or data-only).
 */
export async function sendCcipTransfer(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: CcipTransferParams,
): Promise<CcipTransferResult> {
  const message = buildMessage(params);

  // Get fee estimate
  const fee = await publicClient.readContract({
    address: params.router,
    abi: ccipRouterAbi,
    functionName: "getFee",
    args: [params.destChainSelector, message],
  });

  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  // Send the CCIP message
  const txHash = await walletClient.writeContract({
    address: params.router,
    abi: ccipRouterAbi,
    functionName: "ccipSend",
    args: [params.destChainSelector, message],
    value: params.feeToken === "0x0000000000000000000000000000000000000000" ? fee : 0n,
    account,
    chain: walletClient.chain,
  });

  // Wait for receipt and extract messageId from logs
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  // The CCIPSendRequested event topic
  const ccipSendTopic =
    "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";
  const sendLog = receipt.logs.find((l) => l.topics[0] === ccipSendTopic);
  const messageId = sendLog?.topics[1] ?? ("0x" as `0x${string}`);

  return { messageId: messageId as `0x${string}`, txHash, fee };
}

/**
 * Get the CCIP chain selector for a given chain ID.
 */
export function getChainSelector(chainId: number): bigint | undefined {
  return CCIP_CHAIN_SELECTORS[chainId];
}
