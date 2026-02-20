// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldKeeper } from "../contracts/automation/YieldKeeper.sol";
import { DeadManSwitch } from "../contracts/automation/DeadManSwitch.sol";
import { StrategyController } from "../contracts/strategy/StrategyController.sol";

/// @title RedeployAutomation — Redeploy YieldKeeper + DeadManSwitch pointing to new StrategyController
contract RedeployAutomation is Script {
    // ─── Base Sepolia v4 Contracts ─────────────────────────────────
    address constant YIELD_VAULT = 0x8b0Ef7fe34aD0f4c6CCE1C3B551fC9E89e16d04E;
    address constant STRATEGY_CONTROLLER = 0x8bddBAA5dF61EEF34c3719A7BcB4Cfc9C4Fa5Cee;
    address constant CIRCUIT_BREAKER = 0x378C389Cf24346A023209560638f7E90dde30F11;

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // Deploy YieldKeeper pointing to new controller
        YieldKeeper keeper = new YieldKeeper(
            YIELD_VAULT,
            STRATEGY_CONTROLLER,
            CIRCUIT_BREAKER,
            deployer,
            100e6, // minIdleSupplyAmount
            500, // idleTargetBps: 5%
            50, // harvestMinYieldBps: 0.5%
            10 minutes // harvestCooldown
        );

        // Deploy DeadManSwitch pointing to new controller
        DeadManSwitch dms = new DeadManSwitch(STRATEGY_CONTROLLER, deployer, deployer, 1 hours);

        // Grant KEEPER_ROLE on new controller to both
        StrategyController controller = StrategyController(payable(STRATEGY_CONTROLLER));
        bytes32 keeperRole = controller.KEEPER_ROLE();
        controller.grantRole(keeperRole, address(keeper));
        controller.grantRole(keeperRole, address(dms));

        // Revoke KEEPER_ROLE from old automation contracts
        controller.revokeRole(keeperRole, 0x14eF38B0Ef08ae0A32f69FD1E7C506a3c6c02034); // old YieldKeeper
        controller.revokeRole(keeperRole, 0xA9461ED1956C79910AaFD8014f402a7a5beD1Ab5); // old DeadManSwitch

        vm.stopBroadcast();

        console2.log("=== Automation Redeployment ===");
        console2.log("New YieldKeeper:", address(keeper));
        console2.log("New DeadManSwitch:", address(dms));
        console2.log("StrategyController:", STRATEGY_CONTROLLER);
        console2.log("KEEPER_ROLE granted to new, revoked from old");
    }
}
