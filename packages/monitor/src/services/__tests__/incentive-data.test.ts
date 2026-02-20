import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchMerklIncentives,
  clearMerklCache,
} from "../incentive-data.js";

// --- Test fixtures ---

function makeOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    name: "Lend USDC on Aave",
    status: "LIVE",
    action: "LEND",
    apr: 3.5,
    tvl: 50_000_000,
    depositUrl:
      "https://app.aave.com/reserve-overview/?underlyingAsset=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&marketName=proto_base_v3",
    tokens: [
      {
        symbol: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        chainId: 8453,
        decimals: 6,
        verified: true,
      },
    ],
    aprRecord: {
      cumulated: 3.5,
      breakdowns: [{ value: 3.5, identifier: "0xabc" }],
    },
    ...overrides,
  };
}

const MOCK_OPPORTUNITIES = [
  // Base USDC — 3.5% incentive APR
  makeOpportunity(),
  // Arbitrum USDT — 2.1% incentive APR
  makeOpportunity({
    chainId: 42161,
    name: "Lend USDT on Aave",
    apr: 2.1,
    depositUrl:
      "https://app.aave.com/reserve-overview/?underlyingAsset=0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9&marketName=proto_arbitrum_v3",
    tokens: [
      {
        symbol: "USDT",
        address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        chainId: 42161,
        decimals: 6,
        verified: true,
      },
    ],
    aprRecord: { cumulated: 2.1, breakdowns: [] },
  }),
  // PAST opportunity — should be ignored
  makeOpportunity({
    chainId: 1,
    name: "Lend DAI on Aave",
    status: "PAST",
    apr: 5.0,
    aprRecord: { cumulated: 5.0, breakdowns: [] },
  }),
  // Zero APR — should be ignored
  makeOpportunity({
    chainId: 137,
    name: "Lend USDC on Aave",
    apr: 0,
    aprRecord: { cumulated: 0, breakdowns: [] },
  }),
];

// --- Tests ---

describe("incentive-data", () => {
  beforeEach(() => {
    clearMerklCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearMerklCache();
  });

  it("fetches and parses Merkl opportunities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_OPPORTUNITIES), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const incentives = await fetchMerklIncentives();

    // Should have 2 entries: Base USDC + Arbitrum USDT
    // PAST and zero-APR are filtered out
    expect(incentives.size).toBe(2);
  });

  it("converts percentage APR to decimal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_OPPORTUNITIES), { status: 200 }),
    );

    const incentives = await fetchMerklIncentives();

    // Base USDC: 3.5% → 0.035
    const baseUSDC =
      incentives.get(
        "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ) ?? 0;
    expect(baseUSDC).toBeCloseTo(0.035, 4);

    // Arbitrum USDT: 2.1% → 0.021
    const arbUSDT =
      incentives.get(
        "42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      ) ?? 0;
    expect(arbUSDT).toBeCloseTo(0.021, 4);
  });

  it("extracts token address from depositUrl", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([makeOpportunity()]), { status: 200 }),
    );

    const incentives = await fetchMerklIncentives();

    // Key should use the address from depositUrl, lowercased
    expect(
      incentives.has(
        "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ),
    ).toBe(true);
  });

  it("falls back to tokens array when depositUrl has no underlyingAsset", async () => {
    const opp = makeOpportunity({
      depositUrl: "https://app.aave.com/reserve-overview/",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([opp]), { status: 200 }),
    );

    const incentives = await fetchMerklIncentives();

    // Should still extract from tokens array
    expect(incentives.size).toBe(1);
    expect(
      incentives.has(
        "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ),
    ).toBe(true);
  });

  it("takes highest APR when multiple campaigns target same token", async () => {
    const opps = [
      makeOpportunity({ aprRecord: { cumulated: 2.0, breakdowns: [] } }),
      makeOpportunity({ aprRecord: { cumulated: 5.0, breakdowns: [] } }),
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(opps), { status: 200 }),
    );

    const incentives = await fetchMerklIncentives();

    const baseUSDC =
      incentives.get(
        "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ) ?? 0;
    expect(baseUSDC).toBeCloseTo(0.05, 4); // 5.0% → 0.05
  });

  it("caches results for 30 minutes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(MOCK_OPPORTUNITIES), { status: 200 }),
    );

    // First call — fetches from API
    await fetchMerklIncentives();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    await fetchMerklIncentives();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache expires", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_OPPORTUNITIES), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_OPPORTUNITIES), { status: 200 }),
      );

    await fetchMerklIncentives();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Clear cache to simulate expiry
    clearMerklCache();

    await fetchMerklIncentives();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns empty map on API failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network error"),
    );

    const incentives = await fetchMerklIncentives();

    expect(incentives.size).toBe(0);
  });

  it("returns empty map on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const incentives = await fetchMerklIncentives();

    expect(incentives.size).toBe(0);
  });

  it("filters out non-LEND actions", async () => {
    const opps = [
      makeOpportunity({ action: "BORROW" }),
      makeOpportunity({
        chainId: 42161,
        action: "LEND",
        depositUrl:
          "https://app.aave.com/reserve-overview/?underlyingAsset=0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        tokens: [
          {
            symbol: "USDC",
            address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            chainId: 42161,
            decimals: 6,
            verified: true,
          },
        ],
        aprRecord: { cumulated: 1.5, breakdowns: [] },
      }),
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(opps), { status: 200 }),
    );

    const incentives = await fetchMerklIncentives();

    // Only the LEND opportunity should be included
    expect(incentives.size).toBe(1);
  });

  it("handles pagination when results exceed page size", async () => {
    // First page: full 20 items
    const page1 = Array.from({ length: 20 }, (_, i) =>
      makeOpportunity({
        chainId: 1,
        depositUrl: `https://app.aave.com/reserve-overview/?underlyingAsset=0x${"a".repeat(39)}${i.toString(16)}`,
        aprRecord: { cumulated: 1.0 + i * 0.1, breakdowns: [] },
      }),
    );
    // Second page: fewer than 20 items (last page)
    const page2 = [
      makeOpportunity({
        chainId: 42161,
        depositUrl:
          "https://app.aave.com/reserve-overview/?underlyingAsset=0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        aprRecord: { cumulated: 2.0, breakdowns: [] },
      }),
    ];

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page1), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page2), { status: 200 }),
      );

    const incentives = await fetchMerklIncentives();

    // Should have fetched 2 pages
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // 20 unique from page 1 + 1 from page 2
    expect(incentives.size).toBe(21);
  });
});
