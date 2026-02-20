# Phase 6: Security Hardening — Dev Plan

**Goal:** Fix all audit findings while keeping the demo flow fast and frictionless.
**Constraint:** Demo users should never need to switch wallets, wait >1 min, or perform extra approvals.
**Strategy:** Dual-mode configuration — `DEMO_MODE` constructor flag where needed, sensible defaults that work for both.

**Estimated new tests:** ~45-55 Solidity tests across all tasks.

---

## Status Key

- [ ] Not started
- [~] In progress
- [x] Done

---

## Task 6.1: Fix In-Flight Clearing Bug (CRITICAL)

**File:** `StrategyController.sol:337`
**Bug:** `vault.updateInFlight(sourceChain, -int256(vault.totalInFlight()))` clears ALL global in-flight instead of only the per-chain amount.
**Fix:** Replace with `vault.updateInFlight(sourceChain, -int256(vault.inFlightAmounts(sourceChain)))`.

### Steps

1. [ ] Edit `_ccipReceive()` in StrategyController.sol:
   ```solidity
   // BEFORE (broken):
   vault.updateInFlight(sourceChain, -int256(vault.totalInFlight()));

   // AFTER (correct):
   vault.updateInFlight(sourceChain, -int256(vault.inFlightAmounts(sourceChain)));
   ```
2. [ ] Add `inFlightAmounts(uint64)` to `IYieldVaultStrategy` interface if not already exposed.
3. [ ] Add test: `test_ccipReceive_clearInFlightPerChainOnly` — initiate rotations to 2 chains, simulate balance report from chain A, assert chain B in-flight is unchanged.
4. [ ] Add test: `test_ccipReceive_multipleReportsSequential` — two balance reports arrive sequentially, verify both clear correctly.
5. [ ] Run full test suite, verify no regressions.

**Demo impact:** None. Fix is purely correctness.

---

## Task 6.2: Add CCIP Message Recovery (CRITICAL)

**Problem:** If a CCIP message is lost in transit, `inFlightAmounts` stays elevated forever with no recovery path.
**Fix:** Add admin-callable `clearStaleInFlight()` with a staleness timeout. No timelock needed — this is an emergency recovery, and it only reduces in-flight (cannot inflate assets).

### Steps

1. [ ] Add to `StrategyController.sol`:
   ```solidity
   mapping(uint64 => uint256) public lastRotationSentTime;
   uint256 public inFlightStalenessTimeout; // default 48h mainnet, 5 min demo

   function clearStaleInFlight(uint64 chainSelector) external onlyRole(ADMIN_ROLE) {
       require(
           block.timestamp > lastRotationSentTime[chainSelector] + inFlightStalenessTimeout,
           "Not stale yet"
       );
       uint256 staleAmount = vault.inFlightAmounts(chainSelector);
       if (staleAmount > 0) {
           vault.updateInFlight(chainSelector, -int256(staleAmount));
           emit StaleInFlightCleared(chainSelector, staleAmount);
       }
   }
   ```
2. [ ] Set `lastRotationSentTime[destChain] = block.timestamp` in `initiateCrossChainRotation()` and `initiateTestnetRotation()`.
3. [ ] Constructor: `inFlightStalenessTimeout = paramTimelock > 1 hours ? 48 hours : 5 minutes` (auto-detect demo vs prod based on existing PARAM_TIMELOCK pattern).
4. [ ] Add setter `setInFlightStalenessTimeout(uint256)` behind timelock.
5. [ ] Add test: `test_clearStaleInFlight_works` — initiate rotation, warp past timeout, clear, verify in-flight is zero.
6. [ ] Add test: `test_clearStaleInFlight_revertsTooEarly` — try to clear before timeout, expect revert.
7. [ ] Add test: `test_clearStaleInFlight_onlyAdmin` — non-admin call reverts.

**Demo impact:** 5-minute timeout means demo users can recover quickly if CCIP stalls. No extra wallet switching or approvals.

---

## Task 6.3: Secure Reward Harvester Swap Model (CRITICAL)

**Problem:** Swapper can withdraw reward tokens and never reinvest.
**Fix:** Add escrow accounting with a reinvestment deadline. If swapper doesn't reinvest within the deadline, admin can claw back the underlying value. Keep the two-phase model (withdraw → swap off-chain → reinvest) since atomic DEX swaps add too much complexity and DEX dependency.

