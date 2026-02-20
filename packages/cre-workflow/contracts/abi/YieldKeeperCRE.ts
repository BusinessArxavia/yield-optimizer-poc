import { parseAbiParameters } from "viem"

// ActionType enum maps to uint8 in the report payload
// 0 = SUPPLY_IDLE, 1 = HARVEST_YIELD, 2 = ROTATE, 3 = TESTNET_ROTATE, 4 = FULFILL_REDEMPTIONS, 5 = RECALL_REMOTE
export const ActionTypeParams = parseAbiParameters("uint8 actionType")

// ROTATE carries extra params: destChain, amount, yieldBps, costBps
export const RotateActionParams = parseAbiParameters(
  "uint8 actionType, uint64 destChain, uint256 amount, uint256 yieldBps, uint256 costBps"
)

// TESTNET_ROTATE carries extra params: bridgeToken + bridgeAmount
// On testnet, Aave faucet USDC is not registered in CCIP token pools, so we bridge
// CCIP-BnM tokens instead. The flow: withdraw USDC from Aave + bridge BnM via CCIP.
export const TestnetRotateActionParams = parseAbiParameters(
  "uint8 actionType, uint64 destChain, uint256 amount, address bridgeToken, uint256 bridgeAmount, uint256 yieldBps, uint256 costBps"
)

// FULFILL_REDEMPTIONS: (uint8, uint256)
export const FulfillRedemptionsParams = parseAbiParameters(
  "uint8 actionType, uint256 maxToProcess"
)

// RECALL_REMOTE: (uint8, uint64, uint256)
export const RecallRemoteParams = parseAbiParameters(
  "uint8 actionType, uint64 chainSelector, uint256 amount"
)

// TESTNET_RECALL: (uint8, uint64, uint256, address)
export const TestnetRecallParams = parseAbiParameters(
  "uint8 actionType, uint64 chainSelector, uint256 amount, address bridgeToken"
)

export const ActionType = {
  SUPPLY_IDLE: 0,
  HARVEST_YIELD: 1,
  ROTATE: 2,
  TESTNET_ROTATE: 3,
  FULFILL_REDEMPTIONS: 4,
  RECALL_REMOTE: 5,
  TESTNET_RECALL: 6,
} as const
