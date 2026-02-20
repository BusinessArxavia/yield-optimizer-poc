// @yield-optimizer/monitor
// Yield monitoring & rotation decision engine for Aave V3 stablecoin pools

// Task 1.4 — Aave yield data service
export {
  fetchChainYields,
  fetchChainYieldsFromConfig,
  fetchAllChainYields,
} from "./services/aave-data.js";

// Task 1.5 — Merkl incentive data service
export {
  fetchMerklIncentives,
  clearMerklCache,
} from "./services/incentive-data.js";

// Task 1.6 — DeFi Llama integration
export {
  fetchDefiLlamaYields,
  fetchPoolHistory,
  findPoolId,
  clearDefiLlamaCache,
} from "./services/defillama.js";
export type { DefiLlamaPool, HistoricalYield } from "./services/defillama.js";
// Task 1.7 — Bridge cost estimation
export {
  estimateBridgeCost,
  clearBridgeCostCache,
} from "./services/bridge-cost.js";
// Task 1.8 — Gas oracle service
export {
  getOperationCostUSD,
  getRotationGasCostUSD,
  getGasPrice,
  getNativeTokenPrice,
  clearGasOracleCache,
  OPERATION_GAS_UNITS,
} from "./services/gas-oracle.js";
export type { AaveOperation } from "./services/gas-oracle.js";
// Task 1.9 — Rotation decision engine
export {
  calculateYields,
  getTopPools,
  getBestPoolForStablecoin,
  estimateRotationCost,
  evaluateRotations,
  getRecommendedRotations,
  computeOptimalAllocation,
} from "./engine/index.js";
export type {
  EnrichedPool,
  RotationCostBreakdown,
  CurrentPosition,
  AllocationTarget,
  AllocationDelta,
  OptimalAllocation,
} from "./engine/index.js";
// Task 1.10 — CLI monitor: run with `yarn monitor` (see src/cli.ts)
