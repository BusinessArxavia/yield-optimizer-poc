// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CircuitBreaker } from "../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../contracts/vault/YieldVault.sol";
import { StrategyController } from "../contracts/strategy/StrategyController.sol";

/// @title DeployYieldVaultTestnet — Deploy vault system on Base Sepolia testnet
/// @notice Uses Aave V3 testnet addresses (faucet tokens, not Circle USDC)
contract DeployYieldVaultTestnet is Script {
    // ─── Base Sepolia Addresses (from aave-address-book & Chainlink CCIP directory) ───
    address constant AAVE_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f; // Aave faucet USDC
    address constant USDC_USD_FEED = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165; // Aave oracle (AggregatorV3)
    address constant CCIP_ROUTER = 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93;
    address constant LINK_TOKEN = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        CircuitBreaker circuitBreaker = _deployCircuitBreaker(deployer);
        YieldVault vault = _deployVault(deployer, address(circuitBreaker));
        StrategyController controller = _deployController(deployer, address(vault), address(circuitBreaker));

        // Wire up roles
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        circuitBreaker.grantRole(circuitBreaker.VAULT_ROLE(), address(vault));
        vault.revokeRole(vault.STRATEGY_ROLE(), deployer);

        vm.stopBroadcast();

        console2.log("=== Base Sepolia Testnet Deployment ===");
        console2.log("CircuitBreaker:", address(circuitBreaker));
        console2.log("YieldVault:", address(vault));
        console2.log("StrategyController:", address(controller));
        console2.log("Deployer:", deployer);
        console2.log("Asset (USDC):", USDC);
        console2.log("Aave Pool:", AAVE_POOL);
        console2.log("CCIP Router:", CCIP_ROUTER);
    }

    function _deployCircuitBreaker(address admin) internal returns (CircuitBreaker) {
        // Relaxed thresholds for testnet: less likely to trigger during testing
        uint256[3] memory depeg = [uint256(99_000_000), uint256(98_000_000), uint256(95_000_000)];
        uint256[3] memory tvl = [uint256(1000), uint256(2000), uint256(5000)];
        uint256[3] memory share = [uint256(500), uint256(1000), uint256(2000)];

        CircuitBreaker cb = new CircuitBreaker(admin, admin, admin, USDC_USD_FEED, depeg, tvl, share);
        console2.log("CircuitBreaker:", address(cb));
        return cb;
    }

    function _deployVault(address deployer, address circuitBreaker) internal returns (YieldVault) {
        YieldVault v = new YieldVault(
            IERC20(USDC), "Yield USDC", "yUSDC", deployer, deployer, AAVE_POOL, circuitBreaker, deployer, 1000
        );
        console2.log("YieldVault:", address(v));
        return v;
    }

    function _deployController(address admin, address vault, address circuitBreaker)
        internal
        returns (StrategyController)
    {
        // Lower thresholds for testnet (easier to trigger rotations), 1-minute timelock
        StrategyController sc = new StrategyController(
            admin, vault, AAVE_POOL, CCIP_ROUTER, LINK_TOKEN, circuitBreaker, 25, 200, 1 minutes, 0
        );
        console2.log("StrategyController:", address(sc));
        return sc;
    }
}
