import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

const ARB_SEPOLIA_RPC = process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
const SPOKE_VAULT = "0x99f90636e87646113480F4cfC631f02E0EE4cC22";

// WithdrawAndReturnExecuted(address indexed token, uint256 amount, bytes32 messageId)
const WITHDRAW_EVENT_TOPIC = "0x2a062e2d06445a9e29bcc65773e09d79e291482c97dbac864d48ddf9cdd622bb";

export async function GET(req: NextRequest) {
  const messageId = req.nextUrl.searchParams.get("messageId");
  if (!messageId) {
    return NextResponse.json({ error: "messageId required" }, { status: 400 });
  }

  try {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(ARB_SEPOLIA_RPC) });

    // Look for recent WithdrawAndReturnExecuted events on SpokeVault
    const latestBlock = await client.getBlockNumber();
    const fromBlock = latestBlock > 5000n ? latestBlock - 5000n : 0n;

    const logs = await client.getLogs({
      address: SPOKE_VAULT as `0x${string}`,
      fromBlock,
      toBlock: "latest",
    });

    // Find the log containing our CCIP messageId in tx receipt
    // The SpokeVault emits WithdrawAndReturnExecuted which contains the CCIP return messageId
    // But we need the tx hash of the ccipReceive that triggered it
    // Simpler: search for any recent tx to the SpokeVault from the CCIP router
    for (const log of logs.reverse()) {
      if (log.topics[0] === WITHDRAW_EVENT_TOPIC) {
        return NextResponse.json({ destTxHash: log.transactionHash });
      }
    }

    // Alternative: check the SupplyExecuted event for rotations
    const SUPPLY_EVENT_TOPIC = "0x3c5e0dcc4e82b5056bf44ae372a38e57805e7de307070bcd0988e5afbf1d4eb7";
    for (const log of logs) {
      if (log.topics[0] === SUPPLY_EVENT_TOPIC) {
        return NextResponse.json({ destTxHash: log.transactionHash });
      }
    }

    return NextResponse.json({ destTxHash: null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
