import {
  CronCapability,
  EVMClient,
  HTTPClient,
  handler,
  Runner,
  consensusMedianAggregation,
  getNetwork,
  encodeCallMsg,
  bytesToHex,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  TxStatus,
  type Runtime,
  type NodeRuntime,
  type EVMLog,
} from "@chainlink/cre-sdk"
import {
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
} from "viem"
import {
  YieldVaultAbi,
  CircuitBreakerAbi,
  ERC20Abi,
  ActionType,
  ActionTypeParams,
  RotateActionParams,
  TestnetRotateActionParams,
  FulfillRedemptionsParams,
  RecallRemoteParams,
  TestnetRecallParams,
  AavePoolAbi,
} from "../contracts/abi"

// ─── Configuration ──────────────────────────────────────────────────

type EvmConfig = {
  chainName: string
  vaultAddress: string
  controllerAddress: string
  circuitBreakerAddress: string
  consumerAddress: string
  assetAddress: string
  gasLimit: string
  // Optional: Aave pool for rate reads
  aavePoolAddress?: string
}

type CrossChainConfig = {
  chainName: string
  chainSelector: string // CCIP chain selector (uint64)
  aavePoolAddress: string
  assetAddress: string
  // Testnet only: CCIP-BnM bridge token (faucet USDC is not in CCIP pools)
  bridgeToken?: string
  bridgeAmount?: string // in wei (18 decimals for CCIP-BnM)
}

type MonitoringConfig = {
  endpoint: string
}

type Config = {
  schedule: string
  evm: EvmConfig
  // Phase 4: Cross-chain yield comparison
  crossChains?: CrossChainConfig[]
  // Phase 5: External yield data
  defiLlamaPoolId?: string
  // Phase 6: Monitoring
  monitoring?: MonitoringConfig
  // Keeper parameters (replicate on-chain check logic)
  minIdleSupplyAmount: string
  idleTargetBps: string
  harvestMinYieldBps: string
  harvestCooldown: string
  // Rotation parameters
  minRotationSpreadBps?: string // min yield advantage to trigger rotation (default 100 = 1%)
  rotationAmountBps?: string // % of total assets to rotate (default 2000 = 20%)
  estimatedCostBps?: string // estimated bridge+gas cost in bps (default 10 = 0.1%)
}

// ─── Result Types ───────────────────────────────────────────────────

type WorkflowResult = {
  action: string
  txHash: string
  innerResult: string // "success" | "reverted" | "unknown" — whether onReport() succeeded inside the forwarder tx
  vaultState: VaultState
  crossChainRates?: Record<string, string>
  externalYield?: string
}

type VaultState = {
  totalAssets: string
  totalSupply: string
  idleBalance: string
  lastHarvestSharePrice: string
  circuitBreakerActive: boolean
  pendingRedeemCount: string
  totalPendingAssets: string
}

// ─── Constants ──────────────────────────────────────────────────────

const BPS_DENOMINATOR = 10_000n

// ReceiverContractExecutionStatus enum values from CRE SDK
// (not re-exported from SDK convenience layer, so we use raw values)
const RECEIVER_SUCCESS = 0
const RECEIVER_REVERTED = 1

// KeystoneForwarder emits ReportProcessed(address indexed, bytes32 indexed, bytes2 indexed, bool result)
// keccak256("ReportProcessed(address,bytes32,bytes2,bool)")
const REPORT_PROCESSED_SIG = "3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5"

/** Parse ReportProcessed event from tx logs. Returns true/false/null. */
function parseReportProcessedLog(
  logs: Array<{ eventSig: Uint8Array; data: Uint8Array }>
): boolean | null {
  for (const log of logs) {
    if (bytesToHex(log.eventSig).slice(2) === REPORT_PROCESSED_SIG) {
      // data is ABI-encoded bool: 32 bytes, last byte 0x00=false 0x01=true
      if (log.data.length >= 32) {
        return log.data[log.data.length - 1] !== 0
      }
    }
  }
  return null
}

/**
 * Determine inner execution result after writeReport.
 *
 * Strategy:
 *  1. Use SDK's receiverContractExecutionStatus if it reports REVERTED (trust failures)
 *  2. Fetch tx receipt and parse ReportProcessed event for ground truth
 *     (the simulator broadcast mode incorrectly reports SUCCESS even when onReport reverts)
 *  3. Fall back to SDK status if receipt is unavailable
 */
