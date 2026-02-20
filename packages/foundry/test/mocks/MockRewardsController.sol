// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { ERC20Mock } from "./ERC20Mock.sol";
import { IRewardsController } from "../../contracts/interfaces/IRewardsController.sol";

/// @dev Mock Aave RewardsController for unit testing reward claiming
contract MockRewardsController is IRewardsController {
    // reward token → user → accrued amount
    mapping(address => mapping(address => uint256)) public accrued;
    address[] public rewardTokens;

    function addRewardToken(address token) external {
        rewardTokens.push(token);
    }

    /// @dev Set accrued rewards for a user (the user is typically the vault holding aTokens)
    function setAccruedRewards(address token, address user, uint256 amount) external {
        accrued[token][user] = amount;
    }

    function claimAllRewards(
        address[] calldata,
        /* assets */
        address to
    )
        external
        override
        returns (address[] memory rewardsList, uint256[] memory claimedAmounts)
    {
        rewardsList = rewardTokens;
        claimedAmounts = new uint256[](rewardTokens.length);

        for (uint256 i = 0; i < rewardTokens.length; i++) {
            // msg.sender is the vault (aToken holder), so accrued is keyed by msg.sender
            uint256 amount = accrued[rewardTokens[i]][msg.sender];
            if (amount > 0) {
                accrued[rewardTokens[i]][msg.sender] = 0;
                ERC20Mock(rewardTokens[i]).mint(to, amount);
                claimedAmounts[i] = amount;
            }
        }
    }

    function getAllUserRewards(
        address[] calldata,
        /* assets */
        address user
    )
        external
        view
        override
        returns (address[] memory rewardsList, uint256[] memory unclaimedAmounts)
    {
        rewardsList = rewardTokens;
        unclaimedAmounts = new uint256[](rewardTokens.length);
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            unclaimedAmounts[i] = accrued[rewardTokens[i]][user];
        }
    }

    function getRewardsByAsset(
        address /* asset */
    )
        external
        view
        override
        returns (address[] memory)
    {
        return rewardTokens;
    }
}
