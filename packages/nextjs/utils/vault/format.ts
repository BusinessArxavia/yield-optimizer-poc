import { formatUnits } from "viem";

export const formatUSDC = (value: bigint | undefined, decimals: number): string => {
  if (value === undefined) return "...";
  return Number(formatUnits(value, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

/** Compute percentage using bigint math to avoid precision loss. */
export const bigintPct = (val: bigint, total: bigint): string => {
  if (total === 0n) return "0";
  const bps = (val * 1000n) / total;
  return (Number(bps) / 10).toFixed(1);
};
