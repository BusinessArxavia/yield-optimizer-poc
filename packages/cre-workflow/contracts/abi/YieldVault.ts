import { parseAbi } from "viem"

export const YieldVaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function lastHarvestSharePrice() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function asset() view returns (address)",
  "function pendingRedeemCount() view returns (uint256)",
  "function totalPendingAssets() view returns (uint256)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
])
