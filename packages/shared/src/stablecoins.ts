export interface StablecoinConfig {
  symbol: string;
  decimals: number;
  addresses: Record<number, `0x${string}` | undefined>;
  cctpSupported: boolean;
}

export const STABLECOINS: StablecoinConfig[] = [
  {
    symbol: "USDC",
    decimals: 6,
    cctpSupported: true,
    addresses: {
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
      42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
      10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism
      137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
      43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Avalanche
      56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BNB
    },
  },
  {
    symbol: "USDT",
    decimals: 6,
    cctpSupported: false,
    addresses: {
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      43114: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
      56: "0x55d398326f99059fF775485246999027B3197955",
    },
  },
  {
    symbol: "DAI",
    decimals: 18,
    cctpSupported: false,
    addresses: {
      1: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      42161: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      10: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      137: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      43114: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70",
    },
  },
  {
    symbol: "GHO",
    decimals: 18,
    cctpSupported: false,
    addresses: {
      1: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
      42161: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33",
    },
  },
];
