// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CircuitBreaker } from "../safety/CircuitBreaker.sol";

/// @dev CRE IReceiver interface — receives signed reports from KeystoneForwarder
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

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
    function initiateCrossChainRotation(
        uint64 destChain,
        address token,
        uint256 amount,
        uint256 yieldBps,
        uint256 costBps
    ) external;
    function validateRotation(uint64 destChain, uint256 amount, uint256 yieldBps, uint256 costBps)
        external
        view
        returns (bool);
    function initiateTestnetRotation(
        uint64 destChain,
        uint256 amount,
        address bridgeToken,
        uint256 bridgeAmount,
        uint256 yieldBps,
        uint256 costBps
    ) external;
    function getRegisteredChains() external view returns (uint64[] memory);
    function vault() external view returns (address);
    function processPendingRedemptions(uint256 maxToProcess) external;
    function initiatePartialRemoteRecall(uint64 chainSelector, uint256 amount) external;
    function initiateTestnetRemoteRecall(uint64 chainSelector, uint256 amount, address bridgeToken) external;
}

/// @title YieldKeeperCRE — CRE consumer contract for vault maintenance
/// @notice Replaces Chainlink Automation (Keepers) with CRE workflow reports.
///         Decision logic (check conditions) lives in the off-chain CRE workflow.
///         This contract only executes validated actions delivered via KeystoneForwarder.
contract YieldKeeperCRE is IReceiver, AccessControl {
    // ─── Action Types ────────────────────────────────────────────────
    enum ActionType {
        SUPPLY_IDLE,
        HARVEST_YIELD,
        ROTATE,
        TESTNET_ROTATE,
        FULFILL_REDEMPTIONS,
        RECALL_REMOTE,
        TESTNET_RECALL
    }

    // ─── Roles ───────────────────────────────────────────────────────
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Immutables ──────────────────────────────────────────────────
    IYieldVaultKeeper public immutable vault;
    IStrategyControllerKeeper public immutable strategyController;
    CircuitBreaker public immutable circuitBreaker;
    address public immutable asset;
    uint256 private immutable _vaultDecimals;

    // ─── CRE Forwarder ──────────────────────────────────────────────
    address public forwarder; // KeystoneForwarder address

    // ─── Optional CRE Validation ────────────────────────────────────
    bytes32 public expectedWorkflowId;
    address public expectedWorkflowOwner;

    // ─── Configuration ───────────────────────────────────────────────
    uint256 public minIdleSupplyAmount;
    uint256 public idleTargetBps;
    uint256 public harvestMinYieldBps;
    uint256 public harvestCooldown;

    // ─── State ───────────────────────────────────────────────────────
    uint256 public lastHarvestTime;
    uint256 public lastPerformTime;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─── Events ──────────────────────────────────────────────────────
    event IdleSupplied(uint256 amount);
    event YieldHarvested();
    event RotationInitiated(uint64 indexed destChain, uint256 amount, uint256 yieldBps, uint256 costBps);
    event RedemptionsFulfilled(uint256 maxToProcess);
    event RemoteRecallInitiated(uint64 indexed chainSelector, uint256 amount);
    event ForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);
    event WorkflowIdUpdated(bytes32 indexed oldId, bytes32 indexed newId);
    event WorkflowOwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event ConfigUpdated(
        uint256 minIdleSupplyAmount, uint256 idleTargetBps, uint256 harvestMinYieldBps, uint256 harvestCooldown
    );

    // ─── Errors ──────────────────────────────────────────────────────
    error NoActionNeeded();
    error InvalidConfig();
    error UnauthorizedForwarder();
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidWorkflowOwner(address received, address expected);

    constructor(
        address vault_,
        address strategyController_,
        address circuitBreaker_,
        address admin_,
        address forwarder_,
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

        forwarder = forwarder_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);

        _validateConfig(idleTargetBps_, harvestCooldown_);
        minIdleSupplyAmount = minIdleSupplyAmount_;
        idleTargetBps = idleTargetBps_;
        harvestMinYieldBps = harvestMinYieldBps_;
        harvestCooldown = harvestCooldown_;
    }

    // ─── IReceiver: CRE Report Handler ──────────────────────────────

    /// @notice Called by KeystoneForwarder to deliver workflow reports
    /// @param metadata Encoded workflow metadata (workflowId, workflowName, workflowOwner)
    /// @param report ABI-encoded ActionType from the CRE workflow
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        // Verify caller is the trusted forwarder
        if (forwarder != address(0) && msg.sender != forwarder) revert UnauthorizedForwarder();

        // Optional: validate workflow identity
        if (expectedWorkflowId != bytes32(0) || expectedWorkflowOwner != address(0)) {
            _validateMetadata(metadata);
        }

        // Decode action type from first 32 bytes
        ActionType action = abi.decode(report, (ActionType));

        if (action == ActionType.SUPPLY_IDLE) {
            _performSupply();
        } else if (action == ActionType.HARVEST_YIELD) {
            _performHarvest();
        } else if (action == ActionType.ROTATE) {
            // ROTATE carries extra params: (uint8, uint64, uint256, uint256, uint256)
            (, uint64 destChain, uint256 amount, uint256 yieldBps, uint256 costBps) =
                abi.decode(report, (uint8, uint64, uint256, uint256, uint256));
            _performRotation(destChain, amount, yieldBps, costBps);
        } else if (action == ActionType.TESTNET_ROTATE) {
            // TESTNET_ROTATE: (uint8, uint64, uint256, address, uint256, uint256, uint256)
            (
                ,
                uint64 destChain,
                uint256 amount,
                address bridgeToken,
                uint256 bridgeAmount,
                uint256 yieldBps,
                uint256 costBps
            ) = abi.decode(report, (uint8, uint64, uint256, address, uint256, uint256, uint256));
            _performTestnetRotation(destChain, amount, bridgeToken, bridgeAmount, yieldBps, costBps);
        } else if (action == ActionType.FULFILL_REDEMPTIONS) {
            // FULFILL_REDEMPTIONS: (uint8, uint256)
            (, uint256 maxToProcess) = abi.decode(report, (uint8, uint256));
            _performFulfillRedemptions(maxToProcess);
        } else if (action == ActionType.RECALL_REMOTE) {
            // RECALL_REMOTE: (uint8, uint64, uint256)
            (, uint64 chainSelector, uint256 amount) = abi.decode(report, (uint8, uint64, uint256));
            _performRecallRemote(chainSelector, amount);
        } else if (action == ActionType.TESTNET_RECALL) {
            // TESTNET_RECALL: (uint8, uint64, uint256, address)
            (, uint64 chainSelector, uint256 amount, address bridgeToken) =
                abi.decode(report, (uint8, uint64, uint256, address));
            _performTestnetRecall(chainSelector, amount, bridgeToken);
        } else {
            revert NoActionNeeded();
        }

        lastPerformTime = block.timestamp;
    }

    /// @notice ERC165 interface detection
    function supportsInterface(bytes4 interfaceId) public view override(IERC165, AccessControl) returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    // ─── Internal: Metadata Validation ──────────────────────────────

    function _validateMetadata(bytes calldata metadata) internal view {
        // Metadata is abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
        // Total: 32 + 10 + 20 = 62 bytes
        if (metadata.length < 62) {
            // If validation is configured but metadata is too short, reject — prevents bypass
            if (expectedWorkflowId != bytes32(0) || expectedWorkflowOwner != address(0)) {
                revert("Metadata too short for validation");
            }
            return;
        }

        bytes32 workflowId = bytes32(metadata[0:32]);
        // bytes10 workflowName = bytes10(metadata[32:42]); // available but not validated
        address workflowOwner = address(bytes20(metadata[42:62]));

        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }

        if (expectedWorkflowOwner != address(0) && workflowOwner != expectedWorkflowOwner) {
            revert InvalidWorkflowOwner(workflowOwner, expectedWorkflowOwner);
        }
    }

    // ─── Internal: Idle Supply ───────────────────────────────────────

    function _checkIdleSupply() internal view returns (bool shouldSupply, uint256 supplyAmount) {
        uint256 totalAssets_ = vault.totalAssets();
        if (totalAssets_ == 0) return (false, 0);

        uint256 idle = IERC20(asset).balanceOf(address(vault));
        uint256 targetIdle = (totalAssets_ * idleTargetBps) / BPS_DENOMINATOR;

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
        if (block.timestamp < lastHarvestTime + harvestCooldown) return false;

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

    // ─── Internal: Cross-Chain Rotation ──────────────────────────────

    function _performRotation(uint64 destChain, uint256 amount, uint256 yieldBps, uint256 costBps) internal {
        if (circuitBreaker.isActive()) revert NoActionNeeded();
        if (amount == 0) revert NoActionNeeded();

        // Validate rotation is viable (checks spread, cost, cooldown, exposure limits)
        if (!strategyController.validateRotation(destChain, amount, yieldBps, costBps)) {
            revert NoActionNeeded();
        }

        strategyController.initiateCrossChainRotation(destChain, asset, amount, yieldBps, costBps);
        emit RotationInitiated(destChain, amount, yieldBps, costBps);
    }

    // ─── Internal: Testnet Rotation ──────────────────────────────────

    function _performTestnetRotation(
        uint64 destChain,
        uint256 amount,
        address bridgeToken,
        uint256 bridgeAmount,
        uint256 yieldBps,
        uint256 costBps
    ) internal {
        if (circuitBreaker.isActive()) revert NoActionNeeded();
        if (amount == 0) revert NoActionNeeded();

        if (!strategyController.validateRotation(destChain, amount, yieldBps, costBps)) {
            revert NoActionNeeded();
        }

        strategyController.initiateTestnetRotation(destChain, amount, bridgeToken, bridgeAmount, yieldBps, costBps);
        emit RotationInitiated(destChain, amount, yieldBps, costBps);
    }

    // ─── Internal: Fulfill Redemptions ──────────────────────────────

    function _performFulfillRedemptions(uint256 maxToProcess) internal {
        if (maxToProcess == 0) revert NoActionNeeded();
        // Circuit breaker intentionally NOT checked: user redemptions must always be fulfillable
        strategyController.processPendingRedemptions(maxToProcess);
        emit RedemptionsFulfilled(maxToProcess);
    }

    // ─── Internal: Recall Remote Funds ────────────────────────────────

    function _performRecallRemote(uint64 chainSelector, uint256 amount) internal {
        if (amount == 0) revert NoActionNeeded();
        // Circuit breaker intentionally NOT checked: recalls are needed to fulfill pending redemptions
        strategyController.initiatePartialRemoteRecall(chainSelector, amount);
        emit RemoteRecallInitiated(chainSelector, amount);
    }

    // ─── Internal: Testnet Recall ───────────────────────────────────

    function _performTestnetRecall(uint64 chainSelector, uint256 amount, address bridgeToken) internal {
        if (amount == 0) revert NoActionNeeded();
        // Circuit breaker intentionally NOT checked: recalls are needed to fulfill pending redemptions
        strategyController.initiateTestnetRemoteRecall(chainSelector, amount, bridgeToken);
        emit RemoteRecallInitiated(chainSelector, amount);
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setForwarder(address forwarder_) external onlyRole(ADMIN_ROLE) {
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    function setExpectedWorkflowId(bytes32 workflowId_) external onlyRole(ADMIN_ROLE) {
        emit WorkflowIdUpdated(expectedWorkflowId, workflowId_);
        expectedWorkflowId = workflowId_;
    }

    function setExpectedWorkflowOwner(address owner_) external onlyRole(ADMIN_ROLE) {
        emit WorkflowOwnerUpdated(expectedWorkflowOwner, owner_);
        expectedWorkflowOwner = owner_;
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
