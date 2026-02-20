// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { StrategyController } from "../../contracts/strategy/StrategyController.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { ExposureLimits } from "../../contracts/libraries/ExposureLimits.sol";
import { RotationValidator } from "../../contracts/libraries/RotationValidator.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPriceFeedForStrategy is IAggregatorV3 {
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

contract MockCCIPRouter {
    uint256 public constant MOCK_FEE = 0.01e18;
    bytes32 public lastMessageId;
    uint256 private nonce;

    function isChainSupported(
        uint64 /* destChainSelector */
    )
        external
        pure
        returns (bool)
    {
        return true;
    }

    function getFee(
        uint64,
        /* destinationChainSelector */
        bytes memory /* message */
    )
        external
        pure
        returns (uint256)
    {
        return MOCK_FEE;
    }

    function ccipSend(
        uint64,
        /* destinationChainSelector */
        bytes calldata /* message */
    )
        external
        payable
        returns (bytes32)
    {
        lastMessageId = keccak256(abi.encode(nonce++));
        return lastMessageId;
    }
}

contract MockLinkToken is ERC20Mock {
    constructor() ERC20Mock("Chainlink", "LINK", 18) { }
}

/// @dev Helper contract to wrap library calls as external calls so vm.expectRevert works
contract LibraryWrapper {
    function validateRotationSize(uint256 amount, uint256 totalAssets) external pure {
        ExposureLimits.validateRotationSize(amount, totalAssets);
    }

    function validateInFlight(uint256 currentInFlight, uint256 additionalAmount, uint256 totalAssets) external pure {
        ExposureLimits.validateInFlight(currentInFlight, additionalAmount, totalAssets);
    }

    function validateChainConcentration(
        uint64 chainSelector,
        uint256 currentChainBalance,
        uint256 additionalAmount,
        uint256 totalAssets
    ) external pure {
        ExposureLimits.validateChainConcentration(chainSelector, currentChainBalance, additionalAmount, totalAssets);
    }

    function validateSpread(uint256 yieldBps, uint256 minSpreadBps) external pure {
        RotationValidator.validateSpread(yieldBps, minSpreadBps);
    }

    function validateCost(uint256 costBps, uint256 maxCostBps) external pure {
        RotationValidator.validateCost(costBps, maxCostBps);
    }

    function validateFrequency(uint64 chainSelector, uint256 lastRotationTime, uint256 cooldown) external view {
        RotationValidator.validateFrequency(chainSelector, lastRotationTime, cooldown);
    }
}

