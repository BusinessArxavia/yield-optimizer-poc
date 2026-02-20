// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title RotationValidator — Pure validation helpers for yield rotation parameters
library RotationValidator {
    uint256 private constant BPS_DENOMINATOR = 10_000;

    error SpreadTooLow(uint256 spreadBps, uint256 minSpreadBps);
    error CostTooHigh(uint256 costBps, uint256 maxCostBps);
    error RotationTooFrequent(uint64 chainSelector, uint256 lastRotation, uint256 cooldown);

    /// @notice Validate that the yield spread justifies the rotation
    /// @param yieldBps The yield improvement in basis points
    /// @param minSpreadBps The minimum required spread
    function validateSpread(uint256 yieldBps, uint256 minSpreadBps) internal pure {
        if (yieldBps < minSpreadBps) {
            revert SpreadTooLow(yieldBps, minSpreadBps);
        }
    }

    /// @notice Validate that the rotation cost is within acceptable limits
    /// @param costBps The cost of rotation in basis points of the amount
    /// @param maxCostBps The maximum acceptable cost
    function validateCost(uint256 costBps, uint256 maxCostBps) internal pure {
        if (costBps > maxCostBps) {
            revert CostTooHigh(costBps, maxCostBps);
        }
    }

    /// @notice Validate that enough time has passed since the last rotation to this chain
    /// @param chainSelector The destination chain
    /// @param lastRotationTime The timestamp of the last rotation to this chain
    /// @param cooldown The minimum time between rotations
    function validateFrequency(uint64 chainSelector, uint256 lastRotationTime, uint256 cooldown) internal view {
        if (block.timestamp < lastRotationTime + cooldown) {
            revert RotationTooFrequent(chainSelector, lastRotationTime, cooldown);
        }
    }
}
