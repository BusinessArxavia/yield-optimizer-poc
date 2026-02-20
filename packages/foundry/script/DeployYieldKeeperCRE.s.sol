// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldKeeperCRE } from "../contracts/automation/YieldKeeperCRE.sol";

/// @title DeployYieldKeeperCRE — Deploy the CRE consumer contract
/// @notice Deploys YieldKeeperCRE to Base Sepolia with the KeystoneForwarder
contract DeployYieldKeeperCRE is Script {
    // ─── Base Sepolia Addresses (v8 deployment) ─────────────────────
    address constant VAULT = 0x601F653c1F8940246fECEbCb9dEF8E6322c35570;
    address constant STRATEGY_CONTROLLER = 0x93e37393D12FB6874190b7E38D7AdE096ceBEF90;
    address constant CIRCUIT_BREAKER = 0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f;

    // CRE KeystoneForwarder on Base Sepolia (production)
    address constant KEYSTONE_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    // Keeper config params (testnet values)
    uint256 constant MIN_IDLE_SUPPLY = 100e6; // 100 USDC (6 decimals)
    uint256 constant IDLE_TARGET_BPS = 500; // 5%
    uint256 constant HARVEST_MIN_YIELD_BPS = 50; // 0.5%
    uint256 constant HARVEST_COOLDOWN = 1 hours; // testnet: short cooldown

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        console2.log("Deploying YieldKeeperCRE...");
        console2.log("Deployer:", deployer);
        console2.log("KeystoneForwarder:", KEYSTONE_FORWARDER);

        YieldKeeperCRE keeper = new YieldKeeperCRE(
            VAULT,
            STRATEGY_CONTROLLER,
            CIRCUIT_BREAKER,
            deployer, // admin
            KEYSTONE_FORWARDER,
            MIN_IDLE_SUPPLY,
            IDLE_TARGET_BPS,
            HARVEST_MIN_YIELD_BPS,
            HARVEST_COOLDOWN
        );

        console2.log("YieldKeeperCRE deployed at:", address(keeper));
        console2.log("");
        console2.log("Next steps:");
        console2.log("1. Grant KEEPER_ROLE on StrategyController to this address");
        console2.log("2. Deploy CRE workflow and note the workflow ID");
        console2.log("3. Call setExpectedWorkflowId() and setExpectedWorkflowOwner()");

        vm.stopBroadcast();
    }
}