function resolveInnerResult(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  writeResult: { txStatus: number; receiverContractExecutionStatus?: number; txHash?: Uint8Array }
): string {
  const sdkStatus = writeResult.receiverContractExecutionStatus

  // Trust the SDK if it explicitly says REVERTED
  if (sdkStatus === RECEIVER_REVERTED) {
    runtime.log("SDK reports onReport() reverted")
    return "reverted"
  }

  // Fetch tx receipt to get actual logs (ground truth)
  // Skip zero hash (simulation mode without broadcast)
  const txHash = writeResult.txHash
  const isZeroHash = txHash && txHash.every(b => b === 0)
  if (txHash && txHash.length > 0 && !isZeroHash) {
    try {
      const receipt = evmClient
        .getTransactionReceipt(runtime, {
          hash: hexToBase64(bytesToHex(txHash)),
        })
        .result()

      if (receipt.receipt) {
        const logResult = parseReportProcessedLog(receipt.receipt.logs || [])
        if (logResult !== null) {
          if (!logResult) {
            runtime.log("ReportProcessed event confirms: onReport() REVERTED")
          }
          return logResult ? "success" : "reverted"
        }
      }
    } catch {
      runtime.log("Could not fetch tx receipt for inner result verification")
    }
  }

  // Fall back to SDK status
  if (sdkStatus === RECEIVER_SUCCESS) return "success"
  return "unknown"
}

// ─── Workflow Init ──────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  const handlers = [
    // Phase 2: Core cron-based keeper
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
  ]

  // Phase 3: Event-driven triggers
  const evmConfig = config.evm
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainName,
    isTestnet: evmConfig.chainName.includes("testnet"),
  })

  if (network) {
    const evmClient = new EVMClient(network.chainSelector.selector)

    // 3.1 — React to large vault deposits/withdrawals
    const depositEventHash = keccak256(
      toBytes("Deposit(address,address,uint256,uint256)")
    )
    const withdrawEventHash = keccak256(
      toBytes("Withdraw(address,address,address,uint256,uint256)")
    )

    handlers.push(
      handler(
        evmClient.logTrigger({
          addresses: [hexToBase64(evmConfig.vaultAddress)],
          topics: [
            {
              values: [
                hexToBase64(depositEventHash),
                hexToBase64(withdrawEventHash),
              ],
            },
          ],
        }),
        onVaultEvent
      )
    )

    // 3.2 — React to circuit breaker tier changes
    const tierChangedEventHash = keccak256(
      toBytes("TierChanged(uint8,uint8)")
    )

    handlers.push(
      handler(
        evmClient.logTrigger({
          addresses: [hexToBase64(evmConfig.circuitBreakerAddress)],
          topics: [
            { values: [hexToBase64(tierChangedEventHash)] },
          ],
        }),
        onCircuitBreakerEvent
      )
    )
  }

  return handlers
}

