// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CircuitBreaker } from "../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../contracts/vault/YieldVault.sol";
import { StrategyController } from "../contracts/strategy/StrategyController.sol";
import { ERC20Mock } from "../test/mocks/ERC20Mock.sol";
import { MockAToken } from "../test/mocks/MockAToken.sol";
import { MockAavePool } from "../test/mocks/MockAavePool.sol";

/// @title DeployYieldVaultLocal — Deploy with mocks for local Anvil chain
contract DeployYieldVaultLocal is Script {
    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // Deploy mocks
        ERC20Mock usdc = new ERC20Mock("USD Coin", "USDC", 6);
        MockAToken aToken = new MockAToken(address(usdc));
        MockAavePool aavePool = new MockAavePool(address(aToken));
        ERC20Mock link = new ERC20Mock("Chainlink", "LINK", 18);

        CircuitBreaker circuitBreaker = _deployCircuitBreaker(deployer);

        YieldVault vault = _deployVault(deployer, address(usdc), address(aavePool), address(circuitBreaker));

        StrategyController controller = _deployController(
            deployer, address(vault), address(aavePool), address(link), address(circuitBreaker)
        );

        // Wire up roles
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        circuitBreaker.grantRole(circuitBreaker.VAULT_ROLE(), address(vault));
        vault.revokeRole(vault.STRATEGY_ROLE(), deployer);

        vm.stopBroadcast();

        console2.log("=== Local Deployment (Mocks) ===");
        console2.log("USDC:", address(usdc));
        console2.log("MockAavePool:", address(aavePool));
        console2.log("CircuitBreaker:", address(circuitBreaker));
        console2.log("YieldVault:", address(vault));
        console2.log("StrategyController:", address(controller));
    }

    function _deployCircuitBreaker(address admin) internal returns (CircuitBreaker) {
        uint256[3] memory depeg = [uint256(99_500_000), uint256(99_000_000), uint256(98_000_000)];
        uint256[3] memory tvl = [uint256(500), uint256(1000), uint256(2000)];
        uint256[3] memory share = [uint256(300), uint256(700), uint256(1500)];
        return new CircuitBreaker(admin, admin, admin, admin, depeg, tvl, share);
    }

    function _deployVault(address admin, address usdc, address pool, address cb) internal returns (YieldVault) {
        return new YieldVault(IERC20(usdc), "Yield USDC", "yUSDC", admin, admin, pool, cb, admin, 1000);
    }

    function _deployController(address admin, address vault, address pool, address link, address cb)
        internal
        returns (StrategyController)
    {
        return new StrategyController(admin, vault, pool, admin, link, cb, 50, 100, 1 hours, 0);
    }
}
