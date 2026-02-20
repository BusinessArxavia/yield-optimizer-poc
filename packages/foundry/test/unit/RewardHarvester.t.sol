// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { MockRewardsController } from "../mocks/MockRewardsController.sol";
import { MockMerklDistributor } from "../mocks/MockMerklDistributor.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { RewardHarvester } from "../../contracts/automation/RewardHarvester.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForHarvester is IAggregatorV3 {
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

contract RewardHarvesterTest is Test {
    RewardHarvester public harvester;
    YieldVault public vault;
    ERC20Mock public usdc;
    ERC20Mock public arbToken;
    ERC20Mock public opToken;
    MockAavePool public aavePool;
    MockAToken public aToken;
    MockRewardsController public rewardsController;
    MockMerklDistributor public merklDistributor;
    CircuitBreaker public breaker;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address keeper = makeAddr("keeper");
    address swapper = makeAddr("swapper");
    address feeRecipient = makeAddr("feeRecipient");
    address user1 = makeAddr("user1");

    uint256 constant HARVEST_COOLDOWN = 1 days;

    function setUp() public {
        // Deploy base infrastructure
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        arbToken = new ERC20Mock("Arbitrum", "ARB", 18);
        opToken = new ERC20Mock("Optimism", "OP", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));

        MockPriceFeedForHarvester priceFeed = new MockPriceFeedForHarvester();
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

        // Deploy mock reward systems
        rewardsController = new MockRewardsController();
        rewardsController.addRewardToken(address(arbToken));
        rewardsController.addRewardToken(address(opToken));

        merklDistributor = new MockMerklDistributor();

        // Deploy harvester
        harvester = new RewardHarvester(
            admin, address(vault), address(rewardsController), address(merklDistributor), HARVEST_COOLDOWN
        );

        // Grant roles
        vm.startPrank(admin);
        harvester.grantRole(harvester.KEEPER_ROLE(), keeper);
        harvester.grantRole(harvester.SWAPPER_ROLE(), swapper);
        harvester.setAllowedRewardToken(address(arbToken), true);
        harvester.setAllowedRewardToken(address(opToken), true);

        // Grant harvester the STRATEGY_ROLE on vault so it can call claimAaveRewards
        vault.grantRole(vault.STRATEGY_ROLE(), address(harvester));
        vm.stopPrank();

        // Seed vault with deposits
        usdc.mint(user1, 100_000e18);
        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user1);
        vault.deposit(10_000e18, user1);

        // Simulate accrued Aave rewards on the vault
        rewardsController.setAccruedRewards(address(arbToken), address(vault), 500e18);
        rewardsController.setAccruedRewards(address(opToken), address(vault), 200e18);
    }

    // ─── Aave Reward Claiming ─────────────────────────────────────

    function test_harvestAaveRewards() public {
        vm.prank(keeper);
        harvester.harvestAaveRewards();

        assertEq(arbToken.balanceOf(address(harvester)), 500e18);
        assertEq(opToken.balanceOf(address(harvester)), 200e18);
    }

    function test_harvestAaveRewardsRespectsCooldown() public {
        vm.prank(keeper);
        harvester.harvestAaveRewards();

        // Try again immediately
        vm.prank(keeper);
        vm.expectRevert(RewardHarvester.HarvestCooldownNotElapsed.selector);
        harvester.harvestAaveRewards();

        // After cooldown
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);
        rewardsController.setAccruedRewards(address(arbToken), address(vault), 100e18);

        vm.prank(keeper);
        harvester.harvestAaveRewards(); // succeeds
        assertEq(arbToken.balanceOf(address(harvester)), 600e18);
    }

    function test_harvestAaveRewardsWithNoPending() public {
        // Clear accrued
        rewardsController.setAccruedRewards(address(arbToken), address(vault), 0);
        rewardsController.setAccruedRewards(address(opToken), address(vault), 0);

        vm.prank(keeper);
        harvester.harvestAaveRewards(); // doesn't revert

        assertEq(arbToken.balanceOf(address(harvester)), 0);
    }

    function test_claimAaveRewardsOnlyStrategy() public {
        vm.prank(user1);
        vm.expectRevert();
        vault.claimAaveRewards(address(rewardsController), address(harvester));
    }

    // ─── Merkl Reward Claiming ────────────────────────────────────

    function test_harvestMerklRewards() public {
        address[] memory users = new address[](1);
        users[0] = address(harvester);
        address[] memory tokens = new address[](1);
        tokens[0] = address(arbToken);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 300e18;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        vm.prank(keeper);
        harvester.harvestMerklRewards(users, tokens, amounts, proofs);

        assertEq(arbToken.balanceOf(address(harvester)), 300e18);
    }

    // ─── Swap + Reinvest ──────────────────────────────────────────

    function test_withdrawRewardForSwap() public {
        // First claim
        vm.prank(keeper);
        harvester.harvestAaveRewards();

        // Swapper withdraws ARB
        vm.prank(swapper);
        harvester.withdrawRewardForSwap(address(arbToken), 500e18);

        assertEq(arbToken.balanceOf(swapper), 500e18);
        assertEq(arbToken.balanceOf(address(harvester)), 0);
    }

    function test_withdrawRewardRevertsForNonWhitelisted() public {
        ERC20Mock randomToken = new ERC20Mock("Random", "RND", 18);

        vm.prank(swapper);
        vm.expectRevert(abi.encodeWithSelector(RewardHarvester.TokenNotAllowed.selector, address(randomToken)));
        harvester.withdrawRewardForSwap(address(randomToken), 100e18);
    }

    function test_withdrawRewardRevertsOnZero() public {
        vm.prank(swapper);
        vm.expectRevert(RewardHarvester.ZeroAmount.selector);
        harvester.withdrawRewardForSwap(address(arbToken), 0);
    }

    function test_reinvestSendsUsdcToVault() public {
        uint256 vaultBalanceBefore = usdc.balanceOf(address(vault));

        // First create an escrow via withdrawRewardForSwap
        arbToken.mint(address(harvester), 1000e18);
        vm.prank(swapper);
        uint256 escrowId = harvester.withdrawRewardForSwap(address(arbToken), 1000e18);

        // Swapper has USDC from off-chain swap
        usdc.mint(swapper, 1000e18);
        vm.prank(swapper);
        usdc.approve(address(harvester), type(uint256).max);

        vm.prank(swapper);
        harvester.reinvest(escrowId, 1000e18);

        assertEq(usdc.balanceOf(address(vault)), vaultBalanceBefore + 1000e18);
        assertEq(harvester.totalReinvested(), 1000e18);
    }

    function test_reinvestRevertsOnZero() public {
        // Create an escrow first
        arbToken.mint(address(harvester), 100e18);
        vm.prank(swapper);
        uint256 escrowId = harvester.withdrawRewardForSwap(address(arbToken), 100e18);

        vm.prank(swapper);
        vm.expectRevert(RewardHarvester.NothingToReinvest.selector);
        harvester.reinvest(escrowId, 0);
    }

    function test_totalReinvestedAccumulates() public {
        usdc.mint(swapper, 2000e18);
        vm.prank(swapper);
        usdc.approve(address(harvester), type(uint256).max);

        // Create two escrows
        arbToken.mint(address(harvester), 2000e18);
        vm.prank(swapper);
        uint256 escrow1 = harvester.withdrawRewardForSwap(address(arbToken), 1000e18);
        vm.prank(swapper);
        uint256 escrow2 = harvester.withdrawRewardForSwap(address(arbToken), 1000e18);

        vm.prank(swapper);
        harvester.reinvest(escrow1, 500e18);
        assertEq(harvester.totalReinvested(), 500e18);

        vm.prank(swapper);
        harvester.reinvest(escrow2, 700e18);
        assertEq(harvester.totalReinvested(), 1200e18);
    }

    // ─── Admin ────────────────────────────────────────────────────

    function test_setAllowedRewardToken() public {
        ERC20Mock newToken = new ERC20Mock("New", "NEW", 18);

        vm.prank(admin);
        harvester.setAllowedRewardToken(address(newToken), true);
        assertTrue(harvester.allowedRewardTokens(address(newToken)));

        vm.prank(admin);
        harvester.setAllowedRewardToken(address(newToken), false);
        assertFalse(harvester.allowedRewardTokens(address(newToken)));
    }

    function test_withdrawRewardRevertsForUnderlying() public {
        // Even if USDC is whitelisted, cannot withdraw it (underlying asset)
        vm.prank(admin);
        harvester.setAllowedRewardToken(address(usdc), true);

        // Mint some USDC to harvester to simulate a scenario
        usdc.mint(address(harvester), 100e18);

        vm.prank(swapper);
        vm.expectRevert(RewardHarvester.CannotWithdrawUnderlying.selector);
        harvester.withdrawRewardForSwap(address(usdc), 100e18);
    }

    function test_constructorRevertsOnZeroAddress() public {
        vm.expectRevert(RewardHarvester.ZeroAddress.selector);
        new RewardHarvester(address(0), address(vault), address(rewardsController), address(merklDistributor), 1 days);

        vm.expectRevert(RewardHarvester.ZeroAddress.selector);
        new RewardHarvester(admin, address(0), address(rewardsController), address(merklDistributor), 1 days);
    }

    function test_onlyAdminCanConfigure() public {
        vm.prank(user1);
        vm.expectRevert();
        harvester.setAllowedRewardToken(address(arbToken), false);

        vm.prank(user1);
        vm.expectRevert();
        harvester.setHarvestCooldown(2 days);
    }

    function test_setHarvestCooldown() public {
        vm.prank(admin);
        harvester.setHarvestCooldown(2 days);
        assertEq(harvester.harvestCooldown(), 2 days);
    }

    // ─── View ─────────────────────────────────────────────────────

    function test_rewardBalance() public {
        vm.prank(keeper);
        harvester.harvestAaveRewards();

        assertEq(harvester.rewardBalance(address(arbToken)), 500e18);
        assertEq(harvester.rewardBalance(address(opToken)), 200e18);
    }
}
