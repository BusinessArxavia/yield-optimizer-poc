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

contract MockPriceFeedForAsync is IAggregatorV3 {
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

contract AsyncRedeemTest is Test {
    YieldVault public vault;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address feeRecipient = makeAddr("feeRecipient");
    address user1 = makeAddr("user1");
    address user2 = makeAddr("user2");
    address receiver = makeAddr("receiver");

    uint256 constant INITIAL_BALANCE = 100_000e18;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));

        MockPriceFeedForAsync priceFeed = new MockPriceFeedForAsync();
        uint256[3] memory depeg = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvl = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory share = [uint256(300), uint256(700), uint256(1500)];
        breaker = new CircuitBreaker(admin, admin, admin, address(priceFeed), depeg, tvl, share);

        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            address(aavePool),
            address(breaker),
            feeRecipient,
            1000
        );

        usdc.mint(user1, INITIAL_BALANCE);
        usdc.mint(user2, INITIAL_BALANCE);

        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Constructor Validation ─────────────────────────────────

    function test_constructorRevertsOnZeroFeeRecipient() public {
        vm.expectRevert(YieldVault.InvalidFeeRecipient.selector);
        new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            address(aavePool),
            address(breaker),
            address(0),
            1000
        );
    }

    function test_constructorRevertsOnExcessiveFee() public {
        vm.expectRevert(abi.encodeWithSelector(YieldVault.FeeTooHigh.selector, 5000, 3000));
        new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            address(aavePool),
            address(breaker),
            feeRecipient,
            5000
        );
    }

    // ─── Instant Redeem Path ──────────────────────────────────────

    function test_requestRedeemInstantWhenLiquidityExists() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        uint256 balBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(500e18, user1, 0);

        assertEq(id, 0); // instant
        assertEq(vault.balanceOf(user1), 500e18);
        assertEq(usdc.balanceOf(user1), balBefore + 500e18);
    }

    function test_requestRedeemInstantWithMinAssetsOut() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(500e18, user1, 500e18);

        assertEq(id, 0);
    }

    function test_requestRedeemInstantRevertsOnSlippage() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.RedeemSlippageExceeded.selector, 0, 500e18, 501e18));
        vault.requestRedeem(500e18, user1, 501e18);
    }

    function test_requestRedeemZeroSharesReverts() public {
        vm.prank(user1);
        vm.expectRevert(YieldVault.ZeroAmount.selector);
        vault.requestRedeem(0, user1, 0);
    }

    // ─── Queue Path ───────────────────────────────────────────────

    function test_requestRedeemQueuesWhenInsufficientLiquidity() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Move most assets to remote (simulate cross-chain rotation)
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 800e18);

        // Only 1000 home assets, but user's shares are worth ~1800 effectively
        // However, user has 1000 shares at ~1.8 price per share = worth 1800
        // maxWithdraw is capped to home assets = 1000
        // Request to redeem all shares (worth 1800) → home has 1000 available
        // But 1000 shares * 1.8 price = 1800, and available is 1000
        // So it should queue

        // Actually let's make it simpler: reduce home assets by supplying to Aave and
        // simulating a scenario where available is less than needed
        vm.prank(strategy);
        vault.supplyToAave(900e18);
        // home = 100 idle + 900 aToken = 1000

        // user1 has 1000 shares worth 1800 total assets but homeAssets = 1000
        // requestRedeem(1000 shares) → assets = 1800 > available 1000 → queue
        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);

        assertGt(id, 0); // queued
        assertEq(vault.balanceOf(user1), 0); // shares transferred to vault
        assertEq(vault.balanceOf(address(vault)), 1000e18); // vault holds them
        assertEq(vault.totalPendingShares(), 1000e18);
        assertEq(vault.pendingRedeemCount(), 1);
    }

    function test_requestRedeemQueuesForDifferentReceiver() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Create situation with insufficient home liquidity
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        // 1000 shares at price 1.5 → 1500 worth → home only has 1000
        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, receiver, 0);

        assertGt(id, 0);
        (address owner,,,,) = vault.pendingRedeems(id);
        assertEq(owner, user1);
    }

    function test_multipleQueuedRequests() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);
        vm.prank(user2);
        vault.deposit(500e18, user2);

        // Large remote balance so each user's shares worth > home assets
        // home=1000, remote=2000, totalAssets=3000, price=3.0
        // user1's 500 shares = 1500, user2's 500 shares = 1500, home = 1000
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 2000e18);

        // Both users queue (1500 each > home 1000)
        vm.prank(user1);
        uint256 id1 = vault.requestRedeem(500e18, user1, 0);
        vm.prank(user2);
        uint256 id2 = vault.requestRedeem(500e18, user2, 0);

        assertGt(id1, 0);
        assertGt(id2, 0);
        assertEq(vault.totalPendingShares(), 1000e18);
        assertEq(vault.pendingRedeemCount(), 2);
    }

    // ─── maxWithdraw with Pending Redeems ─────────────────────────

    function test_maxWithdrawReducedByPending() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);
        vm.prank(user2);
        vault.deposit(500e18, user2);

        // Large remote so user1's shares worth > home → queues
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 2000e18);

        uint256 maxBefore = vault.maxWithdraw(user2);

        // user1 queues → reserves some home assets
        vm.prank(user1);
        vault.requestRedeem(500e18, user1, 0);

        uint256 maxAfter = vault.maxWithdraw(user2);
        assertLt(maxAfter, maxBefore);
    }

    // ─── Fulfillment ──────────────────────────────────────────────

    function test_fulfillRedemptions() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Force a queue by having remote balance
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, receiver, 0);
        assertGt(id, 0);

        // Simulate remote capital coming home (simulate CCIP return by minting USDC to vault)
        usdc.mint(address(vault), 500e18);
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 0);

        // Now fulfill
        vm.prank(strategy);
        vault.fulfillRedemptions(10);

        assertEq(vault.pendingRedeemCount(), 0);
        assertEq(vault.totalPendingShares(), 0);
        // receiver got assets
        assertGt(usdc.balanceOf(receiver), 0);
    }

    function test_fulfillRedemptionsSkipsSlippage() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);
        vm.prank(user2);
        vault.deposit(500e18, user2);

        // Large remote so both users queue
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 2000e18);

        // user1 queues with impossible minAssetsOut, user2 with 0
        vm.prank(user1);
        vault.requestRedeem(500e18, user1, type(uint256).max);
        vm.prank(user2);
        vault.requestRedeem(500e18, user2, 0);

        // Bring all capital home
        usdc.mint(address(vault), 2000e18);
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 0);

        vm.prank(strategy);
        vault.fulfillRedemptions(10);

        // user1 still pending (slippage impossible), user2 fulfilled
        assertEq(vault.totalPendingShares(), 500e18);
    }

    function test_fulfillRedemptionsStopsWhenLiquidityExhausted() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);
        vm.prank(user2);
        vault.deposit(500e18, user2);

        // Large remote so both queue
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 2000e18);

        vm.prank(user1);
        vault.requestRedeem(500e18, user1, 0);
        vm.prank(user2);
        vault.requestRedeem(500e18, user2, 0);

        // Only bring back partial capital — not enough for both
        // Each user's 500 shares are worth 500*3000/1000 = 1500 each
        // Bring back 200, so home goes from 1000 to 1200 with remote 1800
        // First user needs ~1500, home has 1200 → still not enough
        usdc.mint(address(vault), 200e18);
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 1800e18);

        vm.prank(strategy);
        vault.fulfillRedemptions(10);

        // Both still pending (neither has enough home liquidity)
        assertGt(vault.totalPendingShares(), 0);
    }

    function test_fulfillRedemptionsPullsFromAave() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Supply to Aave, then create remote to force queue
        vm.prank(strategy);
        vault.supplyToAave(800e18);
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);
        assertGt(id, 0);

        // Bring remote capital home
        usdc.mint(address(vault), 500e18);
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 0);

        // Fulfill — should auto-pull from Aave
        vm.prank(strategy);
        vault.fulfillRedemptions(10);

        assertEq(vault.totalPendingShares(), 0);
    }

    // ─── Cancellation ─────────────────────────────────────────────

    function test_cancelRedeem() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);
        assertGt(id, 0);
        assertEq(vault.balanceOf(user1), 0);

        // Cancel
        vm.prank(user1);
        vault.cancelRedeem(id);

        assertEq(vault.balanceOf(user1), 1000e18); // shares returned
        assertEq(vault.totalPendingShares(), 0);
    }

    function test_cancelRedeemByNonOwnerReverts() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);

        vm.prank(user2);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.NotRedeemOwner.selector, id));
        vault.cancelRedeem(id);
    }

    function test_cancelRedeemAlreadyFulfilledReverts() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);

        // Fulfill
        usdc.mint(address(vault), 500e18);
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 0);
        vm.prank(strategy);
        vault.fulfillRedemptions(10);

        // Try cancel on already fulfilled
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.RedeemNotFound.selector, id));
        vault.cancelRedeem(id);
    }

    function test_cancelExpiredRedeems() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 500e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);
        assertGt(id, 0);

        // Warp past MAX_REDEEM_DELAY
        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(strategy);
        vault.cancelExpiredRedeems();

        assertEq(vault.balanceOf(user1), 1000e18); // shares returned
        assertEq(vault.totalPendingShares(), 0);
        assertEq(vault.pendingRedeemCount(), 0);
    }

    // ─── View Helpers ─────────────────────────────────────────────

    function test_totalPendingAssets() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Large remote so user's shares exceed home → forces queue
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 2000e18);

        vm.prank(user1);
        uint256 id = vault.requestRedeem(1000e18, user1, 0);
        assertGt(id, 0);

        uint256 pending = vault.totalPendingAssets();
        assertGt(pending, 0);
    }

    // ─── Queue Cap ─────────────────────────────────────────────

    function test_queueFullReverts() public {
        uint256 maxQueue = vault.MAX_PENDING_QUEUE();
        uint256 totalShares = (maxQueue + 2) * 100e18;

        // Deposit enough shares for many requests
        usdc.mint(user1, totalShares);
        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user1);
        vault.deposit(totalShares, user1);

        // Massive remote so each 100-share request exceeds all home assets
        // price = (totalShares + 1000x) / totalShares ≈ 1001
        // 100 shares worth ≈ 100,100 USDC >> home (~20,200 USDC) → all queue
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), totalShares * 1000);

        // All requests should queue since each 100 shares > home
        vm.startPrank(user1);
        for (uint256 i = 0; i < maxQueue; i++) {
            vault.requestRedeem(100e18, user1, 0);
        }
        vm.stopPrank();

        assertEq(vault.pendingRedeemCount(), maxQueue);

        // Next one should revert
        vm.prank(user1);
        vm.expectRevert(YieldVault.QueueFull.selector);
        vault.requestRedeem(100e18, user1, 0);
    }

    // ─── View Helpers ─────────────────────────────────────────────

    function test_getPendingRedeemIds() public {
        vm.prank(user1);
        vault.deposit(500e18, user1);
        vm.prank(user2);
        vault.deposit(500e18, user2);

        // Large remote so both users queue
        vm.prank(strategy);
        vault.updateRemoteBalance(uint64(1), 2000e18);

        vm.prank(user1);
        vault.requestRedeem(500e18, user1, 0);
        vm.prank(user2);
        vault.requestRedeem(500e18, user2, 0);

        uint256[] memory ids = vault.getPendingRedeemIds();
        assertEq(ids.length, 2);
    }
}
