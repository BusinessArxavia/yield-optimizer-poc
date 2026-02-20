// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {
    AutomationCompatibleInterface
} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CircuitBreaker } from "../safety/CircuitBreaker.sol";

interface IYieldVaultKeeper {
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function lastHarvestSharePrice() external view returns (uint256);
}

interface IStrategyControllerKeeper {
    function executeLocalSupply(address token, uint256 amount) external;
    function executeHarvestYield() external;
    function getRegisteredChains() external view returns (uint64[] memory);
    function vault() external view returns (address);
}

/// @title YieldKeeper — Chainlink Automation upkeep for routine vault maintenance
/// @notice Handles auto-supply of idle assets and periodic yield harvesting.
///         Cross-chain rotations are handled separately by the CRE workflow.
contract YieldKeeper is AutomationCompatibleInterface, AccessControl {
    // ─── Action Types ────────────────────────────────────────────────
    enum ActionType {
        SUPPLY_IDLE,
        HARVEST_YIELD
    }

    // ─── Roles ───────────────────────────────────────────────────────
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Immutables ──────────────────────────────────────────────────
    IYieldVaultKeeper public immutable vault;
    IStrategyControllerKeeper public immutable strategyController;
    CircuitBreaker public immutable circuitBreaker;
    address public immutable asset;
    uint256 private immutable _vaultDecimals;

    // ─── Configuration ───────────────────────────────────────────────
    address public forwarder; // Chainlink Automation forwarder (set after upkeep registration)
    uint256 public minIdleSupplyAmount; // Min idle to trigger supply (in asset units)
    uint256 public idleTargetBps; // Target idle % to keep as buffer (e.g., 500 = 5%)
    uint256 public harvestMinYieldBps; // Min yield increase to trigger harvest (e.g., 50 = 0.5%)
    uint256 public harvestCooldown; // Min seconds between harvests

    // ─── State ───────────────────────────────────────────────────────
    uint256 public lastHarvestTime;
    uint256 public lastPerformTime;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─── Events ──────────────────────────────────────────────────────
    event IdleSupplied(uint256 amount);
    event YieldHarvested();
    event ForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);
    event ConfigUpdated(
        uint256 minIdleSupplyAmount, uint256 idleTargetBps, uint256 harvestMinYieldBps, uint256 harvestCooldown
    );

    // ─── Errors ──────────────────────────────────────────────────────
    error NoActionNeeded();
    error InvalidConfig();
    error UnauthorizedForwarder();

    constructor(
        address vault_,
        address strategyController_,
        address circuitBreaker_,
        address admin_,
        uint256 minIdleSupplyAmount_,
        uint256 idleTargetBps_,
        uint256 harvestMinYieldBps_,
        uint256 harvestCooldown_
    ) {
        vault = IYieldVaultKeeper(vault_);
        strategyController = IStrategyControllerKeeper(strategyController_);
        circuitBreaker = CircuitBreaker(circuitBreaker_);
        asset = IYieldVaultKeeper(vault_).asset();
        _vaultDecimals = IYieldVaultKeeper(vault_).decimals();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);

        _validateConfig(idleTargetBps_, harvestCooldown_);
        minIdleSupplyAmount = minIdleSupplyAmount_;
        idleTargetBps = idleTargetBps_;
        harvestMinYieldBps = harvestMinYieldBps_;
        harvestCooldown = harvestCooldown_;
    }

    // ─── Chainlink Automation ────────────────────────────────────────

    /// @notice Called off-chain by Chainlink nodes to check if upkeep is needed
    /// @dev Checks two conditions in priority order: idle supply, then yield harvest
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        // Priority 1: Supply idle assets to Aave
        if (!circuitBreaker.isActive()) {
            (bool shouldSupply,) = _checkIdleSupply();
            if (shouldSupply) {
                return (true, abi.encode(ActionType.SUPPLY_IDLE));
            }
        }

        // Priority 2: Harvest yield
        if (_checkHarvestNeeded()) {
            return (true, abi.encode(ActionType.HARVEST_YIELD));
        }

        return (false, "");
    }

    /// @notice Called on-chain by Chainlink Automation when checkUpkeep returns true
    /// @dev Re-validates all conditions on-chain. Only the registered forwarder can call this.
    function performUpkeep(bytes calldata performData) external override {
        if (forwarder != address(0) && msg.sender != forwarder) revert UnauthorizedForwarder();

        ActionType action = abi.decode(performData, (ActionType));

        if (action == ActionType.SUPPLY_IDLE) {
            _performSupply();
        } else if (action == ActionType.HARVEST_YIELD) {
            _performHarvest();
        } else {
            revert NoActionNeeded();
        }

        lastPerformTime = block.timestamp;
    }

    // ─── Internal: Idle Supply ───────────────────────────────────────

    function _checkIdleSupply() internal view returns (bool shouldSupply, uint256 supplyAmount) {
        uint256 totalAssets_ = vault.totalAssets();
        if (totalAssets_ == 0) return (false, 0);

        uint256 idle = IERC20(asset).balanceOf(address(vault));
        uint256 targetIdle = (totalAssets_ * idleTargetBps) / BPS_DENOMINATOR;

        // Only supply if idle exceeds target + minimum threshold
        if (idle > targetIdle + minIdleSupplyAmount) {
            supplyAmount = idle - targetIdle;
            return (true, supplyAmount);
        }

        return (false, 0);
    }

    function _performSupply() internal {
        if (circuitBreaker.isActive()) revert NoActionNeeded();

        (bool shouldSupply, uint256 supplyAmount) = _checkIdleSupply();
        if (!shouldSupply) revert NoActionNeeded();

        strategyController.executeLocalSupply(asset, supplyAmount);
        emit IdleSupplied(supplyAmount);
    }

    // ─── Internal: Yield Harvest ─────────────────────────────────────

    function _checkHarvestNeeded() internal view returns (bool) {
        // Check cooldown
        if (block.timestamp < lastHarvestTime + harvestCooldown) return false;

        // Check if share price has increased enough
        uint256 supply = vault.totalSupply();
        if (supply == 0) return false;

        uint256 currentSharePrice = (vault.totalAssets() * (10 ** _vaultDecimals)) / supply;
        uint256 lastSharePrice = vault.lastHarvestSharePrice();

        if (currentSharePrice <= lastSharePrice) return false;

        uint256 yieldBps = ((currentSharePrice - lastSharePrice) * BPS_DENOMINATOR) / lastSharePrice;
        return yieldBps >= harvestMinYieldBps;
    }

    function _performHarvest() internal {
        if (!_checkHarvestNeeded()) revert NoActionNeeded();

        strategyController.executeHarvestYield();
        lastHarvestTime = block.timestamp;
        emit YieldHarvested();
    }

    // ─── Admin ───────────────────────────────────────────────────────

    /// @notice Set the Chainlink Automation forwarder address
    /// @dev Must be called after registering the upkeep. Set to address(0) to disable the restriction.
    function setForwarder(address forwarder_) external onlyRole(ADMIN_ROLE) {
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    function setConfig(
        uint256 minIdleSupplyAmount_,
        uint256 idleTargetBps_,
        uint256 harvestMinYieldBps_,
        uint256 harvestCooldown_
    ) external onlyRole(ADMIN_ROLE) {
        _validateConfig(idleTargetBps_, harvestCooldown_);
        minIdleSupplyAmount = minIdleSupplyAmount_;
        idleTargetBps = idleTargetBps_;
        harvestMinYieldBps = harvestMinYieldBps_;
        harvestCooldown = harvestCooldown_;
        emit ConfigUpdated(minIdleSupplyAmount_, idleTargetBps_, harvestMinYieldBps_, harvestCooldown_);
    }

    function _validateConfig(uint256 idleTargetBps_, uint256 harvestCooldown_) internal pure {
        if (idleTargetBps_ > BPS_DENOMINATOR) revert InvalidConfig();
        if (harvestCooldown_ < 10 minutes) revert InvalidConfig();
    }
}
