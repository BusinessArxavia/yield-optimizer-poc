// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAavePool } from "../interfaces/IAavePool.sol";
import { IAToken } from "../interfaces/IAToken.sol";
import { IRewardsController } from "../interfaces/IRewardsController.sol";
import { CircuitBreaker } from "../safety/CircuitBreaker.sol";

/// @title YieldVault — ERC-4626 vault lending stablecoins on Aave V3 with cross-chain rotation
/// @notice Withdrawals are NEVER blocked. Deposits are blocked when circuit breaker is CRITICAL.
contract YieldVault is ERC4626, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Roles ──────────────────────────────────────────────────────
    bytes32 public constant STRATEGY_ROLE = keccak256("STRATEGY_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Immutables ─────────────────────────────────────────────────
    IAavePool public immutable aavePool;
    CircuitBreaker public immutable circuitBreaker;

    // ─── State ──────────────────────────────────────────────────────
    IAToken public aToken;

    /// @dev Remote chain balance tracking
    mapping(uint64 => uint256) public remoteBalances;
    uint64[] public activeChains;
    mapping(uint64 => bool) private _isActiveChain;

    /// @dev In-flight tracking for cross-chain rotations
    mapping(uint64 => uint256) public inFlightAmounts;
    uint256 public totalInFlight;

    /// @dev Remote balance staleness tracking
    mapping(uint64 => uint256) public lastRemoteReportTime;
    uint256 public remoteBalanceStalenessTimeout;

    /// @dev Performance fee
    address public feeRecipient;
    uint256 public performanceFeeBps; // e.g., 1000 = 10%
    uint256 public lastHarvestSharePrice;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─── Async Redemption Queue ─────────────────────────────────────
    struct PendingRedeem {
        address owner;
        address receiver;
        uint256 shares;
        uint256 minAssetsOut;
        uint256 requestTime;
    }

    uint256 public nextRedeemId;
    mapping(uint256 => PendingRedeem) public pendingRedeems;
    uint256[] private _pendingRedeemIds;
    uint256 public totalPendingShares;

    uint256 public constant MAX_REDEEM_DELAY = 7 days;
    uint256 public constant MAX_PENDING_QUEUE = 200;
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 3000; // 30%

    // ─── Events ─────────────────────────────────────────────────────
    event SuppliedToAave(uint256 amount);
    event WithdrawnFromAave(uint256 amount);
    event RemoteBalanceUpdated(uint64 indexed chainSelector, uint256 oldBalance, uint256 newBalance);
    event InFlightUpdated(uint64 indexed chainSelector, uint256 newInFlight, uint256 newTotalInFlight);
    event YieldHarvested(uint256 yieldAmount, uint256 feeShares);
    event EmergencyWithdraw(address indexed user, uint256 shares, uint256 assets);
    event RedeemRequested(
        uint256 indexed id, address indexed owner, address receiver, uint256 shares, uint256 minAssetsOut
    );
    event RedeemFulfilled(uint256 indexed id, address indexed receiver, uint256 shares, uint256 assets);
    event RedeemCancelled(uint256 indexed id, address indexed owner, uint256 shares);
    event AaveRewardsClaimed(address[] rewardTokens, uint256[] amounts);
    event RemoteBalanceStalenessTimeoutUpdated(uint256 newTimeout);

    // ─── Errors ─────────────────────────────────────────────────────
    error CircuitBreakerActive();
    error CircuitBreakerWarn();
    error ZeroAmount();
    error RedeemNotFound(uint256 id);
    error NotRedeemOwner(uint256 id);
    error RedeemSlippageExceeded(uint256 id, uint256 assets, uint256 minAssets);
    error QueueFull();
    error InvalidFeeRecipient();
    error FeeTooHigh(uint256 feeBps, uint256 maxBps);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address admin_,
        address strategyController_,
        address aavePool_,
        address circuitBreaker_,
        address feeRecipient_,
        uint256 performanceFeeBps_
    ) ERC4626(asset_) ERC20(name_, symbol_) {
        if (feeRecipient_ == address(0)) revert InvalidFeeRecipient();
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert FeeTooHigh(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(STRATEGY_ROLE, strategyController_);

        aavePool = IAavePool(aavePool_);
        circuitBreaker = CircuitBreaker(circuitBreaker_);
        feeRecipient = feeRecipient_;
        performanceFeeBps = performanceFeeBps_;

        // Resolve aToken from Aave pool
        IAavePool.ReserveData memory reserveData = IAavePool(aavePool_).getReserveData(address(asset_));
        aToken = IAToken(reserveData.aTokenAddress);

        // Set initial share price for harvest tracking
        lastHarvestSharePrice = 10 ** decimals(); // 1:1 initial

        // Remote balance staleness: 30 minutes default (demo-friendly; admin can increase for production)
        remoteBalanceStalenessTimeout = 30 minutes;
    }

    // ─── ERC-4626 Overrides ─────────────────────────────────────────

    /// @notice Total assets = idle + aToken balance + remote balances - in-flight
    function totalAssets() public view override returns (uint256) {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        uint256 aaveBalance = aToken.balanceOf(address(this));
        uint256 remote = _totalRemoteBalances();
        uint256 total = idle + aaveBalance + remote;

        // Subtract in-flight (already counted in source but not yet in destination)
        if (totalInFlight >= total) return 0;
        return total - totalInFlight;
    }

    /// @dev Block deposits when circuit breaker is CRITICAL
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        if (circuitBreaker.isCritical()) revert CircuitBreakerActive();
        return super.deposit(assets, receiver);
    }

    /// @dev Block minting when circuit breaker is CRITICAL
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        if (circuitBreaker.isCritical()) revert CircuitBreakerActive();
        return super.mint(shares, receiver);
    }

    /// @dev Withdrawals are NEVER blocked by circuit breaker
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    /// @dev Redemptions are NEVER blocked by circuit breaker
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Max withdraw is capped to home-chain assets minus assets reserved for pending redeems
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 homeAssets = _homeChainAssets();
        uint256 reserved = _convertToAssets(totalPendingShares, Math.Rounding.Ceil);
        uint256 available = homeAssets > reserved ? homeAssets - reserved : 0;
        uint256 ownerAssets = _convertToAssets(balanceOf(owner), Math.Rounding.Floor);
        return available < ownerAssets ? available : ownerAssets;
    }

    /// @notice Max redeem is capped to shares redeemable from available home-chain assets
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 homeAssets = _homeChainAssets();
        uint256 reserved = _convertToAssets(totalPendingShares, Math.Rounding.Ceil);
        uint256 available = homeAssets > reserved ? homeAssets - reserved : 0;
        uint256 availableShares = _convertToShares(available, Math.Rounding.Floor);
        uint256 ownerShares = balanceOf(owner);
        return availableShares < ownerShares ? availableShares : ownerShares;
    }

    // ─── Emergency Withdraw ─────────────────────────────────────────

    /// @notice Burns all shares and returns pro-rata of home-chain assets. NEVER blocked.
    function emergencyWithdraw() external nonReentrant returns (uint256 assets) {
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert ZeroAmount();

        uint256 homeAssets = _homeChainAssets();
        uint256 totalSupplyBefore = totalSupply();

        // Pro-rata of home-chain assets only
        assets = (homeAssets * shares) / totalSupplyBefore;

        _burn(msg.sender, shares);

        // Withdraw from Aave if needed
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (assets > idle) {
            uint256 needed = assets - idle;
            aavePool.withdraw(address(asset()), needed, address(this));
        }

        IERC20(asset()).safeTransfer(msg.sender, assets);

        emit EmergencyWithdraw(msg.sender, shares, assets);
    }

    // ─── Strategy Functions ─────────────────────────────────────────

    /// @notice Supply idle assets to Aave. Blocked when circuit breaker >= WARN.
    function supplyToAave(uint256 amount) external onlyRole(STRATEGY_ROLE) {
        if (circuitBreaker.isActive()) revert CircuitBreakerWarn();
        if (amount == 0) revert ZeroAmount();

        IERC20(asset()).forceApprove(address(aavePool), amount);
        aavePool.supply(address(asset()), amount, address(this), 0);

        emit SuppliedToAave(amount);
    }

    /// @notice Withdraw from Aave back to vault. Never blocked.
    function withdrawFromAave(uint256 amount) external onlyRole(STRATEGY_ROLE) {
        if (amount == 0) revert ZeroAmount();
        aavePool.withdraw(address(asset()), amount, address(this));
        emit WithdrawnFromAave(amount);
    }

    /// @notice Harvest yield and mint fee shares to feeRecipient
    function harvestYield() external onlyRole(STRATEGY_ROLE) {
        uint256 currentSharePrice = _currentSharePrice();
        if (currentSharePrice <= lastHarvestSharePrice) return; // No yield

        uint256 yieldPerShare = currentSharePrice - lastHarvestSharePrice;
        uint256 totalYield = (yieldPerShare * totalSupply()) / (10 ** decimals());

        uint256 feeAmount = (totalYield * performanceFeeBps) / BPS_DENOMINATOR;
        if (feeAmount > 0) {
            // Mint new shares worth feeAmount to feeRecipient
            uint256 feeShares = _convertToShares(feeAmount, Math.Rounding.Floor);
            if (feeShares > 0) {
                _mint(feeRecipient, feeShares);
                emit YieldHarvested(totalYield, feeShares);
            }
        }

        lastHarvestSharePrice = currentSharePrice;
    }

    /// @notice Update remote chain balance (called by StrategyController on CCIP receive)
    function updateRemoteBalance(uint64 chainSelector, uint256 newBalance) external onlyRole(STRATEGY_ROLE) {
        uint256 oldBalance = remoteBalances[chainSelector];
        remoteBalances[chainSelector] = newBalance;

        lastRemoteReportTime[chainSelector] = block.timestamp;

        if (!_isActiveChain[chainSelector] && newBalance > 0) {
            activeChains.push(chainSelector);
            _isActiveChain[chainSelector] = true;
        }

        emit RemoteBalanceUpdated(chainSelector, oldBalance, newBalance);
    }

    /// @notice Update in-flight amount for a chain (positive = new rotation, negative = landed)
    function updateInFlight(uint64 chainSelector, int256 delta) external onlyRole(STRATEGY_ROLE) {
        if (delta > 0) {
            uint256 increase = uint256(delta);
            inFlightAmounts[chainSelector] += increase;
            totalInFlight += increase;
        } else if (delta < 0) {
            uint256 decrease = uint256(-delta);
            if (decrease > inFlightAmounts[chainSelector]) {
                totalInFlight -= inFlightAmounts[chainSelector];
                inFlightAmounts[chainSelector] = 0;
            } else {
                inFlightAmounts[chainSelector] -= decrease;
                totalInFlight -= decrease;
            }
        }

        emit InFlightUpdated(chainSelector, inFlightAmounts[chainSelector], totalInFlight);
    }

    /// @notice Transfer assets to the strategy controller (for cross-chain rotations)
    function transferToStrategy(uint256 amount) external onlyRole(STRATEGY_ROLE) {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset()).safeTransfer(msg.sender, amount);
    }

    // ─── Reward Claiming ──────────────────────────────────────────

    /// @notice Claim all Aave incentive rewards accrued on this vault's aTokens
    /// @param rewardsController The Aave RewardsController address
    /// @param to Recipient of reward tokens
    function claimAaveRewards(address rewardsController, address to)
        external
        onlyRole(STRATEGY_ROLE)
        returns (address[] memory rewardTokens, uint256[] memory amounts)
    {
        address[] memory assets = new address[](1);
        assets[0] = address(aToken);
        (rewardTokens, amounts) = IRewardsController(rewardsController).claimAllRewards(assets, to);
        emit AaveRewardsClaimed(rewardTokens, amounts);
    }

    // ─── Async Redemption Queue ─────────────────────────────────────

    /// @notice Request redemption. Instant if home liquidity suffices, queued otherwise.
    /// @param shares Number of vault shares to redeem
    /// @param receiver Address to receive the underlying assets
    /// @param minAssetsOut Minimum acceptable asset output (slippage protection, 0 = no check)
    /// @return redeemId 0 if fulfilled instantly, >0 if queued
    function requestRedeem(uint256 shares, address receiver, uint256 minAssetsOut)
        external
        nonReentrant
        returns (uint256 redeemId)
    {
        if (shares == 0) revert ZeroAmount();

        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        uint256 homeAssets = _homeChainAssets();
        uint256 reserved = _convertToAssets(totalPendingShares, Math.Rounding.Ceil);
        uint256 available = homeAssets > reserved ? homeAssets - reserved : 0;

        // Instant path: enough unreserved home liquidity
        if (assets <= available) {
            if (minAssetsOut > 0 && assets < minAssetsOut) {
                revert RedeemSlippageExceeded(0, assets, minAssetsOut);
            }
            // Inline the redeem logic to avoid nested nonReentrant on redeem()
            _withdraw(msg.sender, receiver, msg.sender, assets, shares);
            return 0;
        }

        // Queue path: lock shares in vault
        if (_pendingRedeemIds.length >= MAX_PENDING_QUEUE) revert QueueFull();
        _transfer(msg.sender, address(this), shares);
        redeemId = ++nextRedeemId;
        pendingRedeems[redeemId] = PendingRedeem({
            owner: msg.sender,
            receiver: receiver,
            shares: shares,
            minAssetsOut: minAssetsOut,
            requestTime: block.timestamp
        });
        _pendingRedeemIds.push(redeemId);
        totalPendingShares += shares;

        emit RedeemRequested(redeemId, msg.sender, receiver, shares, minAssetsOut);
    }

    /// @notice Fulfill pending redemptions from the queue (FIFO)
    /// @dev Called by keeper after CCIP tokens return. Skips entries failing slippage check.
    function fulfillRedemptions(uint256 maxToProcess) external onlyRole(STRATEGY_ROLE) nonReentrant {
        uint256 fulfilled;

        for (uint256 i = 0; i < _pendingRedeemIds.length && fulfilled < maxToProcess;) {
            uint256 id = _pendingRedeemIds[i];
            PendingRedeem storage req = pendingRedeems[id];

            // Skip already cleared entries
            if (req.shares == 0) {
                i++;
                continue;
            }

            uint256 assets = _convertToAssets(req.shares, Math.Rounding.Floor);
            uint256 homeAssets = _homeChainAssets();
            uint256 reserved = _convertToAssets(totalPendingShares - req.shares, Math.Rounding.Ceil);
            uint256 available = homeAssets > reserved ? homeAssets - reserved : 0;

            // Not enough liquidity — stop processing
            if (assets > available) break;

            // Slippage check — skip this one, process the rest
            if (req.minAssetsOut > 0 && assets < req.minAssetsOut) {
                i++;
                continue;
            }

            // Fulfill: burn shares, send assets
            totalPendingShares -= req.shares;
            _burn(address(this), req.shares);

            uint256 idle = IERC20(asset()).balanceOf(address(this));
            if (assets > idle) {
                aavePool.withdraw(address(asset()), assets - idle, address(this));
            }
            IERC20(asset()).safeTransfer(req.receiver, assets);

            emit RedeemFulfilled(id, req.receiver, req.shares, assets);
            delete pendingRedeems[id];
            fulfilled++;
            i++;
        }

        // Compact the queue: remove cleared entries
        _compactPendingQueue();
    }

    /// @notice Cancel a pending redemption and return shares to owner
    function cancelRedeem(uint256 redeemId) external nonReentrant {
        PendingRedeem storage req = pendingRedeems[redeemId];
        if (req.shares == 0) revert RedeemNotFound(redeemId);
        if (req.owner != msg.sender) revert NotRedeemOwner(redeemId);

        uint256 shares = req.shares;
        totalPendingShares -= shares;
        _transfer(address(this), req.owner, shares);

        emit RedeemCancelled(redeemId, req.owner, shares);
        delete pendingRedeems[redeemId];
    }

    /// @notice Cancel expired requests (>7 days), returning shares to owners
    function cancelExpiredRedeems() external onlyRole(STRATEGY_ROLE) {
        for (uint256 i = 0; i < _pendingRedeemIds.length; i++) {
            uint256 id = _pendingRedeemIds[i];
            PendingRedeem storage req = pendingRedeems[id];
            if (req.shares > 0 && block.timestamp > req.requestTime + MAX_REDEEM_DELAY) {
                totalPendingShares -= req.shares;
                _transfer(address(this), req.owner, req.shares);
                emit RedeemCancelled(id, req.owner, req.shares);
                delete pendingRedeems[id];
            }
        }
        _compactPendingQueue();
    }

    // ─── View Helpers ───────────────────────────────────────────────

    function getActiveChains() external view returns (uint64[] memory) {
        return activeChains;
    }

    function homeChainAssets() external view returns (uint256) {
        return _homeChainAssets();
    }

    function pendingRedeemCount() external view returns (uint256) {
        return _pendingRedeemIds.length;
    }

    function getPendingRedeemIds() external view returns (uint256[] memory) {
        return _pendingRedeemIds;
    }

    function totalPendingAssets() external view returns (uint256) {
        return _convertToAssets(totalPendingShares, Math.Rounding.Floor);
    }

    /// @notice Check if a remote chain's balance report is stale
    function isRemoteBalanceStale(uint64 chainSelector) external view returns (bool) {
        if (remoteBalanceStalenessTimeout == 0) return false;
        if (lastRemoteReportTime[chainSelector] == 0) return false;
        return block.timestamp > lastRemoteReportTime[chainSelector] + remoteBalanceStalenessTimeout;
    }

    /// @notice Update remote balance staleness timeout
    /// @dev PRODUCTION: set to 72 hours. DEMO: 30 minutes (auto-configured in constructor).
    function setRemoteBalanceStalenessTimeout(uint256 newTimeout) external onlyRole(ADMIN_ROLE) {
        remoteBalanceStalenessTimeout = newTimeout;
        emit RemoteBalanceStalenessTimeoutUpdated(newTimeout);
    }

    // ─── ERC-4626 Internal Overrides ────────────────────────────────

    /// @dev Auto-pull from Aave when idle balance is insufficient for a withdrawal
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        // Pull from Aave if idle balance is insufficient
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (assets > idle) {
            uint256 needed = assets - idle;
            aavePool.withdraw(address(asset()), needed, address(this));
        }
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ─── Internal ───────────────────────────────────────────────────

    function _homeChainAssets() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + aToken.balanceOf(address(this));
    }

    function _totalRemoteBalances() internal view returns (uint256 total) {
        for (uint256 i = 0; i < activeChains.length; i++) {
            uint64 chain = activeChains[i];
            // Skip stale remote balances — if no report in timeout period, exclude from totalAssets
            if (
                remoteBalanceStalenessTimeout > 0 && lastRemoteReportTime[chain] > 0
                    && block.timestamp > lastRemoteReportTime[chain] + remoteBalanceStalenessTimeout
            ) {
                continue;
            }
            total += remoteBalances[chain];
        }
    }

    function _currentSharePrice() internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 10 ** decimals();
        return (totalAssets() * (10 ** decimals())) / supply;
    }

    /// @dev Remove fulfilled/cancelled entries from _pendingRedeemIds
    function _compactPendingQueue() internal {
        uint256 writeIdx;
        for (uint256 readIdx = 0; readIdx < _pendingRedeemIds.length; readIdx++) {
            uint256 id = _pendingRedeemIds[readIdx];
            if (pendingRedeems[id].shares > 0) {
                if (writeIdx != readIdx) {
                    _pendingRedeemIds[writeIdx] = id;
                }
                writeIdx++;
            }
        }
        // Trim the array
        uint256 toRemove = _pendingRedeemIds.length - writeIdx;
        for (uint256 i = 0; i < toRemove; i++) {
            _pendingRedeemIds.pop();
        }
    }
}
