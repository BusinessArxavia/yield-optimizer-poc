# Production Deployment Checklist

## Pre-Deployment Security

### Role Transfer to Multisig
All admin roles MUST transfer to a Safe multisig before mainnet launch.

| Role | Current (Testnet) | Production Target |
|------|-------------------|-------------------|
| DEFAULT_ADMIN_ROLE (all contracts) | Deployer EOA | 3/5 Safe multisig |
| ADMIN_ROLE (all contracts) | Deployer EOA | 3/5 Safe multisig |
| PAUSER_ROLE (CircuitBreaker) | Deployer EOA | 2/3 Safe multisig (faster response) |
| KEEPER_ROLE | YieldKeeper/CRE forwarder | Keep as-is (automation) |
| STRATEGY_ROLE | StrategyController | Keep as-is (contract-to-contract) |
| SWAPPER_ROLE (RewardHarvester) | Deployer EOA | Dedicated hot wallet with limited scope |

### Timeout Configuration
After deployment, set production timeouts via timelocked admin functions:

| Parameter | Demo Default | Production Value | Contract | Setter |
|-----------|-------------|-----------------|----------|--------|
| PARAM_TIMELOCK | 1 minute | 48 hours | StrategyController | Constructor (immutable) |
| inFlightStalenessTimeout | 5 minutes | 48 hours | StrategyController | setInFlightStalenessTimeout() |
| remoteBalanceStalenessTimeout | 30 minutes | 72 hours | YieldVault | setRemoteBalanceStalenessTimeout() |
| reinvestDeadline | 10 minutes | 48 hours | RewardHarvester | setReinvestDeadline() |
| rotationCooldown | 0 | 24 hours | StrategyController | Constructor param (changeable via timelocked setter) |
| harvestCooldown | 10 minutes | 1 hour | YieldKeeper | Constructor |

### Contract Verification
- [ ] All contracts verified on block explorer (Etherscan/Basescan/Arbiscan)
- [ ] Source code matches deployed bytecode
- [ ] Constructor arguments documented

### CCIP Configuration
- [ ] StrategyController funded with LINK (minimum 10 LINK for 50+ rotations)
- [ ] SpokeVault funded with LINK (minimum 5 LINK for balance reports)
- [ ] CCIP gas limit set appropriately (1M for SpokeVault)
- [ ] Spoke registration completed with production chain selectors

### CRE Workflow
- [ ] Deploy workflow: `cre workflow deploy . --target production-settings`
- [ ] Capture workflow ID and owner address
- [ ] Run `ConfigureCREProduction.s.sol` to lock forwarder + set workflow identity
- [ ] Upload secrets: `cre secrets create secrets.yaml --target production-settings`
- [ ] Verify autonomous execution via `lastPerformTime` on YieldKeeperCRE

## Post-Deployment Operations

### Monitoring (Must Have)
- [ ] Alert on `StaleInFlightCleared` events (indicates CCIP failure)
- [ ] Alert on `EmergencyPauseActivated` events
- [ ] Alert on `TierChanged` events (CircuitBreaker)
- [ ] Monitor LINK balances on StrategyController and all SpokeVaults
- [ ] Monitor `expiredEscrowCount()` on RewardHarvester (> 0 = swapper not reinvesting)
- [ ] Dashboard for `isRemoteBalanceStale()` per chain
- [ ] Alert if DeadManSwitch `triggerFallback*` is called (primary keeper failed)
- [ ] Monitor `pendingRedeemCount()` on YieldVault (> 0 = redemption queue active)
- [ ] Alert on `PartialRemoteRecallInitiated` events (CRE recalling remote funds for redemptions)
- [ ] Alert on `RedemptionFulfillRequested` events with high `maxToProcess` values

### TVL Ramp
- [ ] Start with deposit cap at $100K
- [ ] Increase to $500K after 30 days with no incidents
- [ ] Increase to $2M after 60 days
- [ ] Remove cap after 90 days + professional audit

### Bug Bounty
- [ ] Launch Immunefi program
- [ ] Max bounty: 10% of TVL
- [ ] Critical: up to $50K
- [ ] High: up to $10K

### Incident Response
- [ ] Document emergency pause procedure (who calls, how fast)
- [ ] Document spoke deregistration procedure
- [ ] Document CCIP recovery procedure (clearStaleInFlight)
- [ ] Document HWM reset procedure
- [ ] Test all emergency procedures on testnet quarterly

### Professional Audit
- [ ] Engage 2 independent auditors (recommended: Trail of Bits + OpenZeppelin/Spearbit)
- [ ] Scope: all contracts + CRE workflow + frontend
- [ ] Focus areas: cross-chain accounting, ERC-4626 invariants, CCIP message handling
- [ ] Allow 4-6 weeks for audit timeline
- [ ] Fix all critical/high findings before mainnet
- [ ] Publish audit report

### Event Indexing
- [ ] Deploy subgraph (The Graph) for all vault events
- [ ] Index: Deposit, Withdraw, RedeemRequested, RedeemFulfilled, CrossChainRotationInitiated, PartialRemoteRecallInitiated, BalanceReportReceived
- [ ] Frontend should switch from direct RPC reads to subgraph queries at scale

### MEV Protection (Mainnet Only)
- [ ] If deploying to L1: integrate Flashbots Protect RPC recommendation in frontend
- [ ] L2 deployment: sequencer ordering is sufficient (no action needed)
- [ ] Document recommended slippage settings for users (0.5% for USDC)

### Code Annotations (add before mainnet)
- [ ] StrategyController: `// PRODUCTION: call setInFlightStalenessTimeout(48 hours) after deployment`
- [ ] StrategyController: `// PRODUCTION: ensure rotationCooldown >= 24 hours`
- [ ] YieldVault: `// PRODUCTION: call setRemoteBalanceStalenessTimeout(72 hours) after deployment`
- [ ] YieldVault `emergencyWithdraw`: `// PRODUCTION: monitor for frequent calls — may indicate systemic issue`
- [ ] RewardHarvester: `// PRODUCTION: call setReinvestDeadline(48 hours) after deployment`
- [ ] RewardHarvester `withdrawRewardForSwap`: `// PRODUCTION: monitor expiredEscrowCount() — revoke SWAPPER_ROLE if > 0`
- [ ] CircuitBreaker `resetHighWaterMarks`: `// PRODUCTION: only call after investigating root cause`
- [ ] SpokeVault: `// PRODUCTION: fund with 5+ LINK. Monitor balance weekly.`
- [ ] All contracts: transfer DEFAULT_ADMIN_ROLE to multisig after initial configuration
- [ ] Remove deployer from all roles after setup is complete
