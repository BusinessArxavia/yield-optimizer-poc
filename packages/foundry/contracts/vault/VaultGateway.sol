// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title VaultGateway — Slippage-protected entry point for vault operations
/// @notice Wraps ERC-4626 deposit/redeem with minimum output checks.
///         Stateless (no storage besides reentrancy lock). No admin. Immutable.
contract VaultGateway is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    error SlippageExceeded(uint256 received, uint256 minimum);
    error ZeroAmount();

    event DepositWithProtection(
        address indexed vault, address indexed receiver, uint256 assets, uint256 shares, uint256 minSharesOut
    );
    event RedeemWithProtection(
        address indexed vault, address indexed receiver, uint256 shares, uint256 assets, uint256 minAssetsOut
    );

    /// @notice Deposit assets into vault with minimum shares guarantee
    /// @param vault       The ERC-4626 vault address
    /// @param assets      Amount of underlying asset to deposit
    /// @param receiver    Address to receive vault shares
    /// @param minSharesOut Minimum shares to receive (0 = no check)
    function deposit(address vault, uint256 assets, address receiver, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();

        address asset = IERC4626(vault).asset();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        IERC20(asset).forceApprove(vault, assets);

        shares = IERC4626(vault).deposit(assets, receiver);

        // Reset allowance to prevent residual approval on non-compliant vaults
        IERC20(asset).forceApprove(vault, 0);

        if (shares < minSharesOut) revert SlippageExceeded(shares, minSharesOut);

        emit DepositWithProtection(vault, receiver, assets, shares, minSharesOut);
    }

    /// @notice Redeem shares from vault with minimum assets guarantee
    /// @dev User must approve this Gateway to spend their vault shares
    /// @param vault        The ERC-4626 vault address
    /// @param shares       Amount of vault shares to redeem
    /// @param receiver     Address to receive underlying assets
    /// @param minAssetsOut Minimum assets to receive (0 = no check)
    function redeem(address vault, uint256 shares, address receiver, uint256 minAssetsOut)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();

        IERC20(vault).safeTransferFrom(msg.sender, address(this), shares);

        assets = IERC4626(vault).redeem(shares, receiver, address(this));

        if (assets < minAssetsOut) revert SlippageExceeded(assets, minAssetsOut);

        emit RedeemWithProtection(vault, receiver, shares, assets, minAssetsOut);
    }

    /// @notice Preview deposit with slippage tolerance applied
    function previewDepositWithSlippage(address vault, uint256 assets, uint256 slippageBps)
        external
        view
        returns (uint256 expectedShares, uint256 minSharesOut)
    {
        expectedShares = IERC4626(vault).previewDeposit(assets);
        minSharesOut = (expectedShares * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
    }

    /// @notice Preview redeem with slippage tolerance applied
    function previewRedeemWithSlippage(address vault, uint256 shares, uint256 slippageBps)
        external
        view
        returns (uint256 expectedAssets, uint256 minAssetsOut)
    {
        expectedAssets = IERC4626(vault).previewRedeem(shares);
        minAssetsOut = (expectedAssets * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
    }
}
