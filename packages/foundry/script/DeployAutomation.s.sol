// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldKeeper } from "../contracts/automation/YieldKeeper.sol";
import { DeadManSwitch } from "../contracts/automation/DeadManSwitch.sol";

/// @title DeployAutomation — Deploy YieldKeeper and DeadManSwitch
/// @notice Requires existing YieldVault, StrategyController, and CircuitBreaker
contract DeployAutomation is Script {
    function run(address vault, address strategyController, address circuitBreaker, address guardian) external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // Deploy YieldKeeper with sensible defaults
        YieldKeeper keeper = new YieldKeeper(
            vault,
            strategyController,
            circuitBreaker,
            deployer,
            100e6, // minIdleSupplyAmount: 100 USDC (6 decimals)
            500, // idleTargetBps: 5%
            50, // harvestMinYieldBps: 0.5%
            1 hours // harvestCooldown
        );

        // Deploy DeadManSwitch with 24h timeout
        DeadManSwitch dms = new DeadManSwitch(strategyController, deployer, guardian, 24 hours);

        vm.stopBroadcast();

        console2.log("=== Automation Deployment ===");
        console2.log("YieldKeeper:", address(keeper));
        console2.log("DeadManSwitch:", address(dms));
        console2.log("Deployer:", deployer);
        console2.log("Guardian:", guardian);
        console2.log("");
        console2.log("Next steps:");
        console2.log("1. Grant KEEPER_ROLE on StrategyController to YieldKeeper");
        console2.log("2. Grant KEEPER_ROLE on StrategyController to DeadManSwitch");
        console2.log("3. Register YieldKeeper as Chainlink Automation upkeep");
    }
}
