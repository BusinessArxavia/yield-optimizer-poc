// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IAToken } from "../../contracts/interfaces/IAToken.sol";

/// @dev Mock aToken that mints 1:1 for underlying and tracks balances
contract MockAToken is ERC20 {
    address public immutable underlyingAsset;

    constructor(address underlying_) ERC20("Aave aUSDC", "aUSDC") {
        underlyingAsset = underlying_;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return underlyingAsset;
    }

    function scaledBalanceOf(address user) external view returns (uint256) {
        return balanceOf(user);
    }

    /// @dev Called by MockAavePool.supply to mint aTokens
    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Called by MockAavePool.withdraw to burn aTokens
    function burnFrom(address from, uint256 amount) external {
        _burn(from, amount);
    }

    /// @dev Simulate yield accrual by minting extra aTokens
    function simulateYield(address holder, uint256 yieldAmount) external {
        _mint(holder, yieldAmount);
    }
}
