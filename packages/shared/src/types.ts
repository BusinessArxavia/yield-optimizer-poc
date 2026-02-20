export interface PoolYieldData {
  chainId: number;
  chainName: string;
  stablecoin: string;
  tokenAddress: `0x${string}`;
  supplyAPY: number; // base supply APY (decimal, e.g., 0.0315 = 3.15%)
  incentiveAPY: number; // on-chain Aave incentive APY
  merklAPY: number; // Merkl campaign APY
  netAPY: number; // total = supply + incentive + merkl
  totalSupplied: bigint; // total supplied in base units
  supplyCap: bigint; // governance supply cap
  supplyCapHeadroom: bigint; // remaining capacity
  utilizationRate: number; // decimal (0-1)
  timestamp: number;
}

export interface RotationCandidate {
  from: { chainId: number; stablecoin: string; currentAPY: number };
  to: { chainId: number; stablecoin: string; targetAPY: number };
  yieldImprovement: number; // decimal APY difference
  estimatedCost: number; // USD cost of rotation
  dailyGain: number; // USD daily gain from the spread
  breakEvenDays: number; // days to recoup rotation cost
  netBenefitAnnualized: number; // annualized USD benefit after cost
  recommended: boolean; // passes threshold checks
}

export interface RotationConfig {
  minSpreadBps: number; // minimum APY spread in basis points (e.g., 25 = 0.25%)
  maxBreakEvenDays: number; // max days to break even (e.g., 7)
  maxInFlightPct: number; // max % of TVL in flight (e.g., 15)
  maxPerChainPct: number; // max % of TVL on one chain (e.g., 40)
  maxRotationPct: number; // max % of TVL in single rotation (e.g., 20)
  checkIntervalMs: number; // monitoring interval (e.g., 6 * 60 * 60 * 1000 for 6h)
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  minSpreadBps: 25,
  maxBreakEvenDays: 7,
  maxInFlightPct: 15,
  maxPerChainPct: 40,
  maxRotationPct: 20,
  checkIntervalMs: 6 * 60 * 60 * 1000,
};

export interface BridgeCostParams {
  fromChainId: number;
  toChainId: number;
  stablecoin: string;
  amount: bigint;
}

export interface BridgeCostEstimate {
  provider: "cctp" | "ccip" | "lifi";
  feesUSD: number;
  gasUSD: number;
  totalUSD: number;
  estimatedDurationSeconds: number;
}
