export {
  calculateYields,
  getTopPools,
  getBestPoolForStablecoin,
} from "./yield-calculator.js";
export type { EnrichedPool } from "./yield-calculator.js";

export { estimateRotationCost } from "./rotation-cost.js";
export type { RotationCostBreakdown } from "./rotation-cost.js";

export {
  evaluateRotations,
  getRecommendedRotations,
} from "./rotation-decision.js";
export type { CurrentPosition } from "./rotation-decision.js";

export { computeOptimalAllocation } from "./allocation-optimizer.js";
export type {
  AllocationTarget,
  AllocationDelta,
  OptimalAllocation,
} from "./allocation-optimizer.js";
