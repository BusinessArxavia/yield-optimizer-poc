# Aave Cross-Chain Yield Optimizer

An ERC-4626 vault that optimizes USDC yield across Aave V3 deployments on multiple chains, using Chainlink CCIP for cross-chain rotations and CRE (Chainlink Runtime Environment) workflows for decentralized automation.

Built on [Scaffold-ETH 2](https://scaffoldeth.io) (Foundry flavor).

## Architecture

```
                  +------------------------------------------------------+
                  |                  Base (Home Chain)                   |
                  |                                                      |
  User --> VaultGateway --> YieldVault (ERC-4626) --> Aave V3 Pool       |
                  |              |                                       |
                  |       StrategyController                             |
                  |         |           |                                |
                  |   CircuitBreaker   YieldKeeper (Chainlink Automation)|
                  |                    YieldKeeperCRE (CRE consumer)     |
                  |                    DeadManSwitch (Gelato backup)     |
                  |                    RewardHarvester                   |
                  +----------+---------+---------------------------------+
                             |         |
                   CCIP      |         | CRE Workflow (off-chain)
                             |         |
                  +----------v---------v--------------------------------+
                  |   packages/cre-workflow                             |
                  |   - Cron trigger (30s): read vault, decide, write   |
                  |   - Event triggers: Deposit/Withdraw, CircuitBreaker|
                  |   - Cross-chain reads: Aave rates on Base + Arb     |
                  |   - Off-chain data: DeFiLlama yield comparison      |
                  |   - HTTP monitoring: POST execution reports         |
                  +-----------------------------------------------------+
                             |
                   CCIP      |
                             |
                  +----------v------------------------------------------+
                  |            Arbitrum (Spoke Chain)                   |
                  |                                                     |
                  |   SpokeVault --> Aave V3 Pool                       |
                  +-----------------------------------------------------+
```

### Smart Contracts

| Contract | Description |
|---|---|
| **YieldVault** | ERC-4626 vault with Aave V3 supply/withdraw, performance fees, async redemption queue, and emergency withdraw |
| **VaultGateway** | Slippage-protected entry point -- users approve and deposit through the gateway |
| **StrategyController** | Manages local Aave operations, cross-chain rotations via CCIP, partial remote recalls, redemption queue fulfillment, timelocked parameter changes, and keeper-driven harvest |
| **CircuitBreaker** | Safety oracle with NORMAL/CAUTION/CRITICAL levels -- blocks deposits at CRITICAL, never blocks withdrawals |
| **SpokeVault** | Remote-chain vault that receives CCIP instructions (supply, withdraw, report balance) |
| **YieldKeeper** | Chainlink Automation upkeep -- auto-supplies idle funds and harvests yield |
| **YieldKeeperCRE** | CRE consumer contract (IReceiver) -- receives workflow reports via KeystoneForwarder, executes 6 action types: SUPPLY_IDLE, HARVEST_YIELD, ROTATE, TESTNET_ROTATE, FULFILL_REDEMPTIONS, RECALL_REMOTE |
| **DeadManSwitch** | Gelato-compatible fallback -- triggers if primary automation goes silent for 24h |
| **RewardHarvester** | Claims and compounds Aave reward tokens back into the vault |

### Contract Wiring

Contracts use OpenZeppelin `AccessControl` for role-based permissions. After deployment, roles must be granted in the correct order. The full wiring is automated in `DeployAllTestnet.s.sol`.

```
 Deploy Order              Role Grants (post-deploy)
 ────────────              ─────────────────────────

 1. CircuitBreaker    ──►  grant VAULT_ROLE → YieldVault

 2. YieldVault        ──►  grant STRATEGY_ROLE → StrategyController
                           grant STRATEGY_ROLE → RewardHarvester
                           revoke STRATEGY_ROLE from deployer

 3. StrategyController ──► grant KEEPER_ROLE → YieldKeeper
                           grant KEEPER_ROLE → DeadManSwitch
                           grant KEEPER_ROLE → YieldKeeperCRE

 4. VaultGateway           (stateless, no roles)

 5. RewardHarvester   ──►  grant KEEPER_ROLE → YieldKeeper

 6. YieldKeeper       ──►  call setForwarder(chainlinkForwarderAddress)

 7. DeadManSwitch          (guardian set in constructor)

 8. YieldKeeperCRE    ──►  call setExpectedWorkflowId() + setExpectedWorkflowOwner()
                           (forwarder set in constructor)

 9. SpokeVault (remote chain)
    └─► On home chain: StrategyController.queueRegisterSpoke()
        wait for timelock (1 min testnet / 48h mainnet)
        then: StrategyController.executeRegisterSpoke()
```

<details>
<summary>Role reference per contract</summary>

| Contract | Role | Who gets it | What it allows |
|---|---|---|---|
| CircuitBreaker | `PAUSER_ROLE` | Admin (deployer) | Emergency pause (set CRITICAL tier) |
| CircuitBreaker | `UNPAUSER_ROLE` | Admin (multisig in prod) | Deactivate emergency pause |
| CircuitBreaker | `VAULT_ROLE` | YieldVault | Update TVL and share price snapshots |
| YieldVault | `STRATEGY_ROLE` | StrategyController, RewardHarvester | Supply/withdraw Aave, update balances, harvest |
| YieldVault | `ADMIN_ROLE` | Deployer | Emergency withdraw, configuration |
| StrategyController | `KEEPER_ROLE` | YieldKeeper, DeadManSwitch, YieldKeeperCRE | Execute supply, harvest, rotation |
| StrategyController | `ADMIN_ROLE` | Deployer | Register spokes (timelocked), set parameters |
| RewardHarvester | `KEEPER_ROLE` | YieldKeeper | Trigger Aave/Merkl reward claims |
| RewardHarvester | `SWAPPER_ROLE` | Deployer (testnet) | Withdraw rewards for off-chain swap, reinvest |
| DeadManSwitch | `GUARDIAN_ROLE` | Monitoring service | Heartbeat signal, fallback triggers |
| SpokeVault | `ADMIN_ROLE` | Deployer | Set CCIP gas limit |

</details>

### Workspace Packages

| Package | Purpose |
|---|---|
| `packages/foundry` | Solidity contracts, tests (242), and deploy scripts |
| `packages/nextjs` | Vault dashboard (deposit/withdraw, strategy allocation, CRE simulation, cross-chain tracking, async redemption queue, interactive demo) |
| `packages/cre-workflow` | CRE workflow -- TypeScript compiled to WASM, runs on Chainlink DON |
| `packages/monitor` | TypeScript data pipeline -- fetches Aave rates, computes optimal rotations (123 tests) |
| `packages/automation` | TypeScript modules for CRE yield checks, CCIP transfers, CCTP bridges, dead man switch |
| `packages/shared` | Shared types and utilities across TS packages |

## Testnet Deployment

Currently deployed on **Base Sepolia** (home chain) and **Arbitrum Sepolia** (spoke chain). All contracts verified on block explorers.

<details>
<summary>Base Sepolia contracts (chain 84532)</summary>

| Contract | Address |
|---|---|
| CircuitBreaker | [`0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f`](https://sepolia.basescan.org/address/0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f) |
| YieldVault | [`0x601F653c1F8940246fECEbCb9dEF8E6322c35570`](https://sepolia.basescan.org/address/0x601F653c1F8940246fECEbCb9dEF8E6322c35570) |
| StrategyController | [`0x93e37393D12FB6874190b7E38D7AdE096ceBEF90`](https://sepolia.basescan.org/address/0x93e37393D12FB6874190b7E38D7AdE096ceBEF90) |
| VaultGateway | [`0xDc8a5959cB1aEB3937B819924271381A1CC9cC78`](https://sepolia.basescan.org/address/0xDc8a5959cB1aEB3937B819924271381A1CC9cC78) |
| RewardHarvester | [`0x6aa643dfD56f3dE2372671879752464E15E466C3`](https://sepolia.basescan.org/address/0x6aa643dfD56f3dE2372671879752464E15E466C3) |
| YieldKeeper | [`0x5143CBB3D38227BDf6F039F9a1410DDE30fce338`](https://sepolia.basescan.org/address/0x5143CBB3D38227BDf6F039F9a1410DDE30fce338) |
| YieldKeeperCRE | [`0x9B39815964a87eF361d555BD99FfdcDEbe4753bb`](https://sepolia.basescan.org/address/0x9B39815964a87eF361d555BD99FfdcDEbe4753bb) |
| DeadManSwitch | [`0x23C088Ec7598549dFc1107f52A619f99466a4B45`](https://sepolia.basescan.org/address/0x23C088Ec7598549dFc1107f52A619f99466a4B45) |

> These are v8 testnet contracts (Phase 7: redemption queue automation + partial remote recall). All 7 action types are active on-chain.

</details>

<details>
<summary>Arbitrum Sepolia contracts (chain 421614)</summary>

| Contract | Address |
|---|---|
| SpokeVault | [`0x99f90636e87646113480F4cfC631f02E0EE4cC22`](https://sepolia.arbiscan.io/address/0x99f90636e87646113480F4cfC631f02E0EE4cC22) |

</details>

## Requirements

- [Node.js >= v20](https://nodejs.org/en/download/)
- [Yarn](https://classic.yarnpkg.com/en/docs/install/)
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- [Git](https://git-scm.com/downloads)
- [CRE CLI](https://docs.chain.link/cre) (optional -- only needed for CRE workflow simulation/deployment)
- [Bun](https://bun.sh) (optional -- only needed for CRE workflow)

> **Package managers:** The root project and all packages use **Yarn**. The CRE workflow (`packages/cre-workflow`) additionally uses **Bun** because the CRE SDK toolchain (`cre-setup`, WASM compilation) requires it. You do not need Bun unless you are working on the CRE workflow.

### Environment Setup

Each package has its own `.env.example` with the variables it needs:

| File | What to do | Required for |
|---|---|---|
| `packages/foundry/.env.example` | Copy to `packages/foundry/.env` | All contract work (deploy, test, verify) |
| `packages/nextjs/.env.example` | Copy to `packages/nextjs/.env.local` | Frontend development |
| `packages/cre-workflow/.env.example` | Copy to `packages/cre-workflow/.env` | CRE workflow only |

```bash
# Quick setup (copies all .env templates)
cp packages/foundry/.env.example packages/foundry/.env
cp packages/nextjs/.env.example packages/nextjs/.env.local
cp packages/cre-workflow/.env.example packages/cre-workflow/.env
```

The Foundry `.env` ships with default API keys that work out of the box for local development and basic testnet usage. For production, replace them with your own keys.

**Key variables:**

| Variable | Where | Purpose | Default provided? |
|---|---|---|---|
| `ALCHEMY_API_KEY` | `packages/foundry/.env` | RPC endpoints in `foundry.toml` | Yes |
| `ETHERSCAN_API_KEY` | `packages/foundry/.env` | Contract verification | Yes |
| `RPC_BASE` | `packages/foundry/.env` | Fork tests against Base mainnet | Yes |
| `NEXT_PUBLIC_ALCHEMY_API_KEY` | `packages/nextjs/.env.local` | Frontend RPC | Yes (fallback in scaffold.config.ts) |
| `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | `packages/nextjs/.env.local` | WalletConnect | Yes (fallback in scaffold.config.ts) |
| `CRE_ETH_PRIVATE_KEY` | `packages/cre-workflow/.env` | CRE simulate --broadcast | No -- add your funded testnet key |

## Quickstart

```bash
# Install dependencies
yarn install

# Start local chain
yarn chain

# Deploy contracts (local)
yarn deploy

# Start frontend
yarn start
```

The dashboard is at `http://localhost:3000/vault`.

**New here?** Visit [`/vault/demo`](http://localhost:3000/vault/demo) for an interactive walkthrough that explains what the product does, step by step.

### What Works Locally vs. Testnet

The local Anvil chain deploys with **mock contracts** (MockAavePool, MockAToken, ERC20Mock for USDC). This means:

| Feature | Local (Anvil) | Testnet (Base Sepolia) |
|---|---|---|
| Deposit / withdraw USDC | Yes (mock USDC, mint freely) | Yes (get USDC from [Aave faucet](https://app.aave.com/faucet/)) |
| Supply to / withdraw from Aave | Yes (mock pool, no real yield) | Yes (real Aave V3, real yield accrues) |
| Circuit breaker checks | Yes (mock price feed) | Yes (real Chainlink USDC/USD feed) |
| Cross-chain rotation (CCIP) | No -- no CCIP router on Anvil | Yes (CCIP-BnM testnet tokens) |
| CRE workflow simulation | No -- requires live chain state | Yes (`cre workflow simulate`) |
| Chainlink Automation | No -- no keeper network locally | Yes (register upkeep at automation.chain.link) |
| Frontend dashboard | Yes (all UI works with mocks) | Yes (reads real on-chain state) |

**To test with real Aave:** Run fork tests against Base mainnet. Requires `RPC_BASE` in `packages/foundry/.env`:
```bash
cd packages/foundry && source .env && forge test --fork-url $RPC_BASE --match-path "test/fork/*"
```

### Deploy Scripts

`yarn deploy` runs `Deploy.s.sol` by default, which auto-detects the chain:
- **Local (chain 31337):** Deploys core contracts + mocks via `DeployYieldVaultLocal.s.sol`
- **Any other chain:** Deploys core contracts with real addresses via `DeployYieldVault.s.sol`

To run a specific script: `yarn deploy --file <script> --network <network>`

<details>
<summary>Full deploy scripts reference (17 scripts)</summary>

| Script | Purpose | When to use |
|---|---|---|
| `Deploy.s.sol` | Router -- delegates to Local or Vault based on chain ID | Default `yarn deploy` |
| `DeployYieldVaultLocal.s.sol` | Core contracts + mocks for Anvil | Automatic via `Deploy.s.sol` on local |
| `DeployYieldVault.s.sol` | Core 3 contracts with real addresses | Automatic via `Deploy.s.sol` on testnet/mainnet |
| `DeployAllTestnet.s.sol` | All 9 contracts + role wiring for Base Sepolia | Full testnet redeploy |
| `DeployAutomation.s.sol` | YieldKeeper + DeadManSwitch | Adding automation to existing deployment |
| `DeployAutomationTestnet.s.sol` | Automation contracts with testnet params | Same, with shorter cooldowns |
| `DeploySpoke.s.sol` | SpokeVault (generic) | Deploying spoke to any chain |
| `DeploySpokeArbitrumSepolia.s.sol` | SpokeVault with Arb Sepolia addresses | Deploying spoke to Arbitrum Sepolia |
| `DeployYieldKeeperCRE.s.sol` | CRE consumer contract | Adding CRE automation |
| `DeployYieldVaultTestnet.s.sol` | Core contracts with Base Sepolia addresses | Core-only testnet deploy |
| `ConfigureCREProduction.s.sol` | Lock CRE consumer to DON forwarder | After CRE workflow deployment |
| `RedeployAutomation.s.sol` | Redeploy + re-wire automation contracts | Upgrading automation |
| `RedeployStrategyController.s.sol` | Redeploy + re-wire strategy controller | Upgrading strategy logic |
| `UpgradeYieldKeeper.s.sol` | Deploy new keeper, migrate roles | Upgrading keeper |
| `RegisterChainlinkUpkeep.s.sol` | Register keeper with Chainlink Automation | One-time setup after keeper deploy |
| `VerifyAll.s.sol` | Batch verification helper | After deployment |
| `DeployHelpers.s.sol` | Base class with shared utilities | Not run directly |

</details>

### Deploy to Base Sepolia

```bash
# Generate or import a deployer account
yarn generate
# or
yarn account:import

# Fund your deployer with Base Sepolia ETH (check yarn account for the address)
# Faucets: https://www.alchemy.com/faucets/base-sepolia or https://faucet.quicknode.com/base/sepolia

# Deploy all contracts (full suite with role wiring)
yarn deploy --file DeployAllTestnet.s.sol --network baseSepolia

# Verify on Basescan
yarn verify --network baseSepolia
```

### CRE Workflow

> **Prerequisites:** The CRE workflow is an advanced feature that requires the [CRE CLI](https://docs.chain.link/cre) and [Bun](https://bun.sh). It compiles TypeScript to WASM and runs on a Chainlink DON (Decentralized Oracle Network). You can simulate it locally without DON access, but deploying to production requires [CRE Early Access](https://docs.chain.link/cre). **Skip this section if you just want to work on contracts or frontend.**

```bash
cd packages/cre-workflow

# Install workflow dependencies (uses Bun -- required by CRE SDK toolchain)
cd yield-keeper-workflow && bun install && cd ..

# One-time setup (downloads and compiles the Javy WASM plugin)
cd yield-keeper-workflow && bun x cre-setup && cd ..

# Simulate dry-run (reads live testnet state, no tx broadcast)
cre workflow simulate yield-keeper-workflow --target staging-settings

# Simulate with broadcast (sends real on-chain tx via MockKeystoneForwarder)
cre workflow simulate yield-keeper-workflow --target staging-settings --broadcast

# Deploy to DON (requires CRE Early Access account enablement)
cre workflow deploy yield-keeper-workflow --target staging-settings

# Upload secrets to Vault DON
cd .. && cre secrets create secrets.yaml --target staging-settings

# After deploy: lock consumer to DON (fill WORKFLOW_ID + WORKFLOW_OWNER first)
# forge script script/ConfigureCREProduction.s.sol --rpc-url baseSepolia --broadcast
```

## Tests

```bash
# Run all Solidity tests (242 tests)
yarn foundry:test

# Run monitor package tests (123 tests)
yarn test:monitor

# Run fork tests against Base mainnet
# Note: source the .env first so $RPC_BASE is in your shell, or pass the URL directly
cd packages/foundry && source .env && forge test --fork-url $RPC_BASE --match-path "test/fork/*"
```

### Test Coverage

| Category | Count | Details |
|---|---|---|
| Unit tests | 151 | CircuitBreaker 27, YieldVault 30, StrategyController 22, SpokeVault 8, YieldKeeper 18, DeadManSwitch 15, YieldKeeperCRE 31 |
| Phase 4 tests | 44 | VaultGateway, RewardHarvester, async redemption queue |
| Security tests | 26 | In-flight, share price, emergency, concurrent ops |
| Invariant tests | 5 | 256 runs x 50 depth per invariant |
| Fuzz tests | 6 | 1,000 runs each |
| Fork tests | 5 | Requires `RPC_BASE` env var |
| **Solidity total** | **242** | 241 passed, 1 skipped |
| Monitor tests | 123 | Data pipeline and decision engine |
| **Grand total** | **365** | |

## Developer Guide: Technology Reference

<details>
<summary>This project uses several non-standard technologies (CCIP, CRE, Aave, etc.). Expand this section for a function-level map of every integration point.</summary>


### Chainlink CCIP (Cross-Chain Interoperability Protocol)

Cross-chain token transfers and messaging between hub (Base) and spoke (Arbitrum) chains.

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/strategy/StrategyController.sol` | `initiateCrossChainRotation()` | Builds `Client.EVM2AnyMessage`, calls `IRouterClient.ccipSend()` to move USDC to a spoke chain |
| | `initiateTestnetRotation()` | Same flow but bridges CCIP-BnM test tokens instead of USDC (testnet workaround) |
| | `triggerRemoteEmergencyWithdraw()` | Sends CCIP message to spoke instructing emergency withdrawal |
| | `_ccipReceive()` | Inherited from `CCIPReceiver` -- handles incoming balance reports from spokes |
| | `_buildCcipMessage()` | Constructs `Client.EVM2AnyMessage` with token amounts and encoded data payload |
| `packages/foundry/contracts/spoke/SpokeVault.sol` | `_ccipReceive()` | Handles instructions from hub: `SUPPLY`, `WITHDRAW_AND_RETURN`, `REPORT_BALANCE` |
| | `_sendBalanceReport()` | Sends aToken balance back to hub via CCIP |
| `packages/foundry/contracts/interfaces/` | `IRouterClient.sol` | Chainlink CCIP router interface for `ccipSend()` and `getFee()` |

**Imports:** `CCIPReceiver`, `Client`, `IRouterClient` from `@chainlink/contracts-ccip`

### Chainlink CRE (Chainlink Runtime Environment)

Off-chain TypeScript workflow compiled to WASM, runs on a Chainlink DON. Replaces Automation's decision logic with richer capabilities (cross-chain reads, HTTP calls, event triggers).

| File | Function | What it does |
|---|---|---|
| `packages/cre-workflow/yield-keeper-workflow/main.ts` | `initWorkflow()` | Registers handlers for cron trigger, deposit/withdraw events, circuit breaker changes |
| | `onCronTrigger()` | Main loop: reads vault state, evaluates idle/harvest/rotation, writes action |
| | `readVaultState()` | Calls vault contract methods via CRE `EVMClient` |
| | `readCrossChainRates()` | Queries remote-chain Aave rates via CRE cross-chain reads |
| | `fetchDefiLlamaYield()` | Fetches APY from `yields.llama.fi/chart/{poolId}` via CRE `HTTPClient` |
| | `evaluateRotation()` | Compares current vs. remote yields, checks spread/cost thresholds |
| | `writeAction()` | Encodes action type + params, sends to consumer contract via KeystoneForwarder |
| `packages/cre-workflow/yield-keeper-workflow/workflow.yaml` | — | Declares triggers (cron, event), consensus strategy, and target contract |
| `packages/cre-workflow/project.yaml` | — | CRE project manifest: workflow references, chain configs |
| `packages/cre-workflow/yield-keeper-workflow/config.staging.json` | — | Staging config: contract addresses, chain selectors, thresholds |
| `packages/foundry/contracts/automation/YieldKeeperCRE.sol` | `onReport(bytes metadata, bytes report)` | `IReceiver` interface -- called by KeystoneForwarder with workflow output |
| | `_validateMetadata()` | Verifies workflow ID and owner from CRE metadata |
| | `_performRotation()` | Executes cross-chain rotation when CRE says ROTATE |
| | `_performTestnetRotation()` | Testnet variant using CCIP-BnM tokens |
| `packages/foundry/test/mocks/MockKeystoneForwarder.sol` | `report()` | Simulates KeystoneForwarder for unit tests |

**CRE SDK imports (main.ts):** `CronCapability`, `EVMClient`, `HTTPClient`, `handler`, `Runner`, `consensusMedianAggregation`, `getNetwork`, `encodeCallMsg`, `TxStatus`, `Runtime`, `NodeRuntime`, `EVMLog`

**Simulation:**
```bash
cd packages/cre-workflow
cre workflow simulate yield-keeper-workflow --target staging-settings              # dry-run
cre workflow simulate yield-keeper-workflow --target staging-settings --broadcast  # real on-chain tx
```

### Chainlink Automation (Legacy Keeper Network)

Traditional off-chain check + on-chain execute pattern. Still active as secondary automation alongside CRE.

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/automation/YieldKeeper.sol` | `checkUpkeep(bytes)` | Called off-chain by Automation nodes -- returns `(upkeepNeeded, performData)` with action type |
| | `performUpkeep(bytes performData)` | Called on-chain by registered forwarder -- decodes action, executes supply or harvest |
| | `setForwarder(address)` | Sets the Automation-assigned forwarder address (required after upkeep registration) |

**Import:** `AutomationCompatibleInterface` from `@chainlink/contracts/automation/interfaces`

**Forwarder pattern:** After registering the upkeep on [automation.chain.link](https://automation.chain.link), copy the forwarder address and call `setForwarder()`. `performUpkeep()` validates `msg.sender == forwarder`.

### Chainlink Price Feeds (Oracle)

Used by the circuit breaker to monitor USDC peg health.

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/safety/CircuitBreaker.sol` | `_evaluatePrice()` | Calls `priceFeed.latestRoundData()`, checks staleness (>1h), returns threat tier based on depeg thresholds |
| | `checkAndUpdateTier()` | Aggregates price + TVL + share price checks into a single tier (NORMAL → WATCH → WARN → CRITICAL) |
| `packages/foundry/contracts/interfaces/IAggregatorV3.sol` | `latestRoundData()` | Standard Chainlink aggregator interface |

**Thresholds:** WATCH at $0.995, WARN at $0.990, CRITICAL at $0.980

### Aave V3 (Lending Protocol)

The vault earns yield by supplying assets to Aave V3 pools on multiple chains.

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/vault/YieldVault.sol` | `supplyToAave(uint256)` | Approves asset to pool, calls `aavePool.supply()` |
| | `withdrawFromAave(uint256)` | Calls `aavePool.withdraw()` |
| | `claimAaveRewards()` | Calls `IRewardsController.claimAllRewards()` for incentive tokens |
| | `totalAssets()` | Returns idle + `aToken.balanceOf(this)` + remote balances - in-flight |
| | `_withdraw()` | Override that auto-pulls from Aave when idle balance is insufficient |
| `packages/foundry/contracts/spoke/SpokeVault.sol` | `_supply()` / `_withdraw()` | Same Aave interactions on remote chains |
| `packages/foundry/contracts/rewards/RewardHarvester.sol` | `harvestAaveRewards()` | Claims rewards via vault, swaps to asset, reinvests |
| | `harvestMerklRewards()` | Claims Merkl distributor rewards with merkle proofs |
| `packages/foundry/contracts/interfaces/IAavePool.sol` | — | `supply()`, `withdraw()`, `getReserveData()` |
| `packages/foundry/contracts/interfaces/IAToken.sol` | — | `balanceOf()` for tracking deposited amounts |

### ERC-4626 (Tokenized Vault Standard)

The vault is a standard ERC-4626 with custom overrides for circuit breaker gating, cross-chain accounting, and async redemptions.

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/vault/YieldVault.sol` | `totalAssets()` | Idle + aToken + remote balances - in-flight (not just local balance) |
| | `deposit()` / `mint()` | Blocked when circuit breaker is CRITICAL |
| | `withdraw()` / `redeem()` | Never blocked -- users can always exit |
| | `maxWithdraw()` / `maxRedeem()` | Capped to home-chain assets minus pending redeems |
| | `requestRedeem()` | Async redemption queue -- queues if insufficient home-chain liquidity |
| | `fulfillRedemptions()` | Processes queue FIFO after cross-chain assets return |
| | `cancelRedeem()` / `cancelExpiredRedeems()` | Queue management (user cancel, 7-day expiry) |
| `packages/foundry/contracts/vault/VaultGateway.sol` | `deposit()` / `redeem()` | Slippage-protected wrappers around `IERC4626.deposit()` / `IERC4626.redeem()` |

### DeFi Llama API (External Yield Data)

Used by the CRE workflow to compare current vault yield against all Aave V3 pools globally.

| File | Function | What it does |
|---|---|---|
| `packages/cre-workflow/yield-keeper-workflow/main.ts` | `fetchDefiLlamaYield()` | `HTTPClient.sendRequest()` to `yields.llama.fi/chart/{poolId}` -- returns latest APY |
| `packages/nextjs/app/api/yields/route.ts` | `GET /api/yields` | Frontend API route that fetches from `yields.llama.fi/pools` and filters stablecoin Aave V3 pools |
| `packages/nextjs/components/vault/YieldExplorer.tsx` | — | Displays pool table with APY, TVL, 1d/7d/30d trends, rotation candidates |

### Custom Patterns

**Dead Man Switch** -- fallback automation if primary keeper goes offline:

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/automation/DeadManSwitch.sol` | `heartbeat()` | Guardian signals keeper is alive |
| | `isExpired()` | Returns true if timeout exceeded (default 1h) |
| | `triggerFallbackHarvest()` / `triggerFallbackSupply()` | Anyone can execute if switch expired |

**Validation Libraries** -- pure functions for rotation safety:

| File | Function | What it does |
|---|---|---|
| `packages/foundry/contracts/libraries/ExposureLimits.sol` | `validateRotationSize()` | Single rotation ≤ 20% of total assets |
| | `validateInFlight()` | Total in-flight ≤ 15% of total assets |
| | `validateChainConcentration()` | Per-chain balance ≤ 40% of total assets |
| `packages/foundry/contracts/libraries/RotationValidator.sol` | `validateSpread()` | Yield advantage ≥ minSpreadBps |
| | `validateCost()` | Rotation cost ≤ maxCostBps |
| | `validateFrequency()` | Cooldown respected per chain |

</details>

## Key Design Decisions

- **Withdrawals never blocked** -- even at CRITICAL circuit breaker level, users can always exit
- **48h timelock** on spoke registration and parameter changes (1 min on testnet)
- **Async redemption queue** -- large withdrawals are queued and fulfilled when liquidity is available
- **Slippage gateway** -- deposits/withdrawals go through VaultGateway with configurable slippage protection
- **Triple automation** -- CRE workflow (primary), Chainlink Automation (legacy), Gelato dead man switch (backup)
- **CRE workflow features** -- cron + event triggers, cross-chain reads, DeFiLlama integration, HTTP monitoring, automated cross-chain rotation, `simulate --broadcast` for real on-chain testing
- **Testnet rotation workaround** -- Aave faucet USDC is not in CCIP/CCTP token pools, so `TESTNET_ROTATE` withdraws USDC from Aave + bridges CCIP-BnM test tokens via CCIP. SpokeVault is pre-funded with USDC on Arb Sepolia so the destination Aave supply completes, making it a full end-to-end rotation

## Known Limitations

- **CRE DON deployment** accepted into Early Access program, pending account enablement. `simulate --broadcast` works for local testing. Once enabled, deploy via `cre workflow deploy` and lock forwarder
- **Cross-chain USDC rotation** only works natively on mainnet (testnet Aave USDC != CCIP/CCTP USDC). Testnet uses CCIP-BnM tokens as bridge substitute + pre-funded SpokeVault for end-to-end Aave supply on destination
- **CRE simulate vs DON** -- `simulate --broadcast` runs on a single local node (no DON consensus, no KeystoneForwarder signatures). Identical workflow code, different execution environment. After forwarder lock, only the DON delivers reports
- **DeFiLlama** returns 0 for testnet pools (not indexed)
- **CRE event triggers** need a real on-chain tx hash to simulate

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Solidity 0.8.34, Foundry |
| Standards | ERC-4626, OpenZeppelin 5.x |
| Cross-Chain | Chainlink CCIP 1.6.4 |
| Automation | CRE Workflows, Chainlink Automation, Gelato |
| Lending | Aave V3 |
| Frontend | Next.js 15, React 19, Wagmi, Viem, RainbowKit, Tailwind CSS, DaisyUI |
| Monitoring | Custom TypeScript pipeline (packages/monitor) |
| Platform | Scaffold-ETH 2 (Foundry) |
