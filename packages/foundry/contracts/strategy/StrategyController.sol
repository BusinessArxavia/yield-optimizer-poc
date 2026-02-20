// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { CCIPReceiver } from "@chainlink/contracts-ccip/src/v0.8/ccip/applications/CCIPReceiver.sol";
import { Client } from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import { IRouterClient } from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";

import { IAavePool } from "../interfaces/IAavePool.sol";
import { CircuitBreaker } from "../safety/CircuitBreaker.sol";
import { ExposureLimits } from "../libraries/ExposureLimits.sol";
import { RotationValidator } from "../libraries/RotationValidator.sol";

// Forward declaration for vault interface
interface IYieldVault {
    function totalAssets() external view returns (uint256);
    function supplyToAave(uint256 amount) external;
    function withdrawFromAave(uint256 amount) external;
    function transferToStrategy(uint256 amount) external;
    function updateRemoteBalance(uint64 chainSelector, uint256 newBalance) external;
    function updateInFlight(uint64 chainSelector, int256 delta) external;
    function harvestYield() external;
    function remoteBalances(uint64 chainSelector) external view returns (uint256);
    function inFlightAmounts(uint64 chainSelector) external view returns (uint256);
    function totalInFlight() external view returns (uint256);
    function asset() external view returns (address);
    function fulfillRedemptions(uint256 maxToProcess) external;
    function pendingRedeemCount() external view returns (uint256);
    function totalPendingAssets() external view returns (uint256);
}

