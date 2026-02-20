// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title ExposureLimits — Pure validation helpers for cross-chain exposure
library ExposureLimits {
    /// @dev Maximum single rotation as basis points of total assets (20%)
    uint256 public constant MAX_SINGLE_ROTATION_BPS = 2000;
    /// @dev Maximum total in-flight across all chains (15%)
    uint256 public constant MAX_IN_FLIGHT_BPS = 1500;
    /// @dev Maximum allocation per remote chain (40%)
    uint256 public constant MAX_PER_CHAIN_BPS = 4000;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    error RotationTooLarge(uint256 amountBps, uint256 maxBps);
    error InFlightExceeded(uint256 totalInFlightBps, uint256 maxBps);
    error ChainConcentrationExceeded(uint64 chainSelector, uint256 concentrationBps, uint256 maxBps);

    /// @notice Validate that a single rotation doesn't exceed the max percentage of total assets
    function validateRotationSize(uint256 amount, uint256 totalAssets) internal pure {
        if (totalAssets == 0) revert RotationTooLarge(BPS_DENOMINATOR, MAX_SINGLE_ROTATION_BPS);
        uint256 bps = (amount * BPS_DENOMINATOR) / totalAssets;
        if (bps > MAX_SINGLE_ROTATION_BPS) {
            revert RotationTooLarge(bps, MAX_SINGLE_ROTATION_BPS);
        }
    }

    /// @notice Validate that total in-flight amounts don't exceed the limit
    function validateInFlight(uint256 currentInFlight, uint256 additionalAmount, uint256 totalAssets) internal pure {
        if (totalAssets == 0) revert InFlightExceeded(BPS_DENOMINATOR, MAX_IN_FLIGHT_BPS);
        uint256 newInFlight = currentInFlight + additionalAmount;
        uint256 bps = (newInFlight * BPS_DENOMINATOR) / totalAssets;
        if (bps > MAX_IN_FLIGHT_BPS) {
            revert InFlightExceeded(bps, MAX_IN_FLIGHT_BPS);
        }
    }

    /// @notice Validate that a single chain doesn't hold too much of total assets
    function validateChainConcentration(
        uint64 chainSelector,
        uint256 currentChainBalance,
        uint256 additionalAmount,
        uint256 totalAssets
    ) internal pure {
        if (totalAssets == 0) {
            revert ChainConcentrationExceeded(chainSelector, BPS_DENOMINATOR, MAX_PER_CHAIN_BPS);
        }
        uint256 newBalance = currentChainBalance + additionalAmount;
        uint256 bps = (newBalance * BPS_DENOMINATOR) / totalAssets;
        if (bps > MAX_PER_CHAIN_BPS) {
            revert ChainConcentrationExceeded(chainSelector, bps, MAX_PER_CHAIN_BPS);
        }
    }
}
