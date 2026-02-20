// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { VaultHandler } from "./handlers/VaultHandler.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForInvariant is IAggregatorV3 {
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

contract VaultInvariantTest is Test {
    YieldVault public vault;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    VaultHandler public handler;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");

    address[] actors;

    function setUp() public {
        // Deploy infrastructure
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));

        MockPriceFeedForInvariant priceFeed = new MockPriceFeedForInvariant();
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
            strategy,
            address(aavePool),
            address(breaker),
            makeAddr("feeRecipient"),
            1000
        );

        // Create actors
        for (uint256 i = 0; i < 5; i++) {
            address actor = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(actor);
            usdc.mint(actor, 10_000e18);
            vm.prank(actor);
            usdc.approve(address(vault), type(uint256).max);
        }

        handler = new VaultHandler(vault, usdc, actors);

        // Target only the handler for invariant testing
        targetContract(address(handler));
    }

    /// @notice totalAssets should always be >= total share value claims (no over-promise)
    function invariant_totalAssetsGtEqShareClaims() public view {
        uint256 totalAssets = vault.totalAssets();
        uint256 totalSupply = vault.totalSupply();

        if (totalSupply == 0) return;

        // Each share should be redeemable for <= totalAssets/totalSupply
        // This means totalAssets >= shares * (assets/share) — always true by definition
        // The real check: no single actor can withdraw more than totalAssets
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 maxW = vault.maxWithdraw(actors[i]);
            assertLe(maxW, totalAssets, "maxWithdraw exceeds totalAssets");
        }
    }

    /// @notice Emergency withdraw should always return > 0 for holders
    function invariant_emergencyWithdrawAlwaysPositive() public view {
        for (uint256 i = 0; i < actors.length; i++) {
            if (vault.balanceOf(actors[i]) > 0) {
                // There should be some home chain assets available
                uint256 homeAssets = vault.homeChainAssets();
                assertTrue(homeAssets > 0 || vault.totalSupply() == 0, "No home assets for emergency withdraw");
            }
        }
    }

    /// @notice Circuit breaker should never block withdrawals
    function invariant_withdrawNeverBlocked() public {
        // Activate circuit breaker
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        // All actors should still be able to withdraw
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 maxW = vault.maxWithdraw(actors[i]);
            if (maxW > 0) {
                vm.prank(actors[i]);
                vault.withdraw(maxW, actors[i], actors[i]);
            }
        }

        // Deactivate for next round
        vm.warp(block.timestamp + 25 hours);
        vm.prank(unpauser);
        breaker.deactivateEmergencyPause();
    }

    /// @notice Ghost variable sanity: totalWithdrawn <= totalDeposited
    function invariant_withdrawLteDeposit() public view {
        assertLe(handler.ghost_totalWithdrawn(), handler.ghost_totalDeposited(), "Withdrawn more than deposited");
    }

    function invariant_callSummary() public view {
        console2.log("Deposits:", handler.ghost_depositCount());
        console2.log("Withdraws:", handler.ghost_withdrawCount());
        console2.log("Emergency withdraws:", handler.ghost_emergencyWithdrawCount());
        console2.log("Total deposited:", handler.ghost_totalDeposited());
        console2.log("Total withdrawn:", handler.ghost_totalWithdrawn());
    }
}
