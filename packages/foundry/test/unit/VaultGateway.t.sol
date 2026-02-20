// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { VaultGateway } from "../../contracts/vault/VaultGateway.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForGateway is IAggregatorV3 {
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

contract VaultGatewayTest is Test {
    VaultGateway public gateway;
    YieldVault public vault;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;

    address admin = makeAddr("admin");
    address strategy = makeAddr("strategy");
    address feeRecipient = makeAddr("feeRecipient");
    address user1 = makeAddr("user1");

    uint256 constant INITIAL_BALANCE = 100_000e18;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));

        MockPriceFeedForGateway priceFeed = new MockPriceFeedForGateway();
        uint256[3] memory depeg = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvl = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory share = [uint256(300), uint256(700), uint256(1500)];
        breaker = new CircuitBreaker(admin, admin, admin, address(priceFeed), depeg, tvl, share);

        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            strategy,
            address(aavePool),
            address(breaker),
            feeRecipient,
            1000
        );

        gateway = new VaultGateway();

        usdc.mint(user1, INITIAL_BALANCE);
        vm.startPrank(user1);
        usdc.approve(address(gateway), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // ─── Deposit ──────────────────────────────────────────────────

    function test_depositWithNoMinimum() public {
        vm.prank(user1);
        uint256 shares = gateway.deposit(address(vault), 1000e18, user1, 0);

        assertEq(shares, 1000e18);
        assertEq(vault.balanceOf(user1), 1000e18);
    }

    function test_depositWithExactMinimum() public {
        uint256 expected = vault.previewDeposit(1000e18);

        vm.prank(user1);
        uint256 shares = gateway.deposit(address(vault), 1000e18, user1, expected);

        assertEq(shares, expected);
    }

    function test_depositRevertsOnSlippage() public {
        uint256 expected = vault.previewDeposit(1000e18);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(VaultGateway.SlippageExceeded.selector, expected, expected + 1));
        gateway.deposit(address(vault), 1000e18, user1, expected + 1);
    }

    function test_depositRevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(VaultGateway.ZeroAmount.selector);
        gateway.deposit(address(vault), 0, user1, 0);
    }

    function test_depositSendsToCorrectReceiver() public {
        address receiver = makeAddr("receiver");

        vm.prank(user1);
        gateway.deposit(address(vault), 1000e18, receiver, 0);

        assertEq(vault.balanceOf(receiver), 1000e18);
        assertEq(vault.balanceOf(user1), 0);
    }

    // ─── Redeem ───────────────────────────────────────────────────

    function test_redeemWithNoMinimum() public {
        // First deposit directly to get shares
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        // Approve gateway for shares
        vm.prank(user1);
        IERC20(address(vault)).approve(address(gateway), type(uint256).max);

        vm.prank(user1);
        uint256 assets = gateway.redeem(address(vault), 500e18, user1, 0);

        assertEq(assets, 500e18);
        assertEq(vault.balanceOf(user1), 500e18);
    }

    function test_redeemWithExactMinimum() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(user1);
        IERC20(address(vault)).approve(address(gateway), type(uint256).max);

        uint256 expected = vault.previewRedeem(500e18);

        vm.prank(user1);
        uint256 assets = gateway.redeem(address(vault), 500e18, user1, expected);

        assertEq(assets, expected);
    }

    function test_redeemRevertsOnSlippage() public {
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        vm.prank(user1);
        IERC20(address(vault)).approve(address(gateway), type(uint256).max);

        uint256 expected = vault.previewRedeem(500e18);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(VaultGateway.SlippageExceeded.selector, expected, expected + 1));
        gateway.redeem(address(vault), 500e18, user1, expected + 1);
    }

    function test_redeemRevertsOnZeroShares() public {
        vm.prank(user1);
        vm.expectRevert(VaultGateway.ZeroAmount.selector);
        gateway.redeem(address(vault), 0, user1, 0);
    }

    // ─── Preview Helpers ──────────────────────────────────────────

    function test_previewDepositWithSlippage() public {
        (uint256 expected, uint256 min) = gateway.previewDepositWithSlippage(address(vault), 1000e18, 50);

        assertEq(expected, 1000e18);
        // 0.5% slippage: 1000 * 9950 / 10000 = 995
        assertEq(min, 995e18);
    }

    function test_previewRedeemWithSlippage() public {
        // Need deposits first so preview works with non-zero supply
        vm.prank(user1);
        vault.deposit(1000e18, user1);

        (uint256 expected, uint256 min) = gateway.previewRedeemWithSlippage(address(vault), 500e18, 100);

        assertEq(expected, 500e18);
        // 1% slippage: 500 * 9900 / 10000 = 495
        assertEq(min, 495e18);
    }
}
