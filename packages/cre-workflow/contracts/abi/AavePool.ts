import { parseAbi } from "viem"

// Aave V3 Pool — read current supply/borrow rates
export const AavePoolAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
])

// AToken — for balance checks
export const ATokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
])
