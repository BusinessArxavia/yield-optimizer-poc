// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal interface for Chainlink Automation Registrar v2.3
interface IAutomationRegistrar2_3 {
    struct RegistrationParams {
        address upkeepContract;
        uint96 amount;
        address adminAddress;
        uint32 gasLimit;
        uint8 triggerType;
        address billingToken;
        string name;
        bytes encryptedEmail;
        bytes checkData;
        bytes triggerConfig;
        bytes offchainConfig;
    }

    function registerUpkeep(RegistrationParams memory requestParams) external payable returns (uint256);
}

/// @title RegisterChainlinkUpkeep — Register YieldKeeper as Chainlink Automation upkeep on Base Sepolia
contract RegisterChainlinkUpkeep is Script {
    // ─── Base Sepolia Chainlink Automation ──────────────────────────
    address constant LINK_TOKEN = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;
    address constant REGISTRAR = 0xf28D56F3A707E25B71Ce529a21AF388751E1CF2A;

    // ─── Our Contract ──────────────────────────────────────────────
    address constant YIELD_KEEPER = 0xeE96c685cbe0CBf43da08e4F510B5c569E87a24a;

    // ─── Config ────────────────────────────────────────────────────
    uint32 constant GAS_LIMIT = 500_000;
    uint96 constant LINK_FUNDING = 5 ether; // 5 LINK

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // 1. Approve LINK to registrar
        IERC20(LINK_TOKEN).approve(REGISTRAR, LINK_FUNDING);

        // 2. Register the upkeep (v2.3 struct with billingToken)
        IAutomationRegistrar2_3 registrar = IAutomationRegistrar2_3(REGISTRAR);
        uint256 upkeepId = registrar.registerUpkeep(
            IAutomationRegistrar2_3.RegistrationParams({
                upkeepContract: YIELD_KEEPER,
                amount: LINK_FUNDING,
                adminAddress: deployer,
                gasLimit: GAS_LIMIT,
                triggerType: 0, // Conditional (custom logic checkUpkeep/performUpkeep)
                billingToken: LINK_TOKEN,
                name: "YieldKeeper - Aave Yield Optimizer",
                encryptedEmail: bytes(""),
                checkData: bytes(""),
                triggerConfig: bytes(""),
                offchainConfig: bytes("")
            })
        );

        vm.stopBroadcast();

        console2.log("=== Chainlink Automation Upkeep Registered ===");
        console2.log("Upkeep ID:", upkeepId);
        console2.log("YieldKeeper:", YIELD_KEEPER);
        console2.log("Gas Limit:", GAS_LIMIT);
        console2.log("LINK Funded:", LINK_FUNDING / 1e18, "LINK");
        console2.log("Admin:", deployer);
        console2.log("");
        console2.log("View at: https://automation.chain.link/base-sepolia/", upkeepId);
    }
}
