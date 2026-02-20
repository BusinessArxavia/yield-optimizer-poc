// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { StrategyController } from "../../contracts/strategy/StrategyController.sol";
import { YieldKeeper } from "../../contracts/automation/YieldKeeper.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForKeeper is IAggregatorV3 {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }
}

contract MockCCIPRouterForKeeper {
    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    function getFee(uint64, bytes memory) external pure returns (uint256) {
        return 0.01e18;
    }

    function ccipSend(uint64, bytes calldata) external payable returns (bytes32) {
        return keccak256(abi.encode(block.timestamp));
    }
}

contract YieldKeeperTest is Test {
    YieldKeeper public keeper;
    YieldVault public vault;
    StrategyController public controller;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    MockPriceFeedForKeeper public priceFeed;
    MockCCIPRouterForKeeper public ccipRouter;
    ERC20Mock public linkToken;

    address admin = makeAddr("admin");
    address user1 = makeAddr("user1");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");
    address feeRecipient = makeAddr("feeRecipient");

    uint256 constant MIN_IDLE_SUPPLY = 100e18; // 100 USDC
    uint256 constant IDLE_TARGET_BPS = 500; // 5%
    uint256 constant HARVEST_MIN_YIELD_BPS = 50; // 0.5%
    uint256 constant HARVEST_COOLDOWN = 1 hours;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));
        linkToken = new ERC20Mock("Chainlink", "LINK", 18);
        priceFeed = new MockPriceFeedForKeeper();
        ccipRouter = new MockCCIPRouterForKeeper();

        uint256[3] memory depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

        breaker = new CircuitBreaker(
            admin, pauser, unpauser, address(priceFeed), depegThresholds, tvlDropBps, sharePriceDropBps
        );

        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            admin, // temporary strategy
            address(aavePool),
            address(breaker),
            feeRecipient,
            1000 // 10% performance fee
        );

        controller = new StrategyController(
            admin,
            address(vault),
            address(aavePool),
            address(ccipRouter),
            address(linkToken),
            address(breaker),
            50, // min spread bps
            100, // max cost bps
            48 hours,
            24 hours
        );

        // Grant STRATEGY_ROLE to controller
        vm.startPrank(admin);
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        // Grant KEEPER_ROLE to keeper contract (will deploy next)
        vm.stopPrank();

        keeper = new YieldKeeper(
            address(vault),
            address(controller),
            address(breaker),
            admin,
            MIN_IDLE_SUPPLY,
            IDLE_TARGET_BPS,
            HARVEST_MIN_YIELD_BPS,
            HARVEST_COOLDOWN
        );

        // Grant KEEPER_ROLE on StrategyController to the YieldKeeper
        bytes32 keeperRole = controller.KEEPER_ROLE();
        vm.prank(admin);
        controller.grantRole(keeperRole, address(keeper));

        // Fund the aave pool with USDC for withdrawals
        usdc.mint(address(aavePool), 1_000_000e18);
    }

    // ─── Constructor ────────────────────────────────────────────────

    function test_constructorSetsState() public view {
        assertEq(address(keeper.vault()), address(vault));
        assertEq(address(keeper.strategyController()), address(controller));
        assertEq(address(keeper.circuitBreaker()), address(breaker));
        assertEq(keeper.asset(), address(usdc));
        assertEq(keeper.minIdleSupplyAmount(), MIN_IDLE_SUPPLY);
        assertEq(keeper.idleTargetBps(), IDLE_TARGET_BPS);
        assertEq(keeper.harvestMinYieldBps(), HARVEST_MIN_YIELD_BPS);
        assertEq(keeper.harvestCooldown(), HARVEST_COOLDOWN);
    }

    // ─── checkUpkeep: No Action Needed ──────────────────────────────

    function test_checkUpkeep_noActionWhenEmpty() public view {
        (bool upkeepNeeded,) = keeper.checkUpkeep("");
        assertFalse(upkeepNeeded);
    }

    function test_checkUpkeep_noActionWhenIdleBelowThreshold() public {
        // Deposit a small amount — idle is below threshold
        _depositToVault(user1, 50e18);

        (bool upkeepNeeded,) = keeper.checkUpkeep("");
        assertFalse(upkeepNeeded);
    }

    // ─── checkUpkeep: Supply Idle ──────────────────────────────────

    function test_checkUpkeep_supplyIdleWhenExcessIdle() public {
        // Deposit 10,000 USDC — all idle, exceeds threshold
        _depositToVault(user1, 10_000e18);

        (bool upkeepNeeded, bytes memory performData) = keeper.checkUpkeep("");
        assertTrue(upkeepNeeded);

        YieldKeeper.ActionType action = abi.decode(performData, (YieldKeeper.ActionType));
        assertEq(uint256(action), uint256(YieldKeeper.ActionType.SUPPLY_IDLE));
    }

    function test_checkUpkeep_noSupplyWhenCircuitBreakerActive() public {
        _depositToVault(user1, 10_000e18);

        // Activate circuit breaker
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        (bool upkeepNeeded,) = keeper.checkUpkeep("");
        // Supply should be skipped; harvest check runs but no yield yet
        assertFalse(upkeepNeeded);
    }

    // ─── checkUpkeep: Harvest ───────────────────────────────────────

    function test_checkUpkeep_harvestWhenYieldAccumulated() public {
        // Warp past initial harvest cooldown
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        // Deposit and supply to Aave
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // Simulate yield accrual (1% yield = 100 USDC)
        aToken.simulateYield(address(vault), 100e18);

        (bool upkeepNeeded, bytes memory performData) = keeper.checkUpkeep("");
        assertTrue(upkeepNeeded);

        YieldKeeper.ActionType action = abi.decode(performData, (YieldKeeper.ActionType));
        assertEq(uint256(action), uint256(YieldKeeper.ActionType.HARVEST_YIELD));
    }

    function test_checkUpkeep_noHarvestDuringCooldown() public {
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // Simulate yield and harvest once
        aToken.simulateYield(address(vault), 100e18);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.HARVEST_YIELD));

        // Simulate more yield immediately — should NOT trigger due to cooldown
        aToken.simulateYield(address(vault), 100e18);

        (bool upkeepNeeded,) = keeper.checkUpkeep("");
        assertFalse(upkeepNeeded);
    }

    function test_checkUpkeep_harvestAfterCooldown() public {
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // First harvest
        aToken.simulateYield(address(vault), 100e18);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.HARVEST_YIELD));

        // Advance past cooldown
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        // Simulate more yield
        aToken.simulateYield(address(vault), 100e18);

        (bool upkeepNeeded, bytes memory performData) = keeper.checkUpkeep("");
        assertTrue(upkeepNeeded);

        YieldKeeper.ActionType action = abi.decode(performData, (YieldKeeper.ActionType));
        assertEq(uint256(action), uint256(YieldKeeper.ActionType.HARVEST_YIELD));
    }

    // ─── performUpkeep: Supply ──────────────────────────────────────

    function test_performUpkeep_supplyIdle() public {
        _depositToVault(user1, 10_000e18);

        uint256 idleBefore = usdc.balanceOf(address(vault));
        assertEq(idleBefore, 10_000e18);

        uint256 supplyAmount = 10_000e18 - (10_000e18 * IDLE_TARGET_BPS / 10_000);

        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));

        uint256 idleAfter = usdc.balanceOf(address(vault));
        uint256 aTokenBalance = aToken.balanceOf(address(vault));

        assertEq(idleAfter, 10_000e18 - supplyAmount);
        assertEq(aTokenBalance, supplyAmount);
    }

    function test_performUpkeep_supplyRevertsWhenCircuitBreaker() public {
        _depositToVault(user1, 10_000e18);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.expectRevert(YieldKeeper.NoActionNeeded.selector);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));
    }

    function test_performUpkeep_supplyRevertsWhenNoIdle() public {
        // No deposits, no idle
        vm.expectRevert(YieldKeeper.NoActionNeeded.selector);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));
    }

    // ─── performUpkeep: Harvest ─────────────────────────────────────

    function test_performUpkeep_harvest() public {
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // Simulate yield
        aToken.simulateYield(address(vault), 100e18);

        uint256 feeSharesBefore = vault.balanceOf(feeRecipient);

        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.HARVEST_YIELD));

        uint256 feeSharesAfter = vault.balanceOf(feeRecipient);
        assertTrue(feeSharesAfter > feeSharesBefore, "Fee shares should be minted");
        assertEq(keeper.lastHarvestTime(), block.timestamp);
    }

    function test_performUpkeep_harvestRevertsWhenNoYield() public {
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // No yield accrued
        vm.expectRevert(YieldKeeper.NoActionNeeded.selector);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.HARVEST_YIELD));
    }

    // ─── Priority: Supply takes precedence over harvest ─────────────

    function test_checkUpkeep_supplyPriorityOverHarvest() public {
        _depositToVault(user1, 10_000e18);

        // Supply 9500 to Aave, leave 500 idle (5% target)
        _supplyAllToAave(9_500e18);

        // Now deposit more (creates excess idle) and simulate yield
        _depositToVault(user1, 5_000e18);
        aToken.simulateYield(address(vault), 100e18);

        // Both conditions are met, but supply should have priority
        (bool upkeepNeeded, bytes memory performData) = keeper.checkUpkeep("");
        assertTrue(upkeepNeeded);

        YieldKeeper.ActionType action = abi.decode(performData, (YieldKeeper.ActionType));
        assertEq(uint256(action), uint256(YieldKeeper.ActionType.SUPPLY_IDLE));
    }

    // ─── Admin: Config ──────────────────────────────────────────────

    function test_setConfig() public {
        vm.prank(admin);
        keeper.setConfig(200e18, 300, 100, 2 hours);

        assertEq(keeper.minIdleSupplyAmount(), 200e18);
        assertEq(keeper.idleTargetBps(), 300);
        assertEq(keeper.harvestMinYieldBps(), 100);
        assertEq(keeper.harvestCooldown(), 2 hours);
    }

    function test_setConfig_revertNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        keeper.setConfig(200e18, 300, 100, 2 hours);
    }

    // ─── Forwarder Restriction ───────────────────────────────────────

    function test_setForwarder() public {
        address newForwarder = makeAddr("forwarder");
        vm.prank(admin);
        keeper.setForwarder(newForwarder);
        assertEq(keeper.forwarder(), newForwarder);
    }

    function test_setForwarder_revertNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        keeper.setForwarder(makeAddr("forwarder"));
    }

    function test_performUpkeep_revertUnauthorizedForwarder() public {
        _depositToVault(user1, 10_000e18);

        // Set a forwarder
        address chainlinkForwarder = makeAddr("forwarder");
        vm.prank(admin);
        keeper.setForwarder(chainlinkForwarder);

        // Try calling from a random address — should revert
        vm.prank(user1);
        vm.expectRevert(YieldKeeper.UnauthorizedForwarder.selector);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));
    }

    function test_performUpkeep_allowsForwarder() public {
        _depositToVault(user1, 10_000e18);

        address chainlinkForwarder = makeAddr("forwarder");
        vm.prank(admin);
        keeper.setForwarder(chainlinkForwarder);

        // Call from the forwarder — should succeed
        vm.prank(chainlinkForwarder);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));

        assertEq(keeper.lastPerformTime(), block.timestamp);
    }

    function test_performUpkeep_allowsAnyoneWhenNoForwarder() public {
        _depositToVault(user1, 10_000e18);

        // No forwarder set (address(0)) — anyone can call
        vm.prank(user1);
        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));

        assertEq(keeper.lastPerformTime(), block.timestamp);
    }

    // ─── Edge Cases ─────────────────────────────────────────────────

    function test_performUpkeep_updatesLastPerformTime() public {
        _depositToVault(user1, 10_000e18);

        keeper.performUpkeep(abi.encode(YieldKeeper.ActionType.SUPPLY_IDLE));

        assertEq(keeper.lastPerformTime(), block.timestamp);
    }

    function test_checkUpkeep_smallYieldBelowThreshold() public {
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // Small yield: 0.1% (below 0.5% threshold)
        aToken.simulateYield(address(vault), 10e18);

        (bool upkeepNeeded,) = keeper.checkUpkeep("");
        assertFalse(upkeepNeeded);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _depositToVault(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();
    }

    function _supplyAllToAave(uint256 amount) internal {
        vm.prank(admin);
        controller.executeLocalSupply(address(usdc), amount);
    }
}