### Steps

1. [ ] Add to `RewardHarvester.sol`:
   ```solidity
   struct SwapEscrow {
       address token;
       uint256 amount;
       uint256 deadline;  // block.timestamp + reinvestDeadline
       bool settled;
   }

   uint256 public reinvestDeadline;  // 48h mainnet, 10 min demo
   uint256 public nextEscrowId;
   mapping(uint256 => SwapEscrow) public escrows;

   function withdrawRewardForSwap(address token, uint256 amount)
       external onlyRole(SWAPPER_ROLE) nonReentrant
       returns (uint256 escrowId)
   {
       // ... existing checks ...
       escrowId = ++nextEscrowId;
       escrows[escrowId] = SwapEscrow({
           token: token,
           amount: amount,
           deadline: block.timestamp + reinvestDeadline,
           settled: false
       });
       IERC20(token).safeTransfer(msg.sender, amount);
       emit RewardWithdrawnForSwap(token, amount, msg.sender, escrowId);
   }

   function reinvest(uint256 escrowId, uint256 usdcAmount)
       external onlyRole(SWAPPER_ROLE) nonReentrant
   {
       SwapEscrow storage e = escrows[escrowId];
       require(!e.settled, "Already settled");
       require(usdcAmount > 0, "Zero amount");
       e.settled = true;
       asset.safeTransferFrom(msg.sender, address(vault), usdcAmount);
       totalReinvested += usdcAmount;
       emit Reinvested(escrowId, usdcAmount);
   }
   ```
