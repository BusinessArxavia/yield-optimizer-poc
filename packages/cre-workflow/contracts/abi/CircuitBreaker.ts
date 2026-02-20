import { parseAbi } from "viem"

export const CircuitBreakerAbi = parseAbi([
  "function isActive() view returns (bool)",
  "function currentTier() view returns (uint8)",
  "event TierChanged(uint8 indexed oldTier, uint8 indexed newTier)",
])
