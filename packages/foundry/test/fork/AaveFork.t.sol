// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAavePool } from "../../contracts/interfaces/IAavePool.sol";
import { IAToken } from "../../contracts/interfaces/IAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";

/// @title AaveFork — Fork tests against real Aave V3 on Base
/// @notice Run with: forge test --fork-url $RPC_BASE --match-contract AaveFork -vvv
contract AaveForkTest is Test {
    // ─── Base Mainnet Addresses ─────────────────────────────────────
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDC_USD_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;

    // ─── State ──────────────────────────────────────────────────────
    YieldVault public vault;
    CircuitBreaker public breaker;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");
    address user = makeAddr("user");

    function setUp() public {
        // Skip if not running against a fork (Aave pool address has no code locally)
        if (AAVE_POOL.code.length == 0) {
            vm.skip(true);
            return;
        }

        // Deploy circuit breaker with real price feed
        uint256[3] memory depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

        breaker =
            new CircuitBreaker(admin, pauser, unpauser, USDC_USD_FEED, depegThresholds, tvlDropBps, sharePriceDropBps);

        vault = new YieldVault(
            IERC20(USDC),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            AAVE_POOL,
            address(breaker),
            makeAddr("feeRecipient"),
            1000
        );

        // Deal USDC to user (USDC has 6 decimals on Base)
        deal(USDC, user, 10_000e6);

        vm.prank(user);
        IERC20(USDC).approve(address(vault), type(uint256).max);
    }

    function test_fork_depositAndSupplyToAave() public {
        // Deposit into vault
        vm.prank(user);
        vault.deposit(5000e6, user);

        assertEq(vault.totalAssets(), 5000e6);
        assertGt(vault.balanceOf(user), 0);

        // Supply to Aave
        vm.prank(strategy);
        vault.supplyToAave(5000e6);

        // aToken balance should be ~5000e6
        assertApproxEqAbs(vault.totalAssets(), 5000e6, 1);
    }

    function test_fork_yieldAccrual() public {
        vm.prank(user);
        vault.deposit(5000e6, user);

        vm.prank(strategy);
        vault.supplyToAave(5000e6);

        uint256 assetsBefore = vault.totalAssets();

        // Warp 30 days
        vm.warp(block.timestamp + 30 days);
        // Roll 1 block to update Aave state
        vm.roll(block.number + 1);

        uint256 assetsAfter = vault.totalAssets();
        console2.log("Assets before:", assetsBefore);
        console2.log("Assets after 30d:", assetsAfter);

        // Yield should have accrued (even if tiny)
        assertGe(assetsAfter, assetsBefore, "No yield accrued");
    }

    function test_fork_fullFlow() public {
        // 1. Deposit
        vm.prank(user);
        vault.deposit(5000e6, user);

        // 2. Supply to Aave
        vm.prank(strategy);
        vault.supplyToAave(5000e6);

        // 3. Warp for yield
        vm.warp(block.timestamp + 7 days);
        vm.roll(block.number + 1);

        // 4. Withdraw from Aave
        vm.prank(strategy);
        vault.withdrawFromAave(3000e6);

        // 5. User redeems some shares
        uint256 sharesToRedeem = vault.balanceOf(user) / 2;
        vm.prank(user);
        uint256 assetsReceived = vault.redeem(sharesToRedeem, user, user);

        assertGt(assetsReceived, 0, "No assets received on redeem");
        console2.log("Redeemed assets:", assetsReceived);

        // 6. Emergency withdraw remaining
        vm.prank(user);
        uint256 emergencyAssets = vault.emergencyWithdraw();

        assertGt(emergencyAssets, 0, "Emergency withdraw returned 0");
        assertEq(vault.balanceOf(user), 0, "Shares remaining after emergency");
    }

    function test_fork_circuitBreakerWithRealFeed() public {
        // Read the feed's updatedAt and warp to just after it so it's not considered stale
        (,,, uint256 updatedAt,) = IAggregatorV3(USDC_USD_FEED).latestRoundData();
        vm.warp(updatedAt + 1);

        // Check that circuit breaker reads real USDC/USD price
        breaker.checkAndUpdateTier();

        // USDC should be near $1, so tier should be NORMAL (or at most WATCH)
        assertTrue(
            uint256(breaker.currentTier()) <= uint256(CircuitBreaker.Tier.WATCH),
            "Tier should be NORMAL or WATCH for a healthy USDC peg"
        );
    }

    function test_fork_withdrawAfterAaveSupply() public {
        vm.prank(user);
        vault.deposit(5000e6, user);

        vm.prank(strategy);
        vault.supplyToAave(5000e6);

        // User should be able to withdraw (vault will pull from Aave)
        uint256 maxW = vault.maxWithdraw(user);
        assertGt(maxW, 0, "maxWithdraw is 0");

        vm.prank(user);
        vault.withdraw(maxW, user, user);

        assertEq(vault.balanceOf(user), 0);
    }
}