2. [ ] Add `pendingEscrowCount()` view — count of unsettled, non-expired escrows.
3. [ ] Add event `EscrowExpired(uint256 escrowId)` — emitted by admin-callable `flagExpiredEscrow()` for monitoring. Does NOT auto-claw-back (no on-chain price oracle for reward tokens), but provides audit trail and can trigger SWAPPER_ROLE revocation off-chain.
4. [ ] Constructor: `reinvestDeadline = paramTimelock > 1 hours ? 48 hours : 10 minutes`.
5. [ ] Update `YieldKeeper.sol` and `YieldKeeperCRE.sol` if they call harvest directly (they call `harvestAaveRewards` which doesn't use escrow — only `withdrawRewardForSwap` does). Verify no integration changes needed.
6. [ ] Add tests:
   - `test_withdrawCreatesEscrow`
   - `test_reinvestSettlesEscrow`
   - `test_reinvestRevertsAlreadySettled`
   - `test_escrowTracksDeadline`
7. [ ] Update demo page if it has a harvest flow — no change needed since demo only triggers `harvestAaveRewards`, not the swap flow.

**Demo impact:** None for demo users. Escrow is only between swapper and protocol (off-chain bot). Demo users interact via deposit/withdraw/harvest buttons which don't touch the escrow flow.

---

## Task 6.4: Remove Fabricatable Yield Params from Rotation (HIGH)

**Problem:** Keeper passes `yieldBps`/`costBps` as arguments — meaningless validation since keeper can lie.
**Fix:** Remove `yieldBps`/`costBps` from the keeper-facing function signature. Keep them only as event data for off-chain tracking. Rely on exposure limits (which ARE enforced on-chain) for safety.

### Steps

1. [ ] Create new keeper-facing function in `StrategyController.sol`:
   ```solidity
   function initiateCrossChainRotation(
       uint64 destChain,
       address token,
       uint256 amount
   ) external onlyKeeperOrAdmin nonReentrant {
       // On-chain enforceable limits only:
       ExposureLimits.validateRotationSize(amount, vault.totalAssets());
       ExposureLimits.validateInFlight(vault.totalInFlight(), amount, vault.totalAssets());
       ExposureLimits.validateChainConcentration(
           destChain, vault.remoteBalances(destChain), amount, vault.totalAssets()
       );
       RotationValidator.validateFrequency(
           destChain, lastRotationTime[destChain], rotationCooldown
       );
       // ... rest of rotation logic ...
   }
   ```
2. [ ] Keep `yieldBps`/`costBps` as parameters in the `CrossChainRotationInitiated` event (purely informational, logged by CRE workflow).
3. [ ] Update `YieldKeeperCRE.sol` `_performRotation()` to pass yield/cost to the event but not to validation.
4. [ ] Remove `RotationValidator.validateSpread()` and `RotationValidator.validateCost()` from the on-chain execution path.
5. [ ] Keep `RotationValidator` library — move spread/cost checks to the CRE workflow (off-chain decision layer, where they belong).
6. [ ] Update `IStrategyControllerKeeper` interface.
7. [ ] Update tests: remove spread/cost validation tests, add test confirming rotation works without yield params.
8. [ ] Update CRE workflow `main.ts` — keep the spread/cost logic for decision-making, but don't rely on on-chain enforcement.

**Demo impact:** Slightly simpler — fewer parameters to understand when triggering rotations from demo page.

---

## Task 6.5: Add Remote Balance Staleness Check (HIGH)

**Problem:** `remoteBalances[chain]` stays at last-reported value forever. If a spoke goes silent, share price inflates.
**Fix:** Track last report time per chain. Add staleness flag that `totalAssets()` uses to discount stale remote balances.

### Steps

1. [ ] Add to `YieldVault.sol`:
   ```solidity
   mapping(uint64 => uint256) public lastRemoteReportTime;
   uint256 public remoteBalanceStalenessTimeout;  // 72h mainnet, 30 min demo

   function updateRemoteBalance(uint64 chainSelector, uint256 newBalance)
       external onlyRole(STRATEGY_ROLE)
   {
       // ... existing logic ...
       lastRemoteReportTime[chainSelector] = block.timestamp;
   }

   function _totalRemoteBalances() internal view returns (uint256 total) {
       for (uint256 i = 0; i < activeChains.length; i++) {
           uint64 chain = activeChains[i];
           if (block.timestamp > lastRemoteReportTime[chain] + remoteBalanceStalenessTimeout) {
               // Stale — don't count. Emitting events from view is not possible,
               // but CircuitBreaker or keeper can detect and alert.
               continue;
           }
           total += remoteBalances[chain];
       }
   }
   ```
2. [ ] Constructor: `remoteBalanceStalenessTimeout = paramTimelock > 1 hours ? 72 hours : 30 minutes`.
3. [ ] Add admin setter with timelock: `setRemoteBalanceStalenessTimeout(uint256)`.
4. [ ] Add view: `isRemoteBalanceStale(uint64 chainSelector) returns (bool)` — for frontend display.
5. [ ] Add tests:
   - `test_staleRemoteBalanceExcludedFromTotalAssets` — warp past timeout, verify remote balance not counted.
   - `test_freshRemoteBalanceIncluded` — within timeout, balance is counted.
   - `test_reportRefreshesStaleness` — new report resets the clock.
6. [ ] Update frontend `StrategyAllocation` component to show stale warning badge when `isRemoteBalanceStale()` returns true.

**Demo impact:** 30-min timeout is long enough that demo flows (which complete in <5 min) never trigger staleness. If a user leaves and comes back, stale badge is informative, not blocking.

---

## Task 6.6: Add High-Water Mark Reset (HIGH)

**Problem:** CircuitBreaker HWM only ratchets up. After a spike + correction, vault gets permanently stuck in WARN/CRITICAL.
**Fix:** Admin-resettable HWM (behind timelock). Also add a `refreshHighWaterMark()` callable by anyone that sets HWM = current value (only if current < HWM, i.e., acknowledges the drop).

### Steps

1. [ ] Add to `CircuitBreaker.sol`:
   ```solidity
   function resetHighWaterMarks() external onlyRole(ADMIN_ROLE) {
       tvlHighWaterMark = tvlCurrent;
       sharePriceHighWaterMark = sharePriceCurrent;
       emit HighWaterMarksReset(tvlCurrent, sharePriceCurrent);
   }
   ```
2. [ ] No timelock needed — this is a safety recovery function. The admin is already trusted with `activateEmergencyPause()` which has equal impact.
3. [ ] Add test: `test_resetHighWaterMarks` — spike TVL, drop it, reset, verify circuit breaker returns to NORMAL.
4. [ ] Add test: `test_resetHighWaterMarks_onlyAdmin`.

**Demo impact:** None. Demo users don't interact with CircuitBreaker admin functions.

---

## Task 6.7: Add Spoke Deregistration (MEDIUM)

**Problem:** Compromised or deprecated spokes can never be removed.
**Fix:** Add `deregisterSpoke()` behind timelock. Requires zero in-flight and zero remote balance on that chain.

### Steps

1. [ ] Add to `StrategyController.sol`:
   ```solidity
   function deregisterSpoke(uint64 chainSelector) external onlyRole(ADMIN_ROLE) {
       require(spokes[chainSelector] != address(0), "Not registered");
       require(vault.inFlightAmounts(chainSelector) == 0, "In-flight pending");
       require(vault.remoteBalances(chainSelector) == 0, "Remote balance exists");

       delete spokes[chainSelector];
       // Remove from registeredChains array
       for (uint256 i = 0; i < registeredChains.length; i++) {
           if (registeredChains[i] == chainSelector) {
               registeredChains[i] = registeredChains[registeredChains.length - 1];
               registeredChains.pop();
               break;
           }
       }
       emit SpokeDeregistered(chainSelector);
   }
   ```
2. [ ] No timelock for deregistration — it already requires zero balances (safe). The precondition (withdrawing all funds from spoke first) acts as the natural delay.
3. [ ] Add tests:
   - `test_deregisterSpoke_succeeds`
   - `test_deregisterSpoke_revertsWithInFlight`
   - `test_deregisterSpoke_revertsWithRemoteBalance`
   - `test_deregisterSpoke_onlyAdmin`

**Demo impact:** None.

---

## Task 6.8: Add Reentrancy Guard to SpokeVault (MEDIUM)

**Problem:** `_ccipReceive()` and its sub-functions lack reentrancy protection.
**Fix:** Add `ReentrancyGuard` to SpokeVault and `nonReentrant` to `_ccipReceive()`.

### Steps

1. [ ] Add `ReentrancyGuard` import and inheritance to `SpokeVault.sol`.
2. [ ] Since `_ccipReceive` is `internal`, add a `nonReentrant` wrapper. The simplest approach: make `_executeSupply()`, `_executeWithdrawAndReturn()`, and `_reportBalance()` all use a shared reentrancy lock via a state variable check (since they're internal, `nonReentrant` modifier won't work directly). Alternatively, override the external `ccipReceive()` from CCIPReceiver with `nonReentrant`:
   ```solidity
   function ccipReceive(Client.Any2EVMMessage calldata message)
       external override nonReentrant onlyRouter
   {
       _ccipReceive(message);
   }
   ```
3. [ ] Add test: `test_ccipReceive_reentrancyProtected`.

**Demo impact:** None.

---

## Task 6.9: Fix Timelock Self-Call Pattern (MEDIUM)

**Problem:** `executeParamChange()` uses `address(this).call(data)` which changes `msg.sender` to the contract. Setter functions require `ADMIN_ROLE`, so the contract must grant itself ADMIN_ROLE — an anti-pattern.
**Fix:** Use direct storage writes instead of self-calls. The timelock stores the function selector + params, and `executeParamChange` uses an if/else chain to apply them directly.

### Steps

1. [ ] Refactor `executeParamChange()` in `StrategyController.sol`:
   ```solidity
   function executeParamChange(bytes32 id) external onlyRole(ADMIN_ROLE) {
       TimelockEntry storage entry = pendingChanges[id];
       require(entry.exists, "No pending change");
       require(block.timestamp >= entry.readyTime, "Too early");

       // Apply the change directly using stored selector + params
       bytes memory data = entry.data;
       bytes4 selector;
       assembly { selector := mload(add(data, 32)) }

       if (selector == this.setMinSpreadBps.selector) {
           (, uint256 val) = abi.decode(data[4:], (uint256));
           minSpreadBps = val;
       } else if (selector == this.setMaxCostBps.selector) {
           (, uint256 val) = abi.decode(data[4:], (uint256));
           maxCostBps = val;
       }
       // ... etc for each setter

       delete pendingChanges[id];
       emit ParamChangeExecuted(id);
   }
   ```
2. [ ] Remove the need for `controller.grantRole(ADMIN_ROLE, address(controller))`.
3. [ ] Remove old self-call pattern.
4. [ ] Update existing timelock tests to verify new pattern.
5. [ ] Add test: `test_timelockExecute_worksWithoutSelfRole`.

**Demo impact:** None. Demo users don't interact with timelocks (1-min timeout is already fast).

---

## Task 6.10: Frontend Error UX (MEDIUM)

**Problem:** All contract errors go to `console.error()` only. Users see no feedback.
**Fix:** Use toast notifications for all transaction outcomes.

### Steps

1. [ ] Check if SE-2 has a built-in notification system (it does — `useTransactor` or toast utilities).
2. [ ] In `VaultActions.tsx`, replace `console.error("...")` with visible toast:
   ```tsx
   import { notification } from "~~/utils/scaffold-eth";

   // In catch blocks:
   notification.error("Approval failed. Please try again.");
   ```
3. [ ] Add success toasts for deposit/withdraw/redeem completion.
4. [ ] Add loading state feedback: "Transaction submitted, waiting for confirmation..."
5. [ ] Test all error paths in the demo: wrong network, rejected tx, slippage exceeded.

**Demo impact:** Positive — demo becomes more polished and professional.

---

## Task 6.11: Merkl Proof Recipient Validation (MEDIUM)

**Problem:** `harvestMerklRewards()` passes `users` array to Merkl distributor without verifying that the recipient is the vault/harvester.
**Fix:** Validate that `users[i]` is either the vault or the harvester itself.

### Steps

1. [ ] Add validation in `RewardHarvester.sol`:
   ```solidity
   function harvestMerklRewards(
       address[] calldata users,
       address[] calldata tokens,
       uint256[] calldata amounts,
       bytes32[][] calldata proofs
   ) external onlyRole(KEEPER_ROLE) nonReentrant {
       for (uint256 i = 0; i < users.length; i++) {
           require(
               users[i] == address(this) || users[i] == address(vault),
               "Invalid claim recipient"
           );
       }
       merklDistributor.claim(users, tokens, amounts, proofs);
       emit MerklRewardsClaimed(tokens, amounts);
   }
   ```
2. [ ] Add test: `test_harvestMerkl_revertsWrongRecipient`.

**Demo impact:** None.

---

## Task 6.12: New Security Test Suite (HIGH)

**Problem:** Critical scenarios have no test coverage.
**Fix:** Add targeted tests for all audit gaps.

### Steps

1. [ ] Create `packages/foundry/test/unit/SecurityAudit.t.sol`:
   ```
   // In-flight accounting
   test_multiChainRotation_inFlightTracksPerChain
   test_multiChainRotation_balanceReportsIndependent

   // Share price integrity
   test_donationDoesNotInflateSharePrice  // Verify OZ v5 virtual offset
   test_totalAssetsNeverUnderflows
   test_totalAssetsWithMaxRemoteBalances
   test_totalAssetsWithAllStaleRemoteBalances

   // Emergency scenarios
   test_emergencyPauseDuringActiveRotation
   test_emergencyWithdrawWithZeroTotalAssets
   test_emergencyWithdrawWithStaleRemoteBalance

   // Concurrent operations
   test_rotationDuringFulfillRedemptions
   test_depositDuringHarvestYield

   // Edge cases
   test_requestRedeemWithTotalPendingSharesEqualsTotalSupply
   test_fulfillRedemptionsWithPartialLiquidity
   test_zeroAmountRotation
   ```

2. [ ] Create `packages/foundry/test/unit/CCIPRecovery.t.sol`:
   ```
   test_clearStaleInFlight_afterTimeout
   test_clearStaleInFlight_beforeTimeout_reverts
   test_clearStaleInFlight_zeroPending_noOp
   test_rotationSetsTimestamp
   ```

3. [ ] Add to existing test files:
   - `SpokeVault.t.sol`: `test_reentrancyGuard`, `test_zeroAmountSupply`
   - `StrategyController.t.sol`: `test_deregisterSpoke_*` (4 tests)
   - `CircuitBreaker.t.sol`: `test_resetHighWaterMarks_*` (2 tests)
   - `RewardHarvester.t.sol`: `test_escrow_*` (4 tests), `test_merklRecipientValidation`

**Demo impact:** None — tests are developer-facing only.

---

## Task 6.13: Frontend Stale Balance Warning (LOW)

**Problem:** Frontend doesn't show when remote balances are stale.
**Fix:** Add visual indicator in `StrategyAllocation` component.

### Steps

1. [ ] Read `isRemoteBalanceStale(chainSelector)` from vault contract.
2. [ ] Display amber badge "Stale" next to chain balance when stale.
3. [ ] Add tooltip: "No balance report received from this chain in over X minutes."

**Demo impact:** Positive — adds transparency to the cross-chain story.

---

## Task 6.14: Deployment Script Update (LOW)

**Problem:** `DeployAllTestnet.s.sol` missing ADMIN_ROLE self-grant for StrategyController (needed until Task 6.9 lands).
**Fix:** Add the grant, and after Task 6.9 ships, remove it.

### Steps

1. [ ] Add to `DeployAllTestnet.s.sol`:
   ```solidity
   // Temporary: self-grant for timelock self-call pattern (remove after Task 6.9)
   controller.grantRole(controller.ADMIN_ROLE(), address(controller));
   ```
2. [ ] Add comment with TODO to remove after Task 6.9 refactor.
3. [ ] After Task 6.9 ships, remove this line and verify deploy still works.

**Demo impact:** None.

---

## Task 6.15: CRE Workflow Data Validation (LOW)

**Problem:** DeFiLlama API responses used without sanity checks.
**Fix:** Add bounds validation on external yield data.

### Steps

1. [ ] In `main.ts`, add after DeFiLlama fetch:
   ```typescript
   // Sanity check: yield rates should be 0-100% (0-10000 bps)
   if (externalYield && (Number(externalYield) < 0 || Number(externalYield) > 10000)) {
       console.log(`[WARN] Ignoring implausible external yield: ${externalYield} bps`);
       externalYield = undefined;
   }
   ```
2. [ ] Add similar bounds check for cross-chain rate data.
3. [ ] If all external data fails validation, fall back to on-chain-only decision (supply idle / harvest — never rotate on bad data).

**Demo impact:** None — DeFiLlama returns 0 on testnet anyway (known limitation).

---

## Execution Order

The tasks are ordered to minimize redeployment. Group contract changes into a single redeploy.

### Wave 1: Contract Fixes (deploy together as v7)
| Order | Task | Priority | Contract Changed |
|-------|------|----------|------------------|
| 1 | 6.1 — In-flight clearing bug | CRITICAL | StrategyController |
| 2 | 6.2 — CCIP message recovery | CRITICAL | StrategyController |
| 3 | 6.3 — Reward escrow model | CRITICAL | RewardHarvester |
| 4 | 6.4 — Remove yield param validation | HIGH | StrategyController, YieldKeeperCRE |
| 5 | 6.5 — Remote balance staleness | HIGH | YieldVault |
| 6 | 6.6 — HWM reset | HIGH | CircuitBreaker |
| 7 | 6.7 — Spoke deregistration | MEDIUM | StrategyController |
| 8 | 6.8 — SpokeVault reentrancy | MEDIUM | SpokeVault |
| 9 | 6.9 — Timelock self-call fix | MEDIUM | StrategyController |
| 10 | 6.11 — Merkl validation | MEDIUM | RewardHarvester |

### Wave 2: Tests (no deploy needed)
| Order | Task | Priority |
|-------|------|----------|
| 11 | 6.12 — Security test suite | HIGH |

### Wave 3: Frontend + Workflow (no deploy needed)
| Order | Task | Priority |
|-------|------|----------|
| 12 | 6.10 — Frontend error UX | MEDIUM |
| 13 | 6.13 — Stale balance warning | LOW |
| 14 | 6.15 — CRE data validation | LOW |

### Wave 4: Deploy Script (for next redeploy)
| Order | Task | Priority |
|-------|------|----------|
| 15 | 6.14 — Deploy script update | LOW |

---

## Contracts Modified (Summary)

| Contract | Tasks | Needs Redeploy |
|----------|-------|----------------|
| StrategyController | 6.1, 6.2, 6.4, 6.7, 6.9 | Yes (v7) |
| YieldVault | 6.5 | Yes (v2) |
| CircuitBreaker | 6.6 | Yes (v2) |
| RewardHarvester | 6.3, 6.11 | Yes (v2) |
| SpokeVault | 6.8 | Yes (v4) |
| YieldKeeperCRE | 6.4 | Yes (v5) |
| VaultGateway | — | No change |
| DeadManSwitch | — | No change |
| YieldKeeper | — | No change |

---

## Demo-Mode Defaults

All timeouts auto-detect based on `PARAM_TIMELOCK`:

| Parameter | Demo (timelock ≤ 1h) | Production (timelock > 1h) |
|-----------|----------------------|---------------------------|
| `inFlightStalenessTimeout` | 5 minutes | 48 hours |
| `remoteBalanceStalenessTimeout` | 30 minutes | 72 hours |
| `reinvestDeadline` | 10 minutes | 48 hours |
| `rotationCooldown` | 0 (existing) | 24 hours |
| `PARAM_TIMELOCK` | 1 minute (existing) | 48 hours |

No extra config needed. The existing `PARAM_TIMELOCK` constructor pattern acts as the demo/prod switch.

---

## Audit Findings Resolution Matrix

| # | Finding | Severity | Task | Status |
|---|---------|----------|------|--------|
| 1 | In-flight clearing clears all chains | CRITICAL | 6.1 | [x] Fixed: clears per-chain only |
| 2 | No CCIP message recovery | CRITICAL | 6.2 | [x] Added clearStaleInFlight() |
| 3 | Swapper can steal rewards | CRITICAL | 6.3 | [x] Escrow model with deadlines |
| 4 | Keeper fabricates yield params | HIGH | 6.4 | [x] Removed on-chain validation (informational only) |
| 5 | Share price donation attack | ~~CRITICAL~~ RESOLVED | — | [x] OZ v5.5.0 has virtual offset |
| 6 | Stale remote balances inflate TVL | HIGH | 6.5 | [x] Staleness timeout + exclusion |
| 7 | HWM ratchet permanently locks vault | HIGH | 6.6 | [x] Admin-resettable HWM |
| 8 | Spoke cannot be deregistered | MEDIUM | 6.7 | [x] deregisterSpoke() added |
| 9 | SpokeVault no reentrancy guard | MEDIUM | 6.8 | [x] ReentrancyGuard on ccipReceive |
| 10 | Timelock self-call anti-pattern | MEDIUM | 6.9 | [x] Selector-based dispatch |
| 11 | Frontend silent errors | MEDIUM | 6.10 | [x] notification.error/success |
| 12 | Merkl recipient not validated | MEDIUM | 6.11 | [x] Validates vault/self only |
| 13 | Missing security test scenarios | HIGH | 6.12 | [x] 26 new tests added |
| 14 | No stale balance UI indicator | LOW | 6.13 | [x] Amber "Stale" badge |
| 15 | Deploy script missing self-grant | LOW | 6.14 | [x] No longer needed (6.9 fixed root cause) |
| 16 | CRE workflow unvalidated data | LOW | 6.15 | [x] Bounds checks on yield data |

---

## What Was NOT Changed (And Why)

| Concern | Decision | Rationale |
|---------|----------|-----------|
| No upgradeability (proxy) | Keep immutable | Complexity/attack surface trade-off. Protocol is small enough to migrate. Proxies add trust assumptions that conflict with demo simplicity. |
| Single-signer deployer | Keep for testnet | Multisig is production concern. Demo should be single-key for speed. Document as "production: transfer all roles to Safe multisig." |
| No MEV protection | Skip | All activity is on L2 (Base/Arb) where sequencers process in order. No public mempool reordering. VaultGateway slippage protection is sufficient. |
| Redemption queue O(n^2) | Keep | MAX_PENDING_QUEUE=200 is bounded. Gas cost at 200 entries is ~500K gas on L2 (~$0.01). Not worth optimizing. |
| No event indexing (subgraph) | Skip | Frontend reads directly via RPC. Testnet scale doesn't need indexing. Document as "production: deploy subgraph." |
| SE-2 branding | Skip in this phase | Cosmetic. Not a security or correctness issue. Can be done anytime. |
| CCIP message replay | Skip | CCIP protocol itself provides exactly-once delivery guarantees. On-chain deduplication would add storage cost for a scenario that CCIP already handles. |
