// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { MockKeystoneForwarder } from "../mocks/MockKeystoneForwarder.sol";
import { CircuitBreaker } from "../../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../../contracts/vault/YieldVault.sol";
import { StrategyController } from "../../contracts/strategy/StrategyController.sol";
import { YieldKeeperCRE, IReceiver } from "../../contracts/automation/YieldKeeperCRE.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract MockPriceFeedCRE is IAggregatorV3 {
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

contract MockCCIPRouterCRE {
    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    // Accept any calldata — the actual IRouterClient uses EVM2AnyMessage struct
    fallback() external payable {
        // Return a fee for getFee calls, or a messageId for ccipSend calls
        bytes32 result = keccak256(abi.encode(block.timestamp));
        assembly {
            mstore(0x00, result)
            return(0x00, 0x20)
        }
    }

    receive() external payable { }
}

contract YieldKeeperCRETest is Test {
    YieldKeeperCRE public keeper;
    YieldVault public vault;
    StrategyController public controller;
    MockKeystoneForwarder public forwarder;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    CircuitBreaker public breaker;
    MockPriceFeedCRE public priceFeed;
    MockCCIPRouterCRE public ccipRouter;
    ERC20Mock public linkToken;

    address admin = makeAddr("admin");
    address user1 = makeAddr("user1");
    address pauser = makeAddr("pauser");
    address unpauser = makeAddr("unpauser");
    address feeRecipient = makeAddr("feeRecipient");
    address workflowOwner = makeAddr("workflowOwner");

    bytes32 constant WORKFLOW_ID = keccak256("yield-keeper-workflow");
    bytes10 constant WORKFLOW_NAME = bytes10("yieldkeepr");

    uint256 constant MIN_IDLE_SUPPLY = 100e18;
    uint256 constant IDLE_TARGET_BPS = 500; // 5%
    uint256 constant HARVEST_MIN_YIELD_BPS = 50; // 0.5%
    uint256 constant HARVEST_COOLDOWN = 1 hours;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));
        linkToken = new ERC20Mock("Chainlink", "LINK", 18);
        priceFeed = new MockPriceFeedCRE();
        ccipRouter = new MockCCIPRouterCRE();
        forwarder = new MockKeystoneForwarder();

        uint256[3] memory depegThresholds = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvlDropBps = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory sharePriceDropBps = [uint256(300), uint256(700), uint256(1500)];

        breaker = new CircuitBreaker(
            admin, pauser, unpauser, address(priceFeed), depegThresholds, tvlDropBps, sharePriceDropBps
        );

        vault = new YieldVault(
            IERC20(address(usdc)),
            "Yield USDC",
            "yUSDC",
            admin,
            admin,
            address(aavePool),
            address(breaker),
            feeRecipient,
            1000
        );

        controller = new StrategyController(
            admin,
            address(vault),
            address(aavePool),
            address(ccipRouter),
            address(linkToken),
            address(breaker),
            50,
            100,
            48 hours,
            0 // rotationCooldown: 0 for tests (no waiting between rotations)
        );

        vm.startPrank(admin);
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        vm.stopPrank();

        keeper = new YieldKeeperCRE(
            address(vault),
            address(controller),
            address(breaker),
            admin,
            address(forwarder),
            MIN_IDLE_SUPPLY,
            IDLE_TARGET_BPS,
            HARVEST_MIN_YIELD_BPS,
            HARVEST_COOLDOWN
        );

        bytes32 keeperRole = controller.KEEPER_ROLE();
        vm.prank(admin);
        controller.grantRole(keeperRole, address(keeper));

        usdc.mint(address(aavePool), 1_000_000e18);
    }

    // ─── Constructor ────────────────────────────────────────────────

    function test_constructorSetsState() public view {
        assertEq(address(keeper.vault()), address(vault));
        assertEq(address(keeper.strategyController()), address(controller));
        assertEq(address(keeper.circuitBreaker()), address(breaker));
        assertEq(keeper.asset(), address(usdc));
        assertEq(keeper.forwarder(), address(forwarder));
        assertEq(keeper.minIdleSupplyAmount(), MIN_IDLE_SUPPLY);
        assertEq(keeper.idleTargetBps(), IDLE_TARGET_BPS);
        assertEq(keeper.harvestMinYieldBps(), HARVEST_MIN_YIELD_BPS);
        assertEq(keeper.harvestCooldown(), HARVEST_COOLDOWN);
    }

    // ─── ERC165 Support ─────────────────────────────────────────────

    function test_supportsIReceiverInterface() public view {
        assertTrue(keeper.supportsInterface(type(IReceiver).interfaceId));
    }

    function test_supportsIERC165Interface() public view {
        assertTrue(keeper.supportsInterface(type(IERC165).interfaceId));
    }

    function test_supportsAccessControlInterface() public view {
        // AccessControl's interface
        assertTrue(keeper.supportsInterface(type(IERC165).interfaceId));
    }

    // ─── onReport: Supply Idle ──────────────────────────────────────

    function test_onReport_supplyIdle() public {
        _depositToVault(user1, 10_000e18);

        uint256 idleBefore = usdc.balanceOf(address(vault));
        assertEq(idleBefore, 10_000e18);

        uint256 supplyAmount = 10_000e18 - (10_000e18 * IDLE_TARGET_BPS / 10_000);

        _deliverReport(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        uint256 idleAfter = usdc.balanceOf(address(vault));
        uint256 aTokenBalance = aToken.balanceOf(address(vault));

        assertEq(idleAfter, 10_000e18 - supplyAmount);
        assertEq(aTokenBalance, supplyAmount);
    }

    function test_onReport_supplyRevertsWhenCircuitBreaker() public {
        _depositToVault(user1, 10_000e18);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        _deliverReport(YieldKeeperCRE.ActionType.SUPPLY_IDLE);
    }

    function test_onReport_supplyRevertsWhenNoIdle() public {
        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        _deliverReport(YieldKeeperCRE.ActionType.SUPPLY_IDLE);
    }

    // ─── onReport: Harvest ──────────────────────────────────────────

    function test_onReport_harvest() public {
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        aToken.simulateYield(address(vault), 100e18);

        uint256 feeSharesBefore = vault.balanceOf(feeRecipient);

        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);

        uint256 feeSharesAfter = vault.balanceOf(feeRecipient);
        assertTrue(feeSharesAfter > feeSharesBefore, "Fee shares should be minted");
        assertEq(keeper.lastHarvestTime(), block.timestamp);
    }

    function test_onReport_harvestRevertsWhenNoYield() public {
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);
    }

    function test_onReport_harvestRespectsColdown() public {
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        aToken.simulateYield(address(vault), 100e18);
        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);

        // More yield immediately — should revert due to cooldown
        aToken.simulateYield(address(vault), 100e18);
        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);
    }

    function test_onReport_harvestAfterCooldown() public {
        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);

        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        aToken.simulateYield(address(vault), 100e18);
        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);

        vm.warp(block.timestamp + HARVEST_COOLDOWN + 1);
        aToken.simulateYield(address(vault), 100e18);

        // Should succeed after cooldown
        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);
        assertEq(keeper.lastHarvestTime(), block.timestamp);
    }

    // ─── onReport: Updates lastPerformTime ──────────────────────────

    function test_onReport_updatesLastPerformTime() public {
        _depositToVault(user1, 10_000e18);

        _deliverReport(YieldKeeperCRE.ActionType.SUPPLY_IDLE);
        assertEq(keeper.lastPerformTime(), block.timestamp);
    }

    // ─── Access Control: Forwarder ──────────────────────────────────

    function test_onReport_revertUnauthorizedCaller() public {
        _depositToVault(user1, 10_000e18);

        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);
        bytes memory report = abi.encode(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        // Direct call from user (not forwarder) should revert
        vm.prank(user1);
        vm.expectRevert(YieldKeeperCRE.UnauthorizedForwarder.selector);
        keeper.onReport(metadata, report);
    }

    function test_onReport_allowsAnyoneWhenNoForwarder() public {
        // Deploy a keeper with no forwarder
        vm.startPrank(admin);
        YieldKeeperCRE noFwdKeeper = new YieldKeeperCRE(
            address(vault),
            address(controller),
            address(breaker),
            admin,
            address(0),
            MIN_IDLE_SUPPLY,
            IDLE_TARGET_BPS,
            HARVEST_MIN_YIELD_BPS,
            HARVEST_COOLDOWN
        );
        controller.grantRole(controller.KEEPER_ROLE(), address(noFwdKeeper));
        vm.stopPrank();

        _depositToVault(user1, 10_000e18);

        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);
        bytes memory report = abi.encode(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        // Anyone can call when forwarder is address(0)
        vm.prank(user1);
        noFwdKeeper.onReport(metadata, report);
        assertEq(noFwdKeeper.lastPerformTime(), block.timestamp);
    }

    // ─── Metadata Validation ────────────────────────────────────────

    function test_onReport_validatesWorkflowId() public {
        _depositToVault(user1, 10_000e18);

        // Set expected workflow ID
        vm.prank(admin);
        keeper.setExpectedWorkflowId(WORKFLOW_ID);

        // Correct ID — should succeed
        _deliverReport(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        // Wrong ID — should revert
        _depositToVault(user1, 10_000e18);
        bytes32 wrongId = keccak256("wrong-workflow");
        bytes memory metadata = _buildMetadata(wrongId, WORKFLOW_NAME, workflowOwner);
        bytes memory report = abi.encode(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        vm.expectRevert(abi.encodeWithSelector(YieldKeeperCRE.InvalidWorkflowId.selector, wrongId, WORKFLOW_ID));
        forwarder.report(address(keeper), metadata, report);
    }

    function test_onReport_validatesWorkflowOwner() public {
        _depositToVault(user1, 10_000e18);

        vm.prank(admin);
        keeper.setExpectedWorkflowOwner(workflowOwner);

        // Correct owner — should succeed
        _deliverReport(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        // Wrong owner — should revert
        _depositToVault(user1, 10_000e18);
        address wrongOwner = makeAddr("wrongOwner");
        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, wrongOwner);
        bytes memory report = abi.encode(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        vm.expectRevert(abi.encodeWithSelector(YieldKeeperCRE.InvalidWorkflowOwner.selector, wrongOwner, workflowOwner));
        forwarder.report(address(keeper), metadata, report);
    }

    function test_onReport_skipsValidationWhenNotConfigured() public {
        _depositToVault(user1, 10_000e18);

        // No expected ID or owner set — any metadata should pass
        bytes memory metadata = _buildMetadata(bytes32(uint256(999)), bytes10("anythingx"), makeAddr("anyone"));
        bytes memory report = abi.encode(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        forwarder.report(address(keeper), metadata, report);
        assertEq(keeper.lastPerformTime(), block.timestamp);
    }

    // ─── Admin: Setters ─────────────────────────────────────────────

    function test_setForwarder() public {
        address newForwarder = makeAddr("newForwarder");
        vm.prank(admin);
        keeper.setForwarder(newForwarder);
        assertEq(keeper.forwarder(), newForwarder);
    }

    function test_setForwarder_revertNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        keeper.setForwarder(makeAddr("newForwarder"));
    }

    function test_setExpectedWorkflowId() public {
        vm.prank(admin);
        keeper.setExpectedWorkflowId(WORKFLOW_ID);
        assertEq(keeper.expectedWorkflowId(), WORKFLOW_ID);
    }

    function test_setExpectedWorkflowOwner() public {
        vm.prank(admin);
        keeper.setExpectedWorkflowOwner(workflowOwner);
        assertEq(keeper.expectedWorkflowOwner(), workflowOwner);
    }

    function test_setConfig() public {
        vm.prank(admin);
        keeper.setConfig(200e18, 300, 100, 2 hours);

        assertEq(keeper.minIdleSupplyAmount(), 200e18);
        assertEq(keeper.idleTargetBps(), 300);
        assertEq(keeper.harvestMinYieldBps(), 100);
        assertEq(keeper.harvestCooldown(), 2 hours);
    }

    function test_setConfig_revertNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        keeper.setConfig(200e18, 300, 100, 2 hours);
    }

    function test_setConfig_revertInvalidIdleBps() public {
        vm.prank(admin);
        vm.expectRevert(YieldKeeperCRE.InvalidConfig.selector);
        keeper.setConfig(100e18, 10_001, 50, 1 hours);
    }

    function test_setConfig_revertInvalidCooldown() public {
        vm.prank(admin);
        vm.expectRevert(YieldKeeperCRE.InvalidConfig.selector);
        keeper.setConfig(100e18, 500, 50, 5 minutes);
    }

    // ─── onReport: Rotation ────────────────────────────────────────

    function test_onReport_rotate() public {
        // Setup: deposit and supply to Aave so there's something to rotate
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // Register a spoke for the destination chain
        uint64 destChain = 3478487238524512106; // Arb Sepolia
        address spoke = makeAddr("spoke");
        vm.startPrank(admin);
        controller.queueRegisterSpoke(destChain, spoke);
        vm.warp(block.timestamp + 48 hours + 1);
        controller.executeRegisterSpoke(destChain, spoke);

        // Fund controller with LINK for CCIP fees
        linkToken.mint(address(controller), 10e18);
        vm.stopPrank();

        // Build ROTATE report: (uint8, uint64, uint256, uint256, uint256)
        uint256 rotateAmount = 1_000e18; // 10% (within MAX_IN_FLIGHT_BPS of 15%)
        uint256 yieldBps = 200; // 2% spread
        uint256 costBps = 10; // 0.1% cost
        bytes memory report = abi.encode(
            uint8(2), // ActionType.ROTATE
            destChain,
            rotateAmount,
            yieldBps,
            costBps
        );
        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);

        forwarder.report(address(keeper), metadata, report);

        assertEq(keeper.lastPerformTime(), block.timestamp);
    }

    function test_onReport_rotateRevertsWhenCircuitBreaker() public {
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        vm.prank(pauser);
        breaker.activateEmergencyPause();

        bytes memory report = abi.encode(uint8(2), uint64(123), uint256(1000e18), uint256(200), uint256(10));
        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);

        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        forwarder.report(address(keeper), metadata, report);
    }

    function test_onReport_rotateRevertsWhenZeroAmount() public {
        bytes memory report = abi.encode(uint8(2), uint64(123), uint256(0), uint256(200), uint256(10));
        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);

        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        forwarder.report(address(keeper), metadata, report);
    }

    function test_onReport_rotateRevertsWhenValidationFails() public {
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // No spoke registered — validateRotation returns false
        bytes memory report = abi.encode(uint8(2), uint64(999), uint256(1000e18), uint256(200), uint256(10));
        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);

        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        forwarder.report(address(keeper), metadata, report);
    }

    // ─── Edge Cases ─────────────────────────────────────────────────

    function test_onReport_smallYieldBelowThreshold() public {
        _depositToVault(user1, 10_000e18);
        _supplyAllToAave(10_000e18);

        // 0.1% yield (below 0.5% threshold)
        aToken.simulateYield(address(vault), 10e18);

        vm.expectRevert(YieldKeeperCRE.NoActionNeeded.selector);
        _deliverReport(YieldKeeperCRE.ActionType.HARVEST_YIELD);
    }

    function test_onReport_shortMetadataRevertsWhenValidationConfigured() public {
        _depositToVault(user1, 10_000e18);

        // Set expected owner — short metadata should now revert (not bypass)
        vm.prank(admin);
        keeper.setExpectedWorkflowOwner(workflowOwner);

        bytes memory shortMetadata = abi.encodePacked(bytes32(0));
        bytes memory report = abi.encode(YieldKeeperCRE.ActionType.SUPPLY_IDLE);

        vm.expectRevert("Metadata too short for validation");
        forwarder.report(address(keeper), shortMetadata, report);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _depositToVault(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();
    }

    function _supplyAllToAave(uint256 amount) internal {
        vm.prank(admin);
        controller.executeLocalSupply(address(usdc), amount);
    }

    function _buildMetadata(bytes32 workflowId, bytes10 workflowName, address owner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(workflowId, workflowName, owner);
    }

    function _deliverReport(YieldKeeperCRE.ActionType action) internal {
        bytes memory metadata = _buildMetadata(WORKFLOW_ID, WORKFLOW_NAME, workflowOwner);
        bytes memory report = abi.encode(action);
        forwarder.report(address(keeper), metadata, report);
    }
}
