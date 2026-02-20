// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { ExposureLimits } from "../../contracts/libraries/ExposureLimits.sol";
import { RotationValidator } from "../../contracts/libraries/RotationValidator.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForFuzz is IAggregatorV3 {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }
}

/// @dev Helper contract to wrap library calls as external calls so vm.expectRevert works
contract ExposureLimitsWrapper {
    function validateRotationSize(uint256 amount, uint256 totalAssets) external pure {
        ExposureLimits.validateRotationSize(amount, totalAssets);
    }
}

contract DepositWithdrawFuzzTest is Test {
    YieldVault public vault;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    ExposureLimitsWrapper public limitsWrapper;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address user = makeAddr("user");

    uint256 constant MAX_DEPOSIT = 1_000_000e18;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));

        MockPriceFeedForFuzz priceFeed = new MockPriceFeedForFuzz();
        uint256[3] memory depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

        breaker = new CircuitBreaker(
            admin,
            makeAddr("pauser"),
            makeAddr("unpauser"),
            address(priceFeed),
            depegThresholds,
            tvlDropBps,
            sharePriceDropBps
        );

        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            address(aavePool),
            address(breaker),
            makeAddr("feeRecipient"),
            1000
        );

        limitsWrapper = new ExposureLimitsWrapper();

        // Fund user
        usdc.mint(user, MAX_DEPOSIT);
        vm.prank(user);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Fuzz: Deposit then full withdraw ───────────────────────────

    function testFuzz_depositAndFullWithdraw(uint256 amount) public {
        amount = bound(amount, 1, MAX_DEPOSIT);

        vm.prank(user);
        uint256 shares = vault.deposit(amount, user);

        assertGt(shares, 0, "Zero shares minted");
        assertEq(vault.totalAssets(), amount, "totalAssets mismatch after deposit");

        vm.prank(user);
        uint256 withdrawn = vault.redeem(shares, user, user);

        assertEq(withdrawn, amount, "Did not receive full deposit back");
        assertEq(vault.balanceOf(user), 0, "Shares remaining after full redeem");
    }

    // ─── Fuzz: Deposit then partial withdraw ────────────────────────

    function testFuzz_depositAndPartialWithdraw(uint256 depositAmount, uint256 withdrawPct) public {
        depositAmount = bound(depositAmount, 2, MAX_DEPOSIT);
        withdrawPct = bound(withdrawPct, 1, 99);

        vm.prank(user);
        vault.deposit(depositAmount, user);

        uint256 withdrawAmount = (depositAmount * withdrawPct) / 100;
        if (withdrawAmount == 0) withdrawAmount = 1;

        vm.prank(user);
        vault.withdraw(withdrawAmount, user, user);

        uint256 remaining = vault.balanceOf(user);
        assertGt(remaining, 0, "No shares remaining");
        assertLe(vault.totalAssets(), depositAmount, "totalAssets exceeds deposit");
    }

    // ─── Fuzz: Emergency withdraw pro-rata ──────────────────────────

    function testFuzz_emergencyWithdrawProRata(uint256 deposit1, uint256 deposit2) public {
        deposit1 = bound(deposit1, 1e18, MAX_DEPOSIT / 2);
        deposit2 = bound(deposit2, 1e18, MAX_DEPOSIT / 2);

        address user2 = makeAddr("user2");
        usdc.mint(user2, deposit2);
        vm.prank(user2);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(user);
        vault.deposit(deposit1, user);
        vm.prank(user2);
        vault.deposit(deposit2, user2);

        uint256 totalBefore = vault.totalAssets();

        // User1 emergency withdraw
        vm.prank(user);
        uint256 assets1 = vault.emergencyWithdraw();

        // Pro-rata share: assets1 ~ (deposit1 / total) * homeAssets
        // Should be approximately deposit1 (since all assets are on home chain)
        assertApproxEqRel(assets1, deposit1, 0.01e18); // 1% tolerance
    }

    // ─── Fuzz: Rotation validation bounds ───────────────────────────

    function testFuzz_rotationSizeValidation(uint256 amount, uint256 totalAssets) public view {
        totalAssets = bound(totalAssets, 1e18, 1_000_000_000e18);
        uint256 maxAllowed = (totalAssets * ExposureLimits.MAX_SINGLE_ROTATION_BPS) / 10_000;
        amount = bound(amount, 1, maxAllowed);

        // Should not revert (external call via wrapper)
        limitsWrapper.validateRotationSize(amount, totalAssets);
    }

    function testFuzz_rotationSizeValidation_overLimit(uint256 totalAssets) public {
        totalAssets = bound(totalAssets, 1e18, 1_000_000_000e18);
        // Use 25% of totalAssets, which is clearly above the 20% limit.
        // Adding +1 to a borderline value can round down in integer division for
        // very large totalAssets, so we use a definitive over-limit value instead.
        uint256 overLimit = (totalAssets * 2500) / 10_000;
        if (overLimit == 0) overLimit = 1;

        vm.expectRevert();
        limitsWrapper.validateRotationSize(overLimit, totalAssets);
    }

    // ─── Fuzz: Multiple deposit/withdraw sequences ──────────────────

    function testFuzz_multipleDepositWithdrawSequence(uint256 seed) public {
        uint256 ops = bound(seed, 3, 10);
        uint256 totalDeposited = 0;
        uint256 totalWithdrawn = 0;

        for (uint256 i = 0; i < ops; i++) {
            uint256 available = usdc.balanceOf(user);
            if (available > 0 && i % 3 != 2) {
                // Deposit
                uint256 depositAmt = bound(uint256(keccak256(abi.encode(seed, i))), 1, available);
                vm.prank(user);
                vault.deposit(depositAmt, user);
                totalDeposited += depositAmt;
            } else {
                // Withdraw
                uint256 maxW = vault.maxWithdraw(user);
                if (maxW > 0) {
                    uint256 withdrawAmt = bound(uint256(keccak256(abi.encode(seed, i, "w"))), 1, maxW);
                    vm.prank(user);
                    vault.withdraw(withdrawAmt, user, user);
                    totalWithdrawn += withdrawAmt;
                }
            }
        }

        // Sanity check
        assertLe(totalWithdrawn, totalDeposited + 1, "Withdrew more than deposited (rounding)");
    }
}
