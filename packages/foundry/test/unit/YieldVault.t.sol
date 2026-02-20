// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForVault is IAggregatorV3 {
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

contract YieldVaultTest is Test {
    YieldVault public vault;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    MockPriceFeedForVault public priceFeed;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address feeRecipient = makeAddr("feeRecipient");
    address user1 = makeAddr("user1");
    address user2 = makeAddr("user2");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");

    uint256 constant INITIAL_BALANCE = 100_000e18;

    function setUp() public {
        // Deploy mocks
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));

        // Deploy circuit breaker with healthy defaults
        priceFeed = new MockPriceFeedForVault();
        uint256[3] memory depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

        breaker = new CircuitBreaker(
            admin, pauser, unpauser, address(priceFeed), depegThresholds, tvlDropBps, sharePriceDropBps
        );

        // Deploy vault
        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            address(aavePool),
            address(breaker),
            feeRecipient,
            1000 // 10% performance fee
        );

        // Fund users
        usdc.mint(user1, INITIAL_BALANCE);
        usdc.mint(user2, INITIAL_BALANCE);

        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Deposit & Withdraw ─────────────────────────────────────────

    function test_deposit() public {
        uint256 amount = 1000e18;
        vm.prank(user1);
        uint256 shares = vault.deposit(amount, user1);

        assertEq(shares, amount); // 1:1 initially
        assertEq(vault.balanceOf(user1), amount);
        assertEq(vault.totalAssets(), amount);
    }

    function test_withdraw() public {
        uint256 amount = 1000e18;
        vm.prank(user1);
        vault.deposit(amount, user1);

        vm.prank(user1);
        uint256 assets = vault.withdraw(amount, user1, user1);

        assertEq(assets, amount);
        assertEq(vault.balanceOf(user1), 0);
        assertEq(usdc.balanceOf(user1), INITIAL_BALANCE);
    }

    function test_multipleDepositsAndWithdrawals() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);

        vm.prank(user2);
        vault.deposit(500e18, user2);

        assertEq(vault.totalAssets(), 1000e18);

        vm.prank(user1);
        vault.withdraw(250e18, user1, user1);

        assertEq(vault.totalAssets(), 750e18);
    }

    // ─── totalAssets Accounting ──────────────────────────────────────

    function test_totalAssetsIncludesIdleAndAave() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Supply half to Aave
        vm.prank(strategy);
        vault.supplyToAave(500e18);

        // totalAssets = 500 idle + 500 aToken
        assertEq(vault.totalAssets(), 1000e18);
    }

    function test_totalAssetsIncludesRemoteBalances() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Simulate remote balance
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 200e18);

        assertEq(vault.totalAssets(), 1200e18);
    }

    function test_totalAssetsSubtractsInFlight() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.startPrank(strategy);
        vault.updateInFlight(uint64(1), int256(100e18));
        vm.stopPrank();

        assertEq(vault.totalAssets(), 900e18);
    }

    // ─── Emergency Withdraw ─────────────────────────────────────────

    function test_emergencyWithdraw() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Supply all to Aave
        vm.prank(strategy);
        vault.supplyToAave(1000e18);

        // Emergency withdraw
        vm.prank(user1);
        uint256 assets = vault.emergencyWithdraw();

        assertEq(assets, 1000e18);
        assertEq(vault.balanceOf(user1), 0);
        assertEq(usdc.balanceOf(user1), INITIAL_BALANCE);
    }

    function test_emergencyWithdrawProRata() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);
        vm.prank(user2);
        vault.deposit(500e18, user2);

        // Some assets are remote (not withdrawable locally)
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 200e18);

        // user1 emergency withdraw gets pro-rata of home assets only
        vm.prank(user1);
        uint256 assets = vault.emergencyWithdraw();

        // Home assets = 1000e18, user1 has 50% of shares → 500e18
        assertEq(assets, 500e18);
    }

    function test_emergencyWithdrawZeroSharesReverts() public {
        vm.prank(user1);
        vm.expectRevert(YieldVault.ZeroAmount.selector);
        vault.emergencyWithdraw();
    }

    // ─── Circuit Breaker Gating ─────────────────────────────────────

    function test_depositBlockedWhenCritical() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(user1);
        vm.expectRevert(YieldVault.CircuitBreakerActive.selector);
        vault.deposit(1000e18, user1);
    }

    function test_mintBlockedWhenCritical() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(user1);
        vm.expectRevert(YieldVault.CircuitBreakerActive.selector);
        vault.mint(1000e18, user1);
    }

    function test_withdrawNeverBlockedByCB() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Activate emergency
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        // Withdraw should still work!
        vm.prank(user1);
        vault.withdraw(500e18, user1, user1);
        assertEq(vault.balanceOf(user1), 500e18);
    }

    function test_redeemNeverBlockedByCB() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(user1);
        vault.redeem(500e18, user1, user1);
        assertEq(vault.balanceOf(user1), 500e18);
    }

    function test_emergencyWithdrawNeverBlockedByCB() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(user1);
        vault.emergencyWithdraw();
        assertEq(vault.balanceOf(user1), 0);
    }

    // ─── maxWithdraw / maxRedeem Caps ───────────────────────────────

    function test_maxWithdrawCappedToHomeAssets() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Simulate some in remote
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        // maxWithdraw should be capped to home chain assets (1000e18)
        // even though totalAssets = 1500e18
        uint256 maxW = vault.maxWithdraw(user1);
        assertEq(maxW, 1000e18);
    }

    // ─── Aave Operations ────────────────────────────────────────────

    function test_supplyToAave() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.supplyToAave(500e18);

        assertEq(usdc.balanceOf(address(vault)), 500e18);
        assertEq(aToken.balanceOf(address(vault)), 500e18);
        assertEq(vault.totalAssets(), 1000e18);
    }

    function test_withdrawFromAave() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.supplyToAave(1000e18);

        vm.prank(strategy);
        vault.withdrawFromAave(500e18);

        assertEq(usdc.balanceOf(address(vault)), 500e18);
        assertEq(aToken.balanceOf(address(vault)), 500e18);
    }

    function test_supplyToAaveBlockedWhenCBWarn() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(strategy);
        vm.expectRevert(YieldVault.CircuitBreakerWarn.selector);
        vault.supplyToAave(500e18);
    }

    function test_withdrawFromAaveNeverBlocked() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.supplyToAave(1000e18);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        // withdrawFromAave should still work
        vm.prank(strategy);
        vault.withdrawFromAave(500e18);
        assertEq(usdc.balanceOf(address(vault)), 500e18);
    }

    // ─── Performance Fee ────────────────────────────────────────────

    function test_harvestYieldMintsFeeShares() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Simulate yield by minting extra to aToken
        vm.prank(strategy);
        vault.supplyToAave(1000e18);
        aToken.simulateYield(address(vault), 100e18);

        // Harvest
        vm.prank(strategy);
        vault.harvestYield();

        // Fee recipient should have some shares
        assertTrue(vault.balanceOf(feeRecipient) > 0);
    }

    function test_harvestNoYieldDoesNothing() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.harvestYield();

        assertEq(vault.balanceOf(feeRecipient), 0);
    }

    // ─── Access Control ─────────────────────────────────────────────

    function test_onlyStrategyCanSupplyToAave() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(user1);
        vm.expectRevert();
        vault.supplyToAave(500e18);
    }

    function test_onlyStrategyCanWithdrawFromAave() public {
        vm.prank(user1);
        vm.expectRevert();
        vault.withdrawFromAave(500e18);
    }

    function test_onlyStrategyCanUpdateRemoteBalance() public {
        vm.prank(user1);
        vm.expectRevert();
        vault.updateRemoteBalance(uint64(1), 100e18);
    }

    function test_onlyStrategyCanUpdateInFlight() public {
        vm.prank(user1);
        vm.expectRevert();
        vault.updateInFlight(uint64(1), int256(100e18));
    }

    function test_onlyStrategyCanHarvest() public {
        vm.prank(user1);
        vm.expectRevert();
        vault.harvestYield();
    }

    // ─── Remote Balance & InFlight ──────────────────────────────────

    function test_updateRemoteBalance() public {
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(42), 500e18);

        assertEq(vault.remoteBalances(uint64(42)), 500e18);

        uint64[] memory chains = vault.getActiveChains();
        assertEq(chains.length, 1);
        assertEq(chains[0], 42);
    }

    function test_updateInFlight() public {
        vm.startPrank(strategy);

        vault.updateInFlight(uint64(1), int256(100e18));
        assertEq(vault.inFlightAmounts(uint64(1)), 100e18);
        assertEq(vault.totalInFlight(), 100e18);

        // Clear in-flight
        vault.updateInFlight(uint64(1), -int256(100e18));
        assertEq(vault.inFlightAmounts(uint64(1)), 0);
        assertEq(vault.totalInFlight(), 0);

        vm.stopPrank();
    }

    // ─── Zero Amount Errors ─────────────────────────────────────────

    function test_supplyToAaveZeroReverts() public {
        vm.prank(strategy);
        vm.expectRevert(YieldVault.ZeroAmount.selector);
        vault.supplyToAave(0);
    }

    function test_withdrawFromAaveZeroReverts() public {
        vm.prank(strategy);
        vm.expectRevert(YieldVault.ZeroAmount.selector);
        vault.withdrawFromAave(0);
    }
}
