import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { type Hex, createPublicClient, decodeAbiParameters, decodeErrorResult, http } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * API route that runs `cre workflow simulate` and returns the output.
 *
 * POST /api/cre-simulate
 * Body: { broadcast?: boolean, triggerIndex?: number }
 *
 * The CRE CLI runs the workflow locally (single-node, no DON),
 * reading live on-chain state and optionally broadcasting the resulting
 * transaction to the target chain.
 *
 * NOTE: If the consumer contract's forwarder is set to the production
 * KeystoneForwarder (i.e., locked for DON-only), broadcast mode will
 * fail because the MockKeystoneForwarder is rejected. Use dry-run mode
 * or temporarily set forwarder to address(0) for simulation.
 */

const CRE_PROJECT_DIR = path.resolve(process.cwd(), "../../packages/cre-workflow");
const CRE_WORKFLOW_DIR = "yield-keeper-workflow";
const CRE_BIN = path.join(process.env.HOME ?? "~", ".cre/bin/cre");
const TARGET = "staging-settings";

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || "";

/**
 * When a broadcast tx reverts inside the KeystoneForwarder (which swallows the
 * inner revert), replay the inner `onReport()` call via `eth_call` at the same
 * block to surface the actual revert reason.
 */
async function fetchRevertReason(txHash: string): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(BASE_SEPOLIA_RPC),
    });

    const tx = await client.getTransaction({ hash: txHash as Hex });
    if (!tx) return null;

    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });

    // Replay the exact transaction as eth_call at the block it was mined
    try {
      await client.call({
        account: tx.from,
        to: tx.to,
        data: tx.input,
        value: tx.value,
        blockNumber: receipt.blockNumber,
      });
      // If eth_call succeeds, we can't extract a revert reason this way
      return null;
    } catch (callError: unknown) {
      // Extract revert reason from the error
      const err = callError as { cause?: { data?: Hex }; data?: Hex; message?: string };
      const revertData = err.cause?.data ?? err.data;

      if (revertData && revertData !== "0x") {
        try {
          // Try to decode as a standard Error(string) or Panic(uint256)
          const decoded = decodeErrorResult({ data: revertData });
          return `${decoded.errorName}(${decoded.args?.join(", ") ?? ""})`;
        } catch {
          // Raw revert data — return as hex (might be a custom error)
          return revertData.length > 10
            ? `Custom error: ${revertData.slice(0, 10)}... (${(revertData.length - 2) / 2} bytes)`
            : revertData;
        }
      }

      // Fall back to error message
      if (err.message) {
        const match = err.message.match(/reverted with reason string ["'](.+?)["']/);
        if (match) return match[1];
        const execMatch = err.message.match(/execution reverted:?\s*(.*)/i);
        if (execMatch) return execMatch[1] || "execution reverted";
      }

      return "execution reverted (no reason data)";
    }
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const broadcast = body.broadcast === true;
    const triggerIndex = body.triggerIndex ?? 0;

    // Pre-flight check: warn if forwarder is locked (broadcast will fail on-chain)
    if (broadcast) {
      try {
        const client = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
        const forwarder = await client.readContract({
          address: "0x9B39815964a87eF361d555BD99FfdcDEbe4753bb",
          abi: [
            {
              name: "forwarder",
              type: "function",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "address" }],
            },
          ] as const,
          functionName: "forwarder",
        });
        if (forwarder !== "0x0000000000000000000000000000000000000000") {
          return NextResponse.json(
            {
              success: false,
              error: `Consumer forwarder is locked to ${forwarder}. Broadcast mode will fail because only the KeystoneForwarder (DON) can call onReport(). Use dry-run mode, or call setForwarder(address(0)) to re-enable simulation.`,
              forwarderLocked: true,
            },
            { status: 409 },
          );
        }
      } catch {
        // If we can't check, proceed anyway
      }
    }

    const args = [
      "workflow",
      "simulate",
      CRE_WORKFLOW_DIR,
      "--target",
      TARGET,
      "--non-interactive",
      "--trigger-index",
      String(triggerIndex),
    ];

    if (broadcast) {
      args.push("--broadcast");
    }

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve => {
      const proc = execFile(
        CRE_BIN,
        args,
        {
          cwd: CRE_PROJECT_DIR,
          timeout: 120_000, // 2 minutes
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error?.code ? Number(error.code) : (proc.exitCode ?? 0),
          });
        },
      );
    });

    // Strip ANSI escape codes for clean display
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    // Parse workflow JSON result from stdout to extract innerResult.
    // The CRE CLI outputs a pretty-printed JSON block after "Workflow Simulation Result:".
    // We anchor on that marker to avoid matching JSON fragments in log lines.
    let innerResult: string | null = null;
    let workflowAction: string | null = null;
    let txHash: string | null = null;
    const cleanStdout = stripAnsi(result.stdout);
    const resultMarker = cleanStdout.indexOf("Simulation Result:");
    if (resultMarker !== -1) {
      const afterMarker = cleanStdout.slice(resultMarker);
      const braceStart = afterMarker.indexOf("{");
      if (braceStart !== -1) {
        // Find matching closing brace by counting nesting
        let depth = 0;
        let end = -1;
        for (let i = braceStart; i < afterMarker.length; i++) {
          if (afterMarker[i] === "{") depth++;
          else if (afterMarker[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end !== -1) {
          try {
            const parsed = JSON.parse(afterMarker.slice(braceStart, end + 1));
            innerResult = parsed.innerResult ?? null;
            workflowAction = parsed.action ?? null;
            txHash = parsed.txHash ?? null;
          } catch {
            // JSON parse failed, leave as null
          }
        }
      }
    }

    // If the inner call reverted and we have a tx hash, replay to get the revert reason
    let revertReason: string | null = null;
    if (innerResult === "reverted" && txHash && !txHash.startsWith("0x000000000000")) {
      revertReason = await fetchRevertReason(txHash);
    }

    // Extract CCIP messageId from CrossChainRotationInitiated event for rotation actions
    let ccipMessageId: string | null = null;
    const isRotation = workflowAction === "ROTATE" || workflowAction === "TESTNET_ROTATE";
    if (isRotation && txHash && !txHash.startsWith("0x000000000000")) {
      try {
        const client = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
        // CrossChainRotationInitiated(uint64 indexed destChain, address token, uint256 amount, bytes32 messageId)
        const eventTopic = "0xcc9ef79327a06591ee438a58da632c836cf7d8e096712784c6f0b3945e177c03";
        const rotationLog = receipt.logs.find(log => log.topics[0] === eventTopic);
        if (rotationLog) {
          const [, , messageId] = decodeAbiParameters(
            [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "messageId", type: "bytes32" },
            ],
            rotationLog.data,
          );
          ccipMessageId = messageId;
        }
      } catch {
        // Non-critical — just won't have the CCIP link
      }
    }

    return NextResponse.json({
      success: result.exitCode === 0,
      broadcast,
      triggerIndex,
      innerResult,
      workflowAction,
      txHash,
      ccipMessageId,
      revertReason,
      stdout: stripAnsi(result.stdout),
      stderr: stripAnsi(result.stderr),
      exitCode: result.exitCode,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
