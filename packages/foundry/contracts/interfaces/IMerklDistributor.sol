// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Merkl Distributor — claim Merkl-distributed DeFi incentives
interface IMerklDistributor {
    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external;

    function claimed(address user, address token)
        external
        view
        returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot);
}
