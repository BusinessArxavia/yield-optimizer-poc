# Aave Yield Optimizer -- Implementation Progress

## Current Status

- **242 Solidity tests** (241 passed, 1 skipped fork test) + **123 monitor tests** = **365 total**
- **10 contracts** deployed to Base Sepolia (v8) + 1 on Arbitrum Sepolia (v4), all verified
- **CRE workflow** compiles, simulates, and broadcasts real transactions on-chain via `simulate --broadcast`
- **6 CRE action types**: SUPPLY_IDLE, HARVEST_YIELD, ROTATE, TESTNET_ROTATE, FULFILL_REDEMPTIONS, RECALL_REMOTE
- **Automated redemption queue**: CRE detects pending redeems, recalls partial remote funds via CCIP, fulfills queue automatically
- **Testnet rotation** works end-to-end via CCIP-BnM tokens: Aave withdraw on Base + CCIP bridge to Arb + Aave supply on Arb (SpokeVault pre-funded with USDC)
- **Frontend dashboard** live with deposit/withdraw, strategy allocation, automation status, interactive demo with CRE simulation controls, cross-chain tracking, and async redemption queue UX

---

## Phase 1: Data Pipeline + Decision Engine

- [x] Monitor package with 123 tests (Aave rate fetching, rotation decision engine, cost modeling)

## Phase 2: Smart Contracts

### 2A: Interfaces, Libraries, CircuitBreaker
- [x] `IAavePool.sol`, `IAToken.sol`, `IAggregatorV3.sol` -- slim interfaces
- [x] `ExposureLimits.sol`, `RotationValidator.sol` -- pure validation libraries
- [x] `CircuitBreaker.sol` -- safety oracle (27 unit tests)

### 2B: YieldVault (ERC-4626)
- [x] `YieldVault.sol` -- Aave V3 vault with deposits, withdrawals, performance fees, async redemption queue, emergency withdraw (30 unit tests)

### 2C: StrategyController
- [x] `StrategyController.sol` -- local Aave ops, cross-chain CCIP rotation, exposure limits, timelocked params (22 unit tests)

### 2D: SpokeVault
- [x] `SpokeVault.sol` -- remote chain vault, CCIP receive (SUPPLY, WITHDRAW_AND_RETURN, REPORT_BALANCE), source validation (8 unit tests)

### 2E: Test Suite
- [x] Unit: 87 tests | Invariant: 5 (256 runs x 50 depth) | Fuzz: 6 (1000 runs each) | Fork: 5

## Phase 3: Deployment + Integration

### 3A: Base Sepolia Testnet
- [x] Configure RPC (Tenderly), research testnet addresses, create deploy scripts
- [x] Deploy CircuitBreaker, YieldVault, StrategyController
- [x] Verify on-chain: roles wired, vault reads Aave, circuit breaker OK
- [x] Generate frontend ABIs, update scaffold.config.ts

### 3B: Spoke Deployment + CCIP
- [x] Make PARAM_TIMELOCK configurable (immutable constructor param)
- [x] Deploy SpokeVault to Arbitrum Sepolia
- [x] Queue + execute spoke registration (1-min testnet timelock)
- [x] E2E CCIP test -- data-only messaging works (balance report Arb -> Base)

### 3C: Automation Contracts
- [x] `YieldKeeper.sol` -- Chainlink Automation upkeep (18 unit tests)
- [x] `DeadManSwitch.sol` -- Gelato fallback (15 unit tests)
- [x] Deploy + verify all 6 contracts on block explorers
- [x] Register Chainlink Automation upkeep, set forwarder

## Phase 4: Advanced Features

- [x] `VaultGateway.sol` -- slippage-protected deposit/withdraw entry point
- [x] `RewardHarvester.sol` -- claims and compounds Aave reward tokens
- [x] Async redemption queue in YieldVault (requestRedeem/processRedemption)
- [x] `TestnetRewardsController.sol`, `TestnetMerklDistributor.sol` -- testnet mocks
- [x] 44 new unit tests (VaultGateway, RewardHarvester, async redemption)
- [x] Redeploy all 9 contracts to Base Sepolia (v5), all verified, frontend updated

