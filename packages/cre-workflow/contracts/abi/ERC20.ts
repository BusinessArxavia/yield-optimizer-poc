import { parseAbi } from "viem"

export const ERC20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
])