// ─── Core Cron Handler (Phase 2) ────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): WorkflowResult => {
  const config = runtime.config
  const evmConfig = config.evm

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainName,
    isTestnet: evmConfig.chainName.includes("testnet"),
  })
  if (!network) throw new Error(`Network not found: ${evmConfig.chainName}`)

  const evmClient = new EVMClient(network.chainSelector.selector)

  // Read vault state
  const vaultState = readVaultState(runtime, evmClient, evmConfig)
  runtime.log(
    `Vault state: totalAssets=${vaultState.totalAssets}, idle=${vaultState.idleBalance}, cb=${vaultState.circuitBreakerActive}`
  )

  // Phase 4: Cross-chain yield comparison (non-blocking enrichment)
  let crossChainRates: Record<string, string> | undefined
  if (config.crossChains && config.crossChains.length > 0) {
    crossChainRates = readCrossChainRates(runtime, config.crossChains)
    runtime.log(`Cross-chain rates: ${JSON.stringify(crossChainRates)}`)
  }

  // Phase 5: External yield data (non-blocking — timeout or API errors must not crash the workflow)
  let externalYield: string | undefined
  if (config.defiLlamaPoolId) {
    try {
      externalYield = runtime.runInNodeMode(
        (nodeRuntime: NodeRuntime<Config>): string => {
          return fetchDefiLlamaYield(nodeRuntime)
        },
        consensusMedianAggregation()
      )().result().toString()
      runtime.log(`DeFiLlama yield: ${externalYield}`)

      // SECURITY: bounds check prevents bad API data from triggering wrong rotation decisions
      const yieldNum = Number(externalYield)
      if (isNaN(yieldNum) || yieldNum < 0 || yieldNum > 10000) {
        runtime.log(`[WARN] Ignoring implausible external yield: ${externalYield} bps`)
        externalYield = undefined
      }
    } catch {
      runtime.log("[WARN] DeFiLlama fetch failed (timeout or API error), continuing without external yield")
      externalYield = undefined
    }
  }

  // Decision logic (replicates on-chain checkUpkeep)
  const totalAssets = BigInt(vaultState.totalAssets)
  const idleBalance = BigInt(vaultState.idleBalance)
  const totalSupply = BigInt(vaultState.totalSupply)
  const lastSharePrice = BigInt(vaultState.lastHarvestSharePrice)
  const minIdle = BigInt(config.minIdleSupplyAmount)
  const idleTargetBps = BigInt(config.idleTargetBps)
  const harvestMinYieldBps = BigInt(config.harvestMinYieldBps)

  let action = "none"
  let txHash = ""
  let innerResult = "unknown"

  const pendingCount = BigInt(vaultState.pendingRedeemCount)
  const pendingAssets = BigInt(vaultState.totalPendingAssets)

  // Priority 0: Fulfill pending redemptions if liquidity is available
  if (pendingCount > 0n && idleBalance > 0n) {
    runtime.log(`Pending redeems: count=${pendingCount}, pendingAssets=${pendingAssets}, idle=${idleBalance}`)
    const writeRes = writeFulfillRedemptionsAction(runtime, evmClient, evmConfig, pendingCount)
    txHash = writeRes.txHash
    innerResult = writeRes.innerResult
    action = "FULFILL_REDEMPTIONS"
  }

  // Priority 1: Recall remote funds if pending redeems exceed home liquidity
  if (
    action === "none" &&
    pendingCount > 0n &&
    pendingAssets > idleBalance &&
    config.crossChains &&
    config.crossChains.length > 0
  ) {
    const shortfall = pendingAssets - idleBalance
    runtime.log(`Redemption shortfall: ${shortfall} USDC, initiating remote recall`)

    // Find a chain with sufficient remote balance
    const recallResult = evaluateRecall(runtime, evmClient, evmConfig, config, shortfall)
    if (recallResult) {
      txHash = recallResult.txHash
      innerResult = recallResult.innerResult
      action = "RECALL_REMOTE"
    }
  }

  // Priority 2: Supply idle assets
  if (action === "none" && !vaultState.circuitBreakerActive && totalAssets > 0n) {
    const targetIdle = (totalAssets * idleTargetBps) / BPS_DENOMINATOR
    if (idleBalance > targetIdle + minIdle) {
      runtime.log(`Idle supply needed: idle=${idleBalance}, target=${targetIdle}`)
      const writeRes = writeAction(runtime, evmClient, evmConfig, ActionType.SUPPLY_IDLE)
      txHash = writeRes.txHash
      innerResult = writeRes.innerResult
      action = "SUPPLY_IDLE"
    }
  }

  // Priority 3: Harvest yield (only if no other action taken)
  if (action === "none" && totalSupply > 0n && totalAssets > 0n) {
    // Note: cooldown is enforced on-chain by the consumer contract
    // Vault decimals = USDC decimals (6) since ERC4626 inherits from underlying asset
    const vaultDecimals = 6n
    const currentSharePrice = (totalAssets * (10n ** vaultDecimals)) / totalSupply
    if (currentSharePrice > lastSharePrice && lastSharePrice > 0n) {
      const yieldBps = ((currentSharePrice - lastSharePrice) * BPS_DENOMINATOR) / lastSharePrice
      if (yieldBps >= harvestMinYieldBps) {
        runtime.log(`Harvest needed: yieldBps=${yieldBps}`)
        const writeRes = writeAction(runtime, evmClient, evmConfig, ActionType.HARVEST_YIELD)
        txHash = writeRes.txHash
        innerResult = writeRes.innerResult
        action = "HARVEST_YIELD"
      }
    }
  }

  // Priority 4: Cross-chain rotation (only if no other action taken)
  if (
    action === "none" &&
    !vaultState.circuitBreakerActive &&
    totalAssets > 0n &&
    crossChainRates &&
    config.crossChains &&
    config.crossChains.length > 0
  ) {
    const rotationResult = evaluateRotation(
      runtime,
      evmClient,
      evmConfig,
      config,
      totalAssets,
      crossChainRates
    )
    if (rotationResult) {
      txHash = rotationResult.txHash
      innerResult = rotationResult.innerResult
      const isTestnet = evmConfig.chainName.includes("testnet")
      action = isTestnet && config.crossChains!.some(c => c.bridgeToken) ? "TESTNET_ROTATE" : "ROTATE"
    }
  }

  if (action === "none") {
    runtime.log("No action needed")
  }

  const result: WorkflowResult = {
    action,
    txHash,
    innerResult,
    vaultState,
    crossChainRates,
    externalYield,
  }

  // Phase 6: HTTP reporting
  if (config.monitoring?.endpoint) {
    reportToMonitoring(runtime, result)
  }

  return result
}

// ─── Event Handlers (Phase 3) ───────────────────────────────────────

// 3.1 — React to vault deposit/withdraw events
const onVaultEvent = (runtime: Runtime<Config>, log: EVMLog): WorkflowResult => {
  const evmConfig = runtime.config.evm
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainName,
    isTestnet: evmConfig.chainName.includes("testnet"),
  })
  if (!network) throw new Error(`Network not found: ${evmConfig.chainName}`)

  const evmClient = new EVMClient(network.chainSelector.selector)
  const txHash = bytesToHex(log.txHash)
  runtime.log(`Vault event detected in tx: ${txHash}`)

  const vaultState = readVaultState(runtime, evmClient, evmConfig)
  const totalAssets = BigInt(vaultState.totalAssets)
  const idleBalance = BigInt(vaultState.idleBalance)
  const minIdle = BigInt(runtime.config.minIdleSupplyAmount)
  const idleTargetBps = BigInt(runtime.config.idleTargetBps)

  let action = "none"
  let writeTxHash = ""
  let innerResult = "unknown"

  // After a deposit, check if we should supply idle to Aave
  if (!vaultState.circuitBreakerActive && totalAssets > 0n) {
    const targetIdle = (totalAssets * idleTargetBps) / BPS_DENOMINATOR
    if (idleBalance > targetIdle + minIdle) {
      runtime.log(`Post-event idle supply needed: idle=${idleBalance}`)
      const writeRes = writeAction(runtime, evmClient, evmConfig, ActionType.SUPPLY_IDLE)
      writeTxHash = writeRes.txHash
      innerResult = writeRes.innerResult
      action = "SUPPLY_IDLE"
    }
  }

  const result: WorkflowResult = {
    action,
    txHash: writeTxHash,
    innerResult,
    vaultState,
  }

  if (runtime.config.monitoring?.endpoint) {
    reportToMonitoring(runtime, result)
  }

  return result
}

