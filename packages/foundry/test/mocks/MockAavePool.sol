// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAavePool } from "../../contracts/interfaces/IAavePool.sol";
import { MockAToken } from "./MockAToken.sol";

/// @dev Mock Aave pool for unit testing. Transfers underlying 1:1 for aTokens.
contract MockAavePool {
    MockAToken public immutable aTokenContract;

    constructor(address aToken_) {
        aTokenContract = MockAToken(aToken_);
    }

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 /* referralCode */
    )
        external
    {
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        aTokenContract.mintTo(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        aTokenContract.burnFrom(msg.sender, amount);
        IERC20(asset).transfer(to, amount);
        return amount;
    }

    function getReserveData(
        address /* asset */
    )
        external
        view
        returns (IAavePool.ReserveData memory data)
    {
        data.aTokenAddress = address(aTokenContract);
    }
}
