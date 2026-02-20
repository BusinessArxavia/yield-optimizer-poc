import {
  type Chain,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  mainnet,
  bsc,
} from "viem/chains";

export interface AaveChainConfig {
  chain: Chain;
  chainId: number;
  name: string;
  rpcEnvKey: string;
  aave: {
    pool: `0x${string}`;
    poolAddressesProvider: `0x${string}`;
    uiPoolDataProvider: `0x${string}`;
    uiIncentiveDataProvider: `0x${string}`;
  };
  priority: "primary" | "secondary";
}

// Aave V3 contract addresses from @bgd-labs/aave-address-book
// These are hardcoded to avoid issues with the address-book package exports
export const AAVE_CHAINS: AaveChainConfig[] = [
  {
    chain: base,
    chainId: 8453,
    name: "Base",
    rpcEnvKey: "RPC_BASE",
    aave: {
      pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
      poolAddressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
      uiPoolDataProvider: "0x174446a6741300cD2E7C1b1A636Fee99c8F83502",
      uiIncentiveDataProvider: "0xEdD3b4737C1a0011626631a977b91Cf3E944982d",
    },
    priority: "primary",
  },
  {
    chain: arbitrum,
    chainId: 42161,
    name: "Arbitrum",
    rpcEnvKey: "RPC_ARBITRUM",
    aave: {
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
      poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0x145dE30c929a065582da84Cf96F88460dB9745A7",
      uiIncentiveDataProvider: "0xA7F8A757C4f7696c015B595F51B2901AC0e2cEAa",
    },
    priority: "primary",
  },
  {
    chain: optimism,
    chainId: 10,
    name: "Optimism",
    rpcEnvKey: "RPC_OPTIMISM",
    aave: {
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
      poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0xbd83DdBE37fc91923d59C8c1E0bDe0CccCa332d5",
      uiIncentiveDataProvider: "0x6C0b51739E5427C427C53aefEF1B15e2e3aAb9f2",
    },
    priority: "primary",
  },
  {
    chain: polygon,
    chainId: 137,
    name: "Polygon",
    rpcEnvKey: "RPC_POLYGON",
    aave: {
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
      poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0xC69728f11E9E6127733751c8410432913123acf1",
      uiIncentiveDataProvider: "0x874313A46e4957D29FAAC43BF5Eb2B144894f557",
    },
    priority: "primary",
  },
  {
    chain: avalanche,
    chainId: 43114,
    name: "Avalanche",
    rpcEnvKey: "RPC_AVALANCHE",
    aave: {
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
      poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0xF71DBe0FAEF1473ffC607d4c555dfF0aEaDb878d",
      uiIncentiveDataProvider: "0x265d414f80b0f905571b2e73B0F8B6b76FfA5F39",
    },
    priority: "primary",
  },
  {
    chain: mainnet,
    chainId: 1,
    name: "Ethereum",
    rpcEnvKey: "RPC_ETHEREUM",
    aave: {
      pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      poolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
      uiPoolDataProvider: "0x91c0eA31b49B69Ea18607702c5d9aC360bf3dE7d",
      uiIncentiveDataProvider: "0x162A7AC02f547ad796CA549f757e2b8d1D9b10a6",
    },
    priority: "primary",
  },
  {
    chain: bsc,
    chainId: 56,
    name: "BNB Chain",
    rpcEnvKey: "RPC_BNB",
    aave: {
      pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
      poolAddressesProvider: "0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D",
      uiPoolDataProvider: "0x23dF2d19C2eA93a0E59E3E0bECc4aDE7A616113a",
      uiIncentiveDataProvider: "0x8Ae55A4cfBCD870D84920F81e36eC87c19E5f6a1",
    },
    priority: "secondary",
  },
];