// 3.2 — React to circuit breaker tier changes
const onCircuitBreakerEvent = (
  runtime: Runtime<Config>,
  log: EVMLog
): WorkflowResult => {
  const txHash = bytesToHex(log.txHash)
  runtime.log(`Circuit breaker tier changed in tx: ${txHash}`)

  const evmConfig = runtime.config.evm
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainName,
    isTestnet: evmConfig.chainName.includes("testnet"),
  })
  if (!network) throw new Error(`Network not found: ${evmConfig.chainName}`)

  const evmClient = new EVMClient(network.chainSelector.selector)
  const vaultState = readVaultState(runtime, evmClient, evmConfig)

  runtime.log(
    `CB event: active=${vaultState.circuitBreakerActive}, totalAssets=${vaultState.totalAssets}`
  )

  const result: WorkflowResult = {
    action: "CIRCUIT_BREAKER_ALERT",
    txHash: "",
    innerResult: "unknown",
    vaultState,
  }

  // Always report circuit breaker events to monitoring
  if (runtime.config.monitoring?.endpoint) {
    reportToMonitoring(runtime, result)
  }

  return result
}

// ─── Vault State Reader ─────────────────────────────────────────────

function readVaultState(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig
): VaultState {
  // Read totalAssets
  const totalAssetsData = encodeFunctionData({
    abi: YieldVaultAbi,
    functionName: "totalAssets",
  })
  const totalAssetsResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.vaultAddress as Address,
        data: totalAssetsData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const totalAssets = decodeFunctionResult({
    abi: YieldVaultAbi,
    functionName: "totalAssets",
    data: bytesToHex(totalAssetsResult.data),
  }) as bigint

  // Read totalSupply
  const totalSupplyData = encodeFunctionData({
    abi: YieldVaultAbi,
    functionName: "totalSupply",
  })
  const totalSupplyResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.vaultAddress as Address,
        data: totalSupplyData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const totalSupply = decodeFunctionResult({
    abi: YieldVaultAbi,
    functionName: "totalSupply",
    data: bytesToHex(totalSupplyResult.data),
  }) as bigint

  // Read lastHarvestSharePrice
  const sharePriceData = encodeFunctionData({
    abi: YieldVaultAbi,
    functionName: "lastHarvestSharePrice",
  })
  const sharePriceResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.vaultAddress as Address,
        data: sharePriceData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const lastHarvestSharePrice = decodeFunctionResult({
    abi: YieldVaultAbi,
    functionName: "lastHarvestSharePrice",
    data: bytesToHex(sharePriceResult.data),
  }) as bigint

  // Read idle balance (USDC in vault)
  const balanceData = encodeFunctionData({
    abi: ERC20Abi,
    functionName: "balanceOf",
    args: [evmConfig.vaultAddress as Address],
  })
  const balanceResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.assetAddress as Address,
        data: balanceData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const idleBalance = decodeFunctionResult({
    abi: ERC20Abi,
    functionName: "balanceOf",
    data: bytesToHex(balanceResult.data),
  }) as bigint

  // Read circuit breaker state
  const cbData = encodeFunctionData({
    abi: CircuitBreakerAbi,
    functionName: "isActive",
  })
  const cbResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.circuitBreakerAddress as Address,
        data: cbData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const circuitBreakerActive = decodeFunctionResult({
    abi: CircuitBreakerAbi,
    functionName: "isActive",
    data: bytesToHex(cbResult.data),
  }) as boolean

  // Read pending redeem count
  const pendingCountData = encodeFunctionData({
    abi: YieldVaultAbi,
    functionName: "pendingRedeemCount",
  })
  const pendingCountResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.vaultAddress as Address,
        data: pendingCountData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const pendingRedeemCount = decodeFunctionResult({
    abi: YieldVaultAbi,
    functionName: "pendingRedeemCount",
    data: bytesToHex(pendingCountResult.data),
  }) as bigint

  // Read total pending assets
  const pendingAssetsData = encodeFunctionData({
    abi: YieldVaultAbi,
    functionName: "totalPendingAssets",
  })
  const pendingAssetsResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.vaultAddress as Address,
        data: pendingAssetsData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const totalPendingAssets = decodeFunctionResult({
    abi: YieldVaultAbi,
    functionName: "totalPendingAssets",
    data: bytesToHex(pendingAssetsResult.data),
  }) as bigint

  return {
    totalAssets: totalAssets.toString(),
    totalSupply: totalSupply.toString(),
    idleBalance: idleBalance.toString(),
    lastHarvestSharePrice: lastHarvestSharePrice.toString(),
    circuitBreakerActive,
    pendingRedeemCount: pendingRedeemCount.toString(),
    totalPendingAssets: totalPendingAssets.toString(),
  }
}

