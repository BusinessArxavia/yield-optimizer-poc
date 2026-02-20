// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { YieldVault } from "../../../contracts/vault/YieldVault.sol";
import { ERC20Mock } from "../../mocks/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Handler for invariant testing — constrains random calls to valid bounds
contract VaultHandler is Test {
    YieldVault public vault;
    ERC20Mock public usdc;

    address[] public actors;
    address internal currentActor;

    // Ghost variables for tracking
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;
    uint256 public ghost_depositCount;
    uint256 public ghost_withdrawCount;
    uint256 public ghost_emergencyWithdrawCount;

    constructor(YieldVault vault_, ERC20Mock usdc_, address[] memory actors_) {
        vault = vault_;
        usdc = usdc_;
        actors = actors_;
    }

    modifier useActor(uint256 actorSeed) {
        currentActor = actors[actorSeed % actors.length];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    function deposit(uint256 amount, uint256 actorSeed) external useActor(actorSeed) {
        amount = bound(amount, 1, usdc.balanceOf(currentActor));
        if (amount == 0) return;

        vault.deposit(amount, currentActor);
        ghost_totalDeposited += amount;
        ghost_depositCount++;
    }

    function withdraw(uint256 amount, uint256 actorSeed) external useActor(actorSeed) {
        uint256 maxW = vault.maxWithdraw(currentActor);
        if (maxW == 0) return;
        amount = bound(amount, 1, maxW);

        vault.withdraw(amount, currentActor, currentActor);
        ghost_totalWithdrawn += amount;
        ghost_withdrawCount++;
    }

    function redeem(uint256 shares, uint256 actorSeed) external useActor(actorSeed) {
        uint256 maxR = vault.maxRedeem(currentActor);
        if (maxR == 0) return;
        shares = bound(shares, 1, maxR);

        uint256 assets = vault.redeem(shares, currentActor, currentActor);
        ghost_totalWithdrawn += assets;
        ghost_withdrawCount++;
    }

    function emergencyWithdraw(uint256 actorSeed) external useActor(actorSeed) {
        uint256 shares = vault.balanceOf(currentActor);
        if (shares == 0) return;

        uint256 assets = vault.emergencyWithdraw();
        ghost_totalWithdrawn += assets;
        ghost_emergencyWithdrawCount++;
    }
}
