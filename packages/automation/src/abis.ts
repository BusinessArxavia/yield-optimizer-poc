// Minimal ABIs for automation contracts

export const strategyControllerAbi = [
  {
    type: "function",
    name: "executeLocalSupply",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeHarvestYield",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "initiateCrossChainRotation",
    inputs: [
      { name: "destChain", type: "uint64" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "yieldBps", type: "uint256" },
      { name: "costBps", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "validateRotation",
    inputs: [
      { name: "destChain", type: "uint64" },
      { name: "amount", type: "uint256" },
      { name: "yieldBps", type: "uint256" },
      { name: "costBps", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRegisteredChains",
    inputs: [],
    outputs: [{ name: "", type: "uint64[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "spokes",
    inputs: [{ name: "chainSelector", type: "uint64" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const yieldVaultAbi = [
  {
    type: "function",
    name: "totalAssets",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "asset",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "homeChainAssets",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "remoteBalances",
    inputs: [{ name: "chainSelector", type: "uint64" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalInFlight",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getActiveChains",
    inputs: [],
    outputs: [{ name: "", type: "uint64[]" }],
    stateMutability: "view",
  },
] as const;

export const yieldKeeperAbi = [
  {
    type: "function",
    name: "checkUpkeep",
    inputs: [{ name: "checkData", type: "bytes" }],
    outputs: [
      { name: "upkeepNeeded", type: "bool" },
      { name: "performData", type: "bytes" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "performUpkeep",
    inputs: [{ name: "performData", type: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "lastPerformTime",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const deadManSwitchAbi = [
  {
    type: "function",
    name: "isExpired",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "timeRemaining",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "heartbeat",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "triggerFallbackHarvest",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "triggerFallbackSupply",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const ccipRouterAbi = [
  {
    type: "function",
    name: "getFee",
    inputs: [
      { name: "destinationChainSelector", type: "uint64" },
      {
        name: "message",
        type: "tuple",
        components: [
          { name: "receiver", type: "bytes" },
          { name: "data", type: "bytes" },
          {
            name: "tokenAmounts",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "feeToken", type: "address" },
          { name: "extraArgs", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "fee", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ccipSend",
    inputs: [
      { name: "destinationChainSelector", type: "uint64" },
      {
        name: "message",
        type: "tuple",
        components: [
          { name: "receiver", type: "bytes" },
          { name: "data", type: "bytes" },
          {
            name: "tokenAmounts",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "feeToken", type: "address" },
          { name: "extraArgs", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "messageId", type: "bytes32" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "isChainSupported",
    inputs: [{ name: "chainSelector", type: "uint64" }],
    outputs: [{ name: "supported", type: "bool" }],
    stateMutability: "view",
  },
] as const;
