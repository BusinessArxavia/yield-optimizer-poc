// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";

contract MockPriceFeed is IAggregatorV3 {
    int256 public price;
    uint256 public updatedAtValue;
    uint8 public constant DECIMALS = 8;
    bool public shouldRevert;

    constructor(int256 _price) {
        price = _price;
        updatedAtValue = block.timestamp;
    }

    function setPrice(int256 _price) external {
        price = _price;
        updatedAtValue = block.timestamp;
    }

    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAtValue = _updatedAt;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (shouldRevert) revert("Feed error");
        return (1, price, block.timestamp, updatedAtValue, 1);
    }
}

contract CircuitBreakerTest is Test {
    CircuitBreaker public breaker;
    MockPriceFeed public priceFeed;

    address admin = makeAddr("admin");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");
    address vault = makeAddr("vault");
    address nobody = makeAddr("nobody");

    // Depeg thresholds (8 decimals): 0.995, 0.990, 0.980
    uint256[3] depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
    // TVL drop bps: 5%, 10%, 20%
    uint256[3] tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
    // Share price drop bps: 3%, 7%, 15%
    uint256[3] sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

    function setUp() public {
        priceFeed = new MockPriceFeed(1e8); // $1.00 = healthy

        breaker = new CircuitBreaker(
            admin, pauser, unpauser, address(priceFeed), depegThresholds, tvlDropBps, sharePriceDropBps
        );

        // Grant vault role (cache the role first so vm.prank is not consumed by the view call)
        bytes32 vaultRole = breaker.VAULT_ROLE();
        vm.prank(admin);
        breaker.grantRole(vaultRole, vault);
    }

    // ─── Initial State ──────────────────────────────────────────────

    function test_initialTierIsNormal() public view {
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.NORMAL));
        assertFalse(breaker.isActive());
        assertFalse(breaker.isCritical());
    }

    // ─── Price-based Tier Transitions ───────────────────────────────

    function test_priceDropToWatch() public {
        priceFeed.setPrice(99_400_000); // 0.994 → below watch (0.995)
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WATCH));
        assertFalse(breaker.isActive()); // WATCH doesn't activate
    }

    function test_priceDropToWarn() public {
        priceFeed.setPrice(98_900_000); // 0.989 → below warn (0.990)
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WARN));
        assertTrue(breaker.isActive());
        assertFalse(breaker.isCritical());
    }

    function test_priceDropToCritical() public {
        priceFeed.setPrice(97_900_000); // 0.979 → below critical (0.980)
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.CRITICAL));
        assertTrue(breaker.isActive());
        assertTrue(breaker.isCritical());
    }

    function test_priceRecovery() public {
        // Drop to warn
        priceFeed.setPrice(98_900_000);
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WARN));

        // Recover to normal
        priceFeed.setPrice(1e8);
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.NORMAL));
    }

    function test_negativePriceIsCritical() public {
        priceFeed.setPrice(-1);
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.CRITICAL));
    }

    function test_zeroPriceIsCritical() public {
        priceFeed.setPrice(0);
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.CRITICAL));
    }

    // ─── Stale Price Feed ───────────────────────────────────────────

    function test_stalePriceFeedTriggersWarn() public {
        // Warp to a future time so subtraction doesn't underflow
        vm.warp(10 hours);
        priceFeed.setUpdatedAt(block.timestamp - 2 hours); // Stale
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WARN));
    }

    function test_priceFeedRevertTriggersWarn() public {
        priceFeed.setShouldRevert(true);
        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WARN));
    }

    // ─── TVL Drop Detection ─────────────────────────────────────────

    function test_tvlDropTriggersWatch() public {
        vm.startPrank(vault);
        breaker.updateTvlSnapshot(1000e18);
        // Drop 6% (> 5% watch threshold)
        breaker.updateTvlSnapshot(940e18);
        vm.stopPrank();

        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WATCH));
    }

    function test_tvlDropTriggersWarn() public {
        vm.startPrank(vault);
        breaker.updateTvlSnapshot(1000e18);
        // Drop 11% (> 10% warn threshold)
        breaker.updateTvlSnapshot(890e18);
        vm.stopPrank();

        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WARN));
    }

    function test_tvlDropTriggersCritical() public {
        vm.startPrank(vault);
        breaker.updateTvlSnapshot(1000e18);
        // Drop 21% (> 20% critical threshold)
        breaker.updateTvlSnapshot(790e18);
        vm.stopPrank();

        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.CRITICAL));
    }

    function test_tvlHighWaterMarkUpdates() public {
        vm.startPrank(vault);
        breaker.updateTvlSnapshot(1000e18);
        assertEq(breaker.tvlHighWaterMark(), 1000e18);

        breaker.updateTvlSnapshot(1100e18);
        assertEq(breaker.tvlHighWaterMark(), 1100e18);

        // Drop doesn't reduce HWM
        breaker.updateTvlSnapshot(1050e18);
        assertEq(breaker.tvlHighWaterMark(), 1100e18);
        vm.stopPrank();
    }

    // ─── Share Price Drop Detection ─────────────────────────────────

    function test_sharePriceDropTriggersWatch() public {
        vm.startPrank(vault);
        breaker.updateSharePriceSnapshot(1e18);
        // Drop 4% (> 3% watch threshold)
        breaker.updateSharePriceSnapshot(0.96e18);
        vm.stopPrank();

        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WATCH));
    }

    function test_sharePriceDropTriggersWarn() public {
        vm.startPrank(vault);
        breaker.updateSharePriceSnapshot(1e18);
        // Drop 8% (> 7% warn threshold)
        breaker.updateSharePriceSnapshot(0.92e18);
        vm.stopPrank();

        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.WARN));
    }

    // ─── Emergency Pause ────────────────────────────────────────────

    function test_emergencyPauseSetsCritical() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        assertTrue(breaker.emergencyPaused());
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.CRITICAL));
        assertTrue(breaker.isCritical());
        assertTrue(breaker.isActive());
    }

    function test_emergencyPauseOnlyPauser() public {
        vm.prank(nobody);
        vm.expectRevert();
        breaker.activateEmergencyPause();
    }

    function test_deactivateEmergencyPause() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        // Must wait cooldown
        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(unpauser);
        breaker.deactivateEmergencyPause();

        assertFalse(breaker.emergencyPaused());
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.NORMAL));
    }

    function test_deactivateBeforeCooldownReverts() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(unpauser);
        vm.expectRevert();
        breaker.deactivateEmergencyPause();
    }

    function test_deactivateOnlyUnpauser() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(pauser); // Wrong role
        vm.expectRevert();
        breaker.deactivateEmergencyPause();
    }

    function test_deactivateWhenNotPausedReverts() public {
        vm.prank(unpauser);
        vm.expectRevert(CircuitBreaker.NotEmergencyPaused.selector);
        breaker.deactivateEmergencyPause();
    }

    function test_emergencyPauseOverridesAlgorithmicTier() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        // Even if price is fine, still CRITICAL
        priceFeed.setPrice(1e8);
        breaker.checkAndUpdateTier(); // Should be no-op
        assertTrue(breaker.isCritical());
    }

    // ─── Access Control ─────────────────────────────────────────────

    function test_onlyVaultCanUpdateTvl() public {
        vm.prank(nobody);
        vm.expectRevert();
        breaker.updateTvlSnapshot(100e18);
    }

    function test_onlyVaultCanUpdateSharePrice() public {
        vm.prank(nobody);
        vm.expectRevert();
        breaker.updateSharePriceSnapshot(1e18);
    }

    // ─── Worst Tier Logic ───────────────────────────────────────────

    function test_worstTierWins() public {
        // Price is healthy (NORMAL), but TVL dropped heavily (CRITICAL)
        vm.startPrank(vault);
        breaker.updateTvlSnapshot(1000e18);
        breaker.updateTvlSnapshot(790e18); // 21% drop → CRITICAL
        vm.stopPrank();

        breaker.checkAndUpdateTier();
        assertEq(uint256(breaker.currentTier()), uint256(CircuitBreaker.Tier.CRITICAL));
    }

    // ─── Events ─────────────────────────────────────────────────────

    function test_tierChangedEvent() public {
        priceFeed.setPrice(98_900_000); // WARN
        vm.expectEmit();
        emit CircuitBreaker.TierChanged(CircuitBreaker.Tier.NORMAL, CircuitBreaker.Tier.WARN);
        breaker.checkAndUpdateTier();
    }

    function test_emergencyPauseEvent() public {
        vm.prank(pauser);
        vm.expectEmit();
        emit CircuitBreaker.EmergencyPauseActivated(pauser);
        breaker.activateEmergencyPause();
    }
}
