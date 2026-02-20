// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IRewardsController } from "../interfaces/IRewardsController.sol";
import { IMerklDistributor } from "../interfaces/IMerklDistributor.sol";

interface IRewardClaimable {
    function claimAaveRewards(address rewardsController, address to)
        external
        returns (address[] memory, uint256[] memory);
    function asset() external view returns (address);
}

/// @title RewardHarvester — Claims Aave incentives and Merkl rewards, holds for reinvestment
/// @notice Phase 1: claim rewards on-chain (keeper-triggered).
///         Phase 2: off-chain bot swaps reward tokens to USDC and calls reinvest().
contract RewardHarvester is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Roles ──────────────────────────────────────────────────
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant SWAPPER_ROLE = keccak256("SWAPPER_ROLE");

    // ─── Immutables ─────────────────────────────────────────────
    IRewardClaimable public immutable vault;
    IERC20 public immutable asset; // USDC
    IRewardsController public immutable aaveRewardsController;
    IMerklDistributor public immutable merklDistributor;

    // ─── State ──────────────────────────────────────────────────
    mapping(address => bool) public allowedRewardTokens;
    uint256 public totalReinvested;
    uint256 public lastHarvestTime;
    uint256 public harvestCooldown;

    // ─── Escrow ──────────────────────────────────────────────────
    struct SwapEscrow {
        address token;
        uint256 amount;
        uint256 deadline;
        bool settled;
    }

    uint256 public reinvestDeadline;
    uint256 public nextEscrowId;
    mapping(uint256 => SwapEscrow) public escrows;

    // ─── Events ─────────────────────────────────────────────────
    event AaveRewardsClaimed(address[] rewardTokens, uint256[] amounts);
    event MerklRewardsClaimed(address[] tokens, uint256[] amounts);
    event RewardWithdrawnForSwap(address indexed token, uint256 amount, address indexed swapper, uint256 indexed escrowId);
    event Reinvested(uint256 usdcAmount, uint256 indexed escrowId);
    event RewardTokenWhitelisted(address indexed token, bool allowed);
    event HarvestCooldownUpdated(uint256 newCooldown);
    event ReinvestDeadlineUpdated(uint256 newDeadline);

    // ─── Errors ─────────────────────────────────────────────────
    error HarvestCooldownNotElapsed();
    error TokenNotAllowed(address token);
    error CannotWithdrawUnderlying();
    error NothingToReinvest();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidEscrow();
    error EscrowAlreadySettled();
    error InvalidClaimRecipient(address user);
    error EscrowExpired(uint256 escrowId);

    constructor(
        address admin_,
        address vault_,
        address aaveRewardsController_,
        address merklDistributor_,
        uint256 harvestCooldown_
    ) {
        if (admin_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        if (aaveRewardsController_ == address(0) || merklDistributor_ == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);

        vault = IRewardClaimable(vault_);
        asset = IERC20(IRewardClaimable(vault_).asset());
        aaveRewardsController = IRewardsController(aaveRewardsController_);
        merklDistributor = IMerklDistributor(merklDistributor_);
        harvestCooldown = harvestCooldown_;
        reinvestDeadline = 10 minutes;
    }

    // ─── Phase 1: Claim Rewards ─────────────────────────────────

    /// @notice Claim all Aave incentive rewards via the vault's claimAaveRewards
    /// @dev Rewards land in this contract. Keeper-triggered.
    function harvestAaveRewards() external onlyRole(KEEPER_ROLE) nonReentrant {
        if (lastHarvestTime > 0 && block.timestamp < lastHarvestTime + harvestCooldown) {
            revert HarvestCooldownNotElapsed();
        }

        (address[] memory rewardTokens, uint256[] memory amounts) =
            vault.claimAaveRewards(address(aaveRewardsController), address(this));

        lastHarvestTime = block.timestamp;
        emit AaveRewardsClaimed(rewardTokens, amounts);
    }

    /// @notice Claim Merkl rewards using proof data fetched off-chain from Merkl API
    /// @dev Proof data comes from GET https://api.merkl.xyz/v4/users/{vaultAddress}/rewards
    ///      Recipients are validated to be this contract or the vault.
    function harvestMerklRewards(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external onlyRole(KEEPER_ROLE) nonReentrant {
        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] != address(this) && users[i] != address(vault)) {
                revert InvalidClaimRecipient(users[i]);
            }
        }
        merklDistributor.claim(users, tokens, amounts, proofs);
        emit MerklRewardsClaimed(tokens, amounts);
    }

    // ─── Phase 2: Swap + Reinvest ───────────────────────────────

    /// @notice Swapper withdraws reward tokens for off-chain swap to USDC
    /// @dev Only whitelisted reward tokens. Cannot withdraw the vault's underlying asset.
    ///      Creates an escrow entry that must be settled via reinvest().
    function withdrawRewardForSwap(address token, uint256 amount)
        external onlyRole(SWAPPER_ROLE) nonReentrant
        returns (uint256 escrowId)
    {
        if (amount == 0) revert ZeroAmount();
        if (token == address(asset)) revert CannotWithdrawUnderlying();
        if (!allowedRewardTokens[token]) revert TokenNotAllowed(token);

        escrowId = ++nextEscrowId;
        escrows[escrowId] = SwapEscrow({
            token: token,
            amount: amount,
            deadline: block.timestamp + reinvestDeadline,
            settled: false
        });

        IERC20(token).safeTransfer(msg.sender, amount);
        emit RewardWithdrawnForSwap(token, amount, msg.sender, escrowId);
    }

    /// @notice Reinvest swapped USDC back into the vault, settling an escrow
    /// @dev Swapper sends USDC directly to the vault. Increases totalAssets (idle balance).
    function reinvest(uint256 escrowId, uint256 usdcAmount) external onlyRole(SWAPPER_ROLE) nonReentrant {
        if (usdcAmount == 0) revert NothingToReinvest();
        SwapEscrow storage e = escrows[escrowId];
        if (e.amount == 0) revert InvalidEscrow();
        if (e.settled) revert EscrowAlreadySettled();
        if (block.timestamp > e.deadline) revert EscrowExpired(escrowId);

        e.settled = true;
        asset.safeTransferFrom(msg.sender, address(vault), usdcAmount);
        totalReinvested += usdcAmount;

        emit Reinvested(usdcAmount, escrowId);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setAllowedRewardToken(address token, bool allowed) external onlyRole(ADMIN_ROLE) {
        allowedRewardTokens[token] = allowed;
        emit RewardTokenWhitelisted(token, allowed);
    }

    function setHarvestCooldown(uint256 newCooldown) external onlyRole(ADMIN_ROLE) {
        harvestCooldown = newCooldown;
        emit HarvestCooldownUpdated(newCooldown);
    }

    /// @notice Set reinvestment deadline for escrow accounting
    /// @dev PRODUCTION: set to 48 hours. DEMO: 10 minutes (default).
    function setReinvestDeadline(uint256 newDeadline) external onlyRole(ADMIN_ROLE) {
        reinvestDeadline = newDeadline;
        emit ReinvestDeadlineUpdated(newDeadline);
    }

    // ─── Views ──────────────────────────────────────────────────

    /// @notice Check reward token balance held by this contract
    function rewardBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Count unsettled escrows past their deadline (for monitoring/alerting)
    function expiredEscrowCount() external view returns (uint256 count) {
        for (uint256 i = 1; i <= nextEscrowId; i++) {
            if (!escrows[i].settled && block.timestamp > escrows[i].deadline) {
                count++;
            }
        }
    }
}
