// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20Mock } from "../mocks/ERC20Mock.sol";
import { MockAavePool } from "../mocks/MockAavePool.sol";
import { MockAToken } from "../mocks/MockAToken.sol";
import { SpokeVault } from "../../contracts/spoke/SpokeVault.sol";
import { Client } from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal mock router that matches IRouterClient interface signatures
contract MockCCIPRouterForSpoke {
    uint256 public constant MOCK_FEE = 0.01e18;
    uint256 private nonce;

    function getFee(
        uint64,
        /* destinationChainSelector */
        Client.EVM2AnyMessage memory /* message */
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
        Client.EVM2AnyMessage calldata /* message */
    )
        external
        payable
        returns (bytes32)
    {
        return keccak256(abi.encode(nonce++));
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }
}

contract SpokeVaultTest is Test {
    SpokeVault public spoke;
    ERC20Mock public usdc;
    MockAavePool public aavePool;
    MockAToken public aToken;
    MockCCIPRouterForSpoke public ccipRouter;
    ERC20Mock public linkToken;

    address admin = makeAddr("admin");
    address homeStrategy = makeAddr("homeStrategy");
    uint64 constant HOME_CHAIN = 1;
    uint64 constant OTHER_CHAIN = 99;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 18);
        aToken = new MockAToken(address(usdc));
        aavePool = new MockAavePool(address(aToken));
        ccipRouter = new MockCCIPRouterForSpoke();
        linkToken = new ERC20Mock("Chainlink", "LINK", 18);

        spoke = new SpokeVault(
            address(ccipRouter), address(aavePool), admin, HOME_CHAIN, homeStrategy, address(linkToken), address(usdc)
        );

        // Fund spoke with LINK for CCIP fees
        linkToken.mint(address(spoke), 100e18);
        // Fund aavePool with USDC so withdrawals work
        usdc.mint(address(aavePool), 100_000e18);
    }

    // ─── ccipReceive: SUPPLY ────────────────────────────────────────

    function test_ccipReceive_supply() public {
        uint256 amount = 1000e18;

        // Simulate CCIP delivering tokens + message
        usdc.mint(address(spoke), amount);

        SpokeVault.SpokeMessage memory spokeMsg = SpokeVault.SpokeMessage({
            instruction: SpokeVault.SpokeInstruction.SUPPLY, token: address(usdc), amount: amount
        });

        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("test"),
            sourceChainSelector: HOME_CHAIN,
            sender: abi.encode(homeStrategy),
            data: abi.encode(spokeMsg),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        // Call ccipReceive via router
        vm.prank(address(ccipRouter));
        spoke.ccipReceive(ccipMessage);

        // Spoke should have supplied to Aave
        assertEq(aToken.balanceOf(address(spoke)), amount);
        assertEq(usdc.balanceOf(address(spoke)), 0);
    }

    // ─── ccipReceive: WITHDRAW_AND_RETURN ───────────────────────────

    function test_ccipReceive_withdrawAndReturn() public {
        // First supply some
        usdc.mint(address(spoke), 1000e18);
        _simulateSupply(1000e18);

        // Now request withdrawal
        SpokeVault.SpokeMessage memory spokeMsg = SpokeVault.SpokeMessage({
            instruction: SpokeVault.SpokeInstruction.WITHDRAW_AND_RETURN, token: address(usdc), amount: 500e18
        });

        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("test2"),
            sourceChainSelector: HOME_CHAIN,
            sender: abi.encode(homeStrategy),
            data: abi.encode(spokeMsg),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        vm.prank(address(ccipRouter));
        spoke.ccipReceive(ccipMessage);

        // Should have withdrawn 500 from Aave (500 remaining)
        assertEq(aToken.balanceOf(address(spoke)), 500e18);
    }

    // ─── ccipReceive: REPORT_BALANCE ────────────────────────────────

    function test_ccipReceive_reportBalance() public {
        // Supply first
        usdc.mint(address(spoke), 1000e18);
        _simulateSupply(1000e18);

        SpokeVault.SpokeMessage memory spokeMsg = SpokeVault.SpokeMessage({
            instruction: SpokeVault.SpokeInstruction.REPORT_BALANCE, token: address(usdc), amount: 0
        });

        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("test3"),
            sourceChainSelector: HOME_CHAIN,
            sender: abi.encode(homeStrategy),
            data: abi.encode(spokeMsg),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        // Should not revert — just sends balance report
        vm.prank(address(ccipRouter));
        spoke.ccipReceive(ccipMessage);
    }

    // ─── Sender Validation ──────────────────────────────────────────

    function test_ccipReceive_rejectsWrongSourceChain() public {
        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("test4"),
            sourceChainSelector: OTHER_CHAIN,
            sender: abi.encode(homeStrategy),
            data: "",
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        vm.prank(address(ccipRouter));
        vm.expectRevert(abi.encodeWithSelector(SpokeVault.InvalidSourceChain.selector, OTHER_CHAIN));
        spoke.ccipReceive(ccipMessage);
    }

    function test_ccipReceive_rejectsWrongSender() public {
        address wrongSender = makeAddr("wrongSender");

        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("test5"),
            sourceChainSelector: HOME_CHAIN,
            sender: abi.encode(wrongSender),
            data: "",
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        vm.prank(address(ccipRouter));
        vm.expectRevert(abi.encodeWithSelector(SpokeVault.InvalidSender.selector, wrongSender));
        spoke.ccipReceive(ccipMessage);
    }

    function test_ccipReceive_onlyRouter() public {
        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("test6"),
            sourceChainSelector: HOME_CHAIN,
            sender: abi.encode(homeStrategy),
            data: "",
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        vm.prank(makeAddr("notRouter"));
        vm.expectRevert();
        spoke.ccipReceive(ccipMessage);
    }

    // ─── Manual reportBalance ───────────────────────────────────────

    function test_manualReportBalance() public {
        usdc.mint(address(spoke), 500e18);
        _simulateSupply(500e18);

        vm.prank(admin);
        spoke.reportBalance(); // Should not revert
    }

    function test_manualReportBalance_onlyAdmin() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert();
        spoke.reportBalance();
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _simulateSupply(uint256 amount) internal {
        SpokeVault.SpokeMessage memory spokeMsg = SpokeVault.SpokeMessage({
            instruction: SpokeVault.SpokeInstruction.SUPPLY, token: address(usdc), amount: amount
        });

        Client.Any2EVMMessage memory ccipMessage = Client.Any2EVMMessage({
            messageId: keccak256("supply"),
            sourceChainSelector: HOME_CHAIN,
            sender: abi.encode(homeStrategy),
            data: abi.encode(spokeMsg),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });

        vm.prank(address(ccipRouter));
        spoke.ccipReceive(ccipMessage);
    }
}