## Phase 5: CRE Migration (Chainlink Keepers -> CRE Workflows)

### 5.1: Consumer Contract (Solidity)
- [x] `YieldKeeperCRE.sol` -- implements IReceiver + ERC165, replaces AutomationCompatibleInterface
- [x] `MockKeystoneForwarder.sol` -- test mock for local Forge tests
- [x] `YieldKeeperCRE.t.sol` -- 31 unit tests (constructor, onReport, access control, supply, harvest, rotation, metadata validation, ERC165, edge cases)
- [x] v1 deployed at `0xC34271b53E9c1aD9Ea67c6c2D0f3a4F5CA1F5A98` (deprecated -- no ROTATE support)
- [x] v2 deployed at `0x7FD8b06474a5C287C2F08b78325F84fe71b321e4` (deprecated -- no TESTNET_ROTATE)
- [x] v3 deployed at `0x21F862D4a0fb4D027b1Ec20262D670Abd8Bdde73` (deprecated -- points to old StrategyController)
- [x] v4 deployed at `0x8bB92223B74b5A2fb5579aFc52D66683E4721AE0`, KEEPER_ROLE granted, verified, points to StrategyController v6 **(retired -- replaced by v8 `0x9B39815964a87eF361d555BD99FfdcDEbe4753bb`)**

### 5.2: CRE Workflow (TypeScript)
- [x] Scaffold CRE project at `packages/cre-workflow/`
- [x] Contract ABI files (YieldVault, CircuitBreaker, YieldKeeperCRE, ERC20, AavePool)
- [x] Main cron workflow -- reads vault state, decides action, writes report via KeystoneForwarder
- [x] Config files (config.staging.json, config.production.json, project.yaml, workflow.yaml, secrets.yaml)

### 5.3: Event-Driven Triggers
- [x] EVM Log trigger on vault Deposit/Withdraw events -- react to large deposits immediately
- [x] EVM Log trigger on CircuitBreaker TierChanged events -- emergency response

### 5.4: Multi-Chain Reads + Rotation Decision
- [x] Cross-chain yield comparison -- read Aave rates on Base + Arbitrum in same workflow execution
- [x] Rotation decision engine -- compares local vs remote Aave supply rates, triggers ROTATE if spread > `minRotationSpreadBps`

### 5.5: Off-Chain Data Integration
- [x] DeFiLlama API yield data fetch via NodeRuntime + consensus aggregation
- [x] Compare on-chain Aave rates vs external yield sources

### 5.6: HTTP Monitoring
- [x] HTTP POST to external monitoring endpoint after each execution
- [x] Secrets config for monitoring API key

### 5.7: Simulation + On-Chain Test
- [x] Workflow compiles to WASM
- [x] `cre workflow simulate` passes (cron trigger) -- reads vault on-chain, cross-chain Arb data, DeFiLlama fetch, writes report
- [x] Direct on-chain `onReport(HARVEST_YIELD)` test on Base Sepolia -- tx `0x31e6bef1...` harvested yield successfully
- [x] `cre workflow simulate --broadcast` sends real transactions on-chain -- tx `0xaa74ff31...` (HARVEST_YIELD via CRE simulate)
- [x] Frontend API route (`/api/cre-simulate`) triggers simulation from the demo page with dry-run or broadcast mode
- [ ] `cre workflow deploy` -- blocked on CRE Early Access activation (accepted into program, pending enablement)
- [ ] Set `expectedWorkflowId` + `expectedWorkflowOwner` on consumer contract (via `ConfigureCREProduction.s.sol` after deploy)