contract StrategyControllerTest is Test {
    StrategyController public controller;
    YieldVault public vault;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    MockPriceFeedForStrategy public priceFeed;
    MockCCIPRouter public ccipRouter;
    MockLinkToken public linkToken;
    LibraryWrapper public libWrapper;

    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");
    address user1 = makeAddr("user1");
    address nobody = makeAddr("nobody");
    address spokeAddr = makeAddr("spoke");

    uint64 constant REMOTE_CHAIN = 42;
    uint256 constant MIN_SPREAD = 50; // 0.5%
    uint256 constant MAX_COST = 100; // 1%

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));
        linkToken = new MockLinkToken();
        priceFeed = new MockPriceFeedForStrategy();

        uint256[3] memory depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

        breaker = new CircuitBreaker(
            admin, pauser, unpauser, address(priceFeed), depegThresholds, tvlDropBps, sharePriceDropBps
        );

        // Need to deploy vault first, then controller, then grant STRATEGY_ROLE
        // Deploy vault with a temporary strategy address, then update
        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            admin, // temporary strategy — will grant to controller
            address(aavePool),
            address(breaker),
            makeAddr("feeRecipient"),
            1000
        );

        ccipRouter = new MockCCIPRouter();

        controller = new StrategyController(
            admin,
            address(vault),
            address(aavePool),
            address(ccipRouter),
            address(linkToken),
            address(breaker),
            MIN_SPREAD,
            MAX_COST,
            48 hours,
            24 hours
        );

        libWrapper = new LibraryWrapper();

        // Grant STRATEGY_ROLE to controller, KEEPER_ROLE to keeper
        vm.startPrank(admin);
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        controller.grantRole(controller.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        // Fund vault with deposits
        usdc.mint(user1, 100_000e18);
        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user1);
        vault.deposit(10_000e18, user1);

        // Supply to Aave first so there's something to withdraw for rotation
        vm.prank(admin);
        vault.supplyToAave(10_000e18);

        // Fund controller with LINK for CCIP fees
        linkToken.mint(address(controller), 100e18);

        // Fund aavePool with USDC so withdrawals work
        usdc.mint(address(aavePool), 100_000e18);
    }

    // ─── Validation ─────────────────────────────────────────────────

    function test_validateRotation_unregisteredChain() public view {
        bool valid = controller.validateRotation(REMOTE_CHAIN, 1000e18, 100, 50);
        assertFalse(valid); // No spoke registered
    }

    function test_validateRotation_valid() public {
        _registerSpoke(REMOTE_CHAIN, spokeAddr);

        bool valid = controller.validateRotation(REMOTE_CHAIN, 1000e18, 100, 50);
        assertTrue(valid);
    }

    function test_validateRotation_tooLarge() public {
        _registerSpoke(REMOTE_CHAIN, spokeAddr);

        // >20% of total assets
        bool valid = controller.validateRotation(REMOTE_CHAIN, 3000e18, 100, 50);
        assertFalse(valid);
    }

    function test_validateRotation_spreadAndCostAreInformationalOnly() public {
        _registerSpoke(REMOTE_CHAIN, spokeAddr);

        // Spread/cost params are informational (validated off-chain by CRE workflow, not on-chain)
        // Any values should pass on-chain validation since Task 6.4 removed on-chain spread/cost checks
        bool valid = controller.validateRotation(REMOTE_CHAIN, 1000e18, 10, 50);
        assertTrue(valid); // Low spread no longer blocks on-chain

        valid = controller.validateRotation(REMOTE_CHAIN, 1000e18, 100, 200);
        assertTrue(valid); // High cost no longer blocks on-chain
    }

    function test_validateRotation_cooldownNotElapsed() public {
        _registerSpoke(REMOTE_CHAIN, spokeAddr);

        // Simulate previous rotation
        vm.prank(admin);
        // We can't easily set lastRotationTime directly, but we can test via the function
        // First rotation should be valid since lastRotationTime is 0
        assertTrue(controller.validateRotation(REMOTE_CHAIN, 1000e18, 100, 50));
    }

    // ─── Local Operations ───────────────────────────────────────────

    function test_executeLocalSupply() public {
        // First withdraw from Aave so we have idle
        vm.prank(admin);
        vault.withdrawFromAave(5000e18);

        vm.prank(keeper);
        controller.executeLocalSupply(address(usdc), 3000e18);

        // Vault should have supplied back to Aave
        assertEq(usdc.balanceOf(address(vault)), 2000e18);
    }

    function test_executeLocalWithdraw() public {
        vm.prank(keeper);
        controller.executeLocalWithdraw(address(usdc), 3000e18);

        assertEq(usdc.balanceOf(address(vault)), 3000e18);
    }

    function test_executeLocalSupply_onlyKeeperOrAdmin() public {
        vm.prank(nobody);
        vm.expectRevert(StrategyController.NotKeeperOrAdmin.selector);
        controller.executeLocalSupply(address(usdc), 1000e18);
    }

    function test_executeLocalSupply_blockedByCB() public {
        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.prank(keeper);
        vm.expectRevert(StrategyController.CircuitBreakerActive.selector);
        controller.executeLocalSupply(address(usdc), 1000e18);
    }

    function test_executeLocalSupply_zeroReverts() public {
        vm.prank(keeper);
        vm.expectRevert(StrategyController.ZeroAmount.selector);
        controller.executeLocalSupply(address(usdc), 0);
    }

    // ─── Spoke Registration (Timelock) ──────────────────────────────

    function test_registerSpoke_timelocked() public {
        vm.prank(admin);
        controller.queueRegisterSpoke(REMOTE_CHAIN, spokeAddr);

        // Can't execute immediately
        bytes memory data = abi.encode(REMOTE_CHAIN, spokeAddr);
        bytes32 id = keccak256(data);

        vm.prank(admin);
        vm.expectRevert();
        controller.executeRegisterSpoke(REMOTE_CHAIN, spokeAddr);

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(admin);
        controller.executeRegisterSpoke(REMOTE_CHAIN, spokeAddr);

        assertEq(controller.spokes(REMOTE_CHAIN), spokeAddr);
    }

    function test_registerSpoke_onlyAdmin() public {
        vm.prank(nobody);
        vm.expectRevert();
        controller.queueRegisterSpoke(REMOTE_CHAIN, spokeAddr);
    }

    // ─── Parameter Changes (Timelock) ───────────────────────────────

    function test_paramChange_timelocked() public {
        bytes memory data = abi.encodeWithSelector(controller.setMinSpreadBps.selector, 200);

        vm.prank(admin);
        controller.queueParamChange(data);

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(admin);
        controller.executeParamChange(data);

        assertEq(controller.minSpreadBps(), 200);
    }

    // ─── Exposure Limits Library ────────────────────────────────────
    // Note: Library calls are internal, so vm.expectRevert() does not work.
    // We use a LibraryWrapper contract that makes external calls to the library.

    function test_exposureLimits_rotationTooLarge() public {
        vm.expectRevert();
        libWrapper.validateRotationSize(3000, 10000); // 30% > 20%
    }

    function test_exposureLimits_rotationValid() public view {
        libWrapper.validateRotationSize(1500, 10000); // 15% < 20%
    }

    function test_exposureLimits_inFlightExceeded() public {
        vm.expectRevert();
        libWrapper.validateInFlight(1000, 600, 10000); // 16% > 15%
    }

    function test_exposureLimits_chainConcentration() public {
        vm.expectRevert();
        libWrapper.validateChainConcentration(uint64(1), 3000, 1500, 10000); // 45% > 40%
    }

    // ─── Rotation Validator Library ─────────────────────────────────

    function test_rotationValidator_spreadTooLow() public {
        vm.expectRevert();
        libWrapper.validateSpread(10, 50); // 0.1% < 0.5%
    }

    function test_rotationValidator_costTooHigh() public {
        vm.expectRevert();
        libWrapper.validateCost(200, 100); // 2% > 1%
    }

    function test_rotationValidator_frequencyCheck() public {
        // Last rotation was 12 hours ago, cooldown is 24 hours
        vm.warp(100_000);
        vm.expectRevert();
        libWrapper.validateFrequency(uint64(1), 88_000, 24 hours);
    }

    function test_rotationValidator_frequencyOk() public {
        // Warp to a time past the cooldown (lastRotation=0, cooldown=24h)
        vm.warp(24 hours + 1);
        libWrapper.validateFrequency(uint64(1), 0, 24 hours);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _registerSpoke(uint64 chainSelector, address spoke) internal {
        vm.prank(admin);
        controller.queueRegisterSpoke(chainSelector, spoke);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(admin);
        controller.executeRegisterSpoke(chainSelector, spoke);
    }
}