// ─── Cross-Chain Rate Reader (Phase 4) ──────────────────────────────

function readCrossChainRates(
  runtime: Runtime<Config>,
  crossChains: CrossChainConfig[]
): Record<string, string> {
  const rates: Record<string, string> = {}

  for (const chain of crossChains) {
    const network = getNetwork({
      chainFamily: "evm",
      chainSelectorName: chain.chainName,
      isTestnet: chain.chainName.includes("testnet"),
    })
    if (!network) {
      runtime.log(`Skipping unknown chain: ${chain.chainName}`)
      continue
    }

    const evmClient = new EVMClient(network.chainSelector.selector)

    // Read Aave reserve data for the asset
    const callData = encodeFunctionData({
      abi: AavePoolAbi,
      functionName: "getReserveData",
      args: [chain.assetAddress as Address],
    })

    try {
      const result = evmClient
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: chain.aavePoolAddress as Address,
            data: callData,
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result()

      // The currentLiquidityRate is the 2nd field (index 1) in the return tuple
      // It's expressed in RAY (1e27)
      const hex = bytesToHex(result.data)
      // Store raw hex for now — decoding the full tuple is complex
      rates[chain.chainName] = hex.slice(0, 66) // first 32 bytes
      runtime.log(`Rate data for ${chain.chainName}: available`)
    } catch {
      runtime.log(`Failed to read rate for ${chain.chainName}`)
      rates[chain.chainName] = "error"
    }
  }

  return rates
}

// ─── DeFiLlama Yield Fetch (Phase 5) ────────────────────────────────

function fetchDefiLlamaYield(nodeRuntime: NodeRuntime<Config>): string {
  const poolId = nodeRuntime.config.defiLlamaPoolId
  if (!poolId) return "0"

  const httpClient = new HTTPClient()
  const resp = httpClient
    .sendRequest(nodeRuntime, {
      url: `https://yields.llama.fi/chart/${poolId}`,
      method: "GET" as const,
    })
    .result()

  const bodyText = new TextDecoder().decode(resp.body)
  try {
    const data = JSON.parse(bodyText)
    // Get the latest APY from the chart data
    if (data.data && data.data.length > 0) {
      const latest = data.data[data.data.length - 1]
      return latest.apy?.toString() ?? "0"
    }
  } catch {
    nodeRuntime.log("Failed to parse DeFiLlama response")
  }
  return "0"
}

// ─── Rotation Evaluation (Priority 3) ───────────────────────────

function evaluateRotation(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  config: Config,
  totalAssets: bigint,
  crossChainRates: Record<string, string>
): { txHash: string; innerResult: string } | null {
  const minSpreadBps = BigInt(config.minRotationSpreadBps ?? "100") // default 1%
  const rotationAmountBps = BigInt(config.rotationAmountBps ?? "2000") // default 20%
  const estimatedCostBps = BigInt(config.estimatedCostBps ?? "10") // default 0.1%

  // Read local Aave supply rate
  const localRate = readAaveSupplyRate(runtime, evmClient, evmConfig)
  if (localRate === null) {
    runtime.log("Could not read local Aave rate, skipping rotation")
    return null
  }
  runtime.log(`Local Aave supply rate (RAY): ${localRate}`)

  // Compare with each cross-chain rate
  let bestChain: CrossChainConfig | null = null
  let bestSpreadBps = 0n

  for (const chain of config.crossChains!) {
    const rateHex = crossChainRates[chain.chainName]
    if (!rateHex || rateHex === "error") continue

    // Parse the rate from the raw hex (first 32 bytes = configuration data, not the rate)
    // The reserve data tuple has currentLiquidityRate at index 2 (3rd field)
    // For simplicity, read it directly
    const remoteRate = readRemoteAaveRate(runtime, chain)
    if (remoteRate === null) continue

    runtime.log(`Remote rate for ${chain.chainName} (RAY): ${remoteRate}`)

    if (remoteRate > localRate) {
      // Spread in bps: (remoteRate - localRate) * 10000 / localRate
      const spreadBps = localRate > 0n
        ? ((remoteRate - localRate) * BPS_DENOMINATOR) / localRate
        : BPS_DENOMINATOR // If local rate is 0, any positive remote rate is infinite spread

      if (spreadBps > minSpreadBps && spreadBps > bestSpreadBps) {
        bestChain = chain
        bestSpreadBps = spreadBps
      }
    }
  }

  if (!bestChain) {
    runtime.log("No cross-chain rotation opportunity found")
    return null
  }

  // Calculate rotation amount
  const amount = (totalAssets * rotationAmountBps) / BPS_DENOMINATOR
  const destChainSelector = BigInt(bestChain.chainSelector)

  runtime.log(
    `Rotation opportunity: ${bestChain.chainName}, spread=${bestSpreadBps}bps, amount=${amount}`
  )

  // On testnet, use TESTNET_ROTATE: Aave faucet USDC is not in CCIP token pools,
  // so we bridge CCIP-BnM tokens instead. The flow withdraws USDC from Aave (real)
  // and bridges BnM tokens via CCIP (proves cross-chain messaging works).
  const isTestnet = evmConfig.chainName.includes("testnet")
  if (isTestnet && bestChain.bridgeToken) {
    const bridgeAmount = BigInt(bestChain.bridgeAmount ?? "100000000000000000") // default 0.1 BnM (18 dec)
    runtime.log(
      `Using TESTNET_ROTATE: bridgeToken=${bestChain.bridgeToken}, bridgeAmount=${bridgeAmount}`
    )
    return writeTestnetRotateAction(
      runtime,
      evmClient,
      evmConfig,
      destChainSelector,
      amount,
      bestChain.bridgeToken,
      bridgeAmount,
      bestSpreadBps,
      estimatedCostBps
    )
  }

  return writeRotateAction(
    runtime,
    evmClient,
    evmConfig,
    destChainSelector,
    amount,
    bestSpreadBps,
    estimatedCostBps
  )
}