### 5.8: Cross-Chain Rotation via CRE
- [x] `ActionType.ROTATE` added to `YieldKeeperCRE.sol` -- decodes (destChain, amount, yieldBps, costBps) and calls `strategyController.initiateCrossChainRotation()`
- [x] `IStrategyControllerKeeper` extended with `initiateCrossChainRotation()` and `validateRotation()`
- [x] CRE workflow rotation logic -- Priority 3 after supply & harvest, reads local+remote Aave rates, evaluates spread vs `minRotationSpreadBps`
- [x] `RotateActionParams` ABI encoding -- `(uint8, uint64, uint256, uint256, uint256)` for CRE report payload
- [x] 4 new Solidity tests (rotate success, circuit breaker guard, zero amount guard, validation failure guard)
- [x] Config params: `minRotationSpreadBps`, `rotationAmountBps`, `estimatedCostBps` with sensible defaults

### 5.9: Testnet Rotation (CCIP-BnM)
- [x] `ActionType.TESTNET_ROTATE` added -- withdraws USDC from Aave + bridges CCIP-BnM test tokens via CCIP (workaround for testnet USDC incompatibility)
- [x] `StrategyController.initiateTestnetRotation()` -- combines Aave withdraw with CCIP-BnM token bridge
- [x] StrategyController funded with 2 LINK (for CCIP fees) + 2 CCIP-BnM (for bridge testing)
- [x] Demo page updated with TESTNET_ROTATE button, BnM balance display, and pre-flight checks
- [x] YieldKeeperCRE v4 deployed at `0x8bB92223B74b5A2fb5579aFc52D66683E4721AE0`, verified, KEEPER_ROLE granted **(retired -- replaced by v8 `0x9B39815964a87eF361d555BD99FfdcDEbe4753bb`)**
- [x] StrategyController v6 deployed at `0x1E938e27bE1ff76a64c24833937C9412dA381A3A` **(retired -- replaced by v8 `0x93e37393D12FB6874190b7E38D7AdE096ceBEF90`)**
- [x] SpokeVault pre-funded with 10 USDC on Arb Sepolia (enables full end-to-end rotation: Aave supply on destination)
- [x] Rotation cooldown set to 0 via timelock (for demo repeatability)
- [x] TESTNET_ROTATE tested end-to-end: Aave withdraw (Base) + CCIP bridge (BnM) + Aave supply (Arb) -- tx `0xac202e0a...`

### 5.9 Fix: SpokeVault v3 (Cross-Chain Token Address Bug)
- [x] SpokeVault v3 deployed to Arbitrum Sepolia at `0x0d89f6254665a55da6219d81d865ed094ae13025` **(retired -- replaced by v4 `0x99f90636e87646113480F4cfC631f02E0EE4cC22`)**
- [x] Fixed bug: SpokeVault was using the home-chain USDC address from the CCIP message instead of calling `asset()` locally -- caused Aave supply to fail on destination chain when token addresses differ between chains
- [x] Fix: SpokeVault now ignores the token address in the CCIP payload and always calls `asset()` to resolve the local asset address before supplying to Aave
- [x] End-to-end TESTNET_ROTATE confirmed with v3: Base Sepolia -> CCIP -> Arb Sepolia Aave supply completes successfully

### 5.10: Demo Page CRE Integration
- [x] API route `/api/cre-simulate` -- runs CRE CLI from Next.js backend, returns workflow output
- [x] "Simulate (Dry Run)" button -- runs full workflow locally, shows decision without broadcasting
- [x] "Simulate + Broadcast" button -- runs workflow and sends real `onReport()` tx on-chain, shows revert reason via `eth_call` replay
- [x] Testnet vs Mainnet explainer tables for both CRE (Step 5) and CCIP (Step 6)

## Phase 6: Security Hardening

