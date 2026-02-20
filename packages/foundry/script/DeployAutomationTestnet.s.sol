// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldKeeper } from "../contracts/automation/YieldKeeper.sol";
import { DeadManSwitch } from "../contracts/automation/DeadManSwitch.sol";

/// @title DeployAutomationTestnet — Deploy YieldKeeper + DeadManSwitch on Base Sepolia
/// @notice Uses existing v3 contract addresses
contract DeployAutomationTestnet is Script {
    // ─── Base Sepolia v3 Deployed Contracts ───────────────────────
    address constant YIELD_VAULT = 0x8b0Ef7fe34aD0f4c6CCE1C3B551fC9E89e16d04E;
    address constant STRATEGY_CONTROLLER = 0x8bddBAA5dF61EEF34c3719A7BcB4Cfc9C4Fa5Cee;
    address constant CIRCUIT_BREAKER = 0x378C389Cf24346A023209560638f7E90dde30F11;

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // Deploy YieldKeeper
        YieldKeeper keeper = new YieldKeeper(
            YIELD_VAULT,
            STRATEGY_CONTROLLER,
            CIRCUIT_BREAKER,
            deployer,
            100e6, // minIdleSupplyAmount: 100 USDC (6 decimals on testnet faucet = 18 dec actually)
            500, // idleTargetBps: 5%
            50, // harvestMinYieldBps: 0.5%
            10 minutes // harvestCooldown: short for testnet
        );

        // Deploy DeadManSwitch (deployer = admin + guardian for testnet)
        DeadManSwitch dms = new DeadManSwitch(
            STRATEGY_CONTROLLER,
            deployer, // admin
            deployer, // guardian (deployer for testnet)
            1 hours // short timeout for testnet
        );

        vm.stopBroadcast();

        console2.log("=== Automation Testnet Deployment ===");
        console2.log("YieldKeeper:", address(keeper));
        console2.log("DeadManSwitch:", address(dms));
        console2.log("Deployer:", deployer);
        console2.log("");
        console2.log("Next: grant KEEPER_ROLE on StrategyController to both contracts");
    }
}
