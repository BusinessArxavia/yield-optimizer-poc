// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

interface IStrategyControllerDMS {
    function executeLocalSupply(address token, uint256 amount) external;
    function executeLocalWithdraw(address token, uint256 amount) external;
    function executeHarvestYield() external;
    function vault() external view returns (address);
}

interface IYieldVaultDMS {
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
}

/// @title DeadManSwitch — Fallback automation if primary keeper goes offline
/// @notice Monitors the last keeper action timestamp. If no action for `timeout` seconds
///         and a configured guardian calls `triggerFallback()`, it executes a safe action
///         (harvest or local supply) through the StrategyController.
///         Designed to be called by a Gelato Web3 Function as a backup for Chainlink Automation.
contract DeadManSwitch is AccessControl {
    // ─── Roles ───────────────────────────────────────────────────────
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── State ───────────────────────────────────────────────────────
    IStrategyControllerDMS public immutable strategyController;
    uint256 public timeout; // seconds without keeper action before fallback activates
    uint256 public lastKeeperAction; // updated by keeper or manually

    // ─── Events ──────────────────────────────────────────────────────
    event KeeperHeartbeat(uint256 timestamp);
    event FallbackTriggered(address indexed guardian, string action);
    event TimeoutUpdated(uint256 oldTimeout, uint256 newTimeout);

    // ─── Errors ──────────────────────────────────────────────────────
    error KeeperStillActive();
    error TimeoutTooShort();

    constructor(address strategyController_, address admin_, address guardian_, uint256 timeout_) {
        if (timeout_ < 1 hours) revert TimeoutTooShort();

        strategyController = IStrategyControllerDMS(strategyController_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(GUARDIAN_ROLE, guardian_);

        timeout = timeout_;
        lastKeeperAction = block.timestamp;
    }

    /// @notice Called by the primary keeper to signal it's alive
    function heartbeat() external onlyRole(GUARDIAN_ROLE) {
        lastKeeperAction = block.timestamp;
        emit KeeperHeartbeat(block.timestamp);
    }

    /// @notice Check if the dead man switch should activate
    function isExpired() public view returns (bool) {
        return block.timestamp >= lastKeeperAction + timeout;
    }

    /// @notice Time remaining before the switch activates (0 if already expired)
    function timeRemaining() external view returns (uint256) {
        uint256 deadline = lastKeeperAction + timeout;
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    /// @notice Trigger fallback harvest — only when keeper has been offline past timeout
    function triggerFallbackHarvest() external onlyRole(GUARDIAN_ROLE) {
        if (!isExpired()) revert KeeperStillActive();

        strategyController.executeHarvestYield();
        lastKeeperAction = block.timestamp; // Reset timer after fallback

        emit FallbackTriggered(msg.sender, "harvest");
    }

    /// @notice Trigger fallback local supply — only when keeper has been offline past timeout
    function triggerFallbackSupply(address token, uint256 amount) external onlyRole(GUARDIAN_ROLE) {
        if (!isExpired()) revert KeeperStillActive();

        strategyController.executeLocalSupply(token, amount);
        lastKeeperAction = block.timestamp;

        emit FallbackTriggered(msg.sender, "supply");
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setTimeout(uint256 newTimeout) external onlyRole(ADMIN_ROLE) {
        if (newTimeout < 1 hours) revert TimeoutTooShort();
        emit TimeoutUpdated(timeout, newTimeout);
        timeout = newTimeout;
    }
}