- [x] 6.1 — Fix in-flight clearing bug (per-chain, not global)
- [x] 6.2 — CCIP message recovery (clearStaleInFlight with staleness timeout)
- [x] 6.3 — Reward escrow model (withdrawRewardForSwap + reinvest with deadlines)
- [x] 6.4 — Yield params informational only (removed on-chain validation)
- [x] 6.5 — Remote balance staleness (timeout excludes stale from totalAssets)
- [x] 6.6 — HWM reset (resetHighWaterMarks on CircuitBreaker)
- [x] 6.7 — Spoke deregistration (deregisterSpoke with zero-balance precondition)
- [x] 6.8 — SpokeVault reentrancy (nonReentrant on ccipReceive)
- [x] 6.9 — Timelock self-call fix (selector-based dispatch)
- [x] 6.10 — Frontend error UX (notification.error/success)
- [x] 6.11 — Merkl recipient validation (vault/harvester only)
- [x] 6.12 — Security test suite (26 new tests)
- [x] 6.13 — Stale UI warning (amber badge)
- [x] 6.14 — Deploy script updated (self-grant no longer needed after 6.9)
- [x] 6.15 — CRE bounds checks (yield data 0-10000 bps)
- [x] All 9 contracts redeployed to Base Sepolia (v7), all verified

## Phase 7: Automated Redemption Queue + Partial Remote Recall

### 7.1: StrategyController Extensions
- [x] `processPendingRedemptions(maxToProcess)` -- KEEPER_ROLE wrapper for `vault.fulfillRedemptions()`
- [x] `initiatePartialRemoteRecall(chainSelector, amount)` -- KEEPER_ROLE, sends CCIP WITHDRAW_AND_RETURN for specific amount (not full balance)
- [x] `RecallExceedsRemoteBalance` error -- validates recall amount against known remote balance
- [x] `onlyKeeperOrAdmin` modifier upgraded from `require` string to custom error (`NotKeeperOrAdmin`)

### 7.2: YieldKeeperCRE Action Types
- [x] `FULFILL_REDEMPTIONS = 4` -- decodes `(uint8, uint256)`, calls `processPendingRedemptions`
- [x] `RECALL_REMOTE = 5` -- decodes `(uint8, uint64, uint256)`, calls `initiatePartialRemoteRecall`
- [x] Circuit breaker intentionally NOT checked on redemption/recall actions (user withdrawals must always be fulfillable)

### 7.3: CRE Workflow Priority Reorder
- [x] Priority 0: Fulfill pending redemptions (if idle liquidity available)
- [x] Priority 1: Recall remote funds (if pending redeems exceed home liquidity, calculates shortfall, recalls `min(shortfall, remoteBalance)`)
- [x] Priority 2: Supply idle (was Priority 1)
- [x] Priority 3: Harvest yield (was Priority 2)
- [x] Priority 4: Cross-chain rotation (was Priority 3)
- [x] ABI params: `FulfillRedemptionsParams`, `RecallRemoteParams`
- [x] `readVaultState` extended with `pendingRedeemCount` and `totalPendingAssets`

### 7.4: Demo Page UX
- [x] Cross-chain rotation tracker (RotationTracker component) -- polls Arb + Base for events, shows 5-phase timeline with CCIP explorer links
- [x] Request Redeem button -- appears when withdraw exceeds instant liquidity and remote funds exist
- [x] Queue status display -- shows pending count and total queued USDC
- [x] Emergency recall moved to collapsible admin-only section
- [x] CRE simulation naturally triggers FULFILL_REDEMPTIONS / RECALL_REMOTE when queue is non-empty

---

## Deployed Contracts

### Base Sepolia (Chain 84532) -- v8