// SECURITY: maximum plausible Aave liquidity rate in RAY (100% APY = 1e27)
const MAX_AAVE_RATE_RAY = 10n ** 27n

function readAaveSupplyRate(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig
): bigint | null {
  if (!evmConfig.aavePoolAddress) return null

  const callData = encodeFunctionData({
    abi: AavePoolAbi,
    functionName: "getReserveData",
    args: [evmConfig.assetAddress as Address],
  })

  try {
    const result = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: evmConfig.aavePoolAddress as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    // Reserve data is a packed struct. currentLiquidityRate is at offset 2 (3rd slot).
    // Each slot is 32 bytes. The tuple starts at offset 0x20 (after length prefix).
    // Slot 0: configuration (uint256)
    // Slot 1: liquidityIndex (uint128) — but ABI-encoded as 32 bytes
    // Slot 2: currentLiquidityRate (uint128)
    const hex = bytesToHex(result.data)
    // ABI-decoded tuple: skip selector, each param is 32 bytes
    // Slot index 2 = currentLiquidityRate, starting at byte 2 + 2*32 = 66 hex chars offset
    // Actually the raw result.data from callContract is the return value directly
    // For packed struct: offset 0 = config(32), offset 32 = liqIndex(32), offset 64 = currentLiqRate(32)
    if (hex.length >= 2 + 64 * 3) {
      // Skip "0x", then 2 x 64 chars (2 x 32 bytes) to get to slot 2
      const rateHex = "0x" + hex.slice(2 + 128, 2 + 192)
      const rate = BigInt(rateHex)
      // SECURITY: bounds check prevents bad RPC data from triggering wrong rotation decisions
      if (rate < 0n || rate > MAX_AAVE_RATE_RAY) {
        runtime.log(`[WARN] Ignoring implausible local Aave rate: ${rate}`)
        return null
      }
      return rate
    }
  } catch {
    runtime.log("Failed to read local Aave supply rate")
  }
  return null
}

function readRemoteAaveRate(
  runtime: Runtime<Config>,
  chain: CrossChainConfig
): bigint | null {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: chain.chainName,
    isTestnet: chain.chainName.includes("testnet"),
  })
  if (!network) return null

  const evmClient = new EVMClient(network.chainSelector.selector)

  const callData = encodeFunctionData({
    abi: AavePoolAbi,
    functionName: "getReserveData",
    args: [chain.assetAddress as Address],
  })

  try {
    const result = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: chain.aavePoolAddress as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    const hex = bytesToHex(result.data)
    if (hex.length >= 2 + 64 * 3) {
      const rateHex = "0x" + hex.slice(2 + 128, 2 + 192)
      const rate = BigInt(rateHex)
      // SECURITY: bounds check prevents bad RPC data from triggering wrong rotation decisions
      if (rate < 0n || rate > MAX_AAVE_RATE_RAY) {
        runtime.log(`[WARN] Ignoring implausible remote rate for ${chain.chainName}: ${rate}`)
        return null
      }
      return rate
    }
  } catch {
    runtime.log(`Failed to read remote Aave rate for ${chain.chainName}`)
  }
  return null
}

// ─── Write Rotate Action to Consumer Contract ───────────────────

