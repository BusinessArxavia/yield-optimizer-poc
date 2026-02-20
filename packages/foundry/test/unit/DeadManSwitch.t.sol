// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { StrategyController } from "../../contracts/strategy/StrategyController.sol";
import { DeadManSwitch } from "../../contracts/automation/DeadManSwitch.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForDMS is IAggregatorV3 {
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

contract MockCCIPRouterForDMS {
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

contract DeadManSwitchTest is Test {
    DeadManSwitch public dms;
    YieldVault public vault;
    StrategyController public controller;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    MockPriceFeedForDMS public priceFeed;
    MockCCIPRouterForDMS public ccipRouter;
    ERC20Mock public linkToken;

    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address user1 = makeAddr("user1");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");
    address feeRecipient = makeAddr("feeRecipient");

    uint256 constant TIMEOUT = 24 hours;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));
        linkToken = new ERC20Mock("Chainlink", "LINK", 18);
        priceFeed = new MockPriceFeedForDMS();
        ccipRouter = new MockCCIPRouterForDMS();

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
            admin,
            address(aavePool),
            address(breaker),
            feeRecipient,
            1000
        );

        controller = new StrategyController(
            admin,
            address(vault),
            address(aavePool),
            address(ccipRouter),
            address(linkToken),
            address(breaker),
            50,
            100,
            48 hours,
            24 hours
        );

        // Wire roles
        vm.startPrank(admin);
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        vm.stopPrank();

        dms = new DeadManSwitch(address(controller), admin, guardian, TIMEOUT);

        // Grant KEEPER_ROLE on StrategyController to the DeadManSwitch
        bytes32 keeperRole = controller.KEEPER_ROLE();
        vm.prank(admin);
        controller.grantRole(keeperRole, address(dms));

        // Fund aave pool
        usdc.mint(address(aavePool), 1_000_000e18);
    }

    // ─── Constructor ────────────────────────────────────────────────

    function test_constructorSetsState() public view {
        assertEq(address(dms.strategyController()), address(controller));
        assertEq(dms.timeout(), TIMEOUT);
        assertTrue(dms.hasRole(dms.GUARDIAN_ROLE(), guardian));
        assertTrue(dms.hasRole(dms.ADMIN_ROLE(), admin));
    }

    function test_constructorRevertsOnShortTimeout() public {
        vm.expectRevert(DeadManSwitch.TimeoutTooShort.selector);
        new DeadManSwitch(address(controller), admin, guardian, 30 minutes);
    }

    // ─── isExpired / timeRemaining ──────────────────────────────────

    function test_notExpiredInitially() public view {
        assertFalse(dms.isExpired());
        assertGt(dms.timeRemaining(), 0);
    }

    function test_expiredAfterTimeout() public {
        vm.warp(block.timestamp + TIMEOUT);
        assertTrue(dms.isExpired());
        assertEq(dms.timeRemaining(), 0);
    }

    function test_timeRemainingDecreases() public {
        uint256 initial = dms.timeRemaining();
        vm.warp(block.timestamp + 1 hours);
        uint256 after1h = dms.timeRemaining();
        assertEq(after1h, initial - 1 hours);
    }

    // ─── heartbeat ──────────────────────────────────────────────────

    function test_heartbeatResetsTimer() public {
        vm.warp(block.timestamp + TIMEOUT - 1 hours);
        vm.prank(guardian);
        dms.heartbeat();

        assertFalse(dms.isExpired());
        assertEq(dms.timeRemaining(), TIMEOUT);
    }

    function test_heartbeatRevertsWhenNotGuardian() public {
        vm.prank(user1);
        vm.expectRevert();
        dms.heartbeat();
    }

    // ─── triggerFallbackHarvest ──────────────────────────────────────

    function test_fallbackHarvestRevertsWhenNotExpired() public {
        vm.prank(guardian);
        vm.expectRevert(DeadManSwitch.KeeperStillActive.selector);
        dms.triggerFallbackHarvest();
    }

    function test_fallbackHarvestRevertsWhenNotGuardian() public {
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(user1);
        vm.expectRevert();
        dms.triggerFallbackHarvest();
    }

    function test_fallbackHarvestExecutes() public {
        // Setup: deposit and supply to Aave, simulate yield
        _depositToVault(user1, 10_000e18);
        vm.prank(admin);
        controller.executeLocalSupply(address(usdc), 10_000e18);
        aToken.simulateYield(address(vault), 100e18);

        // Expire the timeout
        vm.warp(block.timestamp + TIMEOUT + 1);

        uint256 feeSharesBefore = vault.balanceOf(feeRecipient);

        vm.prank(guardian);
        dms.triggerFallbackHarvest();

        uint256 feeSharesAfter = vault.balanceOf(feeRecipient);
        assertTrue(feeSharesAfter > feeSharesBefore, "Fee shares should be minted");

        // Timer should be reset
        assertFalse(dms.isExpired());
    }

    // ─── triggerFallbackSupply ───────────────────────────────────────

    function test_fallbackSupplyRevertsWhenNotExpired() public {
        vm.prank(guardian);
        vm.expectRevert(DeadManSwitch.KeeperStillActive.selector);
        dms.triggerFallbackSupply(address(usdc), 1000e18);
    }

    function test_fallbackSupplyExecutes() public {
        _depositToVault(user1, 10_000e18);

        vm.warp(block.timestamp + TIMEOUT + 1);

        uint256 idleBefore = usdc.balanceOf(address(vault));

        vm.prank(guardian);
        dms.triggerFallbackSupply(address(usdc), 5_000e18);

        uint256 idleAfter = usdc.balanceOf(address(vault));
        assertEq(idleBefore - idleAfter, 5_000e18);
        assertEq(aToken.balanceOf(address(vault)), 5_000e18);

        // Timer should be reset
        assertFalse(dms.isExpired());
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function test_setTimeout() public {
        vm.prank(admin);
        dms.setTimeout(48 hours);
        assertEq(dms.timeout(), 48 hours);
    }

    function test_setTimeout_revertsTooShort() public {
        vm.prank(admin);
        vm.expectRevert(DeadManSwitch.TimeoutTooShort.selector);
        dms.setTimeout(30 minutes);
    }

    function test_setTimeout_revertsNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        dms.setTimeout(48 hours);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _depositToVault(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();
    }
}
