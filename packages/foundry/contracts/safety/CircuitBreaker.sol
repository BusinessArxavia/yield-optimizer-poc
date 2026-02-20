// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IAggregatorV3 } from "../interfaces/IAggregatorV3.sol";

/// @title CircuitBreaker — Standalone safety oracle for the vault system
/// @notice Monitors depeg risk, TVL drops, and share price drops. Other contracts query it.
///         Does NOT use Pausable — withdrawals must never be locked.
contract CircuitBreaker is AccessControl {
    // ─── Roles ──────────────────────────────────────────────────────
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ─── Enums ──────────────────────────────────────────────────────
    enum Tier {
        NORMAL,
        WATCH,
        WARN,
        CRITICAL
    }

    // ─── State ──────────────────────────────────────────────────────
    Tier public currentTier;
    IAggregatorV3 public immutable priceFeed;

    /// @dev Price thresholds in feed decimals (e.g., 8 decimals for USD feeds)
    uint256 public depegWatchThreshold; // e.g., 0.995e8 → WATCH
    uint256 public depegWarnThreshold; // e.g., 0.990e8 → WARN
    uint256 public depegCriticalThreshold; // e.g., 0.980e8 → CRITICAL

    /// @dev TVL drop thresholds in basis points (from high-water mark)
    uint256 public tvlDropWatchBps; // e.g., 500 = 5%
    uint256 public tvlDropWarnBps; // e.g., 1000 = 10%
    uint256 public tvlDropCriticalBps; // e.g., 2000 = 20%

    /// @dev Share price drop thresholds in basis points (from high-water mark)
    uint256 public sharePriceDropWatchBps;
    uint256 public sharePriceDropWarnBps;
    uint256 public sharePriceDropCriticalBps;

    /// @dev TVL tracking: high-water mark and current value
    uint256 public tvlHighWaterMark;
    uint256 public tvlCurrent;

    /// @dev Share price tracking: high-water mark and current value
    uint256 public sharePriceHighWaterMark;
    uint256 public sharePriceCurrent;

    /// @dev Emergency pause state
    bool public emergencyPaused;
    uint256 public lastUnpauseTime;
    uint256 public constant UNPAUSE_COOLDOWN = 24 hours;

    uint256 public constant STALE_PRICE_THRESHOLD = 1 hours;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─── Events ─────────────────────────────────────────────────────
    event TierChanged(Tier oldTier, Tier newTier);
    event EmergencyPauseActivated(address indexed pauser);
    event EmergencyPauseDeactivated(address indexed unpauser);
    event TvlSnapshotUpdated(uint256 oldTvl, uint256 newTvl);
    event SharePriceSnapshotUpdated(uint256 oldPrice, uint256 newPrice);
    event HighWaterMarksReset(uint256 newTvlHWM, uint256 newSharePriceHWM);

    // ─── Errors ─────────────────────────────────────────────────────
    error UnpauseCooldownNotElapsed(uint256 remaining);
    error NotEmergencyPaused();

    constructor(
        address admin_,
        address pauser_,
        address unpauser_,
        address priceFeed_,
        uint256[3] memory depegThresholds_, // [watch, warn, critical]
        uint256[3] memory tvlDropBps_, // [watch, warn, critical]
        uint256[3] memory sharePriceDropBps_ // [watch, warn, critical]
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(PAUSER_ROLE, pauser_);
        _grantRole(UNPAUSER_ROLE, unpauser_);

        priceFeed = IAggregatorV3(priceFeed_);

        depegWatchThreshold = depegThresholds_[0];
        depegWarnThreshold = depegThresholds_[1];
        depegCriticalThreshold = depegThresholds_[2];

        tvlDropWatchBps = tvlDropBps_[0];
        tvlDropWarnBps = tvlDropBps_[1];
        tvlDropCriticalBps = tvlDropBps_[2];

        sharePriceDropWatchBps = sharePriceDropBps_[0];
        sharePriceDropWarnBps = sharePriceDropBps_[1];
        sharePriceDropCriticalBps = sharePriceDropBps_[2];

        currentTier = Tier.NORMAL;
    }

    // ─── Core Functions ─────────────────────────────────────────────

    /// @notice Re-evaluate the tier based on all inputs. Anyone can call.
    function checkAndUpdateTier() external {
        if (emergencyPaused) return; // Emergency overrides algorithmic tiers

        Tier newTier = _evaluateTier();
        if (newTier != currentTier) {
            emit TierChanged(currentTier, newTier);
            currentTier = newTier;
        }
    }

    /// @notice Returns true if tier >= WARN (deposits should be blocked)
    function isActive() external view returns (bool) {
        return emergencyPaused || currentTier >= Tier.WARN;
    }

    /// @notice Returns true if tier == CRITICAL (emergency mode)
    function isCritical() external view returns (bool) {
        return emergencyPaused || currentTier == Tier.CRITICAL;
    }

    // ─── Emergency Controls ─────────────────────────────────────────

    /// @notice Instantly set CRITICAL tier (single-signer pauser)
    function activateEmergencyPause() external onlyRole(PAUSER_ROLE) {
        Tier oldTier = currentTier;
        emergencyPaused = true;
        currentTier = Tier.CRITICAL;
        emit EmergencyPauseActivated(msg.sender);
        emit TierChanged(oldTier, Tier.CRITICAL);
    }

    /// @notice Reset to NORMAL after cooldown (multisig unpauser)
    function deactivateEmergencyPause() external onlyRole(UNPAUSER_ROLE) {
        if (!emergencyPaused) revert NotEmergencyPaused();
        if (block.timestamp < lastUnpauseTime + UNPAUSE_COOLDOWN) {
            revert UnpauseCooldownNotElapsed(lastUnpauseTime + UNPAUSE_COOLDOWN - block.timestamp);
        }

        emergencyPaused = false;
        currentTier = Tier.NORMAL;
        lastUnpauseTime = block.timestamp;
        emit EmergencyPauseDeactivated(msg.sender);
        emit TierChanged(Tier.CRITICAL, Tier.NORMAL);
    }

    // ─── Admin Recovery ────────────────────────────────────────────

    /// @notice Reset high-water marks to current values after a correction
    /// @dev Used when HWM is artificially elevated (e.g., after a temporary TVL spike)
    function resetHighWaterMarks() external onlyRole(DEFAULT_ADMIN_ROLE) {
        tvlHighWaterMark = tvlCurrent;
        sharePriceHighWaterMark = sharePriceCurrent;
        emit HighWaterMarksReset(tvlCurrent, sharePriceCurrent);
    }

    // ─── Snapshot Updates (Vault only) ──────────────────────────────

    /// @notice Called by vault to report current TVL. Updates high-water mark if TVL increased.
    function updateTvlSnapshot(uint256 newTvl) external onlyRole(VAULT_ROLE) {
        emit TvlSnapshotUpdated(tvlCurrent, newTvl);
        tvlCurrent = newTvl;
        if (newTvl > tvlHighWaterMark) {
            tvlHighWaterMark = newTvl;
        }
    }

    /// @notice Called by vault to report current share price. Updates high-water mark if increased.
    function updateSharePriceSnapshot(uint256 newPrice) external onlyRole(VAULT_ROLE) {
        emit SharePriceSnapshotUpdated(sharePriceCurrent, newPrice);
        sharePriceCurrent = newPrice;
        if (newPrice > sharePriceHighWaterMark) {
            sharePriceHighWaterMark = newPrice;
        }
    }

    // ─── Internal ───────────────────────────────────────────────────

    function _evaluateTier() internal view returns (Tier) {
        Tier priceTier = _evaluatePrice();
        Tier tvlTier = _evaluateTvlDrop();
        Tier shareTier = _evaluateSharePriceDrop();

        // Return the worst (highest) tier
        Tier worst = priceTier;
        if (tvlTier > worst) worst = tvlTier;
        if (shareTier > worst) worst = shareTier;
        return worst;
    }

    function _evaluatePrice() internal view returns (Tier) {
        try priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (block.timestamp - updatedAt > STALE_PRICE_THRESHOLD) {
                return Tier.WARN;
            }
            if (answer <= 0) return Tier.CRITICAL;

            uint256 price = uint256(answer);
            if (price <= depegCriticalThreshold) return Tier.CRITICAL;
            if (price <= depegWarnThreshold) return Tier.WARN;
            if (price <= depegWatchThreshold) return Tier.WATCH;
            return Tier.NORMAL;
        } catch {
            return Tier.WARN; // Feed failure → WARN
        }
    }

    function _evaluateTvlDrop() internal view returns (Tier) {
        if (tvlHighWaterMark == 0) return Tier.NORMAL;
        if (tvlCurrent >= tvlHighWaterMark) return Tier.NORMAL;

        uint256 dropBps = ((tvlHighWaterMark - tvlCurrent) * BPS_DENOMINATOR) / tvlHighWaterMark;
        if (dropBps >= tvlDropCriticalBps) return Tier.CRITICAL;
        if (dropBps >= tvlDropWarnBps) return Tier.WARN;
        if (dropBps >= tvlDropWatchBps) return Tier.WATCH;
        return Tier.NORMAL;
    }

    function _evaluateSharePriceDrop() internal view returns (Tier) {
        if (sharePriceHighWaterMark == 0) return Tier.NORMAL;
        if (sharePriceCurrent >= sharePriceHighWaterMark) return Tier.NORMAL;

        uint256 dropBps = ((sharePriceHighWaterMark - sharePriceCurrent) * BPS_DENOMINATOR) / sharePriceHighWaterMark;
        if (dropBps >= sharePriceDropCriticalBps) return Tier.CRITICAL;
        if (dropBps >= sharePriceDropWarnBps) return Tier.WARN;
        if (dropBps >= sharePriceDropWatchBps) return Tier.WATCH;
        return Tier.NORMAL;
    }
}
