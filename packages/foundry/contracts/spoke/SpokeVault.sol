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
import { IAToken } from "../interfaces/IAToken.sol";

/// @title SpokeVault — Remote chain vault that receives CCIP instructions from StrategyController
/// @notice Supplies received tokens to Aave on the remote chain, reports balance back via CCIP
contract SpokeVault is CCIPReceiver, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Roles ──────────────────────────────────────────────────────
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── CCIP Message Types (must match StrategyController) ─────────
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

    // ─── State ──────────────────────────────────────────────────────
    IAavePool public immutable aavePool;
    uint64 public immutable homeChainSelector;
    address public immutable homeStrategyController;
    IERC20 public immutable linkToken;
    IERC20 public immutable asset;
    IAToken public aToken;

    uint256 public ccipGasLimit;

    // ─── Events ─────────────────────────────────────────────────────
    event SupplyExecuted(address indexed token, uint256 amount);
    event WithdrawAndReturnExecuted(address indexed token, uint256 amount, bytes32 messageId);
    event BalanceReported(uint256 balance, bytes32 messageId);

    // ─── Errors ─────────────────────────────────────────────────────
    error InvalidSourceChain(uint64 sourceChain);
    error InvalidSender(address sender);

    constructor(
        address ccipRouter_,
        address aavePool_,
        address admin_,
        uint64 homeChainSelector_,
        address homeStrategyController_,
        address linkToken_,
        address asset_
    ) CCIPReceiver(ccipRouter_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);

        aavePool = IAavePool(aavePool_);
        homeChainSelector = homeChainSelector_;
        homeStrategyController = homeStrategyController_;
        linkToken = IERC20(linkToken_);
        asset = IERC20(asset_);

        // Resolve aToken
        IAavePool.ReserveData memory reserveData = IAavePool(aavePool_).getReserveData(asset_);
        aToken = IAToken(reserveData.aTokenAddress);

        ccipGasLimit = 200_000;
    }

    // ─── CCIP Receive ───────────────────────────────────────────────

    /// @notice Override external ccipReceive to add reentrancy protection
    function ccipReceive(Client.Any2EVMMessage calldata message)
        external
        override
        onlyRouter
        nonReentrant
    {
        _ccipReceive(message);
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        // Validate source
        if (message.sourceChainSelector != homeChainSelector) {
            revert InvalidSourceChain(message.sourceChainSelector);
        }
        address sender = abi.decode(message.sender, (address));
        if (sender != homeStrategyController) {
            revert InvalidSender(sender);
        }

        SpokeMessage memory spokeMsg = abi.decode(message.data, (SpokeMessage));

        if (spokeMsg.instruction == SpokeInstruction.SUPPLY) {
            _executeSupply(spokeMsg.token, spokeMsg.amount);
        } else if (spokeMsg.instruction == SpokeInstruction.WITHDRAW_AND_RETURN) {
            _executeWithdrawAndReturn(spokeMsg.token, spokeMsg.amount);
        } else if (spokeMsg.instruction == SpokeInstruction.REPORT_BALANCE) {
            _reportBalance();
        } else if (spokeMsg.instruction == SpokeInstruction.TESTNET_WITHDRAW_AND_RETURN) {
            _executeTestnetWithdrawAndReturn(spokeMsg.token, spokeMsg.amount);
        }
    }

    // ─── Internal Operations ────────────────────────────────────────

    function _executeSupply(address /* token */, uint256 amount) internal {
        // Use local asset (home chain sends its own USDC address which differs cross-chain)
        address localAsset = address(asset);
        IERC20(localAsset).safeIncreaseAllowance(address(aavePool), amount);
        aavePool.supply(localAsset, amount, address(this), 0);

        emit SupplyExecuted(localAsset, amount);

        // Report balance back to home chain
        _reportBalance();
    }

    function _executeWithdrawAndReturn(address /* token */, uint256 amount) internal {
        // Use local asset (home chain sends its own USDC address which differs cross-chain)
        address localAsset = address(asset);
        // Withdraw from Aave
        uint256 withdrawn = aavePool.withdraw(localAsset, amount, address(this));

        // Send tokens back via CCIP
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({ token: localAsset, amount: withdrawn });

        // Balance after withdrawal
        uint256 remainingBalance = aToken.balanceOf(address(this));

        Client.EVM2AnyMessage memory ccipMessage = Client.EVM2AnyMessage({
            receiver: abi.encode(homeStrategyController),
            data: abi.encode(remainingBalance),
            tokenAmounts: tokenAmounts,
            feeToken: address(linkToken),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({ gasLimit: ccipGasLimit }))
        });

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(homeChainSelector, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);
        IERC20(localAsset).safeIncreaseAllowance(address(router), withdrawn);

        bytes32 messageId = router.ccipSend(homeChainSelector, ccipMessage);

        emit WithdrawAndReturnExecuted(localAsset, withdrawn, messageId);
    }

    /// @dev Testnet recall: withdraw from Aave + bridge BnM tokens back (USDC can't be bridged on testnet)
    /// @param bridgeToken The CCIP-BnM token address on this chain (for the return bridge)
    /// @param amount USDC amount to withdraw from Aave
    function _executeTestnetWithdrawAndReturn(address bridgeToken, uint256 amount) internal {
        // Step 1: Withdraw USDC from Aave (real Aave interaction)
        address localAsset = address(asset);
        uint256 withdrawn = aavePool.withdraw(localAsset, amount, address(this));

        // Step 2: Bridge BnM tokens back (testnet workaround — USDC stays on spoke)
        uint256 bnmBalance = IERC20(bridgeToken).balanceOf(address(this));
        uint256 remainingBalance = aToken.balanceOf(address(this));

        Client.EVMTokenAmount[] memory tokenAmounts;
        if (bnmBalance > 0 && bridgeToken != address(0)) {
            tokenAmounts = new Client.EVMTokenAmount[](1);
            tokenAmounts[0] = Client.EVMTokenAmount({ token: bridgeToken, amount: bnmBalance });
        } else {
            tokenAmounts = new Client.EVMTokenAmount[](0);
        }

        Client.EVM2AnyMessage memory ccipMessage = Client.EVM2AnyMessage({
            receiver: abi.encode(homeStrategyController),
            data: abi.encode(remainingBalance),
            tokenAmounts: tokenAmounts,
            feeToken: address(linkToken),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({ gasLimit: ccipGasLimit }))
        });

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(homeChainSelector, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);
        if (bnmBalance > 0 && bridgeToken != address(0)) {
            IERC20(bridgeToken).safeIncreaseAllowance(address(router), bnmBalance);
        }

        bytes32 messageId = router.ccipSend(homeChainSelector, ccipMessage);

        emit WithdrawAndReturnExecuted(localAsset, withdrawn, messageId);
    }

    function _reportBalance() internal {
        uint256 balance = aToken.balanceOf(address(this));

        Client.EVM2AnyMessage memory ccipMessage = Client.EVM2AnyMessage({
            receiver: abi.encode(homeStrategyController),
            data: abi.encode(balance),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(linkToken),
            extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({ gasLimit: ccipGasLimit }))
        });

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(homeChainSelector, ccipMessage);
        linkToken.safeIncreaseAllowance(address(router), fee);

        bytes32 messageId = router.ccipSend(homeChainSelector, ccipMessage);

        emit BalanceReported(balance, messageId);
    }

    // ─── ERC165 Override (resolve diamond) ────────────────────────────

    function supportsInterface(bytes4 interfaceId) public pure override(AccessControl, CCIPReceiver) returns (bool) {
        return interfaceId == type(IAccessControl).interfaceId || CCIPReceiver.supportsInterface(interfaceId);
    }

    // ─── Manual Operations ──────────────────────────────────────────

    /// @notice Manual trigger for balance reporting
    function reportBalance() external onlyRole(ADMIN_ROLE) nonReentrant {
        _reportBalance();
    }

    /// @notice Update CCIP gas limit
    function setCcipGasLimit(uint256 newGasLimit) external onlyRole(ADMIN_ROLE) {
        ccipGasLimit = newGasLimit;
    }
}
