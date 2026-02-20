# @yield-optimizer/monitor

Yield monitoring and rotation decision engine for Aave V3 stablecoin pools across multiple chains.

## What it does

This package fetches real-time yield data from Aave V3, DeFi Llama, and Merkl, estimates bridge/gas costs, and recommends optimal cross-chain rotations for the vault's capital.

## Architecture

```
src/
  services/          Data fetchers
    aave-data.ts       Aave V3 on-chain rates (supply APY, utilization, liquidity)
    defillama.ts       DeFi Llama pool yields + historical data
    incentive-data.ts  Merkl reward incentives
    bridge-cost.ts     CCIP bridge cost estimation
    gas-oracle.ts      Gas price + operation cost in USD

  engine/            Decision logic
    yield-calculator.ts    Net yield (base APY + incentives - gas costs)
    rotation-cost.ts       Full rotation cost breakdown (bridge + gas + slippage)
    rotation-decision.ts   Should-rotate evaluation with minimum threshold
    allocation-optimizer.ts  Multi-chain optimal allocation solver
    index.ts               Unified API re-exports

  cli.ts             CLI monitor (yarn monitor)
  index.ts           Library entry point
```

## Usage

### As a library

```typescript
import {
  fetchAllChainYields,
  getRecommendedRotations,
  computeOptimalAllocation,
} from "@yield-optimizer/monitor";
```

### As a CLI

```bash
yarn monitor
```

## Tests

```bash
cd packages/monitor
yarn test        # 123 tests
```

## Environment variables

The monitor reads RPC endpoints from the environment. See the root `.env.example` for the full list. At minimum you need Alchemy (or equivalent) RPC URLs for the chains you want to monitor.
