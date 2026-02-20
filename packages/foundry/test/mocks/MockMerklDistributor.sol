// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { ERC20Mock } from "./ERC20Mock.sol";
import { IMerklDistributor } from "../../contracts/interfaces/IMerklDistributor.sol";

/// @dev Mock Merkl Distributor for unit testing. Skips proof verification.
contract MockMerklDistributor is IMerklDistributor {
    // user → token → cumulative claimed
    mapping(address => mapping(address => uint256)) public cumulativeClaimed;

    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata /* proofs */
    ) external override {
        for (uint256 i = 0; i < users.length; i++) {
            uint256 alreadyClaimed = cumulativeClaimed[users[i]][tokens[i]];
            uint256 delta = amounts[i] - alreadyClaimed;
            if (delta > 0) {
                cumulativeClaimed[users[i]][tokens[i]] = amounts[i];
                ERC20Mock(tokens[i]).mint(msg.sender, delta);
            }
        }
    }

    function claimed(address user, address token)
        external
        view
        override
        returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot)
    {
        amount = uint208(cumulativeClaimed[user][token]);
        timestamp = uint48(block.timestamp);
        merkleRoot = bytes32(0);
    }
}