function writeRotateAction(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  destChain: bigint,
  amount: bigint,
  yieldBps: bigint,
  costBps: bigint
): { txHash: string; innerResult: string } {
  runtime.log(
    `Writing ROTATE action: destChain=${destChain}, amount=${amount}, yieldBps=${yieldBps}, costBps=${costBps}`
  )

  // ABI-encode: (uint8, uint64, uint256, uint256, uint256)
  const reportData = encodeAbiParameters(RotateActionParams, [
    ActionType.ROTATE,
    destChain,
    amount,
    yieldBps,
    costBps,
  ])

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.consumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`ROTATE report delivery FAILED: status=${writeResult.txStatus}, tx=${txHash}`)
    return { txHash, innerResult: "reverted" }
  }

  const innerResult = resolveInnerResult(runtime, evmClient, writeResult)
  runtime.log(`ROTATE ${innerResult === "reverted" ? "FAILED (onReport reverted)" : innerResult}: tx=${txHash}`)

  return { txHash, innerResult }
}

// ─── Write Testnet Rotate Action ─────────────────────────────────
// On testnet, Aave's faucet USDC is not registered in CCIP token pools.
// TESTNET_ROTATE works around this: withdraw USDC from Aave (real) + bridge
// CCIP-BnM tokens via CCIP (proves cross-chain messaging). The SpokeVault
// receives the BnM tokens + data payload and supplies local USDC to Aave.

function writeTestnetRotateAction(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  destChain: bigint,
  amount: bigint,
  bridgeToken: string,
  bridgeAmount: bigint,
  yieldBps: bigint,
  costBps: bigint
): { txHash: string; innerResult: string } {
  runtime.log(
    `Writing TESTNET_ROTATE action: destChain=${destChain}, amount=${amount}, bridgeToken=${bridgeToken}, bridgeAmount=${bridgeAmount}`
  )

  // ABI-encode: (uint8, uint64, uint256, address, uint256, uint256, uint256)
  const reportData = encodeAbiParameters(TestnetRotateActionParams, [
    ActionType.TESTNET_ROTATE,
    destChain,
    amount,
    bridgeToken as `0x${string}`,
    bridgeAmount,
    yieldBps,
    costBps,
  ])

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.consumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`TESTNET_ROTATE report delivery FAILED: status=${writeResult.txStatus}, tx=${txHash}`)
    return { txHash, innerResult: "reverted" }
  }

  const innerResult = resolveInnerResult(runtime, evmClient, writeResult)
  runtime.log(`TESTNET_ROTATE ${innerResult === "reverted" ? "FAILED (onReport reverted)" : innerResult}: tx=${txHash}`)

  return { txHash, innerResult }
}

// ─── Write Action to Consumer Contract ──────────────────────────────

function writeAction(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  actionType: number
): { txHash: string; innerResult: string } {
  runtime.log(`Writing action ${actionType} to consumer: ${evmConfig.consumerAddress}`)

  // ABI-encode the ActionType (uint8)
  const reportData = encodeAbiParameters(ActionTypeParams, [actionType])

  // Generate signed report
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  // Submit to consumer contract via KeystoneForwarder
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.consumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`Action ${actionType} report delivery FAILED: status=${writeResult.txStatus}, tx=${txHash}`)
    return { txHash, innerResult: "reverted" }
  }

  const innerResult = resolveInnerResult(runtime, evmClient, writeResult)
  runtime.log(`Action ${actionType} ${innerResult === "reverted" ? "FAILED (onReport reverted)" : innerResult}: tx=${txHash}`)

  return { txHash, innerResult }
}

// ─── Recall Evaluation (Priority 1) ──────────────────────────────

function evaluateRecall(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  config: Config,
  shortfall: bigint
): { txHash: string; innerResult: string } | null {
  if (!config.crossChains) return null

  // Read remote balances from the vault via StrategyController
  // Use the first chain with sufficient balance
  for (const chain of config.crossChains) {
    const chainSelector = BigInt(chain.chainSelector)

    // Read remote balance from vault
    const callData = encodeFunctionData({
      abi: parseAbi(["function remoteBalances(uint64) view returns (uint256)"]),
      functionName: "remoteBalances",
      args: [chainSelector],
    })

    try {
      const result = evmClient
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: evmConfig.vaultAddress as Address,
            data: callData,
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result()

      const remoteBalance = decodeFunctionResult({
        abi: parseAbi(["function remoteBalances(uint64) view returns (uint256)"]),
        functionName: "remoteBalances",
        data: bytesToHex(result.data),
      }) as bigint

      if (remoteBalance === 0n) continue

      // Recall the minimum of shortfall and remote balance
      const recallAmount = shortfall < remoteBalance ? shortfall : remoteBalance
      runtime.log(
        `Recalling ${recallAmount} from ${chain.chainName} (remote balance: ${remoteBalance})`
      )

      // On testnet, use TESTNET_RECALL (USDC can't be bridged via CCIP on testnet)
      const isTestnet = evmConfig.chainName.includes("testnet")
      if (isTestnet && chain.bridgeToken) {
        runtime.log(
          `Using TESTNET_RECALL: bridgeToken=${chain.bridgeToken} (spoke-chain BnM for return bridge)`
        )
        // bridgeToken in config is the BnM on the SPOKE chain (Arb Sepolia)
        // The Arb Sepolia BnM is different from the Base Sepolia BnM
        const arbBnmToken = "0xA8C0c11bf64AF62CDCA6f93D3769B88BdD7cb93D"
        return writeTestnetRecallAction(
          runtime,
          evmClient,
          evmConfig,
          chainSelector,
          recallAmount,
          arbBnmToken
        )
      }

      return writeRecallRemoteAction(
        runtime,
        evmClient,
        evmConfig,
        chainSelector,
        recallAmount
      )
    } catch {
      runtime.log(`Failed to read remote balance for ${chain.chainName}`)
      continue
    }
  }

  runtime.log("No chain with sufficient remote balance for recall")
  return null
}

