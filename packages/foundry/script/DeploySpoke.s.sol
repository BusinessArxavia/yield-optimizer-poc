// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { SpokeVault } from "../contracts/spoke/SpokeVault.sol";

/// @title DeploySpoke — Deploy SpokeVault on a remote chain
contract DeploySpoke is Script {
    function run(
        address ccipRouter,
        address aavePool,
        address admin,
        uint64 homeChainSelector,
        address homeStrategyController,
        address linkToken,
        address asset
    ) external {
        vm.startBroadcast();

        SpokeVault spoke =
            new SpokeVault(ccipRouter, aavePool, admin, homeChainSelector, homeStrategyController, linkToken, asset);

        console2.log("SpokeVault deployed at:", address(spoke));
        console2.log("  Home chain selector:", homeChainSelector);
        console2.log("  Home strategy controller:", homeStrategyController);

        vm.stopBroadcast();
    }
}