/// @title StrategyController — Manages local Aave supply and cross-chain CCIP rotations
/// @notice Keepers call to rotate yield. Admin manages spoke registration via timelock.
contract StrategyController is AccessControl, ReentrancyGuard, CCIPReceiver {
    using SafeERC20 for IERC20;

    // ─── Roles ──────────────────────────────────────────────────────
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── CCIP Message Types ─────────────────────────────────────────
    enum SpokeInstruction {
        SUPPLY,
        WITHDRAW_AND_RETURN,
        REPORT_BALANCE,
        TESTNET_WITHDRAW_AND_RETURN
    }

    struct SpokeMessage {
        SpokeInstruction instruction;
        address token;
        uint256 amount;
    }

    // ─── Timelock ───────────────────────────────────────────────────
    struct TimelockEntry {
        bytes32 dataHash;
        uint256 readyTime;
        bool exists;
    }

    // ─── Immutables ─────────────────────────────────────────────────
    IYieldVault public immutable vault;
    IAavePool public immutable aavePool;
    CircuitBreaker public immutable circuitBreaker;
    IERC20 public immutable linkToken;

    // ─── State ──────────────────────────────────────────────────────
    mapping(uint64 => address) public spokes; // chainSelector → SpokeVault
    uint64[] public registeredChains;

    uint256 public minSpreadBps;
    uint256 public maxCostBps;
    uint256 public rotationCooldown; // default 24h
    mapping(uint64 => uint256) public lastRotationTime;

    // CCIP message recovery (Task 6.2)
    mapping(uint64 => uint256) public lastRotationSentTime;
    uint256 public inFlightStalenessTimeout;

    // Timelock for parameter changes
    mapping(bytes32 => TimelockEntry) public timelockQueue;
    uint256 public immutable PARAM_TIMELOCK;

    uint256 public ccipGasLimit; // Gas limit for CCIP messages

    // ─── Events ─────────────────────────────────────────────────────
    event LocalSupply(address indexed token, uint256 amount);
    event LocalWithdraw(address indexed token, uint256 amount);
    event HarvestExecuted();
    event CrossChainRotationInitiated(uint64 indexed destChain, address token, uint256 amount, bytes32 messageId);
    event BalanceReportReceived(uint64 indexed sourceChain, uint256 balance);
    event SpokeRegistered(uint64 indexed chainSelector, address spoke);
    event EmergencyWithdrawTriggered(uint64 indexed chainSelector, bytes32 messageId);
    event ParamChangeQueued(bytes32 indexed id, bytes data, uint256 readyTime);
    event ParamChangeExecuted(bytes32 indexed id);
    event StaleInFlightCleared(uint64 indexed chainSelector, uint256 amount);
    event SpokeDeregistered(uint64 indexed chainSelector);
    event MinSpreadBpsUpdated(uint256 newMinSpreadBps);
    event MaxCostBpsUpdated(uint256 newMaxCostBps);
    event RedemptionFulfillRequested(uint256 maxToProcess);
    event PartialRemoteRecallInitiated(uint64 indexed chainSelector, uint256 amount, bytes32 messageId);

    // ─── Errors ─────────────────────────────────────────────────────
    error SpokeNotRegistered(uint64 chainSelector);
    error InvalidSpokeSource(uint64 chainSelector, address sender);
    error CircuitBreakerActive();
    error TimelockNotReady(bytes32 id, uint256 readyTime);
    error TimelockNotQueued(bytes32 id);
    error ZeroAmount();
    error NotKeeperOrAdmin();
    error UnknownParamSelector(bytes4 selector);
    error InFlightNotStaleYet(uint64 chainSelector);
    error InFlightPending(uint64 chainSelector);
    error RemoteBalanceExists(uint64 chainSelector);
    error RecallExceedsRemoteBalance(uint64 chainSelector, uint256 requested, uint256 available);

    constructor(
        address admin_,
        address vault_,
        address aavePool_,
        address ccipRouter_,
        address linkToken_,
        address circuitBreaker_,
        uint256 minSpreadBps_,
        uint256 maxCostBps_,
        uint256 paramTimelock_,
        uint256 rotationCooldown_
    ) CCIPReceiver(ccipRouter_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);

        vault = IYieldVault(vault_);
        aavePool = IAavePool(aavePool_);
        circuitBreaker = CircuitBreaker(circuitBreaker_);
        linkToken = IERC20(linkToken_);

        minSpreadBps = minSpreadBps_;
        maxCostBps = maxCostBps_;
        PARAM_TIMELOCK = paramTimelock_;
        rotationCooldown = rotationCooldown_;
        ccipGasLimit = 200_000;
        inFlightStalenessTimeout = paramTimelock_ > 1 hours ? 48 hours : 5 minutes;
    }

    // ─── Validation ─────────────────────────────────────────────────

    /// @notice Validate whether a rotation is viable (view, does not modify state)
    function validateRotation(uint64 destChain, uint256 amount, uint256 yieldBps, uint256 costBps)
        external
        view
        returns (bool)
    {
        if (spokes[destChain] == address(0)) return false;

        uint256 total = vault.totalAssets();
        if (total == 0) return false;

        // Check rotation size
        uint256 rotationBps = (amount * 10_000) / total;
        if (rotationBps > ExposureLimits.MAX_SINGLE_ROTATION_BPS) return false;

        // Check in-flight
        uint256 newInFlight = vault.totalInFlight() + amount;
        uint256 inFlightBps = (newInFlight * 10_000) / total;
        if (inFlightBps > ExposureLimits.MAX_IN_FLIGHT_BPS) return false;

        // Check chain concentration
        uint256 newChainBalance = vault.remoteBalances(destChain) + amount;
        uint256 chainBps = (newChainBalance * 10_000) / total;
        if (chainBps > ExposureLimits.MAX_PER_CHAIN_BPS) return false;

        // yieldBps and costBps are informational only — validated off-chain by CRE workflow

        // Check cooldown
        if (block.timestamp < lastRotationTime[destChain] + rotationCooldown) return false;

        return true;
    }

    // ─── Local Operations ───────────────────────────────────────────

    /// @notice Supply vault idle assets to local Aave
    function executeLocalSupply(address token, uint256 amount) external onlyKeeperOrAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (circuitBreaker.isActive()) revert CircuitBreakerActive();

        vault.supplyToAave(amount);
        emit LocalSupply(token, amount);
    }

    /// @notice Withdraw from local Aave back to vault
    function executeLocalWithdraw(address token, uint256 amount) external onlyKeeperOrAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        vault.withdrawFromAave(amount);
        emit LocalWithdraw(token, amount);
    }

    /// @notice Harvest accumulated yield and mint fee shares
    function executeHarvestYield() external onlyKeeperOrAdmin nonReentrant {
        vault.harvestYield();
        emit HarvestExecuted();
    }

    // ─── Cross-Chain Rotation ───────────────────────────────────────

    /// @notice Initiate a cross-chain rotation: withdraw from Aave, send via CCIP
    function initiateCrossChainRotation(
        uint64 destChain,
        address token,
        uint256 amount,
        uint256 yieldBps,
        uint256 costBps
    ) external onlyKeeperOrAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (spokes[destChain] == address(0)) revert SpokeNotRegistered(destChain);
        if (circuitBreaker.isActive()) revert CircuitBreakerActive();

        uint256 total = vault.totalAssets();

        // Validate on-chain enforceable limits only
        ExposureLimits.validateRotationSize(amount, total);
        ExposureLimits.validateInFlight(vault.totalInFlight(), amount, total);
        ExposureLimits.validateChainConcentration(destChain, vault.remoteBalances(destChain), amount, total);
        // yieldBps and costBps are informational only — validated off-chain by CRE workflow
        RotationValidator.validateFrequency(destChain, lastRotationTime[destChain], rotationCooldown);

        // Withdraw from Aave to vault, then pull tokens to this contract
        vault.withdrawFromAave(amount);
        vault.transferToStrategy(amount);

        // Build CCIP message
        SpokeMessage memory spokeMsg =
            SpokeMessage({ instruction: SpokeInstruction.SUPPLY, token: token, amount: amount });

        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(destChain, spokeMsg, token, amount);

        // Pay fee in LINK
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(destChain, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);

        // Approve token to router
        IERC20(token).safeIncreaseAllowance(address(router), amount);

        // Send
        bytes32 messageId = router.ccipSend(destChain, ccipMessage);

        // Track in-flight
        vault.updateInFlight(destChain, int256(amount));
        lastRotationTime[destChain] = block.timestamp;
        lastRotationSentTime[destChain] = block.timestamp;

        emit CrossChainRotationInitiated(destChain, token, amount, messageId);
    }

    /// @notice Testnet rotation: withdraw from local Aave + send test tokens via CCIP
    /// @dev Uses a separate bridgeToken (e.g., CCIP-BnM) that is registered in CCIP pools,
    ///      since testnet Aave USDC is not CCIP-compatible. This tests the full flow:
    ///      Aave withdraw (local) + CCIP token+data transfer + SpokeVault receive.
    function initiateTestnetRotation(
        uint64 destChain,
        uint256 amount,
        address bridgeToken,
        uint256 bridgeAmount,
        uint256 yieldBps,
        uint256 costBps
    ) external onlyKeeperOrAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (spokes[destChain] == address(0)) revert SpokeNotRegistered(destChain);
        if (circuitBreaker.isActive()) revert CircuitBreakerActive();

        uint256 total = vault.totalAssets();

        // Same validation as production rotation (on-chain enforceable limits only)
        ExposureLimits.validateRotationSize(amount, total);
        ExposureLimits.validateInFlight(vault.totalInFlight(), amount, total);
        ExposureLimits.validateChainConcentration(destChain, vault.remoteBalances(destChain), amount, total);
        // yieldBps and costBps are informational only — validated off-chain by CRE workflow
        RotationValidator.validateFrequency(destChain, lastRotationTime[destChain], rotationCooldown);

        // Step 1: Withdraw from local Aave (proves Aave interaction works)
        vault.withdrawFromAave(amount);

        // Step 2: Build CCIP message with bridgeToken (CCIP-BnM) instead of vault asset
        // The data payload tells the spoke what happened; the bridge token proves CCIP works
        address vaultAsset = vault.asset();
        SpokeMessage memory spokeMsg =
            SpokeMessage({ instruction: SpokeInstruction.SUPPLY, token: vaultAsset, amount: amount });

        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(destChain, spokeMsg, bridgeToken, bridgeAmount);

        // Pay fee in LINK
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(destChain, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);

        // Approve bridgeToken to router (must be pre-funded in this contract)
        if (bridgeAmount > 0 && bridgeToken != address(0)) {
            IERC20(bridgeToken).safeIncreaseAllowance(address(router), bridgeAmount);
        }

        // Send CCIP message with bridge tokens
        bytes32 messageId = router.ccipSend(destChain, ccipMessage);

        // Track in-flight
        vault.updateInFlight(destChain, int256(amount));
        lastRotationTime[destChain] = block.timestamp;
        lastRotationSentTime[destChain] = block.timestamp;

        emit CrossChainRotationInitiated(destChain, bridgeToken, bridgeAmount, messageId);
    }

    /// @notice Trigger emergency withdrawal from a remote spoke
    function triggerRemoteEmergencyWithdraw(uint64 chainSelector) external onlyRole(ADMIN_ROLE) nonReentrant {
        if (spokes[chainSelector] == address(0)) revert SpokeNotRegistered(chainSelector);

        uint256 remoteBalance = vault.remoteBalances(chainSelector);
        address token = vault.asset();

        SpokeMessage memory spokeMsg =
            SpokeMessage({ instruction: SpokeInstruction.WITHDRAW_AND_RETURN, token: token, amount: remoteBalance });

        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(chainSelector, spokeMsg, address(0), 0);

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(chainSelector, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);

        bytes32 messageId = router.ccipSend(chainSelector, ccipMessage);

        emit EmergencyWithdrawTriggered(chainSelector, messageId);
    }

    // ─── Redemption Queue Operations ─────────────────────────────────

    /// @notice Fulfill pending redemptions from the vault queue
    /// @dev Wraps vault.fulfillRedemptions() with KEEPER_ROLE access control
    function processPendingRedemptions(uint256 maxToProcess) external onlyKeeperOrAdmin nonReentrant {
        if (maxToProcess == 0) revert ZeroAmount();
        vault.fulfillRedemptions(maxToProcess);
        emit RedemptionFulfillRequested(maxToProcess);
    }

    /// @notice Initiate a partial recall of funds from a remote spoke
    /// @dev Sends WITHDRAW_AND_RETURN via CCIP for a specific amount (not full balance)
    function initiatePartialRemoteRecall(uint64 chainSelector, uint256 amount) external onlyKeeperOrAdmin nonReentrant {
        if (spokes[chainSelector] == address(0)) revert SpokeNotRegistered(chainSelector);
        if (amount == 0) revert ZeroAmount();
        uint256 remote = vault.remoteBalances(chainSelector);
        if (amount > remote) revert RecallExceedsRemoteBalance(chainSelector, amount, remote);

        address token = vault.asset();

        SpokeMessage memory spokeMsg =
            SpokeMessage({ instruction: SpokeInstruction.WITHDRAW_AND_RETURN, token: token, amount: amount });

        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(chainSelector, spokeMsg, address(0), 0);

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(chainSelector, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);

        bytes32 messageId = router.ccipSend(chainSelector, ccipMessage);

        emit PartialRemoteRecallInitiated(chainSelector, amount, messageId);
    }

    /// @notice Testnet recall: withdraw from remote Aave + bridge BnM tokens back (USDC can't be bridged on testnet)
    /// @param chainSelector The spoke chain to recall from
    /// @param amount USDC amount to withdraw from Aave on the spoke
    /// @param bridgeToken The CCIP-BnM token address on the SPOKE chain (for the return bridge)
    function initiateTestnetRemoteRecall(uint64 chainSelector, uint256 amount, address bridgeToken)
        external
        onlyKeeperOrAdmin
        nonReentrant
    {
        if (spokes[chainSelector] == address(0)) revert SpokeNotRegistered(chainSelector);
        if (amount == 0) revert ZeroAmount();
        uint256 remote = vault.remoteBalances(chainSelector);
        if (amount > remote) revert RecallExceedsRemoteBalance(chainSelector, amount, remote);

        // TESTNET_WITHDRAW_AND_RETURN: token = BnM on spoke chain, amount = USDC to withdraw
        SpokeMessage memory spokeMsg = SpokeMessage({
            instruction: SpokeInstruction.TESTNET_WITHDRAW_AND_RETURN,
            token: bridgeToken,
            amount: amount
        });

        // Data-only CCIP message (no tokens sent from home to spoke)
        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(chainSelector, spokeMsg, address(0), 0);

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(chainSelector, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);

        bytes32 messageId = router.ccipSend(chainSelector, ccipMessage);

        emit PartialRemoteRecallInitiated(chainSelector, amount, messageId);
    }

    // ─── CCIP Receive ───────────────────────────────────────────────

    /// @notice Handle incoming CCIP messages (balance reports from spokes)
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        uint64 sourceChain = message.sourceChainSelector;
        address sender = abi.decode(message.sender, (address));

        if (spokes[sourceChain] != sender) {
            revert InvalidSpokeSource(sourceChain, sender);
        }

        // Decode balance report
        uint256 reportedBalance = abi.decode(message.data, (uint256));

        // Update vault tracking
        vault.updateRemoteBalance(sourceChain, reportedBalance);

        // Clear in-flight for this chain only (Task 6.1: was incorrectly clearing all chains)
        vault.updateInFlight(sourceChain, -int256(vault.inFlightAmounts(sourceChain)));

        // If tokens were returned (WITHDRAW_AND_RETURN), they come as destTokenAmounts
        if (message.destTokenAmounts.length > 0) {
            // Transfer received tokens to vault
            for (uint256 i = 0; i < message.destTokenAmounts.length; i++) {
                IERC20(message.destTokenAmounts[i].token)
                    .safeTransfer(address(vault), message.destTokenAmounts[i].amount);
            }
        }

        emit BalanceReportReceived(sourceChain, reportedBalance);
    }

    // ─── Spoke Registration (Timelocked) ────────────────────────────

    /// @notice Queue a spoke registration (48h timelock)
    function queueRegisterSpoke(uint64 chainSelector, address spoke) external onlyRole(ADMIN_ROLE) {
        bytes memory data = abi.encode(chainSelector, spoke);
        bytes32 id = keccak256(data);
        timelockQueue[id] =
            TimelockEntry({ dataHash: keccak256(data), readyTime: block.timestamp + PARAM_TIMELOCK, exists: true });
        emit ParamChangeQueued(id, data, block.timestamp + PARAM_TIMELOCK);
    }

    /// @notice Execute a queued spoke registration after timelock
    function executeRegisterSpoke(uint64 chainSelector, address spoke) external onlyRole(ADMIN_ROLE) {
        bytes memory data = abi.encode(chainSelector, spoke);
        bytes32 id = keccak256(data);

        TimelockEntry storage entry = timelockQueue[id];
        if (!entry.exists) revert TimelockNotQueued(id);
        if (block.timestamp < entry.readyTime) revert TimelockNotReady(id, entry.readyTime);

        delete timelockQueue[id];

        spokes[chainSelector] = spoke;
        registeredChains.push(chainSelector);

        emit SpokeRegistered(chainSelector, spoke);
        emit ParamChangeExecuted(id);
    }

    /// @notice Queue a parameter change (48h timelock)
    function queueParamChange(bytes calldata data) external onlyRole(ADMIN_ROLE) {
        bytes32 id = keccak256(data);
        timelockQueue[id] =
            TimelockEntry({ dataHash: keccak256(data), readyTime: block.timestamp + PARAM_TIMELOCK, exists: true });
        emit ParamChangeQueued(id, data, block.timestamp + PARAM_TIMELOCK);
    }

    /// @notice Execute a queued parameter change via direct storage writes (no self-call)
    function executeParamChange(bytes calldata data) external onlyRole(ADMIN_ROLE) {
        bytes32 id = keccak256(data);
        TimelockEntry storage entry = timelockQueue[id];
        if (!entry.exists) revert TimelockNotQueued(id);
        if (block.timestamp < entry.readyTime) revert TimelockNotReady(id, entry.readyTime);

        delete timelockQueue[id];

        // Extract selector from first 4 bytes
        bytes4 selector;
        assembly { selector := calldataload(data.offset) }

        bytes memory params = data[4:];

        // Direct storage writes — no self-call needed (Task 6.9)
        if (selector == this.setMinSpreadBps.selector) {
            uint256 val = abi.decode(params, (uint256));
            minSpreadBps = val;
            emit MinSpreadBpsUpdated(val);
        } else if (selector == this.setMaxCostBps.selector) {
            uint256 val = abi.decode(params, (uint256));
            maxCostBps = val;
            emit MaxCostBpsUpdated(val);
        } else if (selector == this.setRotationCooldown.selector) {
            uint256 val = abi.decode(params, (uint256));
            rotationCooldown = val;
        } else if (selector == this.setCcipGasLimit.selector) {
            uint256 val = abi.decode(params, (uint256));
            ccipGasLimit = val;
        } else if (selector == this.setInFlightStalenessTimeout.selector) {
            uint256 val = abi.decode(params, (uint256));
            inFlightStalenessTimeout = val;
        } else {
            revert UnknownParamSelector(selector);
        }

        emit ParamChangeExecuted(id);
    }

    /// @dev Internal setters — only callable via executeParamChange timelock dispatch.
    ///      External visibility retained so selectors can be used in queueParamChange ABI encoding.
    ///      Direct calls revert because TIMELOCKED_SETTER_ROLE is never granted to any address.
    bytes32 public constant TIMELOCKED_SETTER_ROLE = keccak256("TIMELOCKED_SETTER_ROLE");

    function setMinSpreadBps(uint256 newMinSpreadBps) external onlyRole(TIMELOCKED_SETTER_ROLE) {
        minSpreadBps = newMinSpreadBps;
    }

    function setMaxCostBps(uint256 newMaxCostBps) external onlyRole(TIMELOCKED_SETTER_ROLE) {
        maxCostBps = newMaxCostBps;
    }

    function setRotationCooldown(uint256 newCooldown) external onlyRole(TIMELOCKED_SETTER_ROLE) {
        rotationCooldown = newCooldown;
    }

    function setCcipGasLimit(uint256 newGasLimit) external onlyRole(TIMELOCKED_SETTER_ROLE) {
        ccipGasLimit = newGasLimit;
    }

    function setInFlightStalenessTimeout(uint256 newTimeout) external onlyRole(TIMELOCKED_SETTER_ROLE) {
        inFlightStalenessTimeout = newTimeout;
    }

    // ─── CCIP Message Recovery (Task 6.2) ────────────────────────────

    /// @notice Clear stale in-flight amounts when a CCIP message is lost
    /// @dev Only callable after inFlightStalenessTimeout has elapsed since the last rotation
    /// @param chainSelector The chain whose in-flight amount should be cleared
    function clearStaleInFlight(uint64 chainSelector) external onlyRole(ADMIN_ROLE) {
        if (block.timestamp <= lastRotationSentTime[chainSelector] + inFlightStalenessTimeout) {
            revert InFlightNotStaleYet(chainSelector);
        }
        uint256 staleAmount = vault.inFlightAmounts(chainSelector);
        if (staleAmount > 0) {
            vault.updateInFlight(chainSelector, -int256(staleAmount));
        }
        emit StaleInFlightCleared(chainSelector, staleAmount);
    }

    // ─── Spoke Deregistration (Task 6.7) ─────────────────────────────

    /// @notice Deregister a spoke chain. Requires zero in-flight and zero remote balance.
    /// @param chainSelector The chain selector of the spoke to deregister
    function deregisterSpoke(uint64 chainSelector) external onlyRole(ADMIN_ROLE) {
        if (spokes[chainSelector] == address(0)) revert SpokeNotRegistered(chainSelector);
        if (vault.inFlightAmounts(chainSelector) > 0) revert InFlightPending(chainSelector);
        if (vault.remoteBalances(chainSelector) > 0) revert RemoteBalanceExists(chainSelector);

        delete spokes[chainSelector];
        for (uint256 i = 0; i < registeredChains.length; i++) {
            if (registeredChains[i] == chainSelector) {
                registeredChains[i] = registeredChains[registeredChains.length - 1];
                registeredChains.pop();
                break;
            }
        }
        emit SpokeDeregistered(chainSelector);
    }

    // ─── ERC165 Override (resolve diamond) ────────────────────────────

    function supportsInterface(bytes4 interfaceId) public pure override(AccessControl, CCIPReceiver) returns (bool) {
        return interfaceId == type(IAccessControl).interfaceId || CCIPReceiver.supportsInterface(interfaceId);
    }

    // ─── View ───────────────────────────────────────────────────────

    function getRegisteredChains() external view returns (uint64[] memory) {
        return registeredChains;
    }

    // ─── Internal ───────────────────────────────────────────────────

    function _buildCcipMessage(uint64 destChain, SpokeMessage memory spokeMsg, address token, uint256 amount)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        Client.EVMTokenAmount[] memory tokenAmounts;

        if (amount > 0 && token != address(0)) {
            tokenAmounts = new Client.EVMTokenAmount[](1);
            tokenAmounts[0] = Client.EVMTokenAmount({ token: token, amount: amount });
        } else {
            tokenAmounts = new Client.EVMTokenAmount[](0);
        }

        return Client.EVM2AnyMessage({
            receiver: abi.encode(spokes[destChain]),
            data: abi.encode(spokeMsg),
            tokenAmounts: tokenAmounts,
            feeToken: address(linkToken),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({ gasLimit: ccipGasLimit }))
        });
    }

    modifier onlyKeeperOrAdmin() {
        if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(ADMIN_ROLE, msg.sender)) revert NotKeeperOrAdmin();
        _;
    }
}