// ─── Write Fulfill Redemptions Action ────────────────────────────

function writeFulfillRedemptionsAction(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  maxToProcess: bigint
): { txHash: string; innerResult: string } {
  runtime.log(`Writing FULFILL_REDEMPTIONS action: maxToProcess=${maxToProcess}`)

  const reportData = encodeAbiParameters(FulfillRedemptionsParams, [
    ActionType.FULFILL_REDEMPTIONS,
    maxToProcess,
  ])

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.consumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`FULFILL_REDEMPTIONS report delivery FAILED: status=${writeResult.txStatus}, tx=${txHash}`)
    return { txHash, innerResult: "reverted" }
  }

  const innerResult = resolveInnerResult(runtime, evmClient, writeResult)
  runtime.log(`FULFILL_REDEMPTIONS ${innerResult === "reverted" ? "FAILED" : innerResult}: tx=${txHash}`)

  return { txHash, innerResult }
}

// ─── Write Recall Remote Action ──────────────────────────────────

function writeRecallRemoteAction(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  chainSelector: bigint,
  amount: bigint
): { txHash: string; innerResult: string } {
  runtime.log(
    `Writing RECALL_REMOTE action: chainSelector=${chainSelector}, amount=${amount}`
  )

  const reportData = encodeAbiParameters(RecallRemoteParams, [
    ActionType.RECALL_REMOTE,
    chainSelector,
    amount,
  ])

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.consumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`RECALL_REMOTE report delivery FAILED: status=${writeResult.txStatus}, tx=${txHash}`)
    return { txHash, innerResult: "reverted" }
  }

  const innerResult = resolveInnerResult(runtime, evmClient, writeResult)
  runtime.log(`RECALL_REMOTE ${innerResult === "reverted" ? "FAILED" : innerResult}: tx=${txHash}`)

  return { txHash, innerResult }
}

// ─── Write Testnet Recall Action ─────────────────────────────────
// On testnet, USDC can't be bridged via CCIP. TESTNET_RECALL tells the SpokeVault
// to withdraw from Aave (real) + bridge BnM tokens back (proves CCIP works).

function writeTestnetRecallAction(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  evmConfig: EvmConfig,
  chainSelector: bigint,
  amount: bigint,
  bridgeToken: string
): { txHash: string; innerResult: string } {
  runtime.log(
    `Writing TESTNET_RECALL action: chainSelector=${chainSelector}, amount=${amount}, bridgeToken=${bridgeToken}`
  )

  const reportData = encodeAbiParameters(TestnetRecallParams, [
    ActionType.TESTNET_RECALL,
    chainSelector,
    amount,
    bridgeToken as `0x${string}`,
  ])

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.consumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    runtime.log(`TESTNET_RECALL report delivery FAILED: status=${writeResult.txStatus}, tx=${txHash}`)
    return { txHash, innerResult: "reverted" }
  }

  const innerResult = resolveInnerResult(runtime, evmClient, writeResult)
  runtime.log(`TESTNET_RECALL ${innerResult === "reverted" ? "FAILED" : innerResult}: tx=${txHash}`)

  return { txHash, innerResult }
}

// ─── HTTP Monitoring Reporter (Phase 6) ─────────────────────────────

function reportToMonitoring(
  runtime: Runtime<Config>,
  result: WorkflowResult
): void {
  runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<Config>): string => {
      const monitoringEndpoint = nodeRuntime.config.monitoring?.endpoint
      if (!monitoringEndpoint) return "no-endpoint"

      const httpClient = new HTTPClient()
      const payload = JSON.stringify({
        timestamp: Date.now(),
        workflow: "yield-keeper-cre",
        ...result,
      })

      try {
        httpClient
          .sendRequest(nodeRuntime, {
            url: monitoringEndpoint,
            method: "POST" as const,
            headers: { "Content-Type": "application/json" },
            body: new TextEncoder().encode(payload),
          })
          .result()
        return "reported"
      } catch {
        nodeRuntime.log("Monitoring report failed (non-critical)")
        return "failed"
      }
    },
    consensusMedianAggregation()
  )()
  // Fire-and-forget: don't block on monitoring result
}

// ─── Entry Point ────────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
