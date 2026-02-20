import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../../services/gas-oracle.js", () => ({
  getRotationGasCostUSD: vi.fn(),
}));

vi.mock("../../services/bridge-cost.js", () => ({
  estimateBridgeCost: vi.fn(),
}));

import { getRotationGasCostUSD } from "../../services/gas-oracle.js";
import { estimateBridgeCost } from "../../services/bridge-cost.js";
import { estimateRotationCost } from "../rotation-cost.js";

// --- Tests ---

describe("rotation-cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("combines gas + bridge costs", async () => {
    (getRotationGasCostUSD as ReturnType<typeof vi.fn>).mockResolvedValue(0.50);
    (estimateBridgeCost as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: "cctp",
      feesUSD: 10,
      gasUSD: 0.05,
      totalUSD: 10.05,
      estimatedDurationSeconds: 60,
    });

    const result = await estimateRotationCost(
      8453, 42161, "USDC", 100_000_000_000n,
    );

    expect(result.gasCostUSD).toBeCloseTo(0.50, 2);
    expect(result.bridgeCostUSD).toBeCloseTo(10.05, 2);
    expect(result.totalCostUSD).toBeCloseTo(10.55, 2);
    expect(result.bridgeProvider).toBe("cctp");
    expect(result.bridgeDurationSeconds).toBe(60);
  });

  it("handles null bridge estimate (no route)", async () => {
    (getRotationGasCostUSD as ReturnType<typeof vi.fn>).mockResolvedValue(0.30);
    (estimateBridgeCost as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await estimateRotationCost(
      8453, 42161, "UNKNOWN", 1_000_000n,
    );

    expect(result.gasCostUSD).toBeCloseTo(0.30, 2);
    expect(result.bridgeCostUSD).toBe(0);
    expect(result.totalCostUSD).toBeCloseTo(0.30, 2);
    expect(result.bridgeProvider).toBeNull();
  });

  it("fetches gas and bridge in parallel", async () => {
    let gasResolved = false;
    let bridgeResolved = false;

    (getRotationGasCostUSD as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            gasResolved = true;
            resolve(0.10);
          }, 10),
        ),
    );

    (estimateBridgeCost as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            bridgeResolved = true;
            resolve({
              provider: "lifi",
              feesUSD: 2.5,
              gasUSD: 0.05,
              totalUSD: 2.55,
              estimatedDurationSeconds: 120,
            });
          }, 10),
        ),
    );

    const result = await estimateRotationCost(
      8453, 42161, "USDT", 50_000_000_000n,
    );

    expect(gasResolved).toBe(true);
    expect(bridgeResolved).toBe(true);
    expect(result.totalCostUSD).toBeCloseTo(2.65, 2);
  });

  it("passes correct params to bridge estimator", async () => {
    (getRotationGasCostUSD as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (estimateBridgeCost as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await estimateRotationCost(8453, 137, "USDC", 50_000_000_000n);

    expect(estimateBridgeCost).toHaveBeenCalledWith({
      fromChainId: 8453,
      toChainId: 137,
      stablecoin: "USDC",
      amount: 50_000_000_000n,
    });
  });
});
