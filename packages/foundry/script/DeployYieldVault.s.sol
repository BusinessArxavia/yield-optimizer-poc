// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CircuitBreaker } from "../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../contracts/vault/YieldVault.sol";
import { StrategyController } from "../contracts/strategy/StrategyController.sol";

/// @title DeployYieldVault — Full deployment of vault, circuit breaker, and strategy controller
contract DeployYieldVault is Script {
    // ─── Base Mainnet Addresses ─────────────────────────────────────
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDC_USD_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address constant CCIP_ROUTER = 0x881e3A65B4d4a04dD529061dd0071cf975F58bCD;
    address constant LINK_TOKEN = 0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196;

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

        console2.log("Deployment complete!");
    }

    function _deployCircuitBreaker(address admin) internal returns (CircuitBreaker) {
        uint256[3] memory depeg = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvl = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory share = [uint256(300), uint256(700), uint256(1500)];

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
        StrategyController sc = new StrategyController(
            admin, vault, AAVE_POOL, CCIP_ROUTER, LINK_TOKEN, circuitBreaker, 50, 100, 48 hours, 24 hours
        );
        console2.log("StrategyController:", address(sc));
        return sc;
    }
}
