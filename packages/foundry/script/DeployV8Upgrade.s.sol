// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { StrategyController } from "../contracts/strategy/StrategyController.sol";
import { YieldKeeperCRE } from "../contracts/automation/YieldKeeperCRE.sol";
import { YieldVault } from "../contracts/vault/YieldVault.sol";
import { CircuitBreaker } from "../contracts/safety/CircuitBreaker.sol";

/// @title DeployV8Upgrade — Deploy new StrategyController + YieldKeeperCRE on Base Sepolia
/// @notice Phase 7: Redemption queue automation + testnet recall
///         Run on Base Sepolia. SpokeVault must be deployed separately on Arb Sepolia.
contract DeployV8Upgrade is Script {
    // ─── Existing Base Sepolia Addresses (v7) ──────────────────────────
    address constant VAULT = 0x601F653c1F8940246fECEbCb9dEF8E6322c35570;
    address constant CIRCUIT_BREAKER = 0x68Fcdea702AAB6B006325f48c4b3D2FbAC86Be7f;
    address constant OLD_STRATEGY_CONTROLLER = 0xc1F7E05Abc211b67dFeF183Ea1f96eA9F7c6DD00;
    address constant OLD_YIELD_KEEPER_CRE = 0x545Ec47cf64C62C187AEA5aE000A9Ded7F3EAE8a;

    // ─── Base Sepolia Infra ────────────────────────────────────────────
    address constant AAVE_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant CCIP_ROUTER = 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93;
    address constant LINK_TOKEN = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;

    // ─── Spoke Registration ────────────────────────────────────────────
    // The spoke will be deployed separately on Arb Sepolia, address filled in after
    uint64 constant ARB_CHAIN_SELECTOR = 3478487238524512106;

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        console2.log("=== V8 Upgrade: Base Sepolia ===");
        console2.log("Deployer:", deployer);

        // ─── 1. Deploy new StrategyController ──────────────────────────
        StrategyController newController = new StrategyController(
            deployer,           // admin
            VAULT,
            AAVE_POOL,
            CCIP_ROUTER,
            LINK_TOKEN,
            CIRCUIT_BREAKER,
            25,                 // minSpreadBps
            200,                // maxCostBps
            1 minutes,          // paramTimelock (testnet)
            0                   // rotationCooldown (testnet: 0 for demo)
        );
        console2.log("New StrategyController:", address(newController));

        // ─── 2. Deploy new YieldKeeperCRE ──────────────────────────────
        YieldKeeperCRE newKeeper = new YieldKeeperCRE(
            VAULT,
            address(newController),
            CIRCUIT_BREAKER,
            deployer,           // admin
            address(0),         // forwarder: 0 for simulation mode
            100e6,              // minIdleSupplyAmount
            500,                // idleTargetBps: 5%
            50,                 // harvestMinYieldBps: 0.5%
            10 minutes          // harvestCooldown
        );
        console2.log("New YieldKeeperCRE:", address(newKeeper));

        // ─── 3. Wire Roles ─────────────────────────────────────────────
        YieldVault vault = YieldVault(VAULT);

        // Grant STRATEGY_ROLE to new controller
        vault.grantRole(vault.STRATEGY_ROLE(), address(newController));
        console2.log("Granted STRATEGY_ROLE to new controller");

        // Revoke STRATEGY_ROLE from old controller
        vault.revokeRole(vault.STRATEGY_ROLE(), OLD_STRATEGY_CONTROLLER);
        console2.log("Revoked STRATEGY_ROLE from old controller");

        // Grant KEEPER_ROLE on new controller to new CRE keeper + deployer
        newController.grantRole(newController.KEEPER_ROLE(), address(newKeeper));
        newController.grantRole(newController.KEEPER_ROLE(), deployer);
        console2.log("Granted KEEPER_ROLE to new CRE keeper + deployer");

        // ─── 4. Queue Spoke Registration ───────────────────────────────
        // NOTE: Spoke address must be filled in after deploying SpokeVault on Arb Sepolia.
        // For now, we just log the next steps.

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Next Steps ===");
        console2.log("1. Deploy SpokeVault on Arb Sepolia (pointing to new controller)");
        console2.log("2. Queue + execute spoke registration on new controller");
        console2.log("3. Fund new controller with LINK + CCIP-BnM");
        console2.log("4. Set CCIP gas limit on new controller (setCcipGasLimit via timelock)");
        console2.log("5. Fund SpokeVault with LINK + USDC + CCIP-BnM on Arb Sepolia");
        console2.log("6. Verify all contracts");
        console2.log("7. Update frontend externalContracts.ts or regenerate ABIs");
    }
}
