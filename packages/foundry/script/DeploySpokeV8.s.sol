// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { SpokeVault } from "../contracts/spoke/SpokeVault.sol";

/// @title DeploySpokeV8 — Deploy SpokeVault v4 on Arbitrum Sepolia (Phase 7)
/// @notice Points to new StrategyController (v8) on Base Sepolia
contract DeploySpokeV8 is Script {
    // ─── Arbitrum Sepolia Addresses ──────────────────────────────────
    address constant CCIP_ROUTER = 0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165;
    address constant AAVE_POOL = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address constant LINK_TOKEN = 0xb1D4538B4571d411F07960EF2838Ce337FE1E80E;
    address constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    // ─── Base Sepolia (Home Chain) ───────────────────────────────────
    uint64 constant HOME_CHAIN_SELECTOR = 10344971235874465080; // Base Sepolia
    address constant HOME_STRATEGY_CONTROLLER = 0x93e37393D12FB6874190b7E38D7AdE096ceBEF90; // v8

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        SpokeVault spoke = new SpokeVault(
            CCIP_ROUTER, AAVE_POOL, deployer, HOME_CHAIN_SELECTOR, HOME_STRATEGY_CONTROLLER, LINK_TOKEN, USDC
        );

        vm.stopBroadcast();

        console2.log("=== Arbitrum Sepolia Spoke V4 Deployment ===");
        console2.log("SpokeVault:", address(spoke));
        console2.log("Deployer:", deployer);
        console2.log("Home StrategyController (v8):", HOME_STRATEGY_CONTROLLER);
    }
}