| Contract | Address | Verified |
|---|---|---|
| CircuitBreaker | [`0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f`](https://sepolia.basescan.org/address/0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f) | Yes |
| YieldVault | [`0x601F653c1F8940246fECEbCb9dEF8E6322c35570`](https://sepolia.basescan.org/address/0x601F653c1F8940246fECEbCb9dEF8E6322c35570) | Yes |
| StrategyController (v8) | [`0x93e37393D12FB6874190b7E38D7AdE096ceBEF90`](https://sepolia.basescan.org/address/0x93e37393D12FB6874190b7E38D7AdE096ceBEF90) | Yes |
| VaultGateway | [`0xDc8a5959cB1aEB3937B819924271381A1CC9cC78`](https://sepolia.basescan.org/address/0xDc8a5959cB1aEB3937B819924271381A1CC9cC78) | Yes |
| RewardHarvester | [`0x6aa643dfD56f3dE2372671879752464E15E466C3`](https://sepolia.basescan.org/address/0x6aa643dfD56f3dE2372671879752464E15E466C3) | Yes |
| YieldKeeper | [`0x5143CBB3D38227BDf6F039F9a1410DDE30fce338`](https://sepolia.basescan.org/address/0x5143CBB3D38227BDf6F039F9a1410DDE30fce338) | Yes |
| DeadManSwitch | [`0x23C088Ec7598549dFc1107f52A619f99466a4B45`](https://sepolia.basescan.org/address/0x23C088Ec7598549dFc1107f52A619f99466a4B45) | Yes |
| YieldKeeperCRE (v8) | [`0x9B39815964a87eF361d555BD99FfdcDEbe4753bb`](https://sepolia.basescan.org/address/0x9B39815964a87eF361d555BD99FfdcDEbe4753bb) | Yes |
| Deployer | `0x16fF6709177916bF7549239336F4f9aD8f0d2eA8` | -- |

### Arbitrum Sepolia (Chain 421614)

| Contract | Address | Verified |
|---|---|---|
| SpokeVault (v4) | [`0x99f90636e87646113480F4cfC631f02E0EE4cC22`](https://sepolia.arbiscan.io/address/0x99f90636e87646113480F4cfC631f02E0EE4cC22) | Yes |

### Automation Infrastructure

| Component | Value |
|---|---|
| Chainlink Automation Registry | `0x91D4a4C3D448c7f3CB477332B1c7D420a5810aC3` |
| YieldKeeper Forwarder | `0xd84B8Fe39042f705465Ca43e6AC426ff575387f0` |
| CRE KeystoneForwarder (production) | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |
| CRE MockKeystoneForwarder (simulate) | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |
| CCIP-BnM (Base Sepolia) | `0x88A2d74F47a237a62e7A51cdDa67270CE381555e` |
| CCIP-BnM (Arb Sepolia) | `0xA8C0c11bf64AF62CDCA6f93D3769B88BdD7cb93D` |

### Vault State (Base Sepolia)

Vault state changes frequently during demo testing. Query on-chain for current values.

---

## Test Summary

| Category | Count | Details |
|---|---|---|
| Unit tests | 151 | CircuitBreaker 27, YieldVault 30, StrategyController 21, SpokeVault 8, YieldKeeper 23, DeadManSwitch 15, YieldKeeperCRE 31 |
| Phase 4 tests | 44 | VaultGateway, RewardHarvester, async redemption queue |
| Security audit tests | 26 | SecurityAudit.t.sol, CCIPRecovery.t.sol |
| Invariant tests | 5 | 256 runs x 50 depth per invariant |
| Fuzz tests | 6 | 1,000 runs each |
| Fork tests | 5 | Requires RPC_BASE env var (1 skipped) |
| CRE simulation | 1 | cre workflow simulate (cron trigger) |
| **Solidity total** | **242** | 241 passed, 1 skipped |
| Monitor tests | 123 | Data pipeline and decision engine |
| **Grand total** | **365** | |

---

## Known Limitations

1. **CRE DON deployment pending** -- accepted into CRE Early Access program, awaiting account enablement. `simulate --broadcast` works for local testing. Once enabled: `cre workflow deploy . --target staging-settings`, then `ConfigureCREProduction.s.sol` to lock forwarder.
2. **Cross-chain USDC rotation testnet-only** -- Aave faucet USDC is not in CCIP token pools (same issue for CCTP). Workaround: `TESTNET_ROTATE` withdraws USDC from Aave + bridges CCIP-BnM test tokens via CCIP. SpokeVault is pre-funded with USDC on Arb Sepolia so the destination Aave supply also completes, making it a full end-to-end rotation. On mainnet, the same USDC flows through the entire pipeline natively.
3. **CRE simulate vs DON** -- `simulate --broadcast` runs the workflow on a single local node with no DON consensus or cryptographic multi-sig. Once the forwarder is locked to the production KeystoneForwarder via `ConfigureCREProduction.s.sol`, only the DON can deliver reports. Set forwarder back to `address(0)` to re-enable simulation mode.
4. **DeFiLlama returns 0 for testnet** -- testnet Aave pools are not indexed by DeFiLlama. The fetch + consensus aggregation works, just returns 0.
5. **CRE event triggers need real tx hash** -- EVM Log triggers require `--evm-tx-hash` and `--evm-event-index` in non-interactive mode. Can only be tested when real Deposit/Withdraw/TierChanged events exist on-chain.
6. **Monitoring HTTP POST uses placeholder** -- the monitoring endpoint in config is a placeholder URL. Replace with a real endpoint for production.
7. **No mainnet deployment** -- all contracts are testnet only. Production deployment addresses in config files are TBD.

---

## What's Working End-to-End

1. Deposit USDC via VaultGateway -> YieldVault -> Aave V3 (Base Sepolia)
2. Withdraw USDC from Aave -> YieldVault -> user
3. Chainlink Automation auto-supplies idle funds and harvests yield
4. CRE workflow reads vault state, cross-chain Aave data, DeFiLlama yields, decides action (supply/harvest/rotate), writes to consumer contract
5. CRE `simulate --broadcast` runs full workflow locally and sends real transactions on Base Sepolia (tx `0xaa74ff31...`)
6. CRE consumer contract (`YieldKeeperCRE`) receives reports and executes supply/harvest/rotation via StrategyController
7. Cross-chain rotation: CRE compares local vs remote Aave rates, triggers ROTATE when spread exceeds threshold, StrategyController executes via CCIP
8. Testnet rotation: TESTNET_ROTATE withdraws USDC from Aave (Base) + bridges CCIP-BnM tokens via CCIP to Arbitrum + SpokeVault supplies USDC to Aave on Arbitrum (full end-to-end rotation with pre-funded SpokeVault)
9. Circuit breaker monitors safety state, blocks deposits at CRITICAL
10. Dead man switch triggers fallback if primary automation goes silent 24h
11. CCIP data-only messaging between Base Sepolia and Arb Sepolia (balance reports)
12. Frontend dashboard with deposit/withdraw, strategy allocation, CRE simulate buttons, testnet rotation controls, and testnet-vs-mainnet explainer tables
13. Async redemption queue: `requestRedeem` queues large withdrawals, CRE automation detects pending redeems, recalls remote funds via CCIP, fulfills queue automatically
14. Cross-chain transaction tracker: live polling for destination chain events + CCIP explorer links for full rotation/recall visibility
15. Demo page shows queue status, Request Redeem button for over-liquidity withdrawals, and admin-only emergency recall

---

## What's Next

1. **CRE Early Access** -- accepted into program, awaiting account enablement
2. **Deploy to DON** -- `cre workflow deploy . --target staging-settings`, capture workflow ID
3. **Lock consumer** -- run `ConfigureCREProduction.s.sol` with workflow ID + owner to set forwarder + identity
4. **Upload secrets** -- `cre secrets create secrets.yaml --target staging-settings`
5. **Monitor DON** -- verify autonomous execution via `lastPerformTime` on YieldKeeperCRE
6. **Mainnet deployment** -- deploy to Base mainnet with real Aave, real CCIP, real USDC
7. **Audit preparation** -- formal security review of all contracts
8. **Production monitoring** -- wire up real monitoring endpoint for CRE HTTP reports
