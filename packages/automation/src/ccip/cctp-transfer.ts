/**
 * CCTP Transfer Module
 *
 * Handles native USDC cross-chain transfers via Circle's Cross-Chain Transfer
 * Protocol (CCTP). Uses burn/mint mechanics for capital-efficient transfers.
 *
 * CCTP is the preferred method for USDC transfers as it:
 * - Burns USDC on source, mints on destination (no liquidity pools)
 * - Supports fast transfers (V2) for near-instant delivery
 * - Lower fees than generic bridge solutions
 *
 * Requirements:
 * - Only works with native USDC (not bridged variants)
 * - Requires attestation from Circle's attestation service
 */

import {
  type PublicClient,
  type WalletClient,
  type Address,
} from "viem";

/** CCTP domain IDs for supported chains */
export const CCTP_DOMAINS: Record<number, number> = {
  1: 0, // Ethereum
  43114: 1, // Avalanche
  10: 2, // Optimism
  42161: 3, // Arbitrum
  8453: 6, // Base
  137: 7, // Polygon
};

/** Circle TokenMessenger contract addresses */
export const TOKEN_MESSENGER: Record<number, Address> = {
  1: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
  43114: "0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982",
  10: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
  42161: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
  8453: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
  137: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
};

/** Circle MessageTransmitter contract addresses */
export const MESSAGE_TRANSMITTER: Record<number, Address> = {
  1: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
  43114: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880",
  10: "0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8",
  42161: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
  8453: "0xAD09780d193884d503182aD4F110B887BA1e9AA0",
  137: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
};

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com/attestations";

const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
    stateMutability: "nonpayable",
  },
] as const;

const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export interface CctpTransferParams {
  sourceChainId: number;
  destChainId: number;
  usdcAddress: Address;
  amount: bigint;
  recipient: Address;
}

export interface CctpTransferResult {
  burnTxHash: `0x${string}`;
  nonce: bigint;
  messageHash: `0x${string}`;
}

/**
 * Check if a chain pair supports CCTP transfers.
 */
export function isCctpSupported(
  sourceChainId: number,
  destChainId: number,
): boolean {
  return (
    CCTP_DOMAINS[sourceChainId] !== undefined &&
    CCTP_DOMAINS[destChainId] !== undefined
  );
}

/**
 * Initiate a CCTP burn on the source chain.
 * Returns the burn tx hash and message nonce for attestation tracking.
 */
export async function initiateCctpBurn(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: CctpTransferParams,
): Promise<CctpTransferResult> {
  const { sourceChainId, destChainId, usdcAddress, amount, recipient } = params;

  const tokenMessenger = TOKEN_MESSENGER[sourceChainId];
  if (!tokenMessenger) throw new Error(`CCTP not supported on chain ${sourceChainId}`);

  const destDomain = CCTP_DOMAINS[destChainId];
  if (destDomain === undefined) throw new Error(`CCTP not supported on chain ${destChainId}`);

  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  // Convert recipient address to bytes32
  const mintRecipient = `0x000000000000000000000000${recipient.slice(2)}` as `0x${string}`;

  // Approve TokenMessenger to burn USDC
  await walletClient.writeContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [tokenMessenger, amount],
    account,
    chain: walletClient.chain,
  });

  // Initiate the burn
  const burnTxHash = await walletClient.writeContract({
    address: tokenMessenger,
    abi: tokenMessengerAbi,
    functionName: "depositForBurn",
    args: [amount, destDomain, mintRecipient, usdcAddress],
    account,
    chain: walletClient.chain,
  });

  // Wait for receipt to get the nonce
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: burnTxHash,
  });

  // Extract MessageSent event to get the message hash
  const messageSentTopic =
    "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";
  const messageLog = receipt.logs.find((l) => l.topics[0] === messageSentTopic);
  const messageHash = messageLog?.data ?? ("0x" as `0x${string}`);

  // Nonce is in the MessageSent event data
  const nonce = messageLog ? BigInt(messageLog.topics[1] ?? "0") : 0n;

  return { burnTxHash, nonce, messageHash };
}

/**
 * Wait for Circle's attestation for a CCTP message.
 * Polls the attestation API until the attestation is ready.
 */
export async function waitForAttestation(
  messageHash: `0x${string}`,
  maxWaitMs = 300_000,
  pollIntervalMs = 5_000,
): Promise<{ attestation: `0x${string}`; status: string }> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${CIRCLE_ATTESTATION_API}/${messageHash}`);

    if (response.ok) {
      const data = (await response.json()) as {
        status: string;
        attestation?: string;
      };

      if (data.status === "complete" && data.attestation) {
        return {
          attestation: data.attestation as `0x${string}`,
          status: data.status,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Attestation timeout after ${maxWaitMs}ms`);
}

/**
 * Complete a CCTP transfer by submitting the attestation on the destination chain.
 */
export async function completeCctpTransfer(
  walletClient: WalletClient,
  destChainId: number,
  message: `0x${string}`,
  attestation: `0x${string}`,
): Promise<`0x${string}`> {
  const messageTransmitter = MESSAGE_TRANSMITTER[destChainId];
  if (!messageTransmitter) throw new Error(`CCTP not supported on chain ${destChainId}`);

  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "receiveMessage",
    args: [message, attestation],
    account,
    chain: walletClient.chain,
  });
}
